import type { Issue, GitState } from "./forge/types";
import type { AgentProvider, SessionStatus, ReviewDecision } from "./types";
import { signedOff, type SignoffAuthority, type SignoffView } from "./signoff";
import { checksCleared } from "./checks-gate";
import { verdictStale } from "./verdict-freshness";

/** Issues carrying this label jump to the head of the drain queue. Fixed (the
 *  per-repo `autoLabel` is configurable, but the priority marker is a constant
 *  sibling so operators don't have to wire up two labels). */
export const PRIORITY_LABEL = "shepherd:priority";

/** The drain stamps this label on an issue when it claims it (spawns an auto
 *  session) and keeps it through retire — a ready PR awaiting human merge is still
 *  "taken". The SAME label is also stamped when a human links an issue at task
 *  creation (via the create route) and released when that session is archived, so a
 *  manually-linked issue is claimed too. It is the ONLY cross-instance coordination
 *  point: a second shepherd draining the same forge filters claimed issues out (see
 *  {@link selectCandidates}), so neither a second shepherd NOR the local drain takes
 *  an already-claimed issue (auto or manually-linked), and a retired-but-unmerged
 *  issue is not re-spawned. A constant (not the per-repo `autoLabel`) so every
 *  instance agrees on it without sharing config. The window is narrowed, not
 *  eliminated — two instances listing within the claim's set-up latency can still
 *  race; local dedup then prevents a single instance double-spawning. Released only
 *  when the work is abandoned (manual archive, no merge); a human merge auto-closes
 *  the issue, retiring the claim with it. */
export const ACTIVE_LABEL = "shepherd:active";

/** Why the drain is holding rather than spawning/retiring — surfaced on `drain:status`. */
export interface HoldReason {
  code:
    | "disabled" // per-repo toggle off
    | "cap" // maxAuto auto-agents already running
    | "usage" // usage % at/over the repo's ceiling
    | "credits" // extra-credit (paid overage) spend over the account ceiling
    | "blocked" // an auto-agent is blocked (trouble pause)
    | "changes_requested" // an auto-agent's critic is blocking (trouble pause)
    | "error" // an auto-agent's critic verdict is an error (don't advance on uncertainty)
    | "awaiting_signoff" // draftMode: a retireable PR is held at cap, awaiting its sign-off
    | "awaiting_approval" // epicAttended: next spawn held until operator approves
    | "epic_base_unavailable" // epic: the forge's ensureBranch threw — can't base the child on the integration branch (#1757)
    | "empty"; // no eligible backlog item
  /** A desig (trouble pauses) or a percentage (usage), for the operator banner. */
  detail?: string;
}

export interface EpicProviderSettings {
  agentProvider: AgentProvider;
  model: string | null;
  effort: string | null;
}

export type DrainDecision =
  | {
      kind: "spawn";
      issue: Issue;
      integrationBranch?: string;
      epicProviderSettings?: EpicProviderSettings;
    }
  | { kind: "retire"; sessionId: string; prNumber: number }
  | { kind: "hold"; reason: HoldReason };

/** The slice of an auto session the decision core reasons over. */
export interface AutoSessionView {
  id: string;
  desig: string;
  issueNumber: number | null;
  status: SessionStatus;
  /** Cached PR state from the pr-poller; null when unknown or merge in flight. */
  git: GitState | null;
  /** Latest critic verdict decision, or null when none/critic disabled. */
  reviewDecision: ReviewDecision | null;
  /** The head SHA the latest verdict applies to, or null when no verdict. */
  reviewHeadSha: string | null;
  /** The PR is a draft (not ready-for-review). false when unknown/no PR. */
  isDraft: boolean;
  /** A human submitted an APPROVED review on the PR (forge data). */
  humanApproved: boolean;
  /** The latest critic verdict's discrete findings ([] = clean / none). */
  findings: string[];
  /** Effective full-auto (autopilot ∧ auto-merge). When true the merge train lands this
   *  session, so the drain must NOT retire it (that would foreclose rebase recovery). When
   *  false the drain retires it normally — even in an auto-merge repo — so it can't sit
   *  un-retired-and-un-merged holding a maxAuto slot (which would deadlock the drain). */
  fullAuto: boolean;
}

/** Everything `computeNext` needs about ONE repo, assembled by the side-effect harness. */
export interface DrainRepoState {
  enabled: boolean;
  /** Per-repo critic toggle — when on, a clean verdict for the current head gates merges. */
  criticEnabled: boolean;
  /** Per-repo draft mode — PRs open as drafts and retire is gated on sign-off. */
  draftMode: boolean;
  /** Who can sign off a draft-mode PR for retire/merge ("human"|"critic"|"either"). */
  signoffAuthority: SignoffAuthority;
  maxAuto: number;
  usageCeilingPct: number;
  /** The worse of the 5h / weekly usage windows, 0–100. */
  usagePct: number;
  /** Paid extra-credit spend accrued since the current WEEKLY subscription window began
   *  (account-wide), 0 when none/stale/unknown. NOT the raw month-to-date total: a nonzero
   *  cumulative total with fresh weekly headroom is historical, not imminent, spend and reads 0
   *  here (see DrainService.effectiveCreditSpent). This keeps the pause on the subscription
   *  cadence instead of stuck until the monthly credit reset. */
  creditSpent: number;
  /** Account-wide ceiling (account currency units); spend strictly above it pauses the drain. */
  creditSpendCeiling: number;
  /** Non-archived auto sessions for this repo (sessions mid-merge carry git: null). */
  autoSessions: AutoSessionView[];
  /** Issue numbers already mapped to a non-archived session (auto OR manual). */
  mappedIssueNumbers: Set<number>;
  /** Labeled, ordered backlog issues (see selectCandidates). */
  candidates: Issue[];
  /** Provider the next spawn would use after explicit epic settings or global defaults resolve. */
  spawnAgentProvider: AgentProvider;
  /** Epic mode: when true, hold each spawn until the operator approves it. */
  epicAttended: boolean;
  /** Epic mode: operator approved the next spawn (consumed on spawn). */
  epicApprovedNext: boolean;
  /** Epic mode: the active epic's integration branch — epic-child spawns base on it.
   *  null/undefined for label-drain (spawns base on the default branch). */
  epicIntegrationBranch?: string | null;
  /** Epic mode: explicit provider/model/effort for child spawns. Undefined for label-drain
   *  and for epics inheriting the repo/global defaults. */
  epicProviderSettings?: EpicProviderSettings | null;
  /** Epic mode (#1757): the integration branch a RECENT epic-child spawn failed to ensure on the
   *  forge (`ensureBranch` threw), while that failure is still inside its cooldown window; null
   *  otherwise. Set ONLY for that specific, typed failure — never for an ordinary spawn error —
   *  and only ever for the epic's own branch, so the resulting hold pauses exactly the work that
   *  cannot proceed. Derived fresh each tick (see Drain.buildState), so a stale failure stops
   *  holding once its cooldown lapses: the drain then retries the spawn and either succeeds or
   *  re-holds. Deliberately NOT set when the forge simply lacks `ensureBranch` (gitea/local) —
   *  that degrades to the default branch and the epic still progresses; it surfaces as an epic
   *  warning instead of a hold. */
  epicBaseUnavailable?: string | null;
}

/** True when this session's PR is ready to be retired / handed off for a human to merge.
 *
 *  Basic gate (both modes): open, CI green, host-mergeable, has a PR number.
 *
 *  draftMode: sign-off by the configured `authority` REPLACES the critic sub-gate — the
 *  authority IS the gate, not the repo critic flag. This closes the born-ready retire race:
 *  an unsigned green PR (draft OR briefly-flipped-ready) cannot retire until signed off.
 *
 *  non-draftMode: the original behavior — changes_requested/error blocks; with the critic
 *  ENABLED we additionally require a clean verdict for the CURRENT head, so a first-time auto
 *  PR can't be retired in the same CI-green tick the critic fires on, before it's posted a
 *  verdict. */
/** Sign-off view for a draft-mode gate, projected off the flat AutoSessionView (head from
 *  the cached PR snapshot). Mirrors automerge-core's `signoffView` so the two cores read
 *  identically and the literal lives in one place per core. */
function signoffView(s: AutoSessionView): SignoffView {
  return {
    humanApproved: s.humanApproved,
    reviewDecision: s.reviewDecision,
    findings: s.findings,
    reviewHeadSha: s.reviewHeadSha,
    headSha: s.git?.headSha ?? null,
  };
}

function readyToRetire(
  s: AutoSessionView,
  criticEnabled: boolean,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  const g = s.git;
  if (
    !g ||
    g.state !== "open" ||
    !checksCleared(g.checks, g.noCi ?? false) ||
    g.mergeable !== true ||
    !g.number
  ) {
    return false;
  }
  if (draftMode) {
    return signedOff(authority, signoffView(s));
  }
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled) {
    if (s.reviewDecision === null) return false; // critic on, no verdict yet → wait
    if (s.reviewHeadSha !== g.headSha) return false; // verdict is for an older head → wait
  }
  return true; // critic off → CI-green + mergeable; critic on → clean verdict for this head
}

/** True when a draft-mode session is retireable EXCEPT it lacks the required sign-off, i.e.
 *  open + CI green + host-mergeable + has a PR number, but `signedOff` is false. Used only to
 *  RELABEL the cap hold as `awaiting_signoff` (see computeNext). */
function awaitingSignoff(
  s: AutoSessionView,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  if (!draftMode) return false;
  const g = s.git;
  if (
    !g ||
    g.state !== "open" ||
    !checksCleared(g.checks, g.noCi ?? false) ||
    g.mergeable !== true ||
    !g.number
  ) {
    return false;
  }
  return !signedOff(authority, signoffView(s));
}

function usageGuardsApply(state: DrainRepoState): boolean {
  return state.spawnAgentProvider === "claude";
}

function retireDecision(state: DrainRepoState): DrainDecision | null {
  const toRetire = state.autoSessions.find(
    (s) =>
      !s.fullAuto && readyToRetire(s, state.criticEnabled, state.draftMode, state.signoffAuthority),
  );
  return toRetire
    ? { kind: "retire", sessionId: toRetire.id, prNumber: toRetire.git!.number! }
    : null;
}

function troubleHold(state: DrainRepoState): HoldReason | null {
  const blocked = state.autoSessions.find((s) => s.status === "blocked");
  if (blocked) return { code: "blocked", detail: blocked.desig };
  // A verdict for an OLDER head (rework pushed, PR open at a newer head, re-review pending) is
  // NOT trouble — the same SHA staleness `readyToRetire` already respects. Suppress it here so a
  // superseded changes_requested/error doesn't falsely pause the drain (banner "needs changes").
  const cr = state.autoSessions.find(
    (s) => s.reviewDecision === "changes_requested" && !verdictStale(s.reviewHeadSha, s.git),
  );
  if (cr) return { code: "changes_requested", detail: cr.desig };
  const err = state.autoSessions.find(
    (s) => s.reviewDecision === "error" && !verdictStale(s.reviewHeadSha, s.git),
  );
  return err ? { code: "error", detail: err.desig } : null;
}

function capHold(state: DrainRepoState): HoldReason | null {
  if (state.autoSessions.length < state.maxAuto) return null;
  const awaiting = state.autoSessions.find((s) =>
    awaitingSignoff(s, state.draftMode, state.signoffAuthority),
  );
  return awaiting
    ? { code: "awaiting_signoff", detail: awaiting.desig }
    : { code: "cap", detail: String(state.maxAuto) };
}

function usageHold(state: DrainRepoState): HoldReason | null {
  if (!usageGuardsApply(state)) return null;
  // Claude usage ceiling.
  if (state.usagePct >= state.usageCeilingPct) {
    return { code: "usage", detail: String(state.usagePct) };
  }
  // Extra-credit cost guard: never keep spending NEW real pay-as-you-go money unattended.
  // creditSpent is spend accrued since the weekly window began (see effectiveCreditSpent), so a
  // nonzero month-to-date total with subscription headroom does NOT pause here.
  if (state.creditSpent > state.creditSpendCeiling) {
    return { code: "credits", detail: String(state.creditSpent) };
  }
  return null;
}

/**
 * Pure decision core. Given one repo's state snapshot, returns the single
 * highest-priority next action. The harness applies it, re-reads state, and calls
 * again — so spawns fill up to maxAuto and the loop ends on a `hold`.
 *
 * Priority: completing in-flight work (retire/hand-off) beats starting new work (spawn), and
 * a ready PR is still retired even while a sibling agent is in trouble (trouble only
 * halts NEW spawns).
 */
export function computeNext(state: DrainRepoState): DrainDecision {
  if (!state.enabled) return { kind: "hold", reason: { code: "disabled" } };

  // 1. Retire gate — a ready NON-full-auto session is handed off for a human to merge.
  // Full-auto sessions are left for the merge train (it lands them; retiring would remove the
  // worktree/pane and foreclose rebase recovery). Gating per-session (not on the repo flag)
  // ensures a non-full-auto session in an auto-merge repo still retires instead of sitting
  // un-retired-and-un-merged on a maxAuto slot and deadlocking the drain.
  const retire = retireDecision(state);
  if (retire) return retire;

  // 2. Trouble → halt new spawns (in-flight agents keep running; retires above still pass).
  const trouble = troubleHold(state);
  if (trouble) return { kind: "hold", reason: trouble };

  // 2b. Epic base unavailable (#1757): the forge's `ensureBranch` THREW for a child spawn, so the
  // integration branch could not be ensured. Basing the child on the default branch instead would
  // silently mix bases mid-epic — the merge train would land that one child on main (it is not
  // excluded from full-auto: `isEpicIntegrationBranch(baseBranch)` is false for it) while its
  // siblings integrate on the epic branch. So fail closed and hold. Gated on an active epic run, so
  // it can never fire in label-mode drain; while an epic runs the candidate set IS that epic's
  // children, and every sibling would fail identically, so pausing new spawns is exactly right.
  // Placed AFTER the retire gate (a ready PR still retires) and BEFORE the cap. The marker is
  // cooldown-fresh (see Drain.buildState), so this self-heals: it lapses, the spawn retries.
  if (state.epicIntegrationBranch && state.epicBaseUnavailable) {
    return {
      kind: "hold",
      reason: { code: "epic_base_unavailable", detail: state.epicBaseUnavailable },
    };
  }

  // 3. Concurrency cap. In draftMode, if a session is retireable-but-unsigned it's the reason
  //    the slot stays taken — relabel the hold `awaiting_signoff` (with that session's desig) so
  //    the operator sees WHY the drain is stuck, not a bare `cap`. Relabel is CAP-ONLY by design:
  //    below the cap the drain keeps spawning, and surfacing a pending sign-off there is the herd
  //    UI's job, not a drain hold.
  const cap = capHold(state);
  if (cap) return { kind: "hold", reason: cap };

  // 4. Usage ceiling.
  const usage = usageHold(state);
  if (usage) return { kind: "hold", reason: usage };

  // 5. Next un-mapped candidate.
  const next = state.candidates.find((c) => !state.mappedIssueNumbers.has(c.number));
  if (!next) return { kind: "hold", reason: { code: "empty" } };

  // Epic attended mode: hold the next spawn until the operator approves it.
  if (next && state.epicAttended && !state.epicApprovedNext) {
    return { kind: "hold", reason: { code: "awaiting_approval", detail: String(next.number) } };
  }

  return {
    kind: "spawn",
    issue: next,
    integrationBranch: state.epicIntegrationBranch ?? undefined,
    epicProviderSettings: state.epicProviderSettings ?? undefined,
  };
}

/**
 * Filter issues to those carrying `autoLabel` and NOT already claimed
 * ({@link ACTIVE_LABEL}), then order: priority-labeled first (each group by issue
 * number ascending = oldest first). A priority label without the auto label is
 * ignored — the auto label is the opt-in. Excluding claimed issues is what keeps a
 * second shepherd instance from re-taking an issue this (or another) instance is
 * already working or has a ready PR open for.
 */
export function selectCandidates(issues: Issue[], autoLabel: string): Issue[] {
  const eligible = issues.filter(
    (i) => i.labels.includes(autoLabel) && !i.labels.includes(ACTIVE_LABEL),
  );
  const prio = (i: Issue) => (i.labels.includes(PRIORITY_LABEL) ? 0 : 1);
  return eligible.sort((a, b) => prio(a) - prio(b) || a.number - b.number);
}
