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
  let ribbonEl: HTMLElement | undefined = $state();

  // Publish the ribbon's live height to `--demo-ribbon-h` on the document root so the
  // app shell can reserve space for it (see `.shell:not(.mobile)` in +page.svelte) —
  // the fixed ribbon otherwise overlays the desktop bottom bar (New Task etc.). The var
  // is set ONLY by this demo-only component; outside the demo it stays unset and the
  // shell's `calc(100dvh - var(--demo-ribbon-h, 0px))` falls back to a plain 100dvh, so
  // the real Shepherd layout is untouched. ResizeObserver keeps it correct if the row
  // wraps at narrow widths.
  $effect(() => {
    if (!ribbonEl || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--demo-ribbon-h", `${ribbonEl!.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(ribbonEl);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--demo-ribbon-h");
    };
  });

  function resetDemo(): void {
    // Demo state is entirely in-memory (see demo/state.ts) and re-seeds on
    // boot, so "reset" is just a reload — no live in-place reset exists.
    if (typeof location !== "undefined") location.reload();
  }
</script>

<div
  class="demo-ribbon"
  role="complementary"
  aria-label={m.demoribbon_aria_label()}
  bind:this={ribbonEl}
>
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

  /* .gbtn recipe — copied verbatim from ui/src/routes/design-system/+page.svelte
     (the canonical reference, ~lines 95-109). Do not edit the tokens here;
     edit the source recipe and re-copy instead. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
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

  /* Match the app's OWN mobile breakpoint verbatim (`(max-width: 768px),
     (max-height: 600px)` — the MediaQuery in +page.svelte). In that mode the
     ActionBar switches to `.actions.mobile` (position: fixed; bottom: 0) and the
     desktop height-reservation (`.shell:not(.mobile)`) does NOT apply — so the
     ribbon must lift itself clear of that fixed bar here, across the WHOLE mobile
     band (not just ≤640px, which left an uncovered 641–768px / short-viewport gap
     where a full-width bottom ribbon buried New Task/Backlog). */
  @media (max-width: 768px), (max-height: 600px) {
    .blurb {
      display: none;
    }
    .sep {
      display: none;
    }
    /* ActionBar's mobile bar (.actions.mobile in ActionBar.svelte) is also
       fixed to the viewport bottom, occupying --mobile-actionbar-h, and would
       otherwise sit under this ribbon's higher z-index and lose its primary
       "New Task"/"Backlog" actions. Lift the ribbon clear of that bar and
       shrink it to a compact, non-stretched pill (drop the left:0/right:0
       stretch) so it reads as a small anchored aside rather than a second
       bar covering content. */
    .demo-ribbon {
      left: auto;
      right: 8px;
      bottom: calc(var(--mobile-actionbar-h) + 8px);
      border-top: none;
      border: 1px solid var(--color-line);
      border-radius: 999px;
      padding: 6px 10px;
    }
  }
</style>
