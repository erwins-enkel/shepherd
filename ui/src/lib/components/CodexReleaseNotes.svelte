<script lang="ts">
  import { renderCodexReleaseMarkdown } from "$lib/codex-release-notes-renderer";

  let {
    version,
    body,
    renderMarkdown = renderCodexReleaseMarkdown,
  }: {
    version: string;
    body: string;
    renderMarkdown?: typeof renderCodexReleaseMarkdown;
  } = $props();

  let rendered = $state("");
  let failed = $state(false);

  $effect(() => {
    let alive = true;
    rendered = "";
    failed = false;
    renderMarkdown(body, version)
      .then((html) => {
        if (alive) rendered = html;
      })
      .catch((error) => {
        console.warn("codex release notes markdown render failed", error);
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });
</script>

{#if rendered}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- Codex-only closed renderer + DOMPurify -->
  <div class="release-markdown">{@html rendered}</div>
{:else if failed}
  <pre class="release-fallback">{body}</pre>
{/if}

<style>
  .release-markdown,
  .release-fallback {
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.55;
  }
  .release-fallback {
    margin: 0;
    white-space: pre-wrap;
  }
  .release-markdown :global(:first-child) {
    margin-top: 0;
  }
  .release-markdown :global(:last-child) {
    margin-bottom: 0;
  }
  .release-markdown :global(a) {
    color: var(--color-amber);
  }
  .release-markdown :global(pre) {
    overflow-x: auto;
    padding: 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
  }
  .release-markdown :global(code) {
    font-size: var(--fs-meta);
  }
  .release-markdown :global(table) {
    width: 100%;
    border-collapse: collapse;
  }
  .release-markdown :global(th),
  .release-markdown :global(td) {
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    text-align: left;
  }
</style>
