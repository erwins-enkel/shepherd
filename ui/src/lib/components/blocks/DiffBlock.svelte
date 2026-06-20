<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import DiffFileBlock from "../DiffFileBlock.svelte";

  let { block }: { block: Extract<VisualBlock, { type: "diff" }> } = $props();
</script>

<div class="diff-block">
  <p class="db-summary">{block.summary}</p>

  {#if block.file}
    <DiffFileBlock file={block.file} />
  {:else}
    <p class="db-fallback">{block.path}</p>
  {/if}

  {#if block.annotations && block.annotations.length > 0}
    <ul class="db-annotations">
      {#each block.annotations as ann, i (i)}
        <li class="db-ann">
          {#if ann.label}<strong>{ann.label}</strong>{/if}{ann.label ? " " : ""}{ann.note}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .diff-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .db-summary {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .db-fallback {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-family: var(--font-mono);
  }
  .db-annotations {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .db-ann {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    line-height: 1.5;
  }
</style>
