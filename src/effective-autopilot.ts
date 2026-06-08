import type { Session } from "./types";

/**
 * A session's effective autopilot opt-in: an explicit per-session override wins; a null override
 * falls back to the repo default. Single source of truth shared by AutopilotService (eligibility),
 * PlanGateService (auto-release on plan approval) and isFullAuto (the merge-train leg), so the
 * override-vs-default rule can't drift across them. Takes the already-resolved repo default rather
 * than the store, so it stays decoupled and trivially testable.
 */
export function effectiveAutopilot(
  s: Pick<Session, "autopilotEnabled">,
  repoDefault: boolean,
): boolean {
  return s.autopilotEnabled ?? repoDefault;
}
