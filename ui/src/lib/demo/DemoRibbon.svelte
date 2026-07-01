<script lang="ts">
  // Persistent marketing chrome for the demo build (Task 7). A small, honest
  // "this is a live demo" signal that reads as part of the real app rather than
  // a screen-hogging banner. Non-blocking, anchored — NOT a modal, so no
  // scrim/blur (see CLAUDE.md "Modal & scrim" scope notes: a small anchored
  // popover/pill is exempt).
  import { m } from "$lib/paraglide/messages";

  // Marketing destination for the CTA — adjust this if the landing page moves.
  const CTA_URL = "https://shepherd.run";

  let expanded = $state(false);

  function resetDemo(): void {
    // Demo state is entirely in-memory (see demo/state.ts) and re-seeds on
    // boot, so "reset" is just a reload — no live in-place reset exists.
    if (typeof location !== "undefined") location.reload();
  }
</script>

<div class="demo-ribbon" role="complementary" aria-label={m.demoribbon_aria_label()}>
  <span class="dot" aria-hidden="true"></span>
  <span class="label">{m.demoribbon_label()}</span>
  <span class="sep" aria-hidden="true">·</span>
  <span class="blurb">{m.demoribbon_blurb()}</span>
  <div class="spacer"></div>
  <a class="gbtn primary cta" href={CTA_URL} target="_blank" rel="noopener noreferrer">
    {m.demoribbon_cta()}
  </a>
  <button
    type="button"
    class="gbtn more"
    aria-expanded={expanded}
    aria-label={m.demoribbon_more_aria()}
    onclick={() => (expanded = !expanded)}
  >
    ⋯
  </button>
  {#if expanded}
    <button type="button" class="gbtn reset" onclick={resetDemo}>
      {m.demoribbon_reset()}
    </button>
  {/if}
</div>

<style>
  .demo-ribbon {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 6px 12px;
    /* min touch-target floor for the row itself, matching interactive children */
    min-height: var(--mobile-actionbar-hit);
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--color-amber);
    animation: dot-pulse 1.6s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }

  .label {
    color: var(--color-ink-bright);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .sep {
    color: var(--color-faint);
  }

  .blurb {
    color: var(--color-muted);
    /* let the explanation truncate before it pushes the CTA off small screens */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spacer {
    flex: 1 1 auto;
    min-width: 8px;
  }

  .cta {
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: var(--mobile-actionbar-hit);
    padding-inline: 12px;
    white-space: nowrap;
  }

  .more,
  .reset {
    min-height: var(--mobile-actionbar-hit);
    min-width: var(--mobile-actionbar-hit);
  }

  @media (max-width: 640px) {
    .blurb {
      display: none;
    }
    .sep {
      display: none;
    }
  }
</style>
