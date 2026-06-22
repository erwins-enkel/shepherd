import { m } from "$lib/paraglide/messages";
import type { HoldCode, HoldReason } from "./types";

const HOLD_LINE: Record<HoldCode, (hold: HoldReason) => string> = {
  "halted-error": () => m.hold_halted_error(),
  "halted-usage": ({ params: p = {} }) => {
    if (p.resetAt != null) {
      const time = new Date(p.resetAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      return m.hold_halted_usage({ time });
    }
    return m.hold_halted_usage_pending();
  },
  "autopilot-paused": ({ params: p = {} }) => {
    if (p.question?.trim()) return p.question.trim();
    return m.hold_autopilot_paused();
  },
  "blocked-menu": () => m.hold_blocked_menu(),
  "blocked-yes-no": () => m.hold_blocked_yes_no(),
  "blocked-awaiting-input": () => m.hold_blocked_awaiting_input(),
  "blocked-stall": () => m.hold_blocked_stall(),
  "blocked-generic": () => m.hold_blocked_generic(),
  "quota-rework": () => m.hold_quota_rework(),
  "quota-review": () => m.hold_quota_review(),
  "quota-error": () => m.hold_quota_error(),
  "quota-plan": () => m.hold_quota_plan(),
  "plan-rework": ({ params: p = {} }) =>
    m.hold_plan_rework({ round: p.round ?? 0, cap: p.cap ?? 0 }),
  "critic-rework": ({ params: p = {} }) => m.hold_critic_rework({ findings: p.findings ?? 0 }),
  "ci-red": () => m.hold_ci_red(),
  "awaiting-merge": () => m.hold_awaiting_merge(),
  "train-error": () => m.hold_train_error(),
  stalled: () => m.hold_stalled(),
  "recap-attention": () => m.hold_recap_attention(),
  merging: () => m.hold_merging(),
  "merge-rebasing": ({ params: p = {} }) =>
    m.hold_merge_rebasing({ rebaseCount: p.rebaseCount ?? 0 }),
  "ready-merge": () => m.hold_ready_merge(),
};

/** Return a localized one-line description for a hold reason. Used by Task-7 components. */
export function holdLine(hold: HoldReason): string {
  return HOLD_LINE[hold.code](hold);
}
