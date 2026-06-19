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
 *  - `forgeCache`: the existing detectForge memoization (git shell-out is
 *    expensive — once per path is enough for forge repos).
 */
export function makeForgeResolver(deps: ForgeResolverDeps): (dir: string) => GitForge | null {
  const localForgeCache = new Map<string, LocalForge>();
  const forgeCache = new Map<string, GitForge | null>();

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

    // forge mode — memoized detectForge
    if (!forgeCache.has(dir)) {
      forgeCache.set(dir, deps.detectForge(dir));
    }
    return forgeCache.get(dir) ?? null;
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
