<script module lang="ts">
  // Module-level counter: globally unique render ids across all MermaidBlock instances.
  let renderCounter = 0;
</script>

<script lang="ts">
  import type { VisualBlock } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { theme } from "$lib/theme.svelte";
  import InferredBadge from "./InferredBadge.svelte";

  let { block }: { block: Extract<VisualBlock, { type: "mermaid" }> } = $props();

  let svg = $state<string | null>(null);
  let error = $state<boolean>(false);

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
          themeVariables: Object.keys(themeVariables).length > 0 ? themeVariables : undefined,
        });

        const id = `mm-${block.id}-${++renderCounter}`;
        const result = await mermaid.render(id, source);

        if (alive) {
          svg = result.svg;
          error = false;
        }
      } catch {
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
    <div class="mb-svg">
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- mermaid securityLevel:"strict" sanitizes output -->
      {@html svg}
    </div>
  {/if}
  {#if block.caption}
    <p class="mb-caption">{block.caption}</p>
  {/if}
</div>

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
  .mb-svg {
    padding: 12px;
    overflow-x: auto;
  }
  .mb-svg :global(svg) {
    display: block;
    max-width: 100%;
    height: auto;
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
