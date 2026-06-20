<script lang="ts">
  import type { RepoChip } from "./queue-strip";
  import { m } from "$lib/paraglide/messages";
  import { basename } from "./learnings-drawer";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { chipRailVisible, chipHasTelemetry, pausedText } from "./queue-strip";
  import RepoChipTelemetry from "./repo-switcher/RepoChipTelemetry.svelte";

  let {
    chips,
    repoFilter,
    onrepofilter,
    onlearnings,
    mobile = false,
  }: {
    chips: RepoChip[];
    // active repo full path, or null when showing every repo
    repoFilter: string | null;
    // toggle the herd filter for a repo; null clears it
    onrepofilter: (repoPath: string | null) => void;
    // open the learnings drawer for a repo
    onlearnings?: (repoPath: string) => void;
    // true when rendered on a phone-sized viewport — suppresses the lone-repo
    // telemetry band (collapses into the selected-state subline instead)
    mobile?: boolean;
  } = $props();

  // ── render branch selection ────────────────────────────────────────────────
  const railVisible = $derived(chipRailVisible(chips, repoFilter));
  // Lone-repo telemetry: one repo with no active filter, carrying drain/learnings.
  // (When that lone repo IS the active filter, the rail shows instead — see railVisible.)
  const loneChip = $derived(chips.length === 1 && chipHasTelemetry(chips[0]) ? chips[0] : null);
  // The active chip whose detail line shows below the rail — only when it has telemetry.
  const activeChip = $derived(
    railVisible && repoFilter
      ? (chips.find((c) => c.repoPath === repoFilter && chipHasTelemetry(c)) ?? null)
      : null,
  );

  // ── paused-repo live announcements (derived from chips) ─────────────────────
  const pausedAnnounce = $derived(
    chips
      .filter((c) => c.drain?.paused)
      .map((c) =>
        m.repo_drain_paused_announce({
          repo: basename(c.repoPath),
          text: pausedText(c.drain!),
        }),
      )
      .join(" "),
  );

  // ── edge-fade scroll affordance ─────────────────────────────────────────────
  let scroller = $state<HTMLElement | null>(null);
  // inner track: width == scroll content width; observing it catches content-width
  // changes (rename/glyph/count digit) at a fixed chip count that the scroller's
  // own resize misses.
  let track = $state<HTMLElement | null>(null);
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function recomputeScroll() {
    const el = scroller;
    if (!el) {
      canScrollLeft = false;
      canScrollRight = false;
      return;
    }
    canScrollLeft = el.scrollLeft > 1;
    canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  }

  // Recompute whenever the chip set changes (and on mount).
  $effect(() => {
    // referencing chips makes this effect re-run when the rail content changes
    void chips.length;
    recomputeScroll();
  });

  // Keep the fades honest as either the scroller (viewport / container width) OR
  // the inner track (content width — label/icon/count change at a fixed chip count)
  // resizes. One observer, both elements, disconnected on cleanup.
  $effect(() => {
    const el = scroller;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => recomputeScroll());
    ro.observe(el);
    if (track) ro.observe(track);
    return () => ro.disconnect();
  });

  // Translate a vertical wheel delta to horizontal scroll so a fine pointer can
  // pan the rail without a trackpad gesture.
  function onWheel(e: WheelEvent) {
    const el = scroller;
    if (!el || e.deltaY === 0) return;
    // only hijack when there is hidden horizontal content to reveal
    if (el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
    recomputeScroll();
  }
</script>

{#if railVisible}
  <div class="rs" role="group" aria-label={m.repo_switcher_label()}>
    <div
      class="rs-scroller"
      class:fade-left={canScrollLeft}
      class:fade-right={canScrollRight}
      bind:this={scroller}
      onscroll={recomputeScroll}
      onwheel={onWheel}
    >
      <!-- inner track: its width == the scroll content width, so a ResizeObserver
           on it catches label/icon/count content-width changes at a fixed chip
           count (which the scroller's own resize does not). -->
      <div class="rs-track" bind:this={track}>
        {#each chips as chip (chip.repoPath)}
          {@const active = repoFilter === chip.repoPath}
          {@const repo = basename(chip.repoPath)}
          <button
            type="button"
            class="rs-chip"
            class:active
            aria-pressed={active}
            aria-label={(active
              ? m.repo_filter_active_aria({ repo })
              : m.repo_filter_apply_aria({ repo })) +
              (chip.insights > 0 || chip.curate > 0
                ? " " +
                  m.repo_chip_learnings_aria({
                    count: chip.insights > 0 ? chip.insights : chip.curate,
                  })
                : "")}
            onclick={() => onrepofilter(active ? null : chip.repoPath)}
          >
            <span class="rs-glyph" aria-hidden="true"
              >{projectIcons.iconFor(chip.repoPath) ?? "▣"}</span
            >
            <span class="rs-name">{repo}</span>
            <span class="rs-count">{chip.count}</span>
            {#if chip.drain?.paused}
              <span class="rs-paused-dot" aria-hidden="true">●</span>
            {/if}
            {#if chip.insights > 0 || chip.curate > 0}
              <span class="rs-learn-mark" title={m.learnings_badge_tip()} aria-hidden="true"
                >✦{#if chip.insights > 0}<span class="rs-learn-n">{chip.insights}</span>{/if}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    </div>

    {#if activeChip}
      {#key activeChip.repoPath}
        <RepoChipTelemetry chip={activeChip} {onlearnings} />
      {/key}
    {/if}
  </div>
{:else if loneChip && !mobile}
  <div class="rs">
    <RepoChipTelemetry chip={loneChip} {onlearnings} />
  </div>
{/if}

<!-- live region: paused-repo announcements (always present, visually hidden) -->
<div class="rs-live" role="status" aria-live="polite">{pausedAnnounce}</div>

<style>
  .rs {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    font-family: var(--font-mono);
    /* don't span the parent column — shrink-wrap to the rail content */
    align-self: flex-start;
    max-width: 100%;
    min-width: 0;
  }

  /* the horizontal, single-line scroller of filter chips (overflow viewport) */
  .rs-scroller {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    /* a fixed single-line height so the rail never wraps */
    padding: 2px 0;
    scrollbar-width: none;
    /* peek cue: the visible at-rest peek comes from the .rs-track's trailing
       padding-right plus the narrow right-edge fade, which together guarantee the
       next chip's leading edge protrudes into view. scroll-padding-right keeps
       keyboard-focus scrollIntoView clear of the faded edge. */
    scroll-padding-right: 20px;
  }
  .rs-scroller::-webkit-scrollbar {
    display: none;
  }
  /* inner track: lays out the chips in one line; its width == scroll content width
     (observed for content-width edge-fade recompute). */
  .rs-track {
    display: flex;
    align-items: stretch;
    gap: 4px;
    width: fit-content;
    white-space: nowrap;
    /* trailing padding: ensures the right-most chip is never fully hidden behind
       the fade — it protrudes into the padding, giving the eye a real partial chip
       (the peek) even at scroll position 0. */
    padding-right: 20px;
  }
  /* tonal edge-fade affordance: fade whichever edge hides content. No colored
     element — a mask over the scroller's own pixels.
     Right fade is intentionally narrower (12px vs 24px left) so the partial
     chip behind it still reads as a chip — the fade is a secondary cue, the
     peeking chip shape is the primary one. */
  .rs-scroller.fade-left {
    mask-image: linear-gradient(to right, transparent 0, #000 24px);
  }
  .rs-scroller.fade-right {
    mask-image: linear-gradient(to left, transparent 0, #000 12px);
  }
  .rs-scroller.fade-left.fade-right {
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 24px,
      #000 calc(100% - 12px),
      transparent 100%
    );
  }

  /* one filter chip = one tap target */
  .rs-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    background: none;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .rs-chip:hover,
  .rs-chip:focus-visible {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }
  /* active filter: amber text + amber underline (mirrors .qs-repo-btn.active) */
  .rs-chip.active {
    color: var(--color-amber);
    border-color: var(--color-amber);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  /* the repo glyph is identity, not status — keep it on the ink ramp, never a
     status hue (Four-Light Rule). */
  .rs-glyph {
    color: var(--color-ink);
    text-transform: none;
  }
  .rs-name {
    color: inherit;
  }
  .rs-count {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .rs-chip.active .rs-count {
    color: var(--color-amber);
  }
  /* small red marker that this repo's drain is paused (announced via live region) */
  .rs-paused-dot {
    color: var(--color-red);
    font-size: var(--fs-micro);
    line-height: 1;
  }
  /* display-only ✦ marker: this repo has pending learnings/curate (the actionable
     ✦ button lives on the detail line). Decorative, on the faint/ink ramp — NOT a
     status hue (Four-Light Rule); ✦ is not amber/green/red/slate. */
  .rs-learn-mark {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    line-height: 1;
  }
  .rs-learn-n {
    font-variant-numeric: tabular-nums;
  }

  /* visually-hidden live region (no .sr-only util in app.css) */
  .rs-live {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Coarse pointers: ≥44px tap targets on the chips (mirrors the QueueStrip /
     TopBar coarse-pointer pattern). */
  @media (pointer: coarse) {
    .rs-chip {
      min-height: 44px;
      min-width: 44px;
      justify-content: center;
    }
  }
</style>
