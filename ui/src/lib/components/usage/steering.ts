// Display helpers for the Steering lens (#4175). Kept out of the components so their templates
// stay shallow and the mapping is unit-checkable.
import type { SteeringIntent, SteeringReport } from "#lib/types.js";
import type { TooltipExplanation } from "#lib/tooltips/content.js";
import { m } from "#lib/paraglide/messages.js";

/** A failed run's localized message plus the raw detail when the code alone says too little. */
export function failureText(error: string | null): { text: string; detail: string | null } {
  if (error === "unavailable") return { text: m.usage_steering_err_unavailable(), detail: null };
  if (error === "oversized") return { text: m.usage_steering_err_oversized(), detail: null };
  if (error === "timeout") return { text: m.usage_steering_err_timeout(), detail: null };
  if (error === "unparseable") return { text: m.usage_steering_err_unparseable(), detail: null };
  const detail = error?.replace(/^spawn-failed:\s*/, "").trim() || null;
  return { text: m.usage_steering_err_generic(), detail };
}

/** Sessions the report deliberately left out (not merely outside the window or still live). */
export function skippedCount(report: SteeringReport): number {
  const s = report.sample?.skipped;
  return s ? s.terminal + s.relaunch + s.noop : 0;
}

/** Prompt styles are a closed enum and get localized; prompt types are the helper's free text. */
export function styleLabel(key: string): string {
  if (key === "prescribing") return m.usage_steering_style_prescribing();
  if (key === "describing") return m.usage_steering_style_describing();
  return key;
}

export function intentLabel(intent: SteeringIntent): string {
  if (intent === "correction") return m.usage_steering_intent_correction();
  if (intent === "scope") return m.usage_steering_intent_scope();
  if (intent === "clarification") return m.usage_steering_intent_clarification();
  return m.usage_steering_intent_approval();
}

/** A median, without a trailing `.0`. */
export function median(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** Compact minutes; the same unit letters the Delivery lens uses. Em dash when unmeasured. */
export function minutes(min: number | null): string {
  if (min == null) return "—";
  const mins = Math.round(min);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

export function steeringExplanation(): TooltipExplanation {
  return {
    title: m.usage_steering_explain_label(),
    summary: m.usage_steering_explain_summary(),
    sections: [
      { label: m.usage_steering_style_prescribing(), text: m.usage_steering_explain_prescribing() },
      { label: m.usage_steering_style_describing(), text: m.usage_steering_explain_describing() },
      { label: m.usage_steering_explain_shows_label(), text: m.usage_steering_explain_shows() },
    ],
  };
}
