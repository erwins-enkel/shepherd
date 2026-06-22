import { m } from "$lib/paraglide/messages";
import type { HoldReason } from "./types";

/** Return a localized one-line description for a hold reason. Used by Task-7 components. */
export function holdLine(hold: HoldReason): string {
  const p = hold.params ?? {};
  switch (hold.code) {
    case "halted-error":
      return m.hold_halted_error();
    case "halted-usage":
      if (p.resetAt != null) {
        const time = new Date(p.resetAt).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
        return m.hold_halted_usage({ time });
      }
      return m.hold_halted_usage_pending();
    case "autopilot-paused":
      if (p.question?.trim()) return p.question.trim();
      return m.hold_autopilot_paused();
    case "blocked-menu":
      return m.hold_blocked_menu();
    case "blocked-yes-no":
      return m.hold_blocked_yes_no();
    case "blocked-awaiting-input":
      return m.hold_blocked_awaiting_input();
    case "blocked-stall":
      return m.hold_blocked_stall();
    case "blocked-generic":
      return m.hold_blocked_generic();
    case "quota-rework":
      return m.hold_quota_rework();
    case "quota-review":
      return m.hold_quota_review();
    case "quota-error":
      return m.hold_quota_error();
    case "quota-plan":
      return m.hold_quota_plan();
    case "plan-rework":
      return m.hold_plan_rework({ round: p.round ?? 0, cap: p.cap ?? 0 });
    case "critic-rework":
      return m.hold_critic_rework({ findings: p.findings ?? 0 });
    case "ci-red":
      return m.hold_ci_red();
    case "awaiting-merge":
      return m.hold_awaiting_merge();
    case "train-error":
      return m.hold_train_error();
    case "stalled":
      return m.hold_stalled();
    case "recap-attention":
      return m.hold_recap_attention();
    case "merging":
      return m.hold_merging();
    case "merge-rebasing":
      return m.hold_merge_rebasing({ rebaseCount: p.rebaseCount ?? 0 });
    case "ready-merge":
      return m.hold_ready_merge();
    default: {
      const _x: never = hold.code;
      return _x;
    }
  }
}
