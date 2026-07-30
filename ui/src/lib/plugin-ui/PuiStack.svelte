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
  style:flex-wrap={direction === "horizontal" ? "wrap" : "nowrap"}
  style:gap
>
  {#each children as child, i (i)}
    <PluginUIRenderer node={child} />
  {/each}
</div>

<style>
  /* `flex-wrap` is set inline per direction, NOT here. Wrapping is only meaningful for a
     horizontal stack; on a vertical one `wrap` made this a MULTI-LINE COLUMN container,
     whose flex line is sized to the widest child's intrinsic width instead of to the
     container — so one over-wide child (e.g. a <select> with a long option) stretched every
     sibling past the panel and scrolled the settings pane sideways on a phone. */
  .pui-stack {
    display: flex;
    /* A nested stack is itself a flex item, whose default `min-width: auto` is its
       min-content width — and a <select>'s min-content is its full intrinsic width, so
       without this a nested stack could not shrink and overflowed the panel instead. */
    min-width: 0;
  }
</style>
