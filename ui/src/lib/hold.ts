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
  "plan-question": () => m.hold_plan_question(),
  "critic-rework": ({ params: p = {} }) => m.hold_critic_rework({ findings: p.findings ?? 0 }),
  "ci-red": () => m.hold_ci_red(),
  "pr-conflict": () => m.hold_pr_conflict(),
  "awaiting-merge": () => m.hold_awaiting_merge(),
  "train-error": () => m.hold_train_error(),
  stalled: () => m.hold_stalled(),
  "recap-attention": () => m.hold_recap_attention(),
  merging: () => m.hold_merging(),
  "merge-rebasing": ({ params: p = {} }) =>
    m.hold_merge_rebasing({ rebaseCount: p.rebaseCount ?? 0 }),
  "ready-merge": () => m.hold_ready_merge(),
  "manual-steps": ({ params: p = {} }) => m.hold_manual_steps({ steps: p.steps ?? 1 }),
};

/** Return a localized one-line description for a hold reason. Used by Task-7 components. */
export function holdLine(hold: HoldReason): string {
  return HOLD_LINE[hold.code](hold);
}

/** Does this hold mean the agent has stopped and awaits a DIRECT operator action?
 *  Drives the card-level attention wash (UnitRow `.awaits-operator` + --wash-attention).
 *
 *  This is a VISUAL, agency-based classification — deliberately its OWN set, NOT the
 *  behavioral "needs you" the rest of the app already defines differently:
 *    - nextNeedsYou / CommandBar / common_needs_you → only `status === "blocked"`
 *    - tab-signal.svelte.ts                          → blocked · ci-red · ready-to-merge
 *    - Ready lens (shownSessions "ready")            → idle · blocked · done
 *  and NOT the server rundown's SIGNAL_TIER (src/rundown-core.ts), which ranks by
 *  URGENCY (e.g. critic-rework Tier 1, ready-merge Tier 3), not agency. The wash is
 *  "rein visuell" and must not drift into any of those behavioral paths.
 *
 *  Excluded on purpose:
 *    - ci-red / train-error / halted-usage: non-agent FAILURE / external limit — the
 *      design system reserves a wash for blocked-AGENT state; failures get a subordinate
 *      red chip, never a wash (DESIGN.md "Neither carries a halo, pulse, or wash").
 *    - blocked-stall / stalled / recap-attention: uncertain heuristic / advisory nudge,
 *      not a proven operator block.
 *    - quota-*: limit-exhaustion; still carries the loud red "!" pip on its own.
 *    - critic-rework / merging / merge-rebasing / awaiting-merge: autonomous or handed off.
 *    - ready-merge: a green ✓ actionable-complete state (also guarded by !readyToMerge at
 *      the callsite) — a red wash under green would break the Four-Light Rule.
 *
 *  Exhaustive Record so a newly-added HoldCode fails to compile until it is classified. */
const HOLD_AWAITS_OPERATOR: Record<HoldCode, boolean> = {
  "halted-error": true,
  "autopilot-paused": true,
  "blocked-menu": true,
  "blocked-yes-no": true,
  "blocked-awaiting-input": true,
  "blocked-generic": true,
  "plan-rework": true,
  "plan-question": true,
  "manual-steps": true,
  "blocked-stall": false,
  "quota-rework": false,
  "quota-review": false,
  "quota-error": false,
  "quota-plan": false,
  "critic-rework": false,
  "ci-red": false,
  "pr-conflict": false,
  "awaiting-merge": false,
  "train-error": false,
  stalled: false,
  "recap-attention": false,
  merging: false,
  "merge-rebasing": false,
  "ready-merge": false,
  "halted-usage": false,
};

/** See HOLD_AWAITS_OPERATOR — the card-attention-wash predicate. */
export function holdAwaitsOperator(hold: HoldReason): boolean {
  return HOLD_AWAITS_OPERATOR[hold.code];
}
