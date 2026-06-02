<script lang="ts">
  import { getActivity } from "$lib/api";
  import { glyph, clock } from "$lib/activity";
  import type { ActivityEntry } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();

  let entries = $state<ActivityEntry[]>([]);
  let loaded = $state(false);

  // poll the JSONL-derived activity on select + every 5s; mirrors Viewport's usage effect.
  // this panel mounts only while its tab is active, so polling runs only when viewed.
  $effect(() => {
    const id = sessionId;
    entries = [];
    loaded = false;
    let alive = true;
    const load = () =>
      getActivity(id)
        .then((e) => {
          if (!alive) return;
          entries = e;
          loaded = true;
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  });

  // newest-first for display (server returns oldest→newest)
  const rows = $derived([...entries].reverse());
</script>

<div class="feed">
  {#if rows.length}
    <ul aria-live="polite">
      {#each rows as e (e.ts + e.tool + e.summary)}
        <li class:error={e.status === "error"} class:pending={e.status === "pending"}>
          <span class="time">{clock(e.ts)}</span>
          <span class="glyph" aria-hidden="true">{glyph(e.tool)}</span>
          <span class="summary">{e.summary}</span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">{loaded ? m.activity_empty() : m.common_loading()}</p>
  {/if}
</div>

<style>
  .feed {
    height: 100%;
    overflow-y: auto;
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.5;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    color: var(--color-ink);
    white-space: nowrap;
  }
  .time {
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .glyph {
    color: var(--color-muted);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  li.error .summary {
    color: var(--color-red);
  }
  li.error .glyph {
    color: var(--color-red);
  }
  li.pending {
    color: var(--color-muted);
  }
  .empty {
    color: var(--color-muted);
    margin: 0;
    padding: 4px 0;
  }
</style>
