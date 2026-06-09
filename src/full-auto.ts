import type { Session } from "./types";
import type { RepoConfig } from "./store";
import { effectiveAutopilot } from "./effective-autopilot";

/**
 * A session is "full-auto" — the merge train carries its PR all the way to a merge — when
 * BOTH autopilot AND auto-merge resolve true (a per-session override wins, else the repo
 * default). Single source of truth shared by the merge train (which only lands full-auto
 * sessions), the drain (which leaves full-auto sessions for the train but still retires the
 * rest, so a non-full-auto session in an auto-merge repo never deadlocks a maxAuto slot), and
 * the autopilot stand-down resolver. Keeping one definition prevents the three from drifting.
 *
 * When the repo has draftMode on, the merge half is forced OFF regardless of any per-session
 * autoMergeEnabled override — draft PRs must go through sign-off before they can be landed.
 */
export function isFullAuto(
  s: Pick<Session, "autopilotEnabled" | "autoMergeEnabled">,
  cfg: Pick<RepoConfig, "autopilotEnabled" | "autoMergeEnabled" | "draftMode">,
): boolean {
  const autopilot = effectiveAutopilot(s, cfg.autopilotEnabled);
  const merge = cfg.draftMode ? false : (s.autoMergeEnabled ?? cfg.autoMergeEnabled);
  return autopilot && merge;
}
