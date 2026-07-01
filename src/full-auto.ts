import type { Session } from "./types";
import type { RepoConfig } from "./store";
import { effectiveAutopilot } from "./effective-autopilot";
import { isEpicIntegrationBranch } from "./epic-branch";

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
  s: Pick<Session, "autopilotEnabled" | "autoMergeEnabled" | "baseBranch" | "agentProvider"> & {
    isolated?: boolean;
  },
  cfg: Pick<RepoConfig, "autopilotEnabled" | "autoMergeEnabled" | "draftMode">,
): boolean {
  // Epic children are squash-merged into their integration branch by the drain's retire path,
  // never carried by the merge train — exclude them regardless of repo auto-merge config.
  if (isEpicIntegrationBranch(s.baseBranch)) return false;
  // Codex can only be carried by full-auto when Shepherd owns an isolated worktree. Rebase/CI
  // recovery may resume the pane, and Codex resume is currently `codex resume --last`; in a shared
  // cwd that can target a sibling Codex session. This mirrors autopilot.ts's isolated-session guard
  // while still letting isolated Codex autopilot use the same post-PR recovery path as Claude.
  if ((s.agentProvider ?? "claude") === "codex" && s.isolated !== true) return false;
  const autopilot = effectiveAutopilot(s, cfg.autopilotEnabled);
  const merge = cfg.draftMode ? false : (s.autoMergeEnabled ?? cfg.autoMergeEnabled);
  return autopilot && merge;
}
