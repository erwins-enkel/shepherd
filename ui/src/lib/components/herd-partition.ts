import type { Session, GitState } from "$lib/types";
import { isMerging } from "./merge-train";

/** Split sessions into stage groups, preserving input order within each:
 *  - active: still in play, no later stage reached
 *  - ciRunning: open PR with CI checks in flight (`open` + `pending`)
 *  - ciFailed: open PR whose CI checks failed (`open` + `failure`) — done, needs a look
 *  - reviewerRunning: a critic run is in flight for the session
 *  - waitingOnReviewer / waitingOnMerger: same open+green+handed-off point as
 *    awaitingMerge, but `.shepherd/roles.json` names someone *other* than the
 *    operator as the reviewer (not yet approved) or merger. The server stamps
 *    `git.handoff` so the herd can say "waiting on scoop" instead of "your turn".
 *  - awaitingMerge: open PR, CI green (`open` + `success`) AND the agent is not actively
 *    in the loop (status not `running` and not `blocked`) — handed off, waiting on a
 *    human (repo owner) to merge. Distinct from `ready`, which is operator-flagged. An
 *    agent still in the loop is NOT handed off — e.g. mid auto-correct after a critic
 *    steered findings back (with the PR's green CI now stale), or blocked awaiting
 *    operator input — so it stays in `active` rather than flicker into "waiting for
 *    merge" / get buried when it actually needs attention. When `git.handoff` names
 *    a foreign reviewer/merger, the session lands in the waiting-on-* group instead.
 *  - merging: PR-sessions a launched merge train is working through (marked + within TTL)
 *  - ready: operator-parked "ready to merge"
 *  - merged: PR already landed
 *
 *  First-match precedence (terminal states win; reviewing beats the CI/merge stages
 *  as the later in-flight stage):
 *    merged > merging > ready > reviewerRunning > ciRunning > ciFailed > awaitingMerge > active.
 *  An open PR with `none` checks (no CI reported yet) stays in `active` to avoid
 *  flicker into the "Your turn" group before CI registers as pending.
 *  The groups render top→bottom as active → ciRunning → ciFailed → reviewerRunning →
 *  awaitingMerge → merging → ready → merged, mirroring the session lifecycle. `isReviewing` is
 *  injected so this stays a pure function (the caller wires it to the reviews store). */
/** Pick the bucket for a handed-off (open + green, idle) session: a foreign
 *  reviewer/merger named in `git.handoff` routes to its waiting group, else it's
 *  the operator's turn (`awaitingMerge`). */
function handedOff(
  g: GitState,
  buckets: { waitingOnReviewer: Session[]; waitingOnMerger: Session[]; awaitingMerge: Session[] },
): Session[] {
  if (g.handoff === "reviewer") return buckets.waitingOnReviewer;
  if (g.handoff === "merger") return buckets.waitingOnMerger;
  return buckets.awaitingMerge;
}

export function partitionSessions(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
  now: number = Date.now(),
): {
  active: Session[];
  ciRunning: Session[];
  ciFailed: Session[];
  reviewerRunning: Session[];
  waitingOnReviewer: Session[];
  waitingOnMerger: Session[];
  awaitingMerge: Session[];
  merging: Session[];
  ready: Session[];
  merged: Session[];
} {
  const active: Session[] = [];
  const ciRunning: Session[] = [];
  const ciFailed: Session[] = [];
  const reviewerRunning: Session[] = [];
  const waitingOnReviewer: Session[] = [];
  const waitingOnMerger: Session[] = [];
  const awaitingMerge: Session[] = [];
  const merging: Session[] = [];
  const ready: Session[] = [];
  const merged: Session[] = [];
  for (const s of sessions) {
    const g = git[s.id];
    if (g?.state === "merged") merged.push(s);
    else if (isMerging(s, now)) merging.push(s);
    else if (s.readyToMerge) ready.push(s);
    else if (isReviewing(s.id)) reviewerRunning.push(s);
    else if (g?.state === "open" && g.checks === "pending") ciRunning.push(s);
    else if (g?.state === "open" && g.checks === "failure") ciFailed.push(s);
    else if (
      g?.state === "open" &&
      g.checks === "success" &&
      s.status !== "running" &&
      s.status !== "blocked"
    ) {
      // The server stamps `handoff` when the repo's roles name someone other than
      // the operator: route to "waiting on <reviewer/merger>" instead of "your turn".
      handedOff(g, { waitingOnReviewer, waitingOnMerger, awaitingMerge }).push(s);
    } else active.push(s);
  }
  return {
    active,
    ciRunning,
    ciFailed,
    reviewerRunning,
    waitingOnReviewer,
    waitingOnMerger,
    awaitingMerge,
    merging,
    ready,
    merged,
  };
}
