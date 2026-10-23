<script lang="ts">
  // Test-only harness: calls steerLogs.refresh from a tracked $effect, the way UnitRow does.
  import { steerLogs } from "./steerLogs.svelte";

  let { sessionId }: { sessionId: string } = $props();

  $effect(() => {
    void steerLogs.refresh(sessionId);
  });
</script>
