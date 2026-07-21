<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // The Halt-herd hero action shared by the desktop popover and the mobile sheet:
  // amber ■ e-stop glyph + live "N WORKING" chip. Two-step arm→confirm (the parent
  // owns the armed state and timer); natively disabled — and chip-less — at 0
  // working so it is skipped by Tab and the popover's roving focus.
  let {
    haltable,
    armed,
    mobile = false,
    onclick,
  }: {
    haltable: number;
    armed: boolean;
    mobile?: boolean;
    onclick: () => void;
  } = $props();
</script>

<button
  class={["hero", { armed, mobile }]}
  type="button"
  data-gear-row
  disabled={haltable === 0}
  {onclick}
  aria-label={haltable === 0
    ? m.gearmenu_halt_herd()
    : armed
      ? m.halt_arm_aria({ count: haltable })
      : m.halt_all_aria({ count: haltable })}
>
  <span class="hero-glyph" aria-hidden="true">■</span>
  <span class="hero-label">{armed ? m.halt_arm({ count: haltable }) : m.gearmenu_halt_herd()}</span>
  {#if haltable > 0}
    <span class="chip">{m.gearmenu_working_chip({ count: haltable })}</span>
  {/if}
</button>

<style>
  .hero {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 12px;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--color-line);
    font: inherit;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    text-align: left;
    cursor: pointer;
    flex-shrink: 0;
  }
  .hero-glyph {
    width: 16px;
    text-align: center;
    color: var(--color-amber);
    flex-shrink: 0;
  }
  .hero:disabled {
    color: var(--color-muted);
    cursor: default;
    opacity: 0.4;
  }
  .hero:disabled .hero-glyph {
    color: var(--color-muted);
  }
  .hero:hover:not(:disabled) {
    background: var(--color-hover);
  }
  .hero:focus-visible {
    outline: none;
    background: var(--color-hover);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .chip {
    margin-left: auto;
    border: 1px solid color-mix(in srgb, var(--color-amber) 62%, var(--color-line));
    color: var(--color-amber);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 2px;
    font-variant-numeric: tabular-nums;
  }
  /* Armed e-stop: loud red confirm state, same convention as the old menu row. */
  .hero.armed {
    background: color-mix(in srgb, var(--color-red) 22%, transparent);
    color: var(--color-red);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: var(--fs-meta);
  }
  .hero.armed .hero-glyph,
  .hero.armed .chip {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  /* Sheet scale: 52px hero tier, 16px text, 20px glyph column, sheet gutters. */
  .hero.mobile {
    min-height: 52px;
    padding: 0 20px;
    font-size: var(--fs-lg);
  }
  .hero.mobile .hero-glyph {
    width: 20px;
  }
  .hero.mobile .chip {
    font-size: var(--fs-meta);
    padding: 2px 8px;
  }
  .hero.mobile.armed {
    font-size: var(--fs-base);
  }
  @media (pointer: coarse) {
    .hero {
      min-height: 44px;
    }
  }
</style>
