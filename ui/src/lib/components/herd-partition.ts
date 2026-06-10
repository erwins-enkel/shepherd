import type { Session, GitState } from "$lib/types";
import { displayStatus } from "$lib/display-status";
import { isMerging } from "./merge-train";

/** Split sessions into stage groups, preserving input order within each:
 *  - active: still in play, no later stage reached
 *  - ciRunning: open PR with CI checks in flight (`open` + `pending`)
 *  - ciFailed: open PR whose CI checks failed (`open` + `failure`) — done, needs a look
 *  - reviewerRunning: a critic run is in flight for the session
 *  - draftAwaitingSignoff: open DRAFT PR, CI green (`open` + `success` + `isDraft`) AND
 *    the agent is not actively in the loop — parked, awaiting human sign-off before merge.
 *    Never reads as the green "Your turn" state; rendered in slate (parked, not actionable).
 *  - waitingOnReviewer / waitingOnMerger: same open+green+handed-off point as
 *    awaitingMerge, but `.shepherd/roles.json` names someone *other* than the
 *    operator as the reviewer (not yet approved) or merger. The server stamps
 *    `git.handoff` so the herd can say "waiting on scoop" instead of "your turn".
 *  - awaitingMerge: open non-draft PR, CI green (`open` + `success`) AND the agent is not
 *    actively in the loop (status not `running` and not `blocked`) — handed off, waiting on
 *    a human (repo owner) to merge. Distinct from `ready`, which is operator-flagged. An
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
 *    merged > merging > ready > reviewerRunning > ciRunning > ciFailed >
 *    draftAwaitingSignoff > (waitingOnReviewer | waitingOnMerger | awaitingMerge) > active.
 *  A draft outranks the handed-off groups: a green idle DRAFT is awaiting sign-off
 *  regardless of who the roles file names. An open PR with `none` checks (no CI reported
 *  yet) stays in `active` to avoid flicker into the "Your turn" group before CI registers
 *  as pending. The groups render top→bottom as active → ciRunning → ciFailed →
 *  reviewerRunning → waitingOnReviewer → waitingOnMerger → draftAwaitingSignoff →
 *  awaitingMerge → merging → ready → merged (Herd.svelte's template order, mirrored
 *  by herd-keynav's RAIL_GROUP_ORDER), tracking the session lifecycle. `isReviewing`
 *  is injected so this stays a pure function (the caller wires it to the reviews store). */
type Stage =
  | "merged"
  | "merging"
  | "ready"
  | "reviewerRunning"
  | "ciRunning"
  | "ciFailed"
  | "draftAwaitingSignoff"
  | "waitingOnReviewer"
  | "waitingOnMerger"
  | "awaitingMerge"
  | "active";

/** The herd rail's list filter: everything, or only sessions awaiting the operator. */
export type HerdFilter = "all" | "ready";

/** The sessions the rail actually lists under `filter` — "ready" keeps only sessions
 *  awaiting the operator (not running, not under review). Single source of truth shared
 *  by Herd.svelte's list and herd-keynav's rail order, so keyboard navigation can never
 *  land on a row the rail isn't showing. Goes through `displayStatus` (a working-while-
 *  blocked session is actually mid-turn, so it is NOT awaiting the operator). */
export function shownSessions(
  sessions: Session[],
  filter: HerdFilter,
  inReview: (id: string) => boolean,
  workingBlocked: Record<string, boolean> = {},
): Session[] {
  return filter === "ready"
    ? sessions.filter((s) => displayStatus(s, workingBlocked) !== "running" && !inReview(s.id))
    : sessions;
}

/** Terminal / in-flight stages that win before the green-idle handoff decision, or null
 *  when none apply (the session is then either active or handed off). Split out of stageOf
 *  to keep each branch-set small. */
function terminalStage(
  s: Session,
  g: GitState | undefined,
  isReviewing: (id: string) => boolean,
  now: number,
): Stage | null {
  if (g?.state === "merged") return "merged";
  if (isMerging(s, now)) return "merging";
  if (s.readyToMerge) return "ready";
  if (isReviewing(s.id)) return "reviewerRunning";
  if (g?.state === "open" && g.checks === "pending") return "ciRunning";
  if (g?.state === "open" && g.checks === "failure") return "ciFailed";
  return null;
}

/** Bucket a green, idle (handed-off) PR: a draft awaits sign-off; otherwise a foreign
 *  reviewer/merger named in `git.handoff` routes to its waiting group, else it's the
 *  operator's turn (`awaitingMerge`). */
function handoffStage(g: GitState): Stage {
  if (g.isDraft) return "draftAwaitingSignoff";
  if (g.handoff === "reviewer") return "waitingOnReviewer";
  if (g.handoff === "merger") return "waitingOnMerger";
  return "awaitingMerge";
}

/** Classify ONE session into its lifecycle stage (first-match precedence). Pure + flat so
 *  partitionSessions stays a trivial loop. */
function stageOf(
  s: Session,
  g: GitState | undefined,
  isReviewing: (id: string) => boolean,
  now: number,
): Stage {
  const terminal = terminalStage(s, g, isReviewing, now);
  if (terminal) return terminal;
  // Raw status by design: a working-while-blocked session (display "running") is raw
  // "blocked" — both are excluded from greenIdle, so the display flag can't change
  // the partition and doesn't need threading through here.
  const greenIdle =
    g?.state === "open" &&
    g.checks === "success" &&
    s.status !== "running" &&
    s.status !== "blocked";
  return greenIdle ? handoffStage(g) : "active";
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
  draftAwaitingSignoff: Session[];
  waitingOnReviewer: Session[];
  waitingOnMerger: Session[];
  awaitingMerge: Session[];
  merging: Session[];
  ready: Session[];
  merged: Session[];
} {
  const groups: Record<Stage, Session[]> = {
    active: [],
    ciRunning: [],
    ciFailed: [],
    reviewerRunning: [],
    draftAwaitingSignoff: [],
    waitingOnReviewer: [],
    waitingOnMerger: [],
    awaitingMerge: [],
    merging: [],
    ready: [],
    merged: [],
  };
  for (const s of sessions) {
    groups[stageOf(s, git[s.id], isReviewing, now)].push(s);
  }
  return groups;
}
