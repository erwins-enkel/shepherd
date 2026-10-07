import { m } from "$lib/paraglide/messages";
import type { PulseState } from "./session-pulse";

/** The short, localized name of a progress verdict (card label, panel kicker). */
export function pulseLabel(state: PulseState): string {
  switch (state) {
    case "needs_you":
      return m.pulse_state_needs_you();
    case "looping":
      return m.pulse_state_looping();
    case "ci_failed":
      return m.pulse_state_ci_failed();
    case "ci_overdue":
      return m.pulse_state_ci_overdue();
    case "waiting_ci":
      return m.pulse_state_waiting_ci();
    case "working":
      return m.pulse_state_working();
  }
}
