import { m } from "#lib/paraglide/messages.js";
import { effortLabel } from "#lib/effort-guidance.js";
import type { TooltipExplanation } from "#lib/tooltips/content.js";
import type { EffortSwitchError, PlanGate, Session } from "#lib/types.js";

/**
 * Plan-gated effort switch (#3434) as the Go surfaces read it.
 *
 * - `withheld`: Go did not happen because the switch to the execution effort was not made
 *   (agent busy) or not confirmed. Only on an approved gate still in planning — the two actions
 *   (Retry Go / Go at planning effort) must be able to release it.
 * - `not-restored`: a re-gate could not put the planning effort back. Informational only; the
 *   agent keeps the tier in force until its next restart.
 */
export type EffortSwitchState =
  | { kind: "withheld"; code: "busy" | "unconfirmed"; effort: string }
  | { kind: "not-restored"; effort: string };

type SessionEffort = Pick<Session, "planPhase" | "effort" | "executionEffort" | "activeEffort">;

/** Label of a tier, or the localized "default" for a provider default. */
function tierLabel(tier: string | null | undefined): string {
  return tier ? effortLabel(tier) : m.effort_default();
}

/** Resolve the gate's failure code into what to show. `localCode` is a 409 code from the Go click
 *  itself, used until the WS gate update carrying the same code arrives. */
export function effortSwitchState(
  session: SessionEffort,
  gate: Pick<PlanGate, "approved" | "effortSwitchError"> | undefined,
  localCode: "busy" | "unconfirmed" | null = null,
): EffortSwitchState | null {
  const code: EffortSwitchError | null = gate?.effortSwitchError ?? localCode;
  if (!code) return null;
  if (code === "busy" || code === "unconfirmed") {
    if (!gate?.approved || session.planPhase !== "planning") return null;
    return { kind: "withheld", code, effort: tierLabel(session.executionEffort) };
  }
  // The tier still in force: what Shepherd last confirmed, else the stored planning effort.
  const active = session.activeEffort !== undefined ? session.activeEffort : session.effort;
  return { kind: "not-restored", effort: tierLabel(active) };
}

/** One-line statement of the state (PlanPanel notice, Herd row subline). */
export function effortSwitchLine(state: EffortSwitchState): string {
  if (state.kind === "not-restored") return m.effort_switch_not_restored({ effort: state.effort });
  return state.code === "busy"
    ? m.effort_switch_withheld_busy({ effort: state.effort })
    : m.effort_switch_withheld_unconfirmed({ effort: state.effort });
}

/** Toast copy for a refused Go click: names the withheld cause when the server gave one. */
export function goFailedMessage(code: "busy" | "unconfirmed" | null): string {
  if (code === "busy") return m.effort_switch_go_busy_toast();
  if (code === "unconfirmed") return m.effort_switch_go_unconfirmed_toast();
  return m.hold_cta_go_failed();
}

/** Hover explanation for the Herd row's subline. */
export function effortSwitchExplanation(state: EffortSwitchState): TooltipExplanation {
  if (state.kind === "not-restored")
    return {
      title: m.effort_switch_not_restored_title(),
      summary: m.effort_switch_not_restored({ effort: state.effort }),
      sections: [
        {
          label: m.effort_switch_tip_why(),
          text: m.effort_switch_not_restored_why(),
        },
        { label: m.effort_switch_tip_next(), text: m.effort_switch_not_restored_next() },
      ],
    };
  return {
    title: m.effort_switch_withheld_title(),
    summary: effortSwitchLine(state),
    sections: [
      {
        label: m.effort_switch_tip_why(),
        text:
          state.code === "busy"
            ? m.effort_switch_withheld_busy_why()
            : m.effort_switch_withheld_unconfirmed_why(),
      },
      { label: m.effort_switch_retry_go(), text: m.effort_switch_retry_go_body() },
      { label: m.effort_switch_go_planning(), text: m.effort_switch_go_planning_body() },
    ],
  };
}
