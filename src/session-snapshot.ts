import type { Session } from "./types";
import type { GitState } from "./forge/types";

/** The shared per-session view for a status/git event — the single `store.get(id)`
 *  result, handed to every consumer so they don't each re-fetch the trigger row.
 *  Deliberately minimal: consumers read repoPath (to pump) and the session row
 *  (auto flag, planPhase, reapMerged). Review/activity are NOT here — they are read
 *  inside drain's buildState / autopilot's internal getReview, never at the seam. */
export interface SessionSnapshot {
  id: string;
  repoPath: string;
  session: Session;
}

/** A routed change. The event payload (status string / git state) rides the change;
 *  the snapshot carries the shared session view. */
export type SessionStateChange =
  | { kind: "status"; status: string; snapshot: SessionSnapshot }
  | { kind: "git"; git: GitState; snapshot: SessionSnapshot };

/** Accessors the builder needs. Single-method so tests pass a trivial fake. */
export interface SnapshotAccessors {
  getSession: (id: string) => Session | null;
}

export type ChangePayload = { kind: "status"; status: string } | { kind: "git"; git: GitState };

/** Build the shared view for a change. Returns null when the session is unknown
 *  (e.g. already pruned) — the caller then skips dispatch entirely. */
export function buildSnapshot(
  acc: SnapshotAccessors,
  id: string,
  payload: ChangePayload,
): SessionStateChange | null {
  const session = acc.getSession(id);
  if (session === null) return null;
  const snapshot: SessionSnapshot = { id, repoPath: session.repoPath, session };
  if (payload.kind === "status") {
    return { kind: "status", status: payload.status, snapshot };
  }
  return { kind: "git", git: payload.git, snapshot };
}
