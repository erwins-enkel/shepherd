<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  // Intentional cycle: a stack recursively renders its children through the same
  // renderer (registry → PuiStack → PluginUIRenderer → registry). This is the
  // canonical recursive-component pattern for a tree renderer and Svelte resolves
  // it at runtime; there is no non-deprecated way to recurse without the back-edge.
  // fallow-ignore-next-line circular-dependency
  import PluginUIRenderer from "./PluginUIRenderer.svelte";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const direction = $derived(
    (p.direction as string | undefined) === "horizontal" ? "horizontal" : "vertical",
  );
  const gap = $derived(
    (p.gap as string | undefined) === "sm"
      ? "4px"
      : (p.gap as string | undefined) === "lg"
        ? "16px"
        : "8px",
  );
  const children = $derived(Array.isArray(node.children) ? node.children : []);
</script>

<div
  class="pui-stack"
  style:flex-direction={direction === "horizontal" ? "row" : "column"}
  style:gap
>
  {#each children as child, i (i)}
    <PluginUIRenderer node={child} />
  {/each}
</div>

<style>
  .pui-stack {
    display: flex;
    flex-wrap: wrap;
  }
</style>
