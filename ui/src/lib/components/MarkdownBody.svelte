<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";

  // Shared reading surface for forge Markdown (issue descriptions, #2617): renders `source`
  // through marked + DOMPurify, styled from tokens only. Same lazy-import recipe as GitRail's
  // review body — marked/DOMPurify stay off the first-paint critical path, and the browser-only
  // sanitizer never runs during SSR (effects don't run there).
  let { source }: { source: string } = $props();

  let rendered = $state("");
  // A failed load falls back to the plain (escaped) text — never to unsanitized markup.
  let failed = $state(false);
  $effect(() => {
    const body = source;
    rendered = "";
    failed = false;
    if (!body.trim()) return;
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (alive) rendered = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
      })
      .catch((e) => {
        console.warn("Markdown render failed", e);
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });

  // Links in a forge body point off-app; following one in place would navigate the whole app
  // away (and drop the open dialog). Open them in a new tab instead — a container handler, so
  // no global DOMPurify hook leaks into the other consumers of the shared sanitizer.
  function onclick(e: MouseEvent) {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!(a instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    window.open(a.href, "_blank", "noopener");
  }
</script>

{#if !source.trim()}
  <p class="md-empty">{m.issuedetail_no_description()}</p>
{:else if failed}
  <div class="md-body md-plain">{source}</div>
{:else}
  <!-- The handler only delegates clicks on the (keyboard-reachable) links inside; Enter on a
       focused link fires `click` too, so there is no separate key path to add. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
  <div class="md-body" {onclick}>{@html rendered}</div>
{/if}

<style>
  .md-body {
    min-width: 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .md-plain {
    white-space: pre-wrap;
  }
  .md-empty {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-base);
  }
  .md-body :global(> *:first-child) {
    margin-top: 0;
  }
  .md-body :global(> *:last-child) {
    margin-bottom: 0;
  }
  .md-body :global(p),
  .md-body :global(ul),
  .md-body :global(ol),
  .md-body :global(pre),
  .md-body :global(blockquote),
  .md-body :global(table) {
    margin: 0 0 10px;
  }
  .md-body :global(h1),
  .md-body :global(h2),
  .md-body :global(h3),
  .md-body :global(h4),
  .md-body :global(h5),
  .md-body :global(h6) {
    margin: 16px 0 6px;
    color: var(--color-ink-bright);
    font-weight: 600;
    line-height: 1.3;
  }
  .md-body :global(h1) {
    font-size: var(--fs-xl);
  }
  .md-body :global(h2) {
    font-size: var(--fs-lg);
  }
  .md-body :global(h3),
  .md-body :global(h4),
  .md-body :global(h5),
  .md-body :global(h6) {
    font-size: var(--fs-base);
  }
  .md-body :global(ul),
  .md-body :global(ol) {
    padding-left: 20px;
  }
  .md-body :global(li) {
    margin: 2px 0;
  }
  /* GFM task lists: the checkbox is the marker. */
  .md-body :global(li:has(> input[type="checkbox"])) {
    list-style: none;
    margin-left: -18px;
  }
  .md-body :global(a) {
    color: var(--color-amber);
    text-decoration: underline;
  }
  .md-body :global(strong) {
    color: var(--color-ink-bright);
  }
  .md-body :global(code) {
    padding: 0 3px;
    border-radius: 2px;
    background: var(--color-inset);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .md-body :global(pre) {
    padding: 8px 10px;
    overflow-x: auto;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
  }
  .md-body :global(pre code) {
    padding: 0;
    background: transparent;
  }
  .md-body :global(blockquote) {
    padding-left: 10px;
    border-left: 2px solid var(--color-line-bright);
    color: var(--color-muted);
  }
  .md-body :global(hr) {
    margin: 12px 0;
    border: 0;
    border-top: 1px solid var(--color-line);
  }
  .md-body :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: var(--fs-meta);
  }
  .md-body :global(th),
  .md-body :global(td) {
    padding: 3px 8px;
    border: 1px solid var(--color-line);
    text-align: left;
  }
  .md-body :global(img) {
    max-width: 100%;
  }
</style>
