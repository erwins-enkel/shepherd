<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { PLUGIN_UI_REGISTRY } from "./registry";
  import UnknownNodeTile from "./UnknownNodeTile.svelte";

  let { node }: { node: PluginUINode } = $props();
  const Comp = $derived(
    Object.hasOwn(PLUGIN_UI_REGISTRY, node.type) ? PLUGIN_UI_REGISTRY[node.type] : undefined,
  );
</script>

{#if Comp}<Comp {node} />{:else}<UnknownNodeTile type={node.type} />{/if}
