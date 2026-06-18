<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import RichTextBlock from "./blocks/RichTextBlock.svelte";
  import CalloutBlock from "./blocks/CalloutBlock.svelte";
  let { blocks }: { blocks: VisualBlock[] } = $props();
</script>

<div class="visual-review">
  {#each blocks as block (block.id)}
    {#if block.type === "rich-text"}
      <RichTextBlock {block} />
    {:else if block.type === "callout"}
      <CalloutBlock {block} />
    {/if}
    <!-- file-tree + diff cases added in Task 6 -->
  {/each}
</div>

<style>
  .visual-review {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
</style>
