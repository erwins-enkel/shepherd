import type { Session, GitState } from "$lib/types";
import { displayStatus } from "$lib/display-status";
import { checksCleared } from "$lib/checks-cleared";
import { isMerging } from "./merge-train";

/** Split sessions into stage groups, preserving input order within each:
 *  - active: still in play, no later stage reached
 *  - ciRunning: open PR with CI checks in flight (`open` + `pending`)
 *  - ciFailed: open PR whose CI checks failed (`open` + `failure`) — done, needs a look
 *  - reviewerRunning: a critic run is in flight for the session
 *  - reworkRunning: the task agent is actively addressing plan-gate or critic requested changes
 *  - needsRework: the configured reviewer has active requested changes on an idle green PR.
 *  - branchProtectionBlocked: the forge reports protected-branch merge blocked after checks clear.
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
 *  First-match precedence (terminal states win; reviewing/rework beat the CI/merge stages
 *  as the later in-flight stage):
 *    merged > merging > needsRework > branchProtectionBlocked > ready > reviewerRunning > reworkRunning > ciRunning > ciFailed >
 *    draftAwaitingSignoff > (waitingOnReviewer | waitingOnMerger | awaitingMerge) > active.
 *  A draft outranks the handed-off groups: a green idle DRAFT is awaiting sign-off
 *  regardless of who the roles file names. An open PR with `none` checks (no CI reported
 *  yet) stays in `active` to avoid flicker into the "Your turn" group before CI registers
 *  as pending — UNLESS the repo has no CI at all (`g.noCi`, GitHub + zero workflows), where
 *  `none` is terminal and the PR is handed off like a green one. The groups render top→bottom as
 *  active → ciRunning → ciFailed →
 *  reviewerRunning → reworkRunning → waitingOnReviewer → waitingOnMerger →
 *  draftAwaitingSignoff → awaitingMerge → ready → merging → merged (Herd.svelte's template
 *  order, mirrored by herd-keynav's railOrder via flattenByStage), tracking the session
 *  lifecycle. `isReviewing` is injected so this stays a pure function (the caller wires it to
 *  the reviews store). */
type Stage =
  | "merged"
  | "merging"
  | "ready"
  | "reviewerRunning"
  | "reworkRunning"
  | "needsRework"
  | "branchProtectionBlocked"
  | "ciRunning"
  | "ciFailed"
  | "draftAwaitingSignoff"
  | "waitingOnReviewer"
  | "waitingOnMerger"
  | "awaitingMerge"
  | "active";

/** The herd rail's list filter: everything, only sessions awaiting the operator, only
 *  the Done lens (archived/finished sessions), or the Rundown lens (the daily Herd Rundown
 *  digest). "done" and "rundown" are NOT live-list filters — the page swaps in a dedicated
 *  panel for each; shownSessions returns [] for "rundown" (panel-only, no session list) and
 *  falls through to the live set for "done" (handled by the page). */
export type HerdFilter = "all" | "ready" | "done" | "rundown" | "owed" | "next";

/** Lifecycle stages the "ready" lens hides: the session is NOT awaiting the operator.
 *  A PR with CI still in flight (`ciRunning`) is awaiting CI, a green PR handed off to a
 *  foreign reviewer/merger (`waitingOnReviewer`/`waitingOnMerger`) is waiting on someone
 *  else, and a PR a launched merge train is carrying (`merging`) is in Shepherd's hands —
 *  none is "your turn", so the Ready lens drops them (the All lens still shows them).
 *  `ciFailed` is NOT hidden — a failed CI run is back in your court. Draft-awaiting-signoff
 *  stays too: it awaits the operator's own sign-off. */
const NOT_YOUR_TURN: ReadonlySet<Stage> = new Set([
  "ciRunning",
  "waitingOnReviewer",
  "waitingOnMerger",
  "merging",
]);

/** The sessions the rail actually lists under `filter` — "ready" keeps only sessions
 *  awaiting the operator (not running, not under review, and not handed off to another
 *  party or mid-merge-train — see NOT_YOUR_TURN). Single source of truth shared by
 *  Herd.svelte's list and herd-keynav's
 *  rail order, so keyboard navigation can never land on a row the rail isn't showing. Goes
 *  through `displayStatus` (a working-while-blocked session is actually mid-turn, so it is
 *  NOT awaiting the operator). `git`/`now` drive the stage check for the not-your-turn
 *  exclusion; both default empty/now so legacy 4-arg callers keep today's behavior (no git
 *  → no CI checks, no handoff, `mergingSince: null` → no session resolves to an excluded
 *  stage). */
export function shownSessions(
  sessions: Session[],
  filter: HerdFilter,
  inReview: (id: string) => boolean,
  workingBlocked: Record<string, boolean> = {},
  git: Record<string, GitState> = {},
  now: number = Date.now(),
): Session[] {
  if (filter === "ready")
    return sessions.filter(
      (s) =>
        displayStatus(s, workingBlocked) !== "running" &&
        !inReview(s.id) &&
        !NOT_YOUR_TURN.has(stageOf(s, git[s.id], inReview, () => false, now)),
    );
  // Rundown + Owed + Up Next are panel-only lenses (a dedicated panel, no session list).
  if (filter === "rundown" || filter === "owed" || filter === "next") return [];
  return sessions;
}

/** Terminal / in-flight stages that win before the green-idle handoff decision, or null
 *  when none apply (the session is then either active or handed off). Split out of stageOf
 *  to keep each branch-set small. */
function terminalStage(
  s: Session,
  g: GitState | undefined,
  isReviewing: (id: string) => boolean,
  isReworkRunning: (session: Session) => boolean,
  now: number,
): Stage | null {
  if (g?.state === "merged") return "merged";
  if (isMerging(s, now)) return "merging";
  const idleOpenCleared = isIdleOpenCleared(s, g, isReviewing, isReworkRunning);
  if (idleOpenCleared && g.reviewBlock) return "needsRework";
  if (idleOpenCleared && !g.reviewBlock && g.mergeStateStatus === "blocked")
    return "branchProtectionBlocked";
  if (s.readyToMerge) return "ready";
  if (isReviewing(s.id)) return "reviewerRunning";
  if (isReworkRunning(s)) return "reworkRunning";
  if (g?.state === "open" && g.checks === "pending") return "ciRunning";
  if (g?.state === "open" && g.checks === "failure") return "ciFailed";
  return null;
}

function isIdleOpenCleared(
  s: Session,
  g: GitState | undefined,
  isReviewing: (id: string) => boolean,
  isReworkRunning: (session: Session) => boolean,
): g is GitState & { state: "open" } {
  return (
    g?.state === "open" &&
    checksCleared(g.checks, g.noCi) &&
    s.status !== "running" &&
    s.status !== "blocked" &&
    !isReviewing(s.id) &&
    !isReworkRunning(s)
  );
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
  isReworkRunning: (session: Session) => boolean,
  now: number,
): Stage {
  const terminal = terminalStage(s, g, isReviewing, isReworkRunning, now);
  if (terminal) return terminal;
  // Raw status by design: a working-while-blocked session (display "running") is raw
  // "blocked" — both are excluded from greenIdle, so the display flag can't change
  // the partition and doesn't need threading through here.
  const greenIdle =
    g?.state === "open" &&
    checksCleared(g.checks, g.noCi) &&
    s.status !== "running" &&
    s.status !== "blocked";
  return greenIdle ? handoffStage(g) : "active";
}

/** The canonical top→bottom lifecycle stage order of Herd.svelte's template (active
 *  first, merged last). Single source of truth for stage ordering: `flattenByStage`
 *  here (used by both the render and herd-keynav's `railOrder`) derives from it, so the
 *  render and the keyboard-nav rail can never drift on order. Module-local: consumers go
 *  through `flattenByStage` rather than importing the order array directly. */
const STAGE_ORDER = [
  "active",
  "ciRunning",
  "ciFailed",
  "reviewerRunning",
  "reworkRunning",
  "needsRework",
  "branchProtectionBlocked",
  "waitingOnReviewer",
  "waitingOnMerger",
  "draftAwaitingSignoff",
  "awaitingMerge",
  "ready",
  "merging",
  "merged",
] as const satisfies readonly Stage[];

/** Flatten a partitionSessions result into a single list in STAGE_ORDER. */
export function flattenByStage(p: ReturnType<typeof partitionSessions>): Session[] {
  return STAGE_ORDER.flatMap((stage) => p[stage]);
}

export function partitionSessions(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean,
  isReworkRunning: (session: Session) => boolean,
  now: number = Date.now(),
): {
  active: Session[];
  ciRunning: Session[];
  ciFailed: Session[];
  reviewerRunning: Session[];
  reworkRunning: Session[];
  needsRework: Session[];
  branchProtectionBlocked: Session[];
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
    reworkRunning: [],
    needsRework: [],
    branchProtectionBlocked: [],
    draftAwaitingSignoff: [],
    waitingOnReviewer: [],
    waitingOnMerger: [],
    awaitingMerge: [],
    merging: [],
    ready: [],
    merged: [],
  };
  for (const s of sessions) {
    groups[stageOf(s, git[s.id], isReviewing, isReworkRunning, now)].push(s);
  }
  return groups;
}
