import { repoConfig } from "#lib/reviews.svelte.js";
import type { DrainStatus } from "#lib/types.js";

// Shared by the Agent environment (sandbox) and Start & flow (drain) sections: both say when the
// repo's sandbox holds its unattended starts (#2100). Reads the reactive store, so call it from a
// $derived.

/** Auto-Drain's rails (cap / usage ceiling) govern spawning whenever draining happens —
 *  label-drain OR a running epic. Only a local (non-forge) repo, which never drains, has none. */
export function drainRailsActive(repoPath: string, drain: DrainStatus | null | undefined): boolean {
  return (
    repoConfig.repoModeFor(repoPath) !== "lightweight" &&
    (repoConfig.isAutoDrainEnabled(repoPath) || drain?.epicParent != null)
  );
}

/** Standard is interactive-only, so drain/epic spawns in a repo that RESOLVES to it (incl. via
 *  "inherit") are held. */
export function drainSandboxHeld(repoPath: string, drain: DrainStatus | null | undefined): boolean {
  return (
    drainRailsActive(repoPath, drain) &&
    repoConfig.effectiveSandboxProfileFor(repoPath) === "standard"
  );
}
