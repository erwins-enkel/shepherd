// ExitPlanMode's plan as data (issue #2779).
//
// A PreToolUse hook hands us the tool's `tool_input` = `{plan, planFilePath}` (measured against
// Claude Code 2.1.310, see docs/research/claude-code-pretooluse-dialogs.md). It carries NO options —
// the approval dialog's choices are Claude Code's own UI — so the plan only rides the PTY-classified
// menu block for display; the operator still approves in the terminal.

/** Plan text kept per block; longer plans are cut (the full plan stays in the terminal). */
export const PLAN_MAX = 32_000;

/** An ExitPlanMode approval dialog the agent is waiting on, keyed by its tool_use id. */
export interface PendingPlan {
  toolUseId: string;
  /** Untrusted agent text — clients render it as plain text only. */
  plan: string;
  /** True when `plan` was cut at {@link PLAN_MAX}. */
  truncated: boolean;
}

/**
 * Validate an untrusted ExitPlanMode `tool_input`. Needs a non-blank string `plan`; `planFilePath`
 * (a host path) and any other field are dropped. Never throws.
 */
export function parsePlanInput(input: unknown): Omit<PendingPlan, "toolUseId"> | null {
  const plan =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>).plan : null;
  if (typeof plan !== "string" || !plan.trim()) return null;
  return plan.length > PLAN_MAX
    ? { plan: plan.slice(0, PLAN_MAX), truncated: true }
    : { plan, truncated: false };
}
