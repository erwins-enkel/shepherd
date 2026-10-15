<script lang="ts">
  import type { DrainStatus, QueuedItem } from "#lib/types.js";
  import type { RepoChip } from "../queue-strip";
  import { m } from "#lib/paraglide/messages.js";
  import { getDrainQueue, updateEpic } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { basename } from "../learnings-drawer";
  import { queueOpenable, pausedText } from "../queue-strip";

  let {
    chip,
  }: {
    chip: RepoChip;
  } = $props();

  const d = $derived(chip.drain);

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

  // Lift (or restore) the repo's usage ceiling for the epic the drain is running.
  function setIgnoreCeiling(d: DrainStatus, epic: number, ignoreUsageCeiling: boolean) {
    updateEpic(d.repoPath, epic, { ignoreUsageCeiling }).catch(() =>
      toasts.info(m.epic_update_failed(), { alert: true, key: "epic-update-fail" }),
    );
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

  {#if d?.paused}
    <span class="rs-pause" title={pausedText(d)}>{pausedText(d)}</span>
    {#if d.reason === "usage" && d.epicParent != null}
      {@const epic = d.epicParent}
      <button type="button" class="rs-text-btn" onclick={() => setIgnoreCeiling(d, epic, true)}>
        {m.drain_usage_ignore({ epic })}
      </button>
    {/if}
  {/if}
  {#if d?.usageCeilingIgnored && d.epicParent != null}
    {@const epic = d.epicParent}
    <span class="rs-ceiling-off">{m.drain_usage_ignored({ epic })}</span>
    <button type="button" class="rs-text-btn" onclick={() => setIgnoreCeiling(d, epic, false)}>
      {m.drain_usage_respect()}
    </button>
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
  .rs-queued-btn,
  .rs-text-btn {
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
  .rs-text-btn {
    color: inherit;
  }
  .rs-queued-btn:hover,
  .rs-queued-btn:focus-visible,
  .rs-text-btn:hover,
  .rs-text-btn:focus-visible {
    color: var(--color-ink-bright);
  }
  /* the epic is running over the usage ceiling on the operator's say-so: amber, not alarm-red */
  .rs-ceiling-off {
    color: var(--color-amber);
    text-transform: none;
    letter-spacing: 0.04em;
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
    .rs-text-btn {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
    }
  }
</style>
