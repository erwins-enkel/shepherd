import type { GitForge } from "./forge/types";
import type { Session } from "./types";

export interface MergeTeardownDeps {
  resolveForge: (repoPath: string) => GitForge | null;
  /** service.archive */
  archive: (id: string) => Promise<number>;
  /** prPoller.drop */
  dropPrCache: (id: string) => void;
  /** events.emit("session:archived", {id}) */
  emitArchived: (id: string) => void;
  /** Mark the session so onArchived KEEPS its claim label (issue still open). */
  retainClaim: (id: string) => void;
}

/**
 * Settle a session whose PR has merged (out-of-band OR by the merge train): close its
 * backlog issue, archive the session, drop the pr-cache, and emit archived. Best-effort:
 * the merge is already done, so a close failure must not block teardown — instead we
 * RETAIN the claim (issue still open → its label is what stops a re-spawn). Manual
 * sessions (no issue) skip the close/claim entirely.
 */
export async function settleMergedSession(s: Session, deps: MergeTeardownDeps): Promise<void> {
  let closed = false;
  if (s.auto && s.issueNumber != null) {
    const forge = deps.resolveForge(s.repoPath);
    // Gate on the method existing: a forge without closeIssue leaves the issue
    // OPEN, so we must not treat it as closed (see the claim-retain note below).
    if (forge?.closeIssue) {
      try {
        await forge.closeIssue(s.issueNumber);
        closed = true;
      } catch (err) {
        console.warn(`[merge] closeIssue #${s.issueNumber} failed for ${s.id}:`, err);
      }
    }
    // The issue closed → its claim is moot, so let onArchived drop the now-stale
    // label. If it did NOT close (close failed, or no closeIssue method), retain
    // the claim: the issue is still open and merged, so the label is what stops
    // any instance re-spawning already-merged work.
    if (!closed) deps.retainClaim(s.id);
  }
  await deps.archive(s.id);
  deps.dropPrCache(s.id);
  deps.emitArchived(s.id);
}
