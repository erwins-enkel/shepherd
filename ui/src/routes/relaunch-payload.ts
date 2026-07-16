import type { LaunchUiState, RelaunchOverrides } from "$lib/types";

/** Build the exact payload submitted by the relaunch form. */
export function relaunchOverrides(input: {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  images: string[];
  attachmentNames?: string[];
  launchUiState?: LaunchUiState;
  planGateEnabled: boolean | null;
  autopilotEnabled: boolean | null;
}): RelaunchOverrides {
  return {
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    prompt: input.prompt,
    model: input.model,
    effort: input.effort,
    planGateEnabled: input.planGateEnabled,
    autopilotEnabled: input.autopilotEnabled,
    images: input.images,
    attachmentNames: input.attachmentNames,
    launchUiState: input.launchUiState,
  };
}
