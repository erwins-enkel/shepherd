<script lang="ts">
  import type { GitState } from "$lib/types";
  import { prBadgeLabel } from "./pr-badge";

  let { git }: { git?: GitState } = $props();
  const label = $derived(prBadgeLabel(git));
</script>

{#if label}
  <span class="pr-badge pr-{git!.state}">{label}</span>
{/if}

<style>
  .pr-badge {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .pr-open {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .pr-merged {
    color: var(--color-slate);
  }
  .pr-none,
  .pr-closed {
    color: var(--color-faint);
  }
</style>
