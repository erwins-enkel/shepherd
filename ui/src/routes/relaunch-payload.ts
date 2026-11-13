import type { LaunchUiState, RelaunchOverrides, SandboxProfile } from "#lib/types.js";

/** Build the exact payload submitted by the relaunch form. */
export function relaunchOverrides(input: {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  executionEffort?: string | null;
  images: string[];
  attachmentNames?: string[];
  launchUiState?: LaunchUiState;
  planGateEnabled: boolean | null;
  autopilotEnabled: boolean | null;
  sandboxProfile?: SandboxProfile;
}): RelaunchOverrides {
  return {
    repoPath: input.repoPath,
    baseBranch: input.baseBranch,
    prompt: input.prompt,
    model: input.model,
    effort: input.effort,
    executionEffort: input.executionEffort,
    planGateEnabled: input.planGateEnabled,
    autopilotEnabled: input.autopilotEnabled,
    // Always explicit: the composer was seeded with the original's choice, so its "Default"
    // (undefined) means inherit the repo profile — an absent key would re-carry the original's.
    sandboxProfile: input.sandboxProfile ?? null,
    images: input.images,
    attachmentNames: input.attachmentNames,
    launchUiState: input.launchUiState,
  };
}
