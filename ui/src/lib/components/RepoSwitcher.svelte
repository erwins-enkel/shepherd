<script lang="ts">
  import type { DrainStatus, QueuedItem } from "$lib/types";
  import type { RepoChip } from "./queue-strip";
  import { m } from "$lib/paraglide/messages";
  import { getDrainQueue } from "$lib/api";
  import { basename } from "./learnings-drawer";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { chipRailVisible, chipHasTelemetry, queueOpenable, pausedText } from "./queue-strip";

  let {
    chips,
    repoFilter,
    onrepofilter,
    onlearnings,
  }: {
    chips: RepoChip[];
    // active repo full path, or null when showing every repo
    repoFilter: string | null;
    // toggle the herd filter for a repo; null clears it
    onrepofilter: (repoPath: string | null) => void;
    // open the learnings drawer for a repo
    onlearnings?: (repoPath: string) => void;
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

  // ── inline queue expansion (mirrors QueueStrip toggle/loading/failed) ───────
  // At most one repo's queue is expanded at a time, fetched fresh on open.
  let expandedRepo = $state<string | null>(null);
  let queueItems = $state<QueuedItem[]>([]);
  let loading = $state(false);
  let failed = $state(false);

  async function toggleQueue(d: DrainStatus) {
    if (expandedRepo === d.repoPath) {
      expandedRepo = null;
      return;
    }
    const repo = d.repoPath;
    expandedRepo = repo;
    queueItems = [];
    failed = false;
    loading = true;
    try {
      const q = await getDrainQueue(repo);
      if (expandedRepo === repo) queueItems = q; // ignore a stale (since-switched) response
    } catch {
      if (expandedRepo === repo) failed = true;
    } finally {
      if (expandedRepo === repo) loading = false;
    }
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") expandedRepo = null;
  }

  // A whitespace/special-char-safe DOM id for the inline queue panel, so the toggle's
  // aria-controls (an IDREF — space-separated, so a repoPath with whitespace would parse
  // as multiple tokens) and the panel id stay valid. Only one queue is expanded at a
  // time, so a cross-repo collision after sanitizing can't occur.
  const queueId = (repoPath: string) => `rs-queue-${repoPath.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

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

  // A repo-filter switch invalidates any open inline queue: the expanded repo
  // may no longer be visible, and its cached queueItems are stale. Collapse it
  // so a re-expand refetches. (Writes expandedRepo only; reads repoFilter — no loop.)
  $effect(() => {
    void repoFilter;
    expandedRepo = null;
  });

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

<svelte:window onkeydown={onWindowKeydown} />

<!-- Shared per-repo telemetry: drain inflight/queue + learnings + pause. -->
{#snippet telemetry(chip: RepoChip)}
  {@const d = chip.drain}
  <div class="rs-tele">
    {#if d}
      <span class="rs-inflight">{m.drain_inflight({ count: d.inFlight, max: d.max })}</span>
      {#if queueOpenable(d)}
        {@const repo = basename(d.repoPath)}
        <button
          type="button"
          class="rs-queued rs-queued-btn"
          aria-expanded={expandedRepo === d.repoPath}
          aria-controls={queueId(d.repoPath)}
          aria-label={m.drain_queue_open_aria({ count: d.queued, repo })}
          onclick={() => toggleQueue(d)}
        >
          {m.drain_queued({ count: d.queued })}
        </button>
      {:else}
        <span class="rs-queued">{m.drain_queued({ count: d.queued })}</span>
      {/if}
    {/if}

    {#if chip.insights > 0 || chip.curate > 0}
      <button
        type="button"
        class="rs-insights"
        title={m.learnings_badge_tip()}
        aria-label={chip.insights > 0
          ? m.learnings_open_aria({ count: chip.insights })
          : m.learnings_open_curate_aria({ count: chip.curate })}
        onclick={() => onlearnings?.(chip.repoPath)}
      >
        <span class="rs-insights-icon" aria-hidden="true">✦</span>{#if chip.insights > 0}<span
            class="rs-insights-n">{chip.insights}</span
          >{/if}
      </button>
    {/if}

    {#if d?.paused}
      <span class="rs-pause" title={pausedText(d)}>{pausedText(d)}</span>
    {/if}
  </div>

  {#if d && expandedRepo === d.repoPath}
    {@const repo = basename(d.repoPath)}
    <div class="rs-queue" id={queueId(d.repoPath)}>
      <div class="rs-queue-head">{m.drain_queue_title({ repo })}</div>
      {#if loading}
        <div class="rs-queue-state">{m.common_loading()}</div>
      {:else if failed}
        <div class="rs-queue-state rs-queue-fail">{m.drain_queue_error()}</div>
      {:else if queueItems.length === 0}
        <div class="rs-queue-state">{m.drain_queue_empty()}</div>
      {:else}
        <ul class="rs-queue-list">
          {#each queueItems as it (it.number)}
            <li>
              <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
              <a
                class="rs-queue-item"
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={m.drain_queue_item_aria({ number: it.number })}
              >
                <span class="rs-queue-num">#{it.number}</span>
                <span class="rs-queue-title">{it.title}</span>
              </a>
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
{/snippet}

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
              <span class="rs-learn-mark" aria-hidden="true"
                >✦{#if chip.insights > 0}<span class="rs-learn-n">{chip.insights}</span>{/if}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    </div>

    {#if activeChip}
      {@render telemetry(activeChip)}
    {/if}
  </div>
{:else if loneChip}
  <div class="rs">
    {@render telemetry(loneChip)}
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
  }
  /* tonal edge-fade affordance: fade whichever edge hides content. No colored
     element — a mask over the scroller's own pixels. */
  .rs-scroller.fade-left {
    mask-image: linear-gradient(to right, transparent 0, #000 24px);
  }
  .rs-scroller.fade-right {
    mask-image: linear-gradient(to left, transparent 0, #000 24px);
  }
  .rs-scroller.fade-left.fade-right {
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 24px,
      #000 calc(100% - 24px),
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

  /* active-repo / lone-repo detail line */
  .rs-tele {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .rs-inflight {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }
  .rs-queued {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .rs-queued-btn {
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
  }
  .rs-queued-btn:hover,
  .rs-queued-btn:focus-visible {
    color: var(--color-ink-bright);
  }
  .rs-insights {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    letter-spacing: inherit;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    color: var(--color-faint);
  }
  .rs-insights:hover,
  .rs-insights:focus-visible {
    color: var(--color-ink-bright);
  }
  .rs-insights-n {
    font-variant-numeric: tabular-nums;
  }
  /* a paused drain is the loud thing in the detail line: red, reason inline */
  .rs-pause {
    color: var(--color-red);
    background: color-mix(in oklab, var(--color-red) 12%, transparent);
    padding: 1px 6px;
    border-radius: 2px;
    text-transform: none;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: min(320px, 50vw);
  }

  /* inline queue expansion — chrome mirrors QueueStrip's .qs-pop, but flows
     inline below the detail line (not a floating popover) */
  .rs-queue {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: min(360px, 90vw);
    max-height: 50vh;
    overflow: hidden;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .rs-queue-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .rs-queue-state {
    font-size: var(--fs-base);
    color: var(--color-muted);
  }
  .rs-queue-fail {
    color: var(--color-red);
  }
  .rs-queue-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
  }
  .rs-queue-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 4px;
    border-radius: 2px;
    color: var(--color-ink);
    text-decoration: none;
    font-size: var(--fs-base);
  }
  .rs-queue-item:hover,
  .rs-queue-item:focus-visible {
    background: var(--color-panel);
    color: var(--color-ink-bright);
  }
  .rs-queue-num {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .rs-queue-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  /* Coarse pointers: ≥44px tap targets on the chips and the inline action
     buttons (mirrors the QueueStrip / TopBar coarse-pointer pattern). */
  @media (pointer: coarse) {
    .rs-chip,
    .rs-queued-btn,
    .rs-insights {
      min-height: 44px;
    }
    .rs-chip {
      min-width: 44px;
      justify-content: center;
    }
    .rs-queued-btn,
    .rs-insights {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
    }
  }
</style>
