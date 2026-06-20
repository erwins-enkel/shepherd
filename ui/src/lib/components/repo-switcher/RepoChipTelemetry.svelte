<script lang="ts">
  import type { DrainStatus, QueuedItem } from "$lib/types";
  import type { RepoChip } from "../queue-strip";
  import { m } from "$lib/paraglide/messages";
  import { getDrainQueue } from "$lib/api";
  import { basename } from "../learnings-drawer";
  import { queueOpenable, pausedText } from "../queue-strip";

  let {
    chip,
    onlearnings,
  }: {
    chip: RepoChip;
    // open the learnings drawer for a repo
    onlearnings?: (repoPath: string) => void;
  } = $props();

  const d = $derived(chip.drain);
  const insightsLabel = $derived(
    chip.insights > 0 ? m.learnings_title() : m.learnings_trim_title(),
  );
  const insightsCount = $derived(chip.insights > 0 ? chip.insights : chip.curate);

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
</script>

<svelte:window onkeydown={onWindowKeydown} />

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
      <span class="rs-insights-icon" aria-hidden="true">✦</span><span class="rs-insights-label"
        >{insightsLabel}</span
      ><span class="rs-insights-n">{insightsCount}</span>
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

<style>
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

  /* Coarse pointers: ≥44px tap targets on the inline action buttons
     (mirrors the QueueStrip / TopBar coarse-pointer pattern). */
  @media (pointer: coarse) {
    .rs-queued-btn,
    .rs-insights {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
    }
  }
</style>
