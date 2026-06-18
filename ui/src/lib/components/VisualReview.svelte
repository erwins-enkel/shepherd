<script lang="ts">
  import type { Component } from "svelte";
  import type { VisualBlock } from "$lib/types";
  import RichTextBlock from "./blocks/RichTextBlock.svelte";
  import CalloutBlock from "./blocks/CalloutBlock.svelte";
  import FileTreeBlock from "./blocks/FileTreeBlock.svelte";
  import DiffBlock from "./blocks/DiffBlock.svelte";
  import CodeBlock from "./blocks/CodeBlock.svelte";
  import AnnotatedCodeBlock from "./blocks/AnnotatedCodeBlock.svelte";
  import DataModelBlock from "./blocks/DataModelBlock.svelte";
  import ApiEndpointBlock from "./blocks/ApiEndpointBlock.svelte";
  import TableBlock from "./blocks/TableBlock.svelte";
  import ChecklistBlock from "./blocks/ChecklistBlock.svelte";
  import MermaidBlock from "./blocks/MermaidBlock.svelte";
  import { m } from "$lib/paraglide/messages";

  let { blocks }: { blocks: VisualBlock[] } = $props();

  // Dispatch table — block.type → its renderer. Each block component narrows `block`
  // to its own variant internally; the map is typed loosely here because a dispatcher
  // is inherently heterogeneous.
  const COMPONENTS: Record<VisualBlock["type"], Component<{ block: VisualBlock }>> = {
    "rich-text": RichTextBlock,
    callout: CalloutBlock,
    "file-tree": FileTreeBlock,
    diff: DiffBlock,
    code: CodeBlock,
    "annotated-code": AnnotatedCodeBlock,
    "data-model": DataModelBlock,
    "api-endpoint": ApiEndpointBlock,
    table: TableBlock,
    checklist: ChecklistBlock,
    mermaid: MermaidBlock,
  } as unknown as Record<VisualBlock["type"], Component<{ block: VisualBlock }>>;

  const firstDiffIndex = $derived(blocks.findIndex((b) => b.type === "diff"));
</script>

<div class="visual-review">
  {#each blocks as block, i (block.id)}
    {#if block.type === "diff" && i === firstDiffIndex}
      <h4 class="vr-highlight-head">{m.vblock_diff_highlighted_heading()}</h4>
    {/if}
    {@const Block = COMPONENTS[block.type]}
    {#if Block}
      <Block {block} />
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
