import { mapGiteaActionStatus, mapStatusState } from "./checks";
import { classifyPr } from "./pr-kind";
import { labelColorsFrom } from "./labels";
import { mapBounded } from "../map-bounded";
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
  RepoCounts,
  WorkflowJob,
  WorkflowRun,
} from "./types";
import { EmptyDiffError } from "./types";

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
  head?: { ref?: string; sha: string };
  base?: { ref?: string };
  labels?: Array<{ name?: string }>;
}

/**
 * Bound on simultaneous per-PR commit-status calls in listPullRequests. Mirrors
 * backlog.ts's DEFAULT_MAX_CONCURRENCY: an unbounded fan-out over a 50-PR list
 * would fire 50 requests at a self-hosted Gitea at once (rate limits / process
 * pressure). A small pool keeps most of the parallel speedup without the burst.
 */
const STATUS_FETCH_CONCURRENCY = 6;

/** Cap on workflows surfaced in the Actions tab (one row per workflow, latest
 *  run). Mirrors github.ts's own MAX_WORKFLOWS — the two packages don't share it. */
const MAX_WORKFLOWS = 10;

/** Match (case-insensitively) Gitea's empty-diff signal on a failed pull creation. Best-effort:
 *  with no live Gitea to verify against, we match a small set of documented no-changes wordings —
 *  Gitea returns 422 "There are no changes between the head and the base" when head == base. An
 *  unmatched signal falls through as the original error (the caller's attempt-cap bounds the miss).
 *  Pass an already-lowercased string. */
function isGiteaNoChanges(text: string): boolean {
  return (
    text.includes("no changes between the head and the base") ||
    text.includes("there are no changes") ||
    text.includes("no commits between") ||
    text.includes("has no changes")
  );
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

  get webUrl(): string | null {
    return this.base ? `${this.base}/${this.slug}` : null;
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

  async listBacklogCounts(): Promise<RepoCounts> {
    // The repo summary carries both open counts in one cheap call. Gitea exposes no
    // default-branch CI rollup or PR-kind split, so those stay null (as today).
    const data = (await this.req("GET", `/api/v1/repos/${this.slug}`)) as {
      open_issues_count?: number;
      open_pr_counter?: number;
    };
    return {
      openIssues: typeof data?.open_issues_count === "number" ? data.open_issues_count : null,
      openPRs: typeof data?.open_pr_counter === "number" ? data.open_pr_counter : null,
      ciStatus: null,
      prKinds: null,
    };
  }

  async listIssues(): Promise<Issue[]> {
    // 200 cap vs the unbounded count source (open_issues_count). A repo with
    // >200 open issues lists a truncated set under a larger count; raise this or
    // paginate if such repos appear.
    const raw = (await this.req(
      "GET",
      `/api/v1/repos/${this.slug}/issues?state=open&type=issues&limit=200`,
    )) as Array<{
      number: number;
      title: string;
      body?: string;
      html_url: string;
      labels?: Array<{ name: string; color?: string }>;
      created_at?: string;
      assignees?: Array<{ login?: string }> | null;
      user?: { login?: string } | null;
    }>;
    return (raw ?? []).map((i) => {
      const ts = Date.parse(i.created_at ?? "");
      const labelColors = labelColorsFrom(i.labels ?? []);
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.html_url,
        labels: (i.labels ?? []).map((l) => l.name),
        ...(labelColors ? { labelColors } : {}),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        // Gitea serializes a user's canonical name as `login` (matches the PR-author
        // mapping above); drop any null/unnamed assignee defensively.
        assignees: (i.assignees ?? []).map((a) => a.login).filter((l): l is string => !!l),
        // The issue's author (`user.login`) — surfaced in the UI's "by {login}" row text and
        // author filter, mirroring GitHub's listIssues author mapping.
        author: i.user?.login || undefined,
      };
    });
  }

  async getIssue(issueNumber: number): Promise<Issue | null> {
    // Fresh, uncached single-issue read for the drain's pre-spawn claim re-check
    // (see GitForge.getIssue). Best-effort: a gone/closed issue or a transient error
    // yields null so the caller falls back to spawning, never loses the issue.
    try {
      const i = (await this.req("GET", `/api/v1/repos/${this.slug}/issues/${issueNumber}`)) as {
        number: number;
        title: string;
        body?: string;
        html_url: string;
        labels?: Array<{ name: string }>;
        created_at?: string;
        assignees?: Array<{ login?: string }> | null;
      } | null;
      if (!i) return null;
      const ts = Date.parse(i.created_at ?? "");
      return {
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: i.html_url,
        labels: (i.labels ?? []).map((l) => l.name),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        assignees: (i.assignees ?? []).map((a) => a.login).filter((l): l is string => !!l),
      };
    } catch {
      return null;
    }
  }

  private cachedUser: string | null | undefined;
  /** The authenticated Gitea login (`GET /api/v1/user`), cached for the forge's
   *  lifetime — it never changes mid-session. Drives the "mine & unassigned" issue
   *  filter (#824) so the chip is live on Gitea too, not just GitHub. Null when it
   *  can't be resolved (no token / network error) → fail open (show all). */
  async currentUser(): Promise<string | null> {
    if (this.cachedUser !== undefined) return this.cachedUser;
    try {
      const u = (await this.req("GET", "/api/v1/user")) as { login?: string } | null;
      this.cachedUser = u?.login || null;
    } catch {
      this.cachedUser = null; // unauth / offline → treat as "unknown me"
    }
    return this.cachedUser;
  }

  /** One combined-status call yields both the worst-of rollup (top-level `state`)
   *  and the per-context breakdown (`statuses[]`) for the PRs-tab expand view. */
  private async commitChecks(
    sha: string | undefined,
  ): Promise<{ checks: ChecksState; jobs: WorkflowJob[] }> {
    if (!sha) return { checks: "none", jobs: [] };
    const status = (await this.req("GET", `/api/v1/repos/${this.slug}/commits/${sha}/status`)) as {
      state?: string;
      statuses?: Array<{ status?: string; context?: string; target_url?: string }>;
    } | null;
    const jobs: WorkflowJob[] = (status?.statuses ?? [])
      .filter((s) => s.context)
      .map((s) => ({
        name: s.context ?? "",
        state: mapStatusState(s.status),
        url: s.target_url || undefined,
      }));
    return { checks: mapStatusState(status?.state), jobs };
  }

  private async checksFor(sha: string | undefined): Promise<ChecksState> {
    return (await this.commitChecks(sha)).checks;
  }

  private async toStatus(pr: GiteaPr): Promise<PrStatus> {
    const deployConfigured = Boolean(this.cfg.deployWorkflow);
    const state: PrStatus["state"] = pr.merged ? "merged" : pr.state === "open" ? "open" : "closed";
    const createdAt = Date.parse(pr.created_at ?? "");
    return {
      state,
      number: pr.number,
      url: pr.html_url,
      title: pr.title ?? "",
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      mergeable: pr.mergeable ?? null,
      // Gitea has no draft boolean; draft = the WIP-title-prefix convention (see WIP_PREFIX).
      isDraft: (pr.title ?? "").startsWith(GiteaForge.WIP_PREFIX),
      checks: await this.checksFor(pr.head?.sha),
      headSha: pr.head?.sha,
      deployConfigured,
    };
  }

  async listPullRequests(): Promise<PullRequest[]> {
    // See listIssues: 200 cap vs the unbounded PR count (open_pr_counter).
    // Resolve the default branch concurrently — used to flag non-default-targeting
    // (stacked/epic) PRs; a failure degrades to null (no chip), never rejects the list.
    const [prs, def] = await Promise.all([
      this.req("GET", `/api/v1/repos/${this.slug}/pulls?state=open&limit=200`) as Promise<
        GiteaPr[]
      >,
      this.defaultBranch().catch(() => null),
    ]);
    // Checks ride a per-PR commit-status call (same shape as prStatus); fan out
    // (bounded — see STATUS_FETCH_CONCURRENCY) so the list isn't serialized on a
    // chain of round-trips, nor bursts 50 requests at once. Gitea's list API
    // exposes no human-review summary, so latestReview stays undefined here.
    // A single PR's status call may 404 (e.g. a force-pushed/GC'd head SHA);
    // swallow it to "none" so one bad PR can't reject the whole list.
    return mapBounded(prs ?? [], STATUS_FETCH_CONCURRENCY, async (pr) => {
      const ts = Date.parse(pr.created_at ?? "");
      const { checks, jobs } = await this.commitChecks(pr.head?.sha).catch(() => ({
        checks: "none" as ChecksState,
        jobs: [] as WorkflowJob[],
      }));
      return {
        number: pr.number,
        title: pr.title ?? "",
        url: pr.html_url,
        author: pr.user?.login ?? "",
        kind: classifyPr({
          author: pr.user?.login ?? "",
          title: pr.title ?? "",
          headRefName: pr.head?.ref,
          labels: (pr.labels ?? []).map((l) => l.name).filter((n): n is string => !!n),
        }),
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        isDraft: pr.draft ?? false,
        mergeable: pr.mergeable ?? null,
        checks,
        jobs,
        nonDefaultBase: def && pr.base?.ref && pr.base.ref !== def ? pr.base.ref : undefined,
        headSha: pr.head?.sha,
        headRefName: pr.head?.ref,
      } satisfies PullRequest;
    });
  }

  /** Latest run per workflow on the repo, for the backlog Actions tab. Reads the
   *  `actions/tasks` endpoint — the only Actions API portable across Forgejo +
   *  Gitea ≥1.23. Despite its name it lists *runs*, not jobs: there is no per-job
   *  breakdown (so every `jobs` is empty) and no `conclusion` field — `status` is a
   *  single native enum (mapped by {@link mapGiteaActionStatus}). We don't trust the
   *  server's ordering: sort newest-first, then keep the latest run per workflow
   *  (keyed on the displayed name, so the consumer's keyed list stays unique). */
  async listWorkflowRuns(): Promise<WorkflowRun[]> {
    const raw = (await this.req("GET", `/api/v1/repos/${this.slug}/actions/tasks?limit=50`)) as {
      workflow_runs?: Array<{
        id: number;
        name?: string;
        status?: string;
        url?: string;
        head_sha?: string;
        workflow_id?: string;
        created_at?: string;
      }> | null;
    } | null;

    // Parse each created_at once and sort newest-first (don't assume server order).
    const tasks = (raw?.workflow_runs ?? [])
      .map((t) => ({ task: t, ts: Date.parse(t.created_at ?? "") }))
      .sort((a, b) => (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0));

    // Dedup keeping the newest entry per workflow, keyed on the displayed name
    // (name || workflow_id) so the keyed Actions list can't collide; then cap.
    const newest = new Map<string, (typeof tasks)[number]>();
    for (const entry of tasks) {
      const key = entry.task.name || entry.task.workflow_id || "";
      if (!newest.has(key)) newest.set(key, entry);
    }
    const selected = [...newest.values()].slice(0, MAX_WORKFLOWS);

    return selected.map(({ task, ts }): WorkflowRun => {
      return {
        runId: task.id,
        // Gitea's tasks endpoint exposes no GitHub-style numeric workflow id, and
        // the forge supports neither per-job nor run-history; 0 is the sentinel the
        // history-expander gates off (`{#if run.workflowId}`), so it stays hidden.
        workflowId: 0,
        workflowName: task.name || (task.workflow_id ?? ""),
        runUrl: task.url ?? "",
        headSha: task.head_sha ?? "",
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        state: mapGiteaActionStatus(task.status),
        jobs: [], // the tasks endpoint carries no per-job data
      };
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

  private cachedDefaultBranch?: string;
  /** The repo's default branch (`GET /api/v1/repos/{slug}`), cached for the
   *  forge's lifetime — it never changes mid-session, and listPullRequests polls
   *  this. Cached ONLY on success: a transient failure rethrows so the next call
   *  retries rather than sticking. Mirrors GithubForge.defaultBranch. */
  async defaultBranch(): Promise<string> {
    if (this.cachedDefaultBranch !== undefined) return this.cachedDefaultBranch;
    const repo = (await this.req("GET", `/api/v1/repos/${this.slug}`)) as {
      default_branch?: string;
    };
    if (!repo.default_branch) throw new Error("could not resolve default branch");
    this.cachedDefaultBranch = repo.default_branch;
    return repo.default_branch;
  }

  /** Whether the authenticated user can push. Returns a DEFINITIVE boolean only;
   *  THROWS on a probe failure (request error / missing permissions field) so the
   *  caller can treat that as retryable rather than silently as "no access". */
  async canPush(): Promise<boolean> {
    // `this.req` throwing (offline/unauth) propagates as a probe failure — not caught.
    const repo = (await this.req("GET", `/api/v1/repos/${this.slug}`)) as {
      permissions?: { push?: boolean };
    };
    const push = repo.permissions?.push;
    if (typeof push !== "boolean") throw new Error("gitea repo permissions.push missing");
    return push;
  }

  /** Gitea has no draft boolean in CreatePullRequestOption (confirmed via swagger.v1.json
   *  on gitea.com). Draft PRs are signalled by prefixing the title with `WIP: `.
   *  LIMITATIONS (Gitea is the secondary, non-production forge): (1) Gitea's WIP markers are
   *  server-configurable (default also includes `[WIP]`); we only handle this one default, so a
   *  repo using a custom marker won't be detected. (2) A PR whose real title legitimately starts
   *  with `WIP: ` is indistinguishable from a draft — but that is exactly how Gitea itself treats
   *  such a title, so `markReady` stripping the prefix matches Gitea's own semantics. */
  private static WIP_PREFIX = "WIP: ";

  private static addWip(title: string): string {
    return GiteaForge.WIP_PREFIX + title;
  }

  private static removeWip(title: string): string {
    return title.startsWith(GiteaForge.WIP_PREFIX)
      ? title.slice(GiteaForge.WIP_PREFIX.length)
      : title;
  }

  async openPr(o: OpenPrInput): Promise<PrStatus> {
    const title = o.draft ? GiteaForge.addWip(o.title) : o.title;
    let pr: GiteaPr;
    try {
      pr = (await this.req("POST", `/api/v1/repos/${this.slug}/pulls`, {
        head: o.head,
        base: o.base,
        title,
        body: o.body,
      })) as GiteaPr;
    } catch (err) {
      // req()'s error message embeds the Gitea response body + status. Classify the empty-diff
      // signal so the epic-landing caller (#635) can resolve "nothing to land" rather than
      // retrying forever. Best-effort: there is no live Gitea to verify against here, so we match
      // a small set of documented no-changes wordings (Gitea returns 422 "There are no changes
      // between the head and the base" when head == base). If the signal isn't matched, the
      // original error propagates and the caller's attempt-cap bounds any miss — it never retries
      // forever. We deliberately do NOT map all 409/errors here (e.g. a plain already-exists PR or
      // an unrelated failure) so other openPr callers (gitignore-adopt, etc.) aren't mis-told.
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (isGiteaNoChanges(msg)) throw new EmptyDiffError(o.head, o.base, err);
      throw err;
    }
    return this.toStatus(pr);
  }

  async markReady(prNumber: number): Promise<void> {
    const pr = (await this.req("GET", `/api/v1/repos/${this.slug}/pulls/${prNumber}`)) as GiteaPr;
    // removeWip is idempotent — always send the PATCH (an already-ready PR just gets its
    // unchanged title re-written), keeping this simpler than convertToDraft's skip guard.
    const title = GiteaForge.removeWip(pr.title ?? "");
    await this.req("PATCH", `/api/v1/repos/${this.slug}/pulls/${prNumber}`, { title });
  }

  async convertToDraft(prNumber: number): Promise<void> {
    const pr = (await this.req("GET", `/api/v1/repos/${this.slug}/pulls/${prNumber}`)) as GiteaPr;
    const title = pr.title ?? "";
    if (!title.startsWith(GiteaForge.WIP_PREFIX)) {
      await this.req("PATCH", `/api/v1/repos/${this.slug}/pulls/${prNumber}`, {
        title: GiteaForge.addWip(title),
      });
    }
  }

  async createIssue(o: { title: string; body: string }): Promise<{ number: number; url: string }> {
    const issue = (await this.req("POST", `/api/v1/repos/${this.slug}/issues`, {
      title: o.title,
      body: o.body,
    })) as { number: number; html_url: string };
    return { number: issue.number, url: issue.html_url };
  }

  async merge(prNumber: number, o: MergeInput): Promise<void> {
    await this.req("POST", `/api/v1/repos/${this.slug}/pulls/${prNumber}/merge`, {
      Do: o.method,
      delete_branch_after_merge: o.deleteBranch,
    });
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.req("PATCH", `/api/v1/repos/${this.slug}/issues/${issueNumber}`, {
      state: "closed",
    });
  }

  async commentIssue(issueNumber: number, body: string): Promise<void> {
    await this.req("POST", `/api/v1/repos/${this.slug}/issues/${issueNumber}/comments`, { body });
  }

  async ensureIssueLink(prNumber: number, issueNumber: number): Promise<void> {
    const pr = (await this.req("GET", `/api/v1/repos/${this.slug}/pulls/${prNumber}`)) as {
      body?: string | null;
    } | null;
    const body = pr?.body ?? "";
    const pattern = new RegExp(
      `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
      "i",
    );
    if (pattern.test(body)) return;
    const newBody = body ? `${body}\n\nCloses #${issueNumber}` : `Closes #${issueNumber}`;
    await this.req("PATCH", `/api/v1/repos/${this.slug}/pulls/${prNumber}`, { body: newBody });
  }

  /** Gitea's issue-label API keys on numeric label IDs, so resolve (or create) the
   *  label by name first. Paginated, unlike listIssues' bounded truncation: missing
   *  an existing label here would make addIssueLabel attempt a duplicate create
   *  (409), so walk every page (50-page / 5000-label backstop against a runaway). */
  private async findLabelId(name: string): Promise<number | null> {
    for (let page = 1; page <= 50; page++) {
      const batch = ((await this.req(
        "GET",
        `/api/v1/repos/${this.slug}/labels?limit=100&page=${page}`,
      )) ?? []) as Array<{ id: number; name: string }>;
      const found = batch.find((l) => l.name === name);
      if (found) return found.id;
      if (batch.length < 100) break; // short page → last page
    }
    return null;
  }

  async addIssueLabel(issueNumber: number, label: string): Promise<void> {
    let id = await this.findLabelId(label);
    if (id == null) {
      // Create the label — but a concurrent first-ever claim on another instance
      // may have created it between our lookup and now (409 duplicate name). Re-
      // resolve on any create failure rather than throwing the claim out; only a
      // genuine failure (still absent) propagates. Mirrors GithubForge.ensureLabel.
      try {
        const created = (await this.req("POST", `/api/v1/repos/${this.slug}/labels`, {
          name: label,
          color: "#5319e7",
        })) as { id: number };
        id = created.id;
      } catch (err) {
        id = await this.findLabelId(label);
        if (id == null) throw err;
      }
    }
    await this.req("POST", `/api/v1/repos/${this.slug}/issues/${issueNumber}/labels`, {
      labels: [id],
    });
  }

  async removeIssueLabel(issueNumber: number, label: string): Promise<void> {
    const id = await this.findLabelId(label);
    if (id == null) return; // never defined → nothing applied to remove
    await this.req("DELETE", `/api/v1/repos/${this.slug}/issues/${issueNumber}/labels/${id}`);
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
