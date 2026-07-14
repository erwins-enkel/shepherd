<script lang="ts">
  // Leftover-subprocess dialog for the ⌘K Decommission verb — the same probe + reap flow
  // Viewport's decommission button runs, so the command-bar verb can't silently orphan a running
  // dev server. It owns its own presence check so AppOverlays' template stays a flat list of
  // overlays (its <template> sits at the Tier-1 complexity bar; one more {#if} there tips it).
  import LeftoverDialog from "$lib/components/LeftoverDialog.svelte";
  import type { Leftover } from "$lib/types";

  let {
    leftovers,
    onclose,
    onconfirm,
  }: {
    /** What the probe turned up; [] ⇒ nothing to show. */
    leftovers: Leftover[];
    /** Dismissed without picking: decommission anyway, reaping nothing. */
    onclose: () => void;
    /** Confirmed with the chosen leftovers to reap. */
    onconfirm: (keys: string[]) => void;
  } = $props();
</script>

{#if leftovers.length > 0}
  <LeftoverDialog {leftovers} {onclose} {onconfirm} />
{/if}
