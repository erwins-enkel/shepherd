/** Task dependencies (#2589): `shepherd new --after TASK-x` holds a task until TASK-x has LANDED.
 *
 *  Landed = its PR merged. Evidence, store-first like `deadBaseSession()` (src/dead-base.ts): the
 *  live PR snapshot says merged, or the session was archived as merged, or it is an epic child the
 *  drain already squash-merged into its integration branch (archived with reason "drain"). An
 *  archive without either never counts — the dependent keeps waiting for the operator. */
import type { GitState } from "./forge/types";
import type { SessionStore } from "./store";
import type { Session } from "./types";

export type TaskDepsStore = Pick<SessionStore, "get" | "isEpicIntegratedChild">;
export type PrSnapshot = (id: string) => Pick<GitState, "state"> | undefined;

export function predecessorLanded(store: TaskDepsStore, prGit: PrSnapshot, s: Session): boolean {
  if (prGit(s.id)?.state === "merged") return true;
  if (s.status !== "archived") return false;
  if (s.archiveReason === "merged") return true;
  return s.issueNumber != null && store.isEpicIntegratedChild(s.repoPath, s.issueNumber);
}

/** Release check for a held task's predecessor. A missing row means it was pruned — only archived
 *  rows ever are, long after the fact — so nothing will ever change: release rather than wait
 *  forever. */
export function afterGateOpen(
  store: TaskDepsStore,
  prGit: PrSnapshot,
  afterSessionId: string | undefined,
): boolean {
  if (!afterSessionId) return true;
  const s = store.get(afterSessionId);
  if (!s) {
    console.log(`[held] predecessor ${afterSessionId} is gone — releasing its dependent`);
    return true;
  }
  return predecessorLanded(store, prGit, s);
}
