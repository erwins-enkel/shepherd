<script lang="ts">
  import type { Snippet } from "svelte";

  // One telemetry-menu row, shared by the desktop popover and the mobile sheet:
  // 16/20px glyph column · label · optional right-aligned readout. Renders an <a>
  // when href is set (external links), else a <button>. Plain elements — never
  // role=menuitem (both surfaces are dialogs); data-gear-row feeds the popover's
  // roving focus. Flat tonal states only: hover lift, focus = same lift + a
  // brightened inset hairline ring (the handoff's "no glow rings", never
  // no-indicator).
  let {
    label,
    glyph = "",
    glyphIcon,
    meta = "",
    metaFaint = false,
    href = "",
    ariaLabel = "",
    mobile = false,
    support = false,
    warm = false,
    onclick,
  }: {
    label: string;
    /** Monochrome text glyph for the leading column ("" = none). */
    glyph?: string;
    /** SVG alternative to `glyph` — rendered by the caller (caller styles its size). */
    glyphIcon?: Snippet;
    meta?: string;
    metaFaint?: boolean;
    /** Renders an external-link <a> instead of a <button>. */
    href?: string;
    ariaLabel?: string;
    mobile?: boolean;
    /** Support-group tier: tighter padding (desktop) / 44px + smaller type (sheet). */
    support?: boolean;
    /** Amber attention tone (updates, error diagnostics). */
    warm?: boolean;
    onclick?: () => void;
  } = $props();
</script>

{#snippet body()}
  {#if glyphIcon}
    {@render glyphIcon()}
  {:else if glyph}
    <span class="glyph" aria-hidden="true">{glyph}</span>
  {/if}
  <span class="row-label">{label}</span>
  {#if meta}
    <span class="row-meta" class:faint={metaFaint}>{meta}</span>
  {/if}
{/snippet}

{#if href}
  <a
    class={["row", { mobile, support, warm }]}
    data-gear-row
    {href}
    target="_blank"
    rel="external noreferrer noopener"
    aria-label={ariaLabel || undefined}
    {onclick}
  >
    {@render body()}
  </a>
{:else}
  <button
    class={["row", { mobile, support, warm }]}
    type="button"
    data-gear-row
    aria-label={ariaLabel || undefined}
    {onclick}
  >
    {@render body()}
  </button>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 12px;
    background: transparent;
    border: 0;
    font: inherit;
    font-size: var(--fs-base);
    color: var(--color-ink);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: none;
    box-sizing: border-box;
  }
  .row.support {
    padding: 6px 12px;
  }
  .glyph {
    width: 16px;
    text-align: center;
    color: var(--color-muted);
    flex-shrink: 0;
  }
  .row-meta {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .row-meta.faint {
    color: var(--color-faint);
  }
  .row:hover {
    background: var(--color-hover);
  }
  .row:focus-visible {
    outline: none;
    background: var(--color-hover);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  /* Amber attention tone; text glyphs inherit it, SVG glyphs pick it up via
     currentColor from the row. */
  .row.warm {
    color: var(--color-amber);
  }
  .row.warm .glyph {
    color: inherit;
  }
  /* Sheet scale: 48px workspace/plugin tier (44px support), 16px text, 20px glyph
     column, sheet gutters. */
  .row.mobile {
    min-height: 48px;
    padding: 0 20px;
    font-size: var(--fs-lg);
  }
  .row.mobile .glyph {
    width: 20px;
  }
  .row.mobile .row-meta {
    font-size: var(--fs-meta);
  }
  .row.mobile.support {
    min-height: 44px;
    font-size: var(--fs-base);
  }
  @media (pointer: coarse) {
    .row {
      min-height: 44px;
    }
  }
</style>
