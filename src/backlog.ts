import { readdirSync } from "node:fs";
import { join } from "node:path";
import { detectForge } from "./forge";
import { makeForgeMemo } from "./forge/resolve";
import type { GhRunner } from "./forge/github";
import { EMPTY_BACKLOG_COUNTS } from "./forge/types";
import type { ForgeMap, GitForge, RepoCounts } from "./forge/types";
import { Semaphore } from "./semaphore";

// RepoCounts now lives with the GitForge seam (each adapter returns it); re-export
// so existing importers (backlog-poller, server) keep their "./backlog" path. (CiStatus
// is exported from forge/types.ts directly — backlog.ts no longer has a consumer for it.)
export type { RepoCounts } from "./forge/types";

interface CacheEntry {
  at: number;
  value: RepoCounts;
}

const TTL_MS = 120_000;

/**
 * Cap on simultaneous count fetches. The async runner made the per-repo `gh`
 * calls fan out — without a ceiling a large repo root would spawn one `gh`
 * subprocess per repo at once (on the request path *and* every poller tick),
 * risking GitHub secondary rate limits / process pressure. A small cap keeps
 * most of the parallel speedup without the unbounded burst.
 */
const DEFAULT_MAX_CONCURRENCY = 6;

const NULL_COUNTS = EMPTY_BACKLOG_COUNTS;

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

export class CountsService {
  /** Forge resolver: positives cached for the process lifetime, negatives (e.g. a repo
   *  whose `origin` is added later) re-probed after a TTL so they self-heal without a
   *  restart (#1023). Built in the ctor so `now`/TTL can be injected for tests. */
  private readonly resolveForgeCached: (repoPath: string) => GitForge | null;
  /** TTL read-through cache: repoPath → {at, value}. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Single-flight: repoPath → in-flight Promise. */
  private readonly inflight = new Map<string, Promise<RepoCounts>>();
  /** Bounds simultaneous fetches across both the request path and the warmer. */
  private readonly gate: Semaphore;

  constructor(
    private readonly forges: ForgeMap,
    /** `gh` runner forwarded to the resolved GitHub adapter (production: an untimed
     *  async runner so per-repo GraphQL counts fan out in parallel; tests: a fake). */
    private readonly run: GhRunner,
    private readonly fetchFn: typeof fetch = fetch,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    /** Optional: when provided, lightweight repos are treated as not-forge-backed.
     *  Read per call so a runtime repoMode toggle propagates without a restart. */
    private readonly getRepoConfig?: (repoPath: string) => { repoMode: string },
    /** Optional clock-seam injection for the negative-forge re-probe TTL (tests only). */
    forgeMemoOpts?: { negativeTtlMs?: number; now?: () => number },
  ) {
    this.gate = new Semaphore(maxConcurrency);
    // Resolve adapters with OUR runner/fetch so the counts call (forge.listBacklogCounts)
    // uses them instead of the adapter's built-in defaults — load-bearing for both the
    // injected test fakes and production's untimed runner.
    this.resolveForgeCached = makeForgeMemo(
      (dir) => detectForge(dir, this.forges, { ghRunner: this.run, fetchFn: this.fetchFn }),
      forgeMemoOpts,
    );
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

  private async fetch(repoPath: string): Promise<RepoCounts> {
    // Lightweight repos have no remote forge — skip counts regardless of origin URL.
    // Read repoMode per call so a runtime toggle propagates without a restart. (This is
    // a config gate, NOT a forge-kind check: detectForge still yields a GithubForge for a
    // lightweight github-origin repo, so we must short-circuit before resolving.)
    if (this.getRepoConfig?.(repoPath)?.repoMode === "lightweight") return NULL_COUNTS;

    const forge = this.resolveForgeCached(repoPath);
    if (!forge) return NULL_COUNTS;

    // Each adapter answers in its own way (GitHub GraphQL / Gitea REST / Local null).
    return forge.listBacklogCounts();
  }
}
