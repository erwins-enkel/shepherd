import type { Session } from "./types";
import type { PrCache } from "./pr-poller";
import type { GitForge } from "./forge/types";

export interface ResolvedBase {
  /** The base branch to diff against. */
  base: string;
  /** True when `base` is authoritative — a PR's `baseRefName`, or a definitive "no PR
   *  exists" — and false when we fell back to `session.baseBranch` because the PR base
   *  was momentarily unknowable (on-demand `gh` failed / forge unreachable). The diff
   *  endpoints use `base` regardless; only the recap dedup consults `resolved` (so a
   *  transient fallback can't flip the dedup key and re-fire a billed recap spawn). */
  resolved: boolean;
}

/**
 * Resolve the base branch a session's diff should compare against: prefer the PR's
 * actual target (`baseRefName`) so the diff matches the PR's "Files changed" even when
 * it targets a non-default branch, falling back to the session's stored `baseBranch`.
 *
 * Order: warm prCache → definitive cached "no PR" → on-demand `prStatus` (cold/evicted
 * cache) → `session.baseBranch`. Only a PR base or a definitive no-PR is `resolved:true`;
 * a transient miss (gh failure / unreachable forge) yields the `baseBranch` fallback with
 * `resolved:false`.
 */
export async function resolveDiffBase(
  session: Pick<Session, "id" | "baseBranch" | "branch" | "repoPath">,
  prCache?: Pick<PrCache, "get">,
  resolveForge?: (repoDir: string) => GitForge | null,
): Promise<ResolvedBase> {
  const cached = prCache?.get(session.id);
  if (cached?.baseRefName) return { base: cached.baseRefName, resolved: true };
  if (cached && cached.state === "none") return { base: session.baseBranch, resolved: true };

  if (session.branch && resolveForge) {
    try {
      // resolveForge can shell out to git (cold cache) and prStatus shells out to gh; both can
      // throw. Keep the whole thing in try so this never throws out of a caller (e.g. the recap
      // archive hook) — a failure is simply non-authoritative.
      const forge = resolveForge(session.repoPath);
      if (forge) {
        const st = await forge.prStatus(session.branch);
        if (st.baseRefName) return { base: st.baseRefName, resolved: true };
        if (st.state === "none") return { base: session.baseBranch, resolved: true };
      }
    } catch {
      // transient gh/forge failure — not authoritative; fall through to the stored base.
    }
  }

  return { base: session.baseBranch, resolved: false };
}
