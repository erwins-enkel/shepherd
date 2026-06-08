import type { Issue, GitState } from "./forge/types";
import type { SessionStatus, ReviewDecision } from "./types";

/** Issues carrying this label jump to the head of the drain queue. Fixed (the
 *  per-repo `autoLabel` is configurable, but the priority marker is a constant
 *  sibling so operators don't have to wire up two labels). */
export const PRIORITY_LABEL = "shepherd:priority";

/** The drain stamps this label on an issue when it claims it (spawns an auto
 *  session) and keeps it through retire — a ready PR awaiting human merge is still
 *  "taken". It is the ONLY cross-instance coordination point: a second shepherd
 *  draining the same forge filters claimed issues out (see {@link selectCandidates}),
 *  so two instances don't take the same issue, and a retired-but-unmerged issue is
 *  not re-spawned. A constant (not the per-repo `autoLabel`) so every instance agrees
 *  on it without sharing config. The window is narrowed, not eliminated — two
 *  instances listing within the claim's set-up latency can still race; local dedup
 *  then prevents a single instance double-spawning. Released only when the work is
 *  abandoned (manual archive, no merge); a human merge auto-closes the issue, retiring
 *  the claim with it. */
export const ACTIVE_LABEL = "shepherd:active";

/** Why the drain is holding rather than spawning/retiring — surfaced on `drain:status`. */
export interface HoldReason {
  code:
    | "disabled" // per-repo toggle off
    | "cap" // maxAuto auto-agents already running
    | "usage" // usage % at/over the repo's ceiling
    | "blocked" // an auto-agent is blocked (trouble pause)
    | "changes_requested" // an auto-agent's critic is blocking (trouble pause)
    | "error" // an auto-agent's critic verdict is an error (don't advance on uncertainty)
    | "empty"; // no eligible backlog item
  /** A desig (trouble pauses) or a percentage (usage), for the operator banner. */
  detail?: string;
}

export type DrainDecision =
  | { kind: "spawn"; issue: Issue }
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
  maxAuto: number;
  usageCeilingPct: number;
  /** The worse of the 5h / weekly usage windows, 0–100. */
  usagePct: number;
  /** Non-archived auto sessions for this repo (sessions mid-merge carry git: null). */
  autoSessions: AutoSessionView[];
  /** Issue numbers already mapped to a non-archived session (auto OR manual). */
  mappedIssueNumbers: Set<number>;
  /** Labeled, ordered backlog issues (see selectCandidates). */
  candidates: Issue[];
}

/** True when this session's PR is ready to be retired / handed off for a human to merge:
 *  open, CI green, host-mergeable, and the critic is not blocking/uncertain. With the critic
 *  ENABLED we additionally require a clean verdict for the CURRENT head — so a first-time
 *  auto PR can't be retired in the same CI-green tick the critic fires on, before it's posted
 *  a verdict. */
function readyToRetire(s: AutoSessionView, criticEnabled: boolean): boolean {
  const g = s.git;
  if (!g || g.state !== "open" || g.checks !== "success" || g.mergeable !== true || !g.number) {
    return false;
  }
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled) {
    if (s.reviewDecision === null) return false; // critic on, no verdict yet → wait
    if (s.reviewHeadSha !== g.headSha) return false; // verdict is for an older head → wait
  }
  return true; // critic off → CI-green + mergeable; critic on → clean verdict for this head
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
  const toRetire = state.autoSessions.find(
    (s) => !s.fullAuto && readyToRetire(s, state.criticEnabled),
  );
  if (toRetire) {
    return { kind: "retire", sessionId: toRetire.id, prNumber: toRetire.git!.number! };
  }

  // 2. Trouble → halt new spawns (in-flight agents keep running; retires above still pass).
  const blocked = state.autoSessions.find((s) => s.status === "blocked");
  if (blocked) return { kind: "hold", reason: { code: "blocked", detail: blocked.desig } };
  const cr = state.autoSessions.find((s) => s.reviewDecision === "changes_requested");
  if (cr) return { kind: "hold", reason: { code: "changes_requested", detail: cr.desig } };
  const err = state.autoSessions.find((s) => s.reviewDecision === "error");
  if (err) return { kind: "hold", reason: { code: "error", detail: err.desig } };

  // 3. Concurrency cap.
  if (state.autoSessions.length >= state.maxAuto) {
    return { kind: "hold", reason: { code: "cap", detail: String(state.maxAuto) } };
  }

  // 4. Usage ceiling.
  if (state.usagePct >= state.usageCeilingPct) {
    return { kind: "hold", reason: { code: "usage", detail: String(state.usagePct) } };
  }

  // 5. Next un-mapped candidate.
  const next = state.candidates.find((c) => !state.mappedIssueNumbers.has(c.number));
  if (!next) return { kind: "hold", reason: { code: "empty" } };
  return { kind: "spawn", issue: next };
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
