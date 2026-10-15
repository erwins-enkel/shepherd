/** Is a pull request's base branch already DEAD — the head of a Shepherd session whose own PR
 *  already merged? (#3102)
 *
 *  Merging into such a branch lands the work nowhere anyone reads: the branch has already been
 *  squashed into its own base and nothing will merge it again. That is how aetherial's M0 epic
 *  lost #63/#64/#67/#69 — each manually merged into a landed sibling's branch. The manual merge
 *  endpoints refuse it and name the branch to re-target onto.
 *
 *  Store-only, so the guard costs no forge call. Narrowed to Shepherd session branches on purpose:
 *  "the head of some merged PR" would also match long-lived branches (`develop` merged into
 *  `main` by a release PR) that are very much alive. */
import { epicParentFromBranch } from "./epic-branch";
import type { SessionStore } from "./store";

export interface DeadBase {
  /** The branch the dead base itself merged into — what to re-target onto. */
  mergedInto: string;
}

export function deadBaseSession(
  store: Pick<SessionStore, "list" | "isEpicIntegratedChild" | "getEpicIntegrationBranch">,
  repoPath: string,
  base: string | null | undefined,
): DeadBase | null {
  if (!base) return null;
  for (const s of store.list()) {
    if (s.repoPath !== repoPath || s.branch !== base || s.status !== "archived") continue;
    const integrated =
      s.issueNumber != null && store.isEpicIntegratedChild(repoPath, s.issueNumber);
    if (integrated) {
      const parent = s.epicParent ?? epicParentFromBranch(s.baseBranch);
      const pinned = parent != null ? store.getEpicIntegrationBranch(repoPath, parent) : null;
      return { mergedInto: pinned ?? s.baseBranch };
    }
    if (s.archiveReason === "merged") return { mergedInto: s.baseBranch };
  }
  return null;
}
