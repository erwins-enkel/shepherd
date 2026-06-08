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
 */
export function isFullAuto(
  s: Pick<Session, "autopilotEnabled" | "autoMergeEnabled">,
  cfg: Pick<RepoConfig, "autopilotEnabled" | "autoMergeEnabled">,
): boolean {
  const autopilot = effectiveAutopilot(s, cfg.autopilotEnabled);
  const merge = s.autoMergeEnabled ?? cfg.autoMergeEnabled;
  return autopilot && merge;
}
