<script lang="ts">
  import type { VisualBlock } from "$lib/types";

  let { block }: { block: Extract<VisualBlock, { type: "checklist" }> } = $props();
</script>

<ul class="cl-list">
  {#each block.items as item (item.id)}
    <li class="cl-item" class:cl-checked={item.checked} class:cl-unchecked={item.checked === false}>
      <span class="cl-glyph" aria-hidden="true">{item.checked ? "☑" : "☐"}</span>
      <span class="cl-label">{item.label}</span>
      {#if item.note}
        <span class="cl-note">{item.note}</span>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .cl-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cl-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.5;
  }
  .cl-checked .cl-label {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .cl-glyph {
    flex-shrink: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .cl-checked .cl-glyph {
    color: var(--color-green);
  }
  .cl-label {
    flex: 1;
  }
  .cl-note {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    flex-shrink: 0;
  }
</style>
