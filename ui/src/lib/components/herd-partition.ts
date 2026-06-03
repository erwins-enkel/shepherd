import type { Session, GitState } from "$lib/types";

/** Split sessions into stage groups, preserving input order within each:
 *  - active: still in play, no later stage reached
 *  - ciRunning: open PR with CI checks in flight (`open` + `pending`)
 *  - ciFailed: open PR whose CI checks failed (`open` + `failure`) — done, needs a look
 *  - reviewerRunning: a critic run is in flight for the session
 *  - awaitingMerge: open PR, CI green (`open` + `success`) — handed off, waiting on a
 *    human (repo owner) to merge. Distinct from `ready`, which is operator-flagged.
 *  - ready: operator-parked "ready to merge"
 *  - merged: PR already landed
 *
 *  First-match precedence (terminal states win; reviewing beats the CI/merge stages
 *  as the later in-flight stage):
 *    merged > ready > reviewerRunning > ciRunning > ciFailed > awaitingMerge > active.
 *  An open PR with `none` checks (no CI reported yet) stays in `active` to avoid
 *  flicker into the "Your turn" group before CI registers as pending.
 *  The groups render top→bottom as active → ciRunning → ciFailed → reviewerRunning →
 *  awaitingMerge → ready → merged, mirroring the session lifecycle. `isReviewing` is
 *  injected so this stays a pure function (the caller wires it to the reviews store). */
export function partitionSessions(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
): {
  active: Session[];
  ciRunning: Session[];
  ciFailed: Session[];
  reviewerRunning: Session[];
  awaitingMerge: Session[];
  ready: Session[];
  merged: Session[];
} {
  const active: Session[] = [];
  const ciRunning: Session[] = [];
  const ciFailed: Session[] = [];
  const reviewerRunning: Session[] = [];
  const awaitingMerge: Session[] = [];
  const ready: Session[] = [];
  const merged: Session[] = [];
  for (const s of sessions) {
    const g = git[s.id];
    if (g?.state === "merged") merged.push(s);
    else if (s.readyToMerge) ready.push(s);
    else if (isReviewing(s.id)) reviewerRunning.push(s);
    else if (g?.state === "open" && g.checks === "pending") ciRunning.push(s);
    else if (g?.state === "open" && g.checks === "failure") ciFailed.push(s);
    else if (g?.state === "open" && g.checks === "success") awaitingMerge.push(s);
    else active.push(s);
  }
  return { active, ciRunning, ciFailed, reviewerRunning, awaitingMerge, ready, merged };
}
