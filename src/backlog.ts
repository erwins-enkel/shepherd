import { readdirSync } from "node:fs";
import { join } from "node:path";
import { detectForge } from "./forge";
import { makeForgeMemo } from "./forge/resolve";
import { COUNTS_BATCH_SIZE, listBacklogCountsBatch, type GhRunner } from "./forge/github";
import { EMPTY_BACKLOG_COUNTS } from "./forge/types";
import type { ForgeMap, GitForge, RepoCounts } from "./forge/types";
import { Semaphore } from "./semaphore";
import type { GithubCacheEntry, GithubReadCache } from "./github-read-cache";

// RepoCounts now lives with the GitForge seam (each adapter returns it); re-export
// so existing importers (backlog-poller, server) keep their "./backlog" path. (CiStatus
// is exported from forge/types.ts directly — backlog.ts no longer has a consumer for it.)
export type { RepoCounts } from "./forge/types";

type CacheEntry = GithubCacheEntry<RepoCounts> & { negative?: boolean; revision?: number };

/** Read TTL. Must outlive BacklogPoller's cold cadence (15 min, #2656): a cold repo is
 *  re-warmed that rarely, and a shorter TTL would make every backlog broadcast and GET
 *  re-fetch it on the request path anyway — undoing the tiering. Hot repos are rewritten
 *  every warm tick, so they never get near it. */
const TTL_MS = 20 * 60_000;
const FAILURE_TTL_MS = 30_000;

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
  /** Single-flight: forge slug (or repoPath when none) → in-flight Promise. */
  private readonly inflight = new Map<string, Promise<RepoCounts>>();
  /** Bounds simultaneous fetches across both the request path and the warmer. */
  private readonly gate: Semaphore;
  private readonly revisions = new Map<string, number>();
  private readonly pending: PendingFetch[] = [];

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
    private readonly readCache?: GithubReadCache,
  ) {
    this.gate = new Semaphore(maxConcurrency);
    // Resolve adapters with OUR runner/fetch so the counts call (forge.listBacklogCounts)
    // uses them instead of the adapter's built-in defaults — load-bearing for both the
    // injected test fakes and production's untimed runner.
    this.resolveForgeCached = makeForgeMemo(
      (dir) =>
        detectForge(dir, this.forges, {
          ghRunner: this.run,
          fetchFn: this.fetchFn,
          githubCache: this.readCache,
        }),
      forgeMemoOpts,
    );
  }

  /**
   * Synchronous cache-only peek — returns the last cached value for `repoPath` (regardless
   * of TTL freshness) or null when nothing has been cached yet. Never triggers a fetch, so
   * a caller on the event loop can read the kept-warm cache without an async forge
   * round-trip. The backlog poller keeps these warm.
   */
  peek(repoPath: string): RepoCounts | null {
    return this.entry(repoPath)?.value ?? null;
  }

  /** Read-through: serve a TTL-fresh cached value, else load it. */
  async counts(repoPath: string, trigger = "read-through"): Promise<RepoCounts> {
    const entry = this.entry(repoPath);
    const slug = this.githubSlug(repoPath);
    const fpKey = slug ? this.readCache?.contentKey("counts", slug) : null;
    if (entry && fpKey != null && entry.contentKey === fpKey) {
      if (this.readCache?.expired(entry) && this.readCache.canRefresh())
        void this.load(repoPath, true, trigger);
      return entry.value;
    }
    if (entry && fpKey == null && this.now() - entry.at < TTL_MS) return entry.value;
    return this.load(repoPath, false, trigger);
  }

  private now(): number {
    return this.readCache?.now() ?? Date.now();
  }

  private githubSlug(repoPath: string): string | null {
    if (!this.readCache || this.getRepoConfig?.(repoPath)?.repoMode === "lightweight") return null;
    const forge = this.resolveForgeCached(repoPath);
    return forge?.kind === "github" ? forge.slug : null;
  }

  private entry(repoPath: string): CacheEntry | null {
    const slug = this.githubSlug(repoPath);
    const entry = this.cache.get(slug ?? repoPath);
    if (slug && this.readCache) {
      if (
        entry?.negative &&
        this.now() - entry.at < FAILURE_TTL_MS &&
        entry.revision === this.readCache.revision(slug) &&
        entry.contentKey === this.readCache.contentKey("counts", slug)
      )
        return entry;
      return this.readCache.get("counts", slug);
    }
    return entry ?? null;
  }

  /**
   * Restamp an existing entry as fresh without a fetch — for a repo whose fingerprint was just
   * seen unchanged (#2756), so its counts don't expire into a request-path re-fetch. No-op
   * when nothing is cached yet.
   */
  touch(repoPath: string): void {
    if (this.githubSlug(repoPath)) return; // fetchedAt must keep the 24h safety bound
    const entry = this.cache.get(repoPath);
    if (entry) entry.at = this.now();
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
  async refresh(repoPath: string, trigger = "refresh"): Promise<RepoCounts> {
    return this.load(repoPath, true, trigger);
  }

  private load(
    repoPath: string,
    preserveOnError = false,
    trigger = "unknown",
  ): Promise<RepoCounts> {
    const slug = this.githubSlug(repoPath);
    // Two local clones of one GitHub repo share one fetch: key by slug, fall back to path.
    const key = slug ?? repoPath;
    const revision = slug ? this.readCache?.revision(slug) : undefined;
    if (slug) {
      if (revision !== this.revisions.get(key)) this.inflight.delete(key);
      this.revisions.set(key, revision ?? 0);
    }
    const fpKey = slug ? (this.readCache?.contentKey("counts", slug) ?? null) : null;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.fetch(repoPath, trigger).then(
      (v) => {
        if (
          this.inflight.get(key) === promise &&
          (!slug || revision === this.readCache?.revision(slug))
        ) {
          this.cache.set(key, { at: this.now(), value: v, contentKey: fpKey });
          if (slug) this.readCache?.put("counts", slug, fpKey, v);
          this.inflight.delete(key);
        }
        return v;
      },
      () => {
        const current =
          this.inflight.get(key) === promise &&
          (!slug || revision === this.readCache?.revision(slug));
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
        const prev = this.entry(repoPath);
        if (preserveOnError && prev && !slug) return prev.value;
        const value = preserveOnError && prev ? prev.value : NULL_COUNTS;
        if (current)
          this.cache.set(key, {
            at: this.now(),
            value,
            contentKey: fpKey,
            ...(slug ? { negative: true, revision } : {}),
          });
        return value;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  private async fetch(repoPath: string, trigger: string): Promise<RepoCounts> {
    // Lightweight repos have no remote forge — skip counts regardless of origin URL.
    // Read repoMode per call so a runtime toggle propagates without a restart. (This is
    // a config gate, NOT a forge-kind check: detectForge still yields a GithubForge for a
    // lightweight github-origin repo, so we must short-circuit before resolving.)
    if (this.getRepoConfig?.(repoPath)?.repoMode === "lightweight") return NULL_COUNTS;

    const forge = this.resolveForgeCached(repoPath);
    if (!forge) return NULL_COUNTS;
    if (forge.kind === "github" && forge.slug) return this.batched(forge, trigger);

    // Each adapter answers in its own way (Gitea REST / Local null).
    return this.gate.run(() => forge.listBacklogCounts());
  }

  /** GitHub fetches requested in the same tick are collected and sent as aliased queries of up
   *  to {@link COUNTS_BATCH_SIZE} repos (#2879); a lone repo, or one the batch could not answer,
   *  uses its own query. */
  private batched(forge: GitForge, trigger: string): Promise<RepoCounts> {
    return new Promise((resolve, reject) => {
      this.pending.push({ forge, trigger, resolve, reject });
      if (this.pending.length === 1) setTimeout(() => this.flush(), 0);
    });
  }

  private flush(): void {
    const items = this.pending.splice(0);
    if (items.length > 1) {
      const by = new Map<string, number>();
      for (const i of items) by.set(i.trigger, (by.get(i.trigger) ?? 0) + 1);
      const who = [...by].map(([t, n]) => `${t}×${n}`).join(", ");
      console.log(`[backlog] counts refresh: ${items.length} repos (${who})`);
    }
    for (let i = 0; i < items.length; i += COUNTS_BATCH_SIZE)
      void this.runBatch(items.slice(i, i + COUNTS_BATCH_SIZE));
  }

  private async runBatch(items: PendingFetch[]): Promise<void> {
    let result = new Map<string, RepoCounts>();
    if (items.length > 1) {
      try {
        result = await this.gate.run(() =>
          listBacklogCountsBatch(
            this.run,
            items.map((i) => i.forge.slug as string),
          ),
        );
      } catch {
        // fall through to per-repo queries
      }
    }
    await Promise.all(
      items.map(async (i) => {
        const hit = result.get(i.forge.slug as string);
        if (hit) return i.resolve(hit);
        try {
          i.resolve(await this.gate.run(() => i.forge.listBacklogCounts()));
        } catch (err) {
          i.reject(err);
        }
      }),
    );
  }
}

interface PendingFetch {
  forge: GitForge;
  trigger: string;
  resolve: (v: RepoCounts) => void;
  reject: (e: unknown) => void;
}
