<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { highlightLines } from "$lib/highlight";

  let { block }: { block: Extract<VisualBlock, { type: "code" }> } = $props();

  // Theme detection via data-theme attribute on root html element.
  function getTheme(): "dark" | "light" {
    if (typeof document === "undefined") return "dark";
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }

  let highlightedLines = $state<string[] | null>(null);

  $effect(() => {
    const code = block.code;
    if (!code) {
      highlightedLines = null;
      return;
    }
    let alive = true;
    const lines = code.split("\n");
    highlightLines(lines, block.filename, getTheme())
      .then((result) => {
        if (alive) highlightedLines = result;
      })
      .catch(() => {
        if (alive)
          highlightedLines = lines.map((l) =>
            l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
          );
      });
    return () => {
      alive = false;
    };
  });
</script>

<div class="code-block">
  <div class="cb-header">
    <span class="cb-filename">{block.filename}</span>
    {#if block.truncated}
      <span class="cb-truncated">{m.vblock_code_truncated()}</span>
    {/if}
  </div>
  {#if block.code && highlightedLines !== null}
    <div class="cb-body">
      {#each highlightedLines as line, i (i)}
        <div class="cb-line">
          <span class="cb-lineno">{i + 1}</span>
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by shiki / escapeHtml -->
          <span class="cb-code">{@html line}</span>
        </div>
      {/each}
    </div>
  {:else if block.truncated}
    <div class="cb-empty">{m.vblock_code_truncated()}</div>
  {/if}
</div>

<style>
  .code-block {
    display: flex;
    flex-direction: column;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }
  .cb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--color-line);
  }
  .cb-filename {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cb-truncated {
    font-size: var(--fs-micro);
    color: var(--color-amber);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .cb-body {
    overflow-x: auto;
    padding: 6px 0;
  }
  .cb-line {
    display: flex;
    gap: 0;
    line-height: 1.5;
  }
  .cb-lineno {
    display: inline-block;
    min-width: 40px;
    padding: 0 10px 0 10px;
    text-align: right;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-faint);
    user-select: none;
    flex-shrink: 0;
  }
  .cb-code {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    white-space: pre;
    padding-right: 16px;
  }
  .cb-empty {
    padding: 8px 10px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-style: italic;
  }
</style>
