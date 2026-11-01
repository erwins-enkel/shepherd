<script lang="ts">
  /** An option's preview (ASCII art, a draft): literal text, aligned, scrolling inside its box. */
  let { text }: { text?: string } = $props();
</script>

{#if text}
  <pre class="qf-option-preview">{text}</pre>
{/if}

<style>
  .qf-option-preview {
    margin: 4px 0 0;
    padding: 6px 8px;
    max-height: 16em;
    overflow: auto;
    white-space: pre;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    line-height: 1.35;
    color: var(--color-ink);
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
</style>
