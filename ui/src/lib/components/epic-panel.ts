import type { DrainRunSummary, DrainStatus, Epic, EpicChild, EpicChildState } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { pausedText } from "./queue-strip";

export type ChipTone = "done" | "review" | "running" | "ready" | "muted";

const TONES: Record<EpicChildState, ChipTone> = {
  merged: "done",
  "in-review": "review",
  running: "running",
  ready: "ready",
  blocked: "muted",
};

export function chipFor(state: EpicChildState): { key: EpicChildState; tone: ChipTone } {
  return { key: state, tone: TONES[state] };
}

export function stateLabel(s: EpicChildState): string {
  const labels: Record<EpicChildState, string> = {
    merged: m.epic_state_merged(),
    "in-review": m.epic_state_in_review(),
    running: m.epic_state_running(),
    ready: m.epic_state_ready(),
    blocked: m.epic_state_blocked(),
  };
  return labels[s];
}

export function progress(children: Pick<EpicChild, "state">[]): {
  merged: number;
  total: number;
} {
  return {
    merged: children.filter((c) => c.state === "merged").length,
    total: children.length,
  };
}

/**
 * Localized "why is this epic's train holding" line, or null when there's nothing to say
 * (not running, no drain, or the drain is actively spawning/retiring → `reason == null`).
 * The caller passes the repo's DrainStatus ONLY when it belongs to this epic
 * (`drain.epicParent === parent`); this helper does not re-check that.
 *
 * `empty` is the NORMAL serialized-progress state (a running child + its blocked dependents
 * yield no new candidate), so it is progress-aware: a still-in-flight child reads as
 * "waiting on in-flight children"; a genuinely idle-but-incomplete epic reads as
 * "nothing eligible". Repo-wide pauses (usage/credits) reuse the drain banner copy; the
 * trouble/cap/awaiting reasons get epic-framed copy that names the session desig.
 */
export function epicHoldLine(
  drain: DrainStatus | null | undefined,
  running: boolean,
  children: Pick<EpicChild, "state">[],
): string | null {
  if (!running || !drain || drain.reason == null) return null;
  const desig = drain.detail ?? "";
  switch (drain.reason) {
    case "blocked":
      return m.epic_hold_blocked({ desig });
    case "changes_requested":
      return m.epic_hold_changes({ desig });
    case "error":
      return m.epic_hold_error({ desig });
    case "usage":
    case "credits":
      return pausedText(drain);
    case "cap":
      return m.epic_hold_cap({ inFlight: drain.inFlight, max: drain.max });
    case "awaiting_approval":
      return m.epic_hold_awaiting_approval({ num: desig });
    // #1757: `detail` is the integration branch, not a desig — the forge's ensureBranch threw, so
    // no child can be based on it. Self-heals when the forge recovers (cooldown → retry).
    case "epic_base_unavailable":
      return m.epic_hold_epic_base_unavailable({ branch: desig });
    case "awaiting_signoff":
      return m.epic_hold_awaiting_signoff({ desig });
    case "empty":
      return children.some((c) => c.state === "running" || c.state === "in-review")
        ? m.epic_hold_waiting_inflight()
        : m.epic_hold_empty();
    case "disabled":
      return m.epic_hold_disabled();
    default:
      return null;
  }
}

// ── run-control region (#2620) ─────────────────────────────────────────────────────────────
// Pure derivations for the epic detail's "Abarbeitung" region, from the repo's live DrainStatus
// (its read-only `runSummary`, #2616) and the epic record. Only one epic leads a repo at a time;
// a superseded epic whose child is still in flight is "winding down".

export type EpicRole = "leading" | "winding";

/** This epic's role in its repo's run, or null (idle / not in the run / no runSummary). */
export function epicRole(
  summary: DrainRunSummary | null | undefined,
  parent: number,
): EpicRole | null {
  if (!summary) return null;
  if (summary.leadingEpic === parent) return "leading";
  return summary.windingDown.some((w) => w.epic === parent) ? "winding" : null;
}

/** 1-based agent slot `issueNumber` holds (`index/max`), or null when no slot holds it. */
export function slotHeldBy(
  summary: DrainRunSummary | null | undefined,
  issueNumber: number,
): { index: number; max: number } | null {
  if (!summary) return null;
  const i = summary.slots.holders.findIndex((h) => h.issueNumber === issueNumber);
  return i < 0 ? null : { index: i + 1, max: summary.slots.max };
}

export type EpicRunKind =
  | "winding"
  | "paused"
  | "idle"
  | "waiting_slot"
  | "awaiting_approval"
  | "halted"
  | "nothing"
  | "running";

/** Indicator tone: `run` = amber pulse (work happening / waiting its turn), `halt` = blocked
 *  red, `quiet` = muted (paused, not started, nothing eligible). */
export type EpicRunTone = "run" | "halt" | "quiet";

export interface EpicRunState {
  kind: EpicRunKind;
  tone: EpicRunTone;
  /** In-flight issue #s — the winding-down label names them. */
  inFlight: number[];
  /** Why a halted run holds (the former hold line); null for every other kind. */
  note: string | null;
}

const HALT_REASONS = new Set([
  "blocked",
  "changes_requested",
  "error",
  "usage",
  "credits",
  "epic_base_unavailable",
  "awaiting_signoff",
  "disabled",
]);

/** The region's live state. `drain` is the REPO's status; its hold reason only counts while it
 *  belongs to this epic (`drain.epicParent === parent`), as for the former hold line. */
export function epicRunState(
  epic: Pick<Epic, "run" | "children">,
  parent: number,
  drain: DrainStatus | null | undefined,
): EpicRunState {
  const summary = drain?.runSummary;
  const winding = summary?.windingDown.find((w) => w.epic === parent);
  const base = { inFlight: winding?.inFlight ?? [], note: null };
  if (winding) return { ...base, kind: "winding", tone: "run" };
  if (epic.run.status === "paused") return { ...base, kind: "paused", tone: "quiet" };
  if (epic.run.status !== "running") return { ...base, kind: "idle", tone: "quiet" };
  const own = drain?.epicParent === parent ? drain : null;
  const reason = own?.reason ?? null;
  if (reason === "cap") return { ...base, kind: "waiting_slot", tone: "run" };
  if (reason === "awaiting_approval") return { ...base, kind: "awaiting_approval", tone: "run" };
  if (reason != null && HALT_REASONS.has(reason)) {
    return { ...base, kind: "halted", tone: "halt", note: epicHoldLine(own, true, epic.children) };
  }
  const inFlight = epic.children.some((c) => c.state === "running" || c.state === "in-review");
  if (reason === "empty" && !inFlight) return { ...base, kind: "nothing", tone: "quiet" };
  return { ...base, kind: "running", tone: "run" };
}

/** Localized label of the run state; `inflight` names the in-flight issues a winding-down
 *  epic still finishes. */
export function epicRunStateLabel(kind: EpicRunKind, inflight: string): string {
  const labels: Record<EpicRunKind, () => string> = {
    winding: () => m.epic_run_state_winding({ inflight }),
    paused: m.epic_run_state_paused,
    idle: m.epic_run_state_idle,
    waiting_slot: m.epic_run_state_waiting_slot,
    awaiting_approval: m.epic_run_state_awaiting_approval,
    halted: m.epic_run_state_halted,
    nothing: m.epic_run_state_nothing,
    running: m.epic_run_state_running,
  };
  return labels[kind]();
}

export type SlotHolder = DrainRunSummary["slots"]["holders"][number];

/** When the leading epic's next task starts. */
export type NextNote = "after_slot" | "approval" | "resume" | "soon";

export type EpicRunSteps =
  | {
      kind: "leading";
      slots: { used: number; max: number };
      /** The leading epic (this one) — a holder of any other epic is winding down. */
      leader: number;
      now: SlotHolder[];
      /** `runSummary.next[0]`; null when nothing is startable. */
      next: number | null;
      nextNote: NextNote;
      /** The holder whose finish frees the slot `next` waits for (`after_slot` only). */
      freedBy: SlotHolder | null;
      /** Open children directly blocked by `next`. */
      after: number[];
      /** How many of `after` become startable once `next` lands (no other open blocker). */
      parallel: number;
    }
  | {
      kind: "winding";
      slots: { used: number; max: number };
      /** This epic's own in-flight holders. */
      now: SlotHolder[];
      /** Unstarted children (ready/blocked) the superseded epic leaves behind. */
      leftBehind: number;
      /** Who gets the slot next: the leading epic's `next[0]`. */
      handover: { issue: number; epic: number | null } | null;
      leader: number | null;
    };

/** The Now → Next → After steps, for a leading or winding-down epic; null otherwise. */
export function epicRunSteps(
  epic: Pick<Epic, "run" | "children">,
  parent: number,
  drain: DrainStatus | null | undefined,
): EpicRunSteps | null {
  const summary = drain?.runSummary;
  const role = epicRole(summary, parent);
  if (!summary || !role) return null;
  const slots = { used: summary.slots.used, max: summary.slots.max };
  const head = summary.next[0] ?? null;
  if (role === "winding") {
    return {
      kind: "winding",
      slots,
      now: summary.slots.holders.filter((h) => h.epicParent === parent),
      leftBehind: epic.children.filter((c) => c.state === "ready" || c.state === "blocked").length,
      handover: head == null ? null : { issue: head, epic: summary.leadingEpic },
      leader: summary.leadingEpic,
    };
  }
  const full = slots.used >= slots.max;
  let nextNote: NextNote = "soon";
  if (epic.run.status === "paused") nextNote = "resume";
  else if (drain?.epicParent === parent && drain.reason === "awaiting_approval")
    nextNote = "approval";
  else if (full) nextNote = "after_slot";
  const merged = new Set(epic.children.filter((c) => c.state === "merged").map((c) => c.number));
  const parallel = summary.after.filter((n) => {
    const child = epic.children.find((c) => c.number === n);
    return !!child && child.blockedBy.every((b) => b === head || merged.has(b));
  }).length;
  return {
    kind: "leading",
    slots,
    leader: parent,
    now: summary.slots.holders,
    next: head,
    nextNote,
    freedBy: nextNote === "after_slot" ? (summary.slots.holders[0] ?? null) : null,
    after: summary.after,
    parallel,
  };
}
