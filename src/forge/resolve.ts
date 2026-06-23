import type { GitForge, ForgeMap } from "./types";
import type { SessionStore } from "../store";
import { LocalForge } from "./local";
import { detectForge } from ".";

/** Minimal store slice `makeProductionForgeResolver` needs — injectable for tests. */
export type ForgeResolverStore = Pick<
  SessionStore,
  "getRepoConfig" | "ensureLocalPr" | "getLocalPr" | "getLocalPrByNumber" | "markLocalPrMerged"
>;

/** Deps injected into makeForgeResolver — split out so tests can stub them. */
export interface ForgeResolverDeps {
  getRepoConfig: (dir: string) => { repoMode: "forge" | "lightweight" };
  detectForge: (dir: string) => GitForge | null;
  makeLocalForge: (dir: string) => LocalForge;
}

/** Default window before a negative (null) forge result is re-probed. */
const DEFAULT_NEGATIVE_TTL_MS = 30_000;

/**
 * Memoize `detect(dir)` with **asymmetric** caching:
 *  - **Positive** results (a real forge) are cached for the process lifetime — a
 *    detected forge identity never changes for a given dir, and the `git` shell-out
 *    is expensive, so once per path is enough.
 *  - **Negative** results (null — e.g. a repo seen before its `origin` remote was
 *    added) are cached only for `negativeTtlMs`, then re-probed. This is the #1023
 *    fix: a permanent negative cache left a later `git remote add origin` invisible
 *    until a process restart. We do NOT re-probe on literally every miss (that would
 *    add a recurring synchronous git shell-out to poll paths like
 *    `backlog-poller.isForgeBacked`, which runs the resolver for every repo each
 *    tick); the TTL bounds re-probes to at most once per window per dir while still
 *    self-healing on the next poll after a remote appears.
 *
 * `now` is injectable purely so tests can drive the TTL deterministically.
 *
 * Note: positive caching is intentionally permanent — a dir that *later* gains a
 * differing-slug `upstream` remote (the fork topology `detectForge` re-targets to)
 * will not re-target without a restart. Pre-existing behavior, out of scope for #1023.
 */
export function makeForgeMemo(
  detect: (dir: string) => GitForge | null,
  opts: { negativeTtlMs?: number; now?: () => number } = {},
): (dir: string) => GitForge | null {
  const positive = new Map<string, GitForge>();
  const negativeAt = new Map<string, number>();
  const ttl = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const now = opts.now ?? Date.now;

  return (dir: string): GitForge | null => {
    const hit = positive.get(dir);
    if (hit) return hit;

    const at = negativeAt.get(dir);
    if (at !== undefined && now() - at < ttl) return null;

    const f = detect(dir);
    if (f) {
      positive.set(dir, f);
      negativeAt.delete(dir);
      return f;
    }
    negativeAt.set(dir, now());
    return null;
  };
}

/**
 * Build the mode-aware `resolveForge` closure used in src/index.ts.
 *
 * Per-call repoMode read (cheap PK lookup) means a runtime toggle propagates
 * immediately — no restart required:
 *  - "lightweight" → returns a cached LocalForge instance for `dir`
 *  - "forge" (or absent) → returns the memoized detectForge result for `dir`
 *
 * Two separate caches keep the invariants clean:
 *  - `localForgeCache`: reuse the LocalForge instance across calls while the
 *    repo stays in lightweight mode. If the mode flips to "forge", the local
 *    entry is simply skipped; if it flips back, the same instance is reused.
 *  - `forgeMemo`: detectForge memoization — positives cached for the process
 *    lifetime, negatives re-probed after a TTL (see `makeForgeMemo`).
 */
export function makeForgeResolver(deps: ForgeResolverDeps): (dir: string) => GitForge | null {
  const localForgeCache = new Map<string, LocalForge>();
  const forgeMemo = makeForgeMemo(deps.detectForge);

  return (dir: string): GitForge | null => {
    const { repoMode } = deps.getRepoConfig(dir);

    if (repoMode === "lightweight") {
      let local = localForgeCache.get(dir);
      if (!local) {
        local = deps.makeLocalForge(dir);
        localForgeCache.set(dir, local);
      }
      return local;
    }

    // forge mode — memoized detectForge (positives permanent, negatives TTL-bounded)
    return forgeMemo(dir);
  };
}

/**
 * Wire `makeForgeResolver` for production use (index.ts).
 * Returns the same `(dir) => GitForge | null` shape the rest of the app expects.
 */
export function makeProductionForgeResolver(
  store: ForgeResolverStore,
  forges: ForgeMap,
): (dir: string) => GitForge | null {
  return makeForgeResolver({
    getRepoConfig: (dir) => store.getRepoConfig(dir),
    detectForge: (dir) => detectForge(dir, forges),
    makeLocalForge: (dir) =>
      new LocalForge(dir, {
        ensureLocalPr: store.ensureLocalPr.bind(store),
        getLocalPr: store.getLocalPr.bind(store),
        getLocalPrByNumber: store.getLocalPrByNumber.bind(store),
        markLocalPrMerged: store.markLocalPrMerged.bind(store),
      }),
  });
}
