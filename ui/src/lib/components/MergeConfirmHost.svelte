<script lang="ts">
  import MergeConfirmDialog from "./MergeConfirmDialog.svelte";
  import type { MergeConfirmFlow } from "./merge-confirm-flow.svelte";

  // Renders a merge confirmation while its flow is open, and wires the two answers back to it.
  // Every manual merge entry point mounts one of these unconditionally, so the "is the dialog
  // open" branch lives here once instead of in five host templates — several of which are large
  // enough to be under a complexity cap.
  let { flow }: { flow: MergeConfirmFlow } = $props();
</script>

{#if flow.ctx}
  <MergeConfirmDialog
    ctx={flow.ctx}
    busy={flow.busy}
    error={flow.error}
    onclose={() => flow.close()}
    onconfirm={() => flow.confirm()}
  />
{/if}
