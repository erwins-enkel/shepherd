<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { HeldTask } from "#lib/types.js";

  // Names the predecessor an `after` hold waits on (#2589); renders nothing for other holds.
  let { task }: { task: HeldTask } = $props();
</script>

{#if task.reason === "after"}
  <span class="held-row-after"
    >{task.afterDesig
      ? m.topbar_held_after({ task: task.afterDesig })
      : m.topbar_held_after_unknown()}</span
  >
{/if}

<style>
  .held-row-after {
    min-width: 0;
    color: var(--color-muted);
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
