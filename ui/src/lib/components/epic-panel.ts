import type { DrainStatus, EpicChild, EpicChildState } from "$lib/types";
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
