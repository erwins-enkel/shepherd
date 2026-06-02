import type { Session, GitState } from "$lib/types";

/** Split sessions into stage groups, preserving input order within each:
 *  - active: still in play, no later stage reached
 *  - prRunning: open PR with CI checks in flight (`open` + `pending`)
 *  - reviewerRunning: a critic run is in flight for the session
 *  - ready: operator-parked "ready to merge"
 *  - merged: PR already landed
 *
 *  First-match precedence (terminal states win; reviewing beats PR-running as the
 *  later lifecycle stage): merged > ready > reviewerRunning > prRunning > active.
 *  The groups render top→bottom as active → prRunning → reviewerRunning → ready →
 *  merged, mirroring the session lifecycle. `isReviewing` is injected so this stays
 *  a pure function (the caller wires it to the reviews store). */
export function partitionSessions(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
): {
  active: Session[];
  prRunning: Session[];
  reviewerRunning: Session[];
  ready: Session[];
  merged: Session[];
} {
  const active: Session[] = [];
  const prRunning: Session[] = [];
  const reviewerRunning: Session[] = [];
  const ready: Session[] = [];
  const merged: Session[] = [];
  for (const s of sessions) {
    const g = git[s.id];
    if (g?.state === "merged") merged.push(s);
    else if (s.readyToMerge) ready.push(s);
    else if (isReviewing(s.id)) reviewerRunning.push(s);
    else if (g?.state === "open" && g.checks === "pending") prRunning.push(s);
    else active.push(s);
  }
  return { active, prRunning, reviewerRunning, ready, merged };
}
