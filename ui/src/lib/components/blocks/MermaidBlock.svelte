<script module lang="ts">
  // Module-level counter: globally unique render ids across all MermaidBlock instances.
  let renderCounter = 0;
</script>

<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { theme } from "$lib/theme.svelte";
  import InferredBadge from "./InferredBadge.svelte";
  import DiagramLightbox from "./DiagramLightbox.svelte";

  let { block }: { block: Extract<VisualBlock, { type: "mermaid" }> } = $props();

  let svg = $state<string | null>(null);
  let error = $state<boolean>(false);
  // Click the diagram to inspect it near-fullscreen (zoom + pan) — inline it's
  // capped to the plan column and complex graphs render too small to read.
  let zoomed = $state(false);

  $effect(() => {
    // Read reactive deps at top so the effect re-runs on theme/contrast change.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reactive dep
    const resolved = theme.resolved;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    theme.contrast;
    const source = block.source;

    let alive = true;

    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;

        const cs = getComputedStyle(document.documentElement);
        const get = (prop: string) => cs.getPropertyValue(prop).trim();

        const bg = get("--color-bg");
        const ink = get("--color-ink-bright");
        const line = get("--color-line");
        const amber = get("--color-amber");

        const themeVariables: Record<string, string> = {};
        if (bg) themeVariables.background = bg;
        if (bg) themeVariables.mainBkg = bg;
        if (ink) themeVariables.primaryTextColor = ink;
        if (line) themeVariables.lineColor = line;
        if (amber) themeVariables.primaryColor = amber;

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          // Without this, a failed render leaves Mermaid's default error graphic
          // (the bomb / "Syntax error in text") orphaned in document.body — it leaks
          // into the UI. With it, Mermaid removes its temp node and re-throws cleanly,
          // so only our own .mb-error fallback shows.
          suppressErrorRendering: true,
          themeVariables: Object.keys(themeVariables).length > 0 ? themeVariables : undefined,
        });

        const safeId = block.id.replace(/[^a-zA-Z0-9_-]/g, "-");
        const id = `mm-${safeId}-${++renderCounter}`;
        const result = await mermaid.render(id, source);

        if (alive) {
          svg = result.svg;
          error = false;
        }
      } catch (e) {
        // Diagnostic only — Mermaid's message is English, so it must NOT reach the
        // localized UI (that would re-leak untranslated internals). The visible
        // fallback stays localized (m.vblock_mermaid_error) + raw source.
        console.error("MermaidBlock render failed", e);
        if (alive) {
          svg = null;
          error = true;
        }
      }
    })();

    return () => {
      alive = false;
    };
  });
</script>

<div class="mermaid-block">
  <div class="mb-header">
    <InferredBadge />
  </div>
  {#if error}
    <div class="mb-error">
      <span class="mb-error-msg">{m.vblock_mermaid_error()}</span>
      <pre class="mb-source">{block.source}</pre>
    </div>
  {:else if svg !== null}
    <button
      type="button"
      class="mb-svg"
      onclick={() => (zoomed = true)}
      aria-label={m.vblock_mermaid_expand()}
    >
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- mermaid securityLevel:"strict" sanitizes output -->
      {@html svg}
      <span class="mb-zoom" aria-hidden="true">⤢</span>
    </button>
  {/if}
  {#if block.caption}
    <p class="mb-caption">{block.caption}</p>
  {/if}
</div>

{#if zoomed && svg}
  <DiagramLightbox {svg} title={block.caption} onclose={() => (zoomed = false)} />
{/if}

<style>
  .mermaid-block {
    display: flex;
    flex-direction: column;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }
  .mb-header {
    display: flex;
    align-items: center;
    padding: 4px 10px;
    border-bottom: 1px solid var(--color-line);
  }
  /* the rendered SVG is the click target — reset the button, keep the inset look,
     and hint that it opens larger (cursor + corner glyph on hover/focus) */
  .mb-svg {
    position: relative;
    display: block;
    width: 100%;
    padding: 12px;
    overflow-x: auto;
    background: transparent;
    border: 0;
    font: inherit;
    text-align: left;
    cursor: zoom-in;
  }
  .mb-svg :global(svg) {
    display: block;
    max-width: 100%;
    height: auto;
  }
  .mb-zoom {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-panel);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1;
    opacity: 0;
    transition: opacity 0.12s;
    pointer-events: none;
  }
  .mb-svg:hover .mb-zoom,
  .mb-svg:focus-visible .mb-zoom {
    opacity: 1;
  }
  .mb-svg:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .mb-error {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
  }
  .mb-error-msg {
    font-size: var(--fs-meta);
    color: var(--color-amber);
  }
  .mb-source {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    padding: 8px 10px;
    margin: 0;
    overflow-x: auto;
    white-space: pre;
  }
  .mb-caption {
    padding: 4px 10px 8px;
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    border-top: 1px solid var(--color-line);
  }
</style>
