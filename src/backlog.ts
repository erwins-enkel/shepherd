import { execFileSync } from "./instrument";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseRemote } from "./forge/remote";
import { detectForge } from "./forge";
import { classifyPr } from "./forge/pr-kind";
import type { ForgeMap } from "./forge/types";

/** Default-branch CI rollup state, or null when unknown / no CI / non-GitHub. */
export type CiStatus = "success" | "failure" | "pending" | null;

export interface RepoCounts {
  openIssues: number | null;
  openPRs: number | null;
  /** Default-branch CI health for the Actions tab marker. GitHub-only; null otherwise. */
  ciStatus: CiStatus;
  /** Open-PR breakdown by kind for the repo-list row. GitHub-only; null for Gitea/unknown. */
  prKinds: { release: number; dependabot: number; regular: number } | null;
}

/**
 * Runs `gh` and returns stdout. Sync or async — the background warmer passes an
 * async runner so handleBacklog's per-repo `Promise.all` actually fans out in
 * parallel instead of serializing on a blocking `execFileSync`.
 */
export type CountsRunner = (args: string[]) => string | Promise<string>;

interface CacheEntry {
  at: number;
  value: RepoCounts;
}

const TTL_MS = 60_000;

/**
 * Cap on simultaneous count fetches. The async runner made the per-repo `gh`
 * calls fan out — without a ceiling a large repo root would spawn one `gh`
 * subprocess per repo at once (on the request path *and* every poller tick),
 * risking GitHub secondary rate limits / process pressure. A small cap keeps
 * most of the parallel speedup without the unbounded burst.
 */
const DEFAULT_MAX_CONCURRENCY = 6;

const NULL_COUNTS: RepoCounts = {
  openIssues: null,
  openPRs: null,
  ciStatus: null,
  prKinds: null,
};

/**
 * Minimal FIFO semaphore — bounds how many gated thunks run concurrently.
 * Strict: a releaser hands its slot directly to the next waiter (the active
 * count is unchanged across the handoff) instead of decrementing and letting
 * the woken waiter re-increment. That closes the window where a fresh arrival
 * could slip in between a decrement and a wake-up and push `active` to max+1.
 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve)); // woken = slot already ours
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next)
        next(); // hand the slot off — keep `active`
      else this.active--; // no waiter — free the slot
    }
  }
}

/**
 * Number of workflows *defined* in a repo working copy — the count shown on the
 * backlog Actions tab. "Defined" = files directly under `.github/workflows`
 * ending in `.yml`/`.yaml`. Read from the local checkout, so it adds zero
 * GitHub API pressure to the rate-limited counts warmer (unlike issue/PR counts,
 * which hit the forge). Missing dir / unreadable → 0.
 *
 * Deliberately diverges from ActionsPanel, which lists workflow *runs* from
 * GitHub: a never-run (or non-default-branch) workflow still counts here but
 * has no run row there, so the badge can read higher than the panel.
 */
export function countDefinedWorkflows(repoDir: string): number {
  try {
    return readdirSync(join(repoDir, ".github", "workflows"), { withFileTypes: true }).filter(
      (e) => e.isFile() && /\.ya?ml$/i.test(e.name),
    ).length;
  } catch {
    return 0;
  }
}

function originUrl(repoDir: string): string | null {
  try {
    return execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** GitHub StatusState rollup → our CiStatus. Unknown/absent → null. */
function mapRollupState(state: string | undefined | null): CiStatus {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

export class CountsService {
  /** Resolved forge per repoPath, null = not a supported forge. Immutable once set. */
  private readonly forgeCache = new Map<string, ReturnType<typeof detectForge>>();
  /** TTL read-through cache: repoPath → {at, value}. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Single-flight: repoPath → in-flight Promise. */
  private readonly inflight = new Map<string, Promise<RepoCounts>>();
  /** Bounds simultaneous fetches across both the request path and the warmer. */
  private readonly gate: Semaphore;

  constructor(
    private readonly forges: ForgeMap,
    private readonly run: CountsRunner,
    private readonly fetchFn: typeof fetch = fetch,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  ) {
    this.gate = new Semaphore(maxConcurrency);
  }

  /**
   * Synchronous cache-only peek — returns the last cached value for `repoPath` (regardless
   * of TTL freshness) or null when nothing has been cached yet. Never triggers a fetch, so
   * a caller on the event loop (e.g. the rundown's backlog-priority ranking) can read the
   * kept-warm cache without an async forge round-trip. The backlog poller keeps these warm.
   */
  peek(repoPath: string): RepoCounts | null {
    return this.cache.get(repoPath)?.value ?? null;
  }

  /** Read-through: serve a TTL-fresh cached value, else load it. */
  async counts(repoPath: string): Promise<RepoCounts> {
    const entry = this.cache.get(repoPath);
    if (entry && Date.now() - entry.at < TTL_MS) return entry.value;
    return this.load(repoPath);
  }

  /**
   * Force a refetch regardless of TTL — used by the background warmer to rewrite
   * the cached value on a cadence so the request path always finds a fresh
   * entry. Single-flight still dedupes against any in-flight load.
   *
   * `preserveOnError`: a warm failure keeps the last-known-good value instead of
   * clobbering it with nulls. The warmer runs every 45s, so without this a brief
   * `gh`/network flake would blink the overview's counts to null until the next
   * successful warm. A genuinely expired entry still falls back to a live fetch
   * on the request path, so persistent failures eventually surface as null.
   */
  async refresh(repoPath: string): Promise<RepoCounts> {
    return this.load(repoPath, true);
  }

  private load(repoPath: string, preserveOnError = false): Promise<RepoCounts> {
    const existing = this.inflight.get(repoPath);
    if (existing) return existing;

    const promise = this.gate
      .run(() => this.fetch(repoPath))
      .then(
        (v) => {
          this.cache.set(repoPath, { at: Date.now(), value: v });
          this.inflight.delete(repoPath);
          return v;
        },
        () => {
          this.inflight.delete(repoPath);
          const prev = this.cache.get(repoPath);
          if (preserveOnError && prev) return prev.value; // keep last-known-good
          this.cache.set(repoPath, { at: Date.now(), value: NULL_COUNTS });
          return NULL_COUNTS;
        },
      );
    this.inflight.set(repoPath, promise);
    return promise;
  }

  private resolveForge(repoPath: string): ReturnType<typeof detectForge> {
    if (!this.forgeCache.has(repoPath)) {
      this.forgeCache.set(repoPath, detectForge(repoPath, this.forges));
    }
    return this.forgeCache.get(repoPath)!;
  }

  private async fetch(repoPath: string): Promise<RepoCounts> {
    const forge = this.resolveForge(repoPath);
    if (!forge) return NULL_COUNTS;

    if (forge.kind === "github") {
      return this.fetchGitHub(forge.slug!);
    }
    return this.fetchGitea(forge.slug!, repoPath);
  }

  private async fetchGitHub(slug: string): Promise<RepoCounts> {
    const [owner, name] = slug.split("/");
    const out = await this.run([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-f",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN, first:100){ totalCount nodes{ author{login} title headRefName labels(first:10){nodes{name}} } } defaultBranchRef{target{... on Commit{statusCheckRollup{state}}}}}}",
    ]);
    const json = JSON.parse(out) as {
      data?: {
        repository?: {
          issues?: { totalCount?: number };
          pullRequests?: {
            totalCount?: number;
            nodes?: Array<{
              author?: { login?: string } | null;
              title?: string;
              headRefName?: string;
              labels?: { nodes?: Array<{ name?: string } | null> } | null;
            } | null>;
          };
          defaultBranchRef?: {
            target?: { statusCheckRollup?: { state?: string } | null } | null;
          } | null;
        };
      };
    };
    const repo = json.data?.repository;
    const issues = repo?.issues?.totalCount;
    const prs = repo?.pullRequests?.totalCount;
    const openPRs = typeof prs === "number" ? prs : null;

    // Open-PR breakdown for the repo-list row. We fetch only the first 100 open
    // PRs (one page — no extra request); each node is classified once. `regular`
    // is derived from the authoritative `totalCount` minus the bot kinds (clamped
    // at 0), NOT by counting "regular" nodes — so a repo with >100 open PRs
    // classifies the first page and its unfetched tail safely falls into
    // `regular` rather than silently vanishing.
    let prKinds: RepoCounts["prKinds"] = null;
    if (openPRs !== null) {
      const kinds = (repo?.pullRequests?.nodes ?? [])
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map((n) =>
          classifyPr({
            author: n.author?.login ?? "",
            title: n.title ?? "",
            headRefName: n.headRefName ?? undefined,
            labels: (n.labels?.nodes ?? [])
              .map((l) => l?.name)
              .filter((name): name is string => !!name),
          }),
        );
      const release = kinds.filter((k) => k === "release").length;
      const dependabot = kinds.filter((k) => k === "dependabot").length;
      prKinds = { release, dependabot, regular: Math.max(0, openPRs - release - dependabot) };
    }

    return {
      openIssues: typeof issues === "number" ? issues : null,
      openPRs,
      ciStatus: mapRollupState(repo?.defaultBranchRef?.target?.statusCheckRollup?.state),
      prKinds,
    };
  }

  private async fetchGitea(slug: string, repoPath: string): Promise<RepoCounts> {
    const url = originUrl(repoPath);
    if (!url) return NULL_COUNTS;
    const remote = parseRemote(url);
    if (!remote) return NULL_COUNTS;

    const cfg = this.forges[remote.host] ?? {};
    const base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cfg.token) headers.Authorization = `token ${cfg.token}`;

    const res = await this.fetchFn(`${base}/api/v1/repos/${slug}`, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gitea GET /api/v1/repos/${slug} → ${res.status}: ${text}`);
    }
    const data = (await res.json()) as {
      open_issues_count?: number;
      open_pr_counter?: number;
    };
    return {
      openIssues: typeof data.open_issues_count === "number" ? data.open_issues_count : null,
      openPRs: typeof data.open_pr_counter === "number" ? data.open_pr_counter : null,
      ciStatus: null,
      prKinds: null,
    };
  }
}
