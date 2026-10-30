<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { HeldTask } from "#lib/types.js";

  // Names what a non-usage hold waits on: the predecessor of an `after` hold (#2589), or memory
  // for a start the pressure brake holds. Renders nothing for usage and capacity holds.
  let { task }: { task: HeldTask } = $props();
</script>

{#if task.reason === "after"}
  <span class="held-row-reason"
    >{task.afterDesig
      ? m.topbar_held_after({ task: task.afterDesig })
      : m.topbar_held_after_unknown()}</span
  >
{:else if task.reason === "memory"}
  <span class="held-row-reason">{m.topbar_held_memory()}</span>
{/if}

<style>
  .held-row-reason {
    min-width: 0;
    color: var(--color-muted);
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
