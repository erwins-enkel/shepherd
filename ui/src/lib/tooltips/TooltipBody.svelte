<script lang="ts">
  import type { TooltipContent } from "./content";

  // `wide`: a roomy panel (e.g. the session status panel) — sections flow into columns where
  // the width allows and stack again on a narrow viewport.
  let { content, wide = false }: { content: TooltipContent; wide?: boolean } = $props();

  const MARK = { ok: "✓", run: "◷", fail: "✕", warn: "!", idle: "·" } as const;
</script>

<!-- Phrasing elements keep this valid inside GlossaryTerm's inline disclosure,
     including when its trigger sits inside a paragraph. Never render raw HTML. -->
<span class={wide ? "tooltip-body wide" : "tooltip-body"}>
  {#if typeof content === "string"}
    {content}
  {:else}
    <strong class="tooltip-title">{content.title}</strong>
    <span class="tooltip-summary">{content.summary}</span>
    <span class="tooltip-sections">
      {#each content.sections as section, index (index)}
        <span class="tooltip-section">
          <strong class="tooltip-label">{section.label}</strong>
          {#if section.text}<span>{section.text}</span>{/if}
          {#if section.rows?.length}
            <span class="tooltip-rows">
              {#each section.rows as row, r (r)}
                <span class="tooltip-row tone-{row.tone ?? 'idle'}">
                  <span class="tooltip-mark" aria-hidden="true">{MARK[row.tone ?? "idle"]}</span>
                  <span class="tooltip-row-text">{row.text}</span>
                  {#if row.aside}<span class="tooltip-aside">{row.aside}</span>{/if}
                </span>
              {/each}
            </span>
          {/if}
        </span>
      {/each}
    </span>
  {/if}
</span>

<style>
  .tooltip-body {
    display: block;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    font-weight: 400;
    line-height: 1.55;
    text-align: left;
    text-transform: none;
    letter-spacing: normal;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .tooltip-title {
    display: block;
    margin-bottom: 6px;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.35;
  }

  .tooltip-summary {
    display: block;
  }

  .tooltip-sections {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }

  .tooltip-sections:empty {
    display: none;
  }

  .tooltip-section,
  .tooltip-label {
    display: block;
  }

  .tooltip-label {
    margin-bottom: 2px;
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .wide .tooltip-sections {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr));
    column-gap: 20px;
  }

  .tooltip-rows {
    display: grid;
    gap: 2px;
    margin-top: 2px;
  }

  .tooltip-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }

  .tooltip-mark {
    flex: none;
    width: 1ch;
    text-align: center;
    color: var(--color-muted);
  }

  /* Status marks follow CI's own hues (Stepper's ci-* segments): passing green, running amber,
     red failing, caution warn. The glyph differs per tone too, so hue never stands alone. */
  .tone-ok .tooltip-mark {
    color: var(--color-green);
  }
  .tone-run .tooltip-mark {
    color: var(--status-running);
  }
  .tone-fail .tooltip-mark {
    color: var(--color-red);
  }
  .tone-warn .tooltip-mark {
    color: var(--status-warn);
  }

  .tooltip-row-text {
    min-width: 0;
  }

  .tooltip-aside {
    margin-left: auto;
    flex: none;
    padding-left: 8px;
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
