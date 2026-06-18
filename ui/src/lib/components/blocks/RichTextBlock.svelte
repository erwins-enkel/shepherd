<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  let { block }: { block: Extract<VisualBlock, { type: "rich-text" }> } = $props();
  let rendered = $state("");
  $effect(() => {
    const md = block.markdown;
    if (!md) {
      rendered = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (alive) rendered = DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
      })
      .catch((err) => console.warn("RichTextBlock markdown render failed", err));
    return () => {
      alive = false;
    };
  });
</script>

{#if rendered}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
  <div class="rt-md">{@html rendered}</div>
{/if}

<style>
  .rt-md {
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.5;
  }
  .rt-md :global(p) {
    margin: 0 0 8px 0;
  }
  .rt-md :global(ul),
  .rt-md :global(ol) {
    margin: 0 0 8px 0;
    padding-left: 18px;
  }
  .rt-md :global(a) {
    color: var(--color-amber);
  }
  .rt-md :global(code) {
    font-size: var(--fs-meta);
  }
</style>
