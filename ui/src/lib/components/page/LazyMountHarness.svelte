<script lang="ts">
  import type { Loader } from "#lib/lazy-component.js";
  import LazyMount from "./LazyMount.svelte";
  import type LazyMountProbe from "./LazyMountProbe.svelte";

  let { load }: { load: Loader<typeof LazyMountProbe> } = $props();
</script>

<LazyMount {load}>{#snippet children(Probe)}<Probe label="loaded" />{/snippet}</LazyMount>
