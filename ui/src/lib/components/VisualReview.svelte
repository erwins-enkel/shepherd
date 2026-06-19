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
  import WireframeBlock from "./blocks/WireframeBlock.svelte";
  import QuestionFormBlock from "./blocks/QuestionFormBlock.svelte";
  import { m } from "$lib/paraglide/messages";

  // `answerCtx` (plan gate, planning phase only) makes question-form blocks interactive; absent in
  // read-only contexts (recap / Done panels), where the form renders disabled.
  let {
    blocks,
    answerCtx,
  }: { blocks: VisualBlock[]; answerCtx?: { sessionId: string; locked: boolean } } = $props();

  // Dispatch table — block.type → its renderer. Using `satisfies` enforces key-exhaustiveness
  // (a missing block type is a compile error) while keeping the value cast localised to the use site.
  const COMPONENTS = {
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
    wireframe: WireframeBlock,
    "question-form": QuestionFormBlock,
  } satisfies Record<VisualBlock["type"], unknown>;

  const firstDiffIndex = $derived(blocks.findIndex((b) => b.type === "diff"));
</script>

<div class="visual-review">
  {#each blocks as block, i (block.id)}
    {#if block.type === "diff" && i === firstDiffIndex}
      <h4 class="vr-highlight-head">{m.vblock_diff_highlighted_heading()}</h4>
    {/if}
    {#if block.type === "question-form"}
      <QuestionFormBlock {block} {answerCtx} />
    {:else}
      {@const Block = COMPONENTS[block.type] as unknown as Component<{ block: VisualBlock }>}
      {#if Block}
        <Block {block} />
      {/if}
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
