<script lang="ts">
  import type { Loader } from "#lib/lazy-component.js";
  import LazyMount from "./LazyMount.svelte";
  import type LazyMountProbe from "./LazyMountProbe.svelte";

  let { load, onerror }: { load: Loader<typeof LazyMountProbe>; onerror?: () => void } = $props();
</script>

<LazyMount {load} {onerror}>{#snippet children(Probe)}<Probe label="loaded" />{/snippet}</LazyMount>
