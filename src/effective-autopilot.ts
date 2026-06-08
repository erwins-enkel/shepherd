import type { Session } from "./types";

/**
 * A session's effective autopilot opt-in: an explicit per-session override wins; a null override
 * inherits the repo default. Single source of truth shared by AutopilotService (eligibility) and
 * PlanGateService (auto-release on plan approval) so the two can't drift. Takes `getRepoConfig`
 * rather than the whole store, so it stays decoupled and trivially testable.
 */
export function effectiveAutopilot(
  s: Pick<Session, "autopilotEnabled" | "repoPath">,
  getRepoConfig: (repoPath: string) => { autopilotEnabled: boolean },
): boolean {
  if (s.autopilotEnabled !== null) return s.autopilotEnabled;
  return getRepoConfig(s.repoPath).autopilotEnabled;
}
