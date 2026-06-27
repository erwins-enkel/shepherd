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
  s: Pick<Session, "autopilotEnabled" | "autoMergeEnabled" | "baseBranch" | "agentProvider">,
  cfg: Pick<RepoConfig, "autopilotEnabled" | "autoMergeEnabled" | "draftMode">,
): boolean {
  // Epic children are squash-merged into their integration branch by the drain's retire path,
  // never carried by the merge train — exclude them regardless of repo auto-merge config.
  if (isEpicIntegrationBranch(s.baseBranch)) return false;
  // Codex autopilot deliberately ends AT the open PR ("bis zum PR"): never landed by the merge
  // train, never driven past the PR. (Codex autopilot is best-effort/Alpha; auto-merge for codex
  // is explicitly out of scope.) The isolation guard in autopilot.ts eligible() does not cover
  // the merge-train/drain legs, which call isFullAuto directly — so the cutoff lives here.
  if ((s.agentProvider ?? "claude") === "codex") return false;
  const autopilot = effectiveAutopilot(s, cfg.autopilotEnabled);
  const merge = cfg.draftMode ? false : (s.autoMergeEnabled ?? cfg.autoMergeEnabled);
  return autopilot && merge;
}
