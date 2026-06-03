<script lang="ts">
  import type { DrainStatus, QueuedItem } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { getDrainQueue } from "$lib/api";
  import { basename } from "./learnings-drawer";
  import { enabledDrains, pausedText, queueOpenable } from "./queue-strip";

  let { drain }: { drain: Record<string, DrainStatus> } = $props();

  const rows = $derived(enabledDrains(drain));

  // Lazy queue popover: at most one open at a time, fetched fresh on open.
  let openRepo = $state<string | null>(null);
  let items = $state<QueuedItem[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let stripEl = $state<HTMLElement | null>(null);

  async function toggle(d: DrainStatus) {
    if (openRepo === d.repoPath) {
      openRepo = null;
      return;
    }
    const repo = d.repoPath;
    openRepo = repo;
    items = [];
    failed = false;
    loading = true;
    try {
      const q = await getDrainQueue(repo);
      if (openRepo === repo) items = q; // ignore a response for a since-switched popover
    } catch {
      if (openRepo === repo) failed = true;
    } finally {
      if (openRepo === repo) loading = false;
    }
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") openRepo = null;
  }
  function onWindowPointerdown(e: PointerEvent) {
    if (openRepo && stripEl && !stripEl.contains(e.target as Node)) openRepo = null;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

{#if rows.length > 0}
  <div class="queue-strip" role="status" aria-label={m.drain_strip_label()} bind:this={stripEl}>
    <span class="qs-label">🚰 {m.drain_strip_label()}</span>
    <ul class="qs-rows">
      {#each rows as d (d.repoPath)}
        <li class="qs-row" class:paused={d.paused}>
          <span class="qs-repo">{basename(d.repoPath)}</span>
          <span class="qs-inflight">{m.drain_inflight({ count: d.inFlight, max: d.max })}</span>
          {#if queueOpenable(d)}
            <button
              type="button"
              class="qs-queued qs-queued-btn"
              aria-haspopup="dialog"
              aria-expanded={openRepo === d.repoPath}
              aria-label={m.drain_queue_open_aria({ count: d.queued, repo: basename(d.repoPath) })}
              onclick={() => toggle(d)}
            >
              {m.drain_queued({ count: d.queued })}
            </button>
          {:else}
            <span class="qs-queued">{m.drain_queued({ count: d.queued })}</span>
          {/if}
          {#if d.paused}
            <span class="qs-pause" title={pausedText(d)}>{pausedText(d)}</span>
          {/if}

          {#if openRepo === d.repoPath}
            <div
              class="qs-pop"
              role="dialog"
              aria-label={m.drain_queue_title({ repo: basename(d.repoPath) })}
            >
              <div class="qs-pop-head">{m.drain_queue_title({ repo: basename(d.repoPath) })}</div>
              {#if loading}
                <div class="qs-pop-state">{m.common_loading()}</div>
              {:else if failed}
                <div class="qs-pop-state qs-pop-fail">{m.drain_queue_error()}</div>
              {:else if items.length === 0}
                <div class="qs-pop-state">{m.drain_queue_empty()}</div>
              {:else}
                <ul class="qs-pop-list">
                  {#each items as it (it.number)}
                    <li>
                      <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
                      <a
                        class="qs-pop-item"
                        href={it.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={m.drain_queue_item_aria({ number: it.number })}
                      >
                        <span class="qs-pop-num">#{it.number}</span>
                        <span class="qs-pop-title">{it.title}</span>
                      </a>
                      <!-- eslint-enable svelte/no-navigation-without-resolve -->
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .queue-strip {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 5px 10px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-panel);
    font-family: var(--font-mono);
  }
  .qs-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .qs-rows {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }
  .qs-row {
    /* positioning context for the queue popover anchored to this row */
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
  }
  .qs-repo {
    color: var(--color-ink-bright);
    font-weight: 500;
  }
  .qs-inflight {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }
  .qs-queued {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  /* the queued count, when something is queued, is a button into the list popover */
  .qs-queued-btn {
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
  .qs-queued-btn:hover,
  .qs-queued-btn:focus-visible {
    color: var(--color-ink-bright);
  }
  /* a paused drain is the loud thing in the band: red, with its reason inline */
  .qs-pause {
    color: var(--color-red);
    background: color-mix(in oklab, var(--color-red) 12%, transparent);
    padding: 1px 6px;
    border-radius: 2px;
    text-transform: none;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 320px;
  }

  /* queue popover — chrome mirrors GitRail's .pr-pop, anchored under the row */
  .qs-pop {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 20;
    margin-top: 4px;
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
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    text-transform: none;
    letter-spacing: normal;
  }
  .qs-pop-head {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .qs-pop-state {
    font-size: var(--fs-base);
    color: var(--color-muted);
  }
  .qs-pop-fail {
    color: var(--color-red);
  }
  .qs-pop-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
  }
  .qs-pop-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 4px;
    border-radius: 2px;
    color: var(--color-ink);
    text-decoration: none;
    font-size: var(--fs-base);
  }
  .qs-pop-item:hover,
  .qs-pop-item:focus-visible {
    background: var(--color-panel);
    color: var(--color-ink-bright);
  }
  .qs-pop-num {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .qs-pop-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
