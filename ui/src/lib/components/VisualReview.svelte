<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import RichTextBlock from "./blocks/RichTextBlock.svelte";
  import CalloutBlock from "./blocks/CalloutBlock.svelte";
  import FileTreeBlock from "./blocks/FileTreeBlock.svelte";
  import DiffBlock from "./blocks/DiffBlock.svelte";
  import { m } from "$lib/paraglide/messages";

  let { blocks }: { blocks: VisualBlock[] } = $props();

  const firstDiffIndex = $derived(blocks.findIndex((b) => b.type === "diff"));
</script>

<div class="visual-review">
  {#each blocks as block, i (block.id)}
    {#if block.type === "rich-text"}
      <RichTextBlock {block} />
    {:else if block.type === "callout"}
      <CalloutBlock {block} />
    {:else if block.type === "file-tree"}
      <FileTreeBlock {block} />
    {:else if block.type === "diff"}
      {#if i === firstDiffIndex}
        <h4 class="vr-highlight-head">{m.vblock_diff_highlighted_heading()}</h4>
      {/if}
      <DiffBlock {block} />
    {/if}
  {/each}
</div>

<style>
  .visual-review {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .vr-highlight-head {
    margin: 0 0 4px 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }
</style>
