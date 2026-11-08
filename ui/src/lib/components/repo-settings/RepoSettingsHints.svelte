<script lang="ts">
  import type { DrainStatus } from "#lib/types.js";
  import AutomationNoPrCiHold from "../automation-settings/AutomationNoPrCiHold.svelte";
  import RepoEpicHaltHint from "./RepoEpicHaltHint.svelte";

  // What needs attention in this repo's settings (#3443), above its sections — each card only
  // while it applies.
  let {
    repoPath,
    drain = null,
    onsetupci,
  }: {
    repoPath: string;
    drain?: DrainStatus | null;
    /** Seed a New Task that sets up PR CI for this repo; absent hides that action. */
    onsetupci?: () => void;
  } = $props();
</script>

<AutomationNoPrCiHold {repoPath} {onsetupci} />
<RepoEpicHaltHint {repoPath} {drain} />
