import type {
  ChecksState,
  ForgeConfig,
  GitForge,
  Issue,
  MergeInput,
  MergeMethod,
  OpenPrInput,
  PostReviewInput,
  PrStatus,
  PullRequest,
  RedeployInput,
} from "./types";

interface GiteaPr {
  number: number;
  title?: string;
  state: string; // open | closed
  merged?: boolean;
  mergeable?: boolean;
  draft?: boolean;
  html_url: string;
  user?: { login?: string } | null;
  created_at?: string;
  head?: { ref: string; sha: string };
}

/**
 * Bound on simultaneous per-PR commit-status calls in listPullRequests. Mirrors
 * backlog.ts's DEFAULT_MAX_CONCURRENCY: an unbounded fan-out over a 50-PR list
 * would fire 50 requests at a self-hosted Gitea at once (rate limits / process
 * pressure). A small pool keeps most of the parallel speedup without the burst.
 */
const STATUS_FETCH_CONCURRENCY = 6;

/** Order-preserving bounded-concurrency map: at most `limit` `fn`s run at once. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Map Gitea's server-computed combined commit status to our worst-of rollup. */
function mapCombinedStatus(state: string | undefined): ChecksState {
  switch ((state ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "pending":
    case "running":
      return "pending";
    case "failure":
    case "error":
      return "failure";
    default:
      return "none";
  }
}

/** Gitea/Forgejo forge driven through the /api/v1 REST API (API-compatible). */
export class GiteaForge implements GitForge {
  readonly kind = "gitea" as const;
  readonly mergeMethod: MergeMethod;
  readonly deployWorkflow: string | null;
  private readonly base: string;

  constructor(
    readonly slug: string,
    private readonly cfg: ForgeConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
    this.mergeMethod = cfg.mergeMethod ?? "squash";
    this.deployWorkflow = cfg.deployWorkflow ?? null;
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.token) headers.Authorization = `token ${this.cfg.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gitea ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async listIssues(): Promise<Issue[]> {
    const raw = (await this.req(
      "GET",
      `/api/v1/repos/${this.slug}/issues?state=open&type=issues&limit=200`,
    )) as Array<{
      number: number;
      title: string;
      body?: string;
      html_url: string;
      labels?: Array<{ name: string }>;
      created_at?: string;
    }>;
    return (raw ?? []).map((i) => {
      const ts = Date.parse(i.created_at ?? "");
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.html_url,
        labels: (i.labels ?? []).map((l) => l.name),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
      };
    });
  }

  private async checksFor(sha: string | undefined): Promise<ChecksState> {
    if (!sha) return "none";
    const status = (await this.req("GET", `/api/v1/repos/${this.slug}/commits/${sha}/status`)) as {
      state?: string;
    } | null;
    return mapCombinedStatus(status?.state);
  }

  private async toStatus(pr: GiteaPr): Promise<PrStatus> {
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
    const state: PrStatus["state"] = pr.merged ? "merged" : pr.state === "open" ? "open" : "closed";
    return {
      state,
      number: pr.number,
      url: pr.html_url,
      title: pr.title ?? "",
      mergeable: pr.mergeable ?? null,
      checks: await this.checksFor(pr.head?.sha),
      headSha: pr.head?.sha,
      deployConfigured,
    };
  }

  async listPullRequests(): Promise<PullRequest[]> {
    const prs = (await this.req(
      "GET",
      `/api/v1/repos/${this.slug}/pulls?state=open&limit=50`,
    )) as GiteaPr[];
    // Checks ride a per-PR commit-status call (same shape as prStatus); fan out
    // (bounded — see STATUS_FETCH_CONCURRENCY) so the list isn't serialized on a
    // chain of round-trips, nor bursts 50 requests at once. Gitea's list API
    // exposes no human-review summary, so latestReview stays undefined here.
    // A single PR's status call may 404 (e.g. a force-pushed/GC'd head SHA);
    // swallow it to "none" so one bad PR can't reject the whole list.
    return mapBounded(prs ?? [], STATUS_FETCH_CONCURRENCY, async (pr) => {
      const ts = Date.parse(pr.created_at ?? "");
      const checks = await this.checksFor(pr.head?.sha).catch((): ChecksState => "none");
      return {
        number: pr.number,
        title: pr.title ?? "",
        url: pr.html_url,
        author: pr.user?.login ?? "",
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        isDraft: pr.draft ?? false,
        mergeable: pr.mergeable ?? null,
        checks,
      } satisfies PullRequest;
    });
  }

  async prStatus(headBranch: string): Promise<PrStatus> {
    const prs = (await this.req(
      "GET",
      `/api/v1/repos/${this.slug}/pulls?state=all&limit=50`,
    )) as GiteaPr[];
    const pr = (prs ?? []).find((p) => p.head?.ref === headBranch);
    if (!pr)
      return { state: "none", checks: "none", deployConfigured: Boolean(this.cfg.deployWorkflow) };
    return this.toStatus(pr);
  }

  async openPr(o: OpenPrInput): Promise<PrStatus> {
    const pr = (await this.req("POST", `/api/v1/repos/${this.slug}/pulls`, {
      head: o.head,
      base: o.base,
      title: o.title,
      body: o.body,
    })) as GiteaPr;
    return this.toStatus(pr);
  }

  async merge(prNumber: number, o: MergeInput): Promise<void> {
    await this.req("POST", `/api/v1/repos/${this.slug}/pulls/${prNumber}/merge`, {
      Do: o.method,
      delete_branch_after_merge: o.deleteBranch,
    });
  }

  async redeploy(o: RedeployInput): Promise<void> {
    await this.req(
      "POST",
      `/api/v1/repos/${this.slug}/actions/workflows/${o.workflow}/dispatches`,
      { ref: o.ref },
    );
  }

  async postReview(prNumber: number, o: PostReviewInput): Promise<{ url?: string }> {
    const res = (await this.req("POST", `/api/v1/repos/${this.slug}/pulls/${prNumber}/reviews`, {
      event: o.event,
      body: o.body,
    })) as { html_url?: string } | null;
    return { url: res?.html_url };
  }
}
