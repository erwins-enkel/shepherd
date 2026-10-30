<script lang="ts">
  import { renderMarkdown } from "#lib/sanitize-html.js";
  import { linkifySessionDesignations } from "#lib/markdownSessionLinks.js";
  import { m } from "#lib/paraglide/messages.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { theme } from "#lib/theme.svelte.js";

  // Shared reading surface for forge Markdown (issue descriptions, #2617): renders `source`
  // through the shared sanitizer (#lib/sanitize-html), styled from tokens only. It loads lazily,
  // off the first-paint critical path, and never runs during SSR (effects don't run there).
  let {
    source,
    sessionDesigs = new Map(),
    onSessionLink,
    copyCode = false,
  }: {
    source: string;
    sessionDesigs?: ReadonlyMap<string, string>;
    onSessionLink?: (id: string) => void;
    /** Give each code block a hover copy button (chat replies). */
    copyCode?: boolean;
  } = $props();

  const COPY_ICON =
    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
  const CHECK_ICON = '<path d="M20 6 9 17l-5-5"/>';

  function svg(paths: string, cls: string): SVGSVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [k, v] of Object.entries({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      class: cls,
    }))
      el.setAttribute(k, v);
    el.innerHTML = paths;
    return el;
  }

  // Wraps each (already sanitized) code block with our own copy button — built here, after the
  // sanitizer, from constants only, so nothing from the Markdown source reaches the markup.
  function addCopyButtons(root: HTMLElement) {
    for (const pre of root.querySelectorAll("pre")) {
      const wrap = document.createElement("div");
      wrap.className = "md-code";
      pre.replaceWith(wrap);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icon-btn md-copy";
      btn.dataset.copyCode = "";
      btn.title = m.markdown_copy_code();
      btn.setAttribute("aria-label", m.markdown_copy_code());
      btn.append(svg(COPY_ICON, "md-copy-icon"), svg(CHECK_ICON, "md-check-icon"));
      wrap.append(pre, btn);
    }
  }

  async function copyBlock(btn: HTMLButtonElement) {
    const text = btn.closest(".md-code")?.querySelector("pre")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toasts.info(m.clipboard_copy_failed(), { alert: true });
      return;
    }
    btn.dataset.copied = "";
    btn.setAttribute("aria-label", m.markdown_code_copied());
    status = m.markdown_code_copied();
    setTimeout(() => {
      delete btn.dataset.copied;
      btn.setAttribute("aria-label", m.markdown_copy_code());
      status = "";
    }, 1500);
  }

  // Colors each tagged fence (marked's `language-<x>` class) in place. Runs after the sanitizer:
  // the code is re-read as text and re-escaped, and colors come only from our Shiki themes, so
  // nothing from the source reaches the markup. Shiki loads lazily, off the first-paint path.
  async function highlightFences(root: HTMLElement, mode: "dark" | "light"): Promise<boolean> {
    const fences = [...root.querySelectorAll<HTMLElement>("pre > code[class*='language-']")];
    if (fences.length === 0) return false;
    const { highlightCode } = await import("#lib/highlight.js");
    let changed = false;
    for (const code of fences) {
      const lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
      const html = lang ? await highlightCode(code.textContent ?? "", lang, mode) : null;
      if (html === null) continue;
      code.innerHTML = html;
      changed = true;
    }
    return changed;
  }

  let rendered = $state("");
  // A failed load falls back to the plain (escaped) text — never to unsanitized markup.
  let failed = $state(false);
  // Polite announcement for a finished copy (the button's own label swap isn't announced).
  let status = $state("");
  $effect(() => {
    const body = source;
    const live = sessionDesigs;
    const linkSessions = !!onSessionLink;
    const withCopy = copyCode;
    const mode = theme.resolved;
    rendered = "";
    failed = false;
    if (!body.trim()) return;
    let alive = true;
    // The shared sanitizer also strips `data-session-id`: that marker belongs only to links we
    // generate, never to the Markdown source.
    renderMarkdown(body)
      .then((html) => {
        if (!alive) return;
        const root = document.createElement("div");
        root.innerHTML = html;
        if (linkSessions && live.size > 0) linkifySessionDesignations(root, live);
        if (withCopy) addCopyButtons(root);
        // Plain first, colors once Shiki is ready.
        rendered = root.innerHTML;
        return highlightFences(root, mode).then(
          (changed) => {
            if (alive && changed) rendered = root.innerHTML;
          },
          (e: unknown) => console.warn("Code highlight failed", e),
        );
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
  // away (and drop the open dialog). The sanitizer already sets target=_blank; this container
  // handler also routes generated session links and keeps `noopener` on every open.
  function onclick(e: MouseEvent) {
    const copyBtn = e.target instanceof Element ? e.target.closest("button[data-copy-code]") : null;
    if (copyBtn instanceof HTMLButtonElement) {
      void copyBlock(copyBtn);
      return;
    }
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!(a instanceof HTMLAnchorElement)) return;
    e.preventDefault();
    const id = a.dataset.sessionId;
    if (id !== undefined) {
      if (sessionDesigs.get(a.textContent!.toUpperCase()) === id) onSessionLink?.(id);
      return;
    }
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
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via renderMarkdown (#lib/sanitize-html) above -->
  <div class="md-body" {onclick}>{@html rendered}</div>
  {#if copyCode}
    <span class="sr-only" role="status">{status}</span>
  {/if}
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
  .md-body :global(table),
  .md-body :global(.md-code) {
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
  /* Tailwind preflight strips list markers; restore them. */
  .md-body :global(ul) {
    list-style: disc;
  }
  .md-body :global(ol) {
    list-style: decimal;
  }
  .md-body :global(ul ul) {
    list-style: circle;
  }
  .md-body :global(li) {
    margin: 2px 0;
  }
  /* GFM task lists: the checkbox is the marker. Loose lists wrap it in a <p>. */
  .md-body
    :global(
      li:has(> input[type="checkbox"], > p:first-child > input[type="checkbox"]:first-child)
    ) {
    list-style: none;
    margin-left: -18px;
  }
  .md-body :global(a) {
    color: var(--color-amber);
    text-decoration: underline;
  }
  .md-body :global(a[data-session-id]) {
    cursor: pointer;
  }
  .md-body :global(a[data-session-id]:focus-visible) {
    outline: 1px solid var(--color-amber);
    outline-offset: 2px;
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
  .md-body :global(.md-code) {
    position: relative;
  }
  /* As specific as the `> *:last-child` reset above, so restate it for the wrapper. */
  .md-body :global(> .md-code:last-child) {
    margin-bottom: 0;
  }
  .md-body :global(.md-code > pre) {
    margin: 0;
  }
  .md-body :global(.md-copy) {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 24px;
    height: 24px;
    background: var(--color-inset);
    border-color: var(--color-line);
    opacity: 0;
    transition: opacity 0.12s;
  }
  .md-body :global(.md-copy:hover) {
    border-color: var(--color-line-bright);
  }
  .md-body :global(.md-code:hover .md-copy),
  .md-body :global(.md-copy:focus-visible),
  .md-body :global(.md-copy[data-copied]) {
    opacity: 1;
  }
  @media (hover: none) {
    .md-body :global(.md-copy) {
      opacity: 1;
    }
  }
  .md-body :global(.md-copy svg) {
    width: 14px;
    height: 14px;
  }
  .md-body :global(.md-copy .md-check-icon),
  .md-body :global(.md-copy[data-copied] .md-copy-icon) {
    display: none;
  }
  .md-body :global(.md-copy[data-copied] .md-check-icon) {
    display: block;
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
