<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import CodeBlock from "./CodeBlock.svelte";

  let { block }: { block: Extract<VisualBlock, { type: "annotated-code" }> } = $props();

  // Expose the inner block as a "code" type for CodeBlock.
  const codeBlock = $derived({
    type: "code" as const,
    id: block.id,
    filename: block.filename,
    language: block.language,
    code: block.code,
    truncated: block.truncated,
  });
</script>

<div class="acb-root">
  <CodeBlock block={codeBlock} />
  {#if block.annotations && block.annotations.length > 0}
    <ul class="acb-annotations">
      {#each block.annotations as ann, i (i)}
        <li class="acb-ann">
          {#if ann.label}<strong>{ann.label}</strong>
          {/if}{ann.note}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .acb-root {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .acb-annotations {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .acb-ann {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
    padding: 4px 10px;
    background: var(--color-inset);
    border-left: 2px solid var(--color-line-bright);
  }
</style>
