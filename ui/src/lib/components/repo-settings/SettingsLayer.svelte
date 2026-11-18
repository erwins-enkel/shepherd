<script lang="ts">
  import type { Snippet } from "svelte";
  import { provideSettingsLayer, type SettingsLayer } from "./repo-config-editor.svelte.js";
  let { layer, children }: { layer: SettingsLayer; children: Snippet } = $props();
  // Each instance has a fixed layer for its lifetime.
  // svelte-ignore state_referenced_locally
  provideSettingsLayer(layer);
</script>

{@render children()}
