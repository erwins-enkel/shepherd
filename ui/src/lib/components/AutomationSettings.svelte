<script lang="ts">
  import type { DrainStatus } from "#lib/types.js";
  import AutomationPanel from "./automation-settings/AutomationPanel.svelte";
  let {
    repoPath,
    sessionId,
    drain = null,
    onsetupci,
  }: {
    repoPath: string;
    sessionId?: string;
    drain?: DrainStatus | null;
    onsetupci?: () => void;
  } = $props();
</script>

{#key repoPath}<AutomationPanel {repoPath} {sessionId} {drain} {onsetupci} />{/key}
