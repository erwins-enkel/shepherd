<script lang="ts">
  import { getActivity, getDiff } from "$lib/api";
  import { pollWhileVisible } from "$lib/visibility";
  import { glyph, clock, groupActivity } from "$lib/activity";
  import type { ActivityKind } from "$lib/activity";
  import { diffToFileTree } from "$lib/diff";
  import type { ActivityEntry, DiffResult } from "$lib/types";
  import FileTreeBlock from "$lib/components/blocks/FileTreeBlock.svelte";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();

  let entries = $state<ActivityEntry[]>([]);
  let loaded = $state(false);

  let diff = $state<DiffResult | null>(null);
  let diffLoaded = $state(false);

  // Map ActivityKind → localized label
  const kindLabel: Record<ActivityKind, () => string> = {
    edit: m.activity_kind_edit,
    read: m.activity_kind_read,
    search: m.activity_kind_search,
    exec: m.activity_kind_exec,
    tasks: m.activity_kind_tasks,
    agent: m.activity_kind_agent,
    web: m.activity_kind_web,
    other: m.activity_kind_other,
  };

  // poll the JSONL-derived activity on select + every 5s; mirrors Viewport's usage effect.
  // this panel mounts only while its tab is active, so polling runs only when viewed.
  $effect(() => {
    const id = sessionId;
    entries = [];
    loaded = false;
    diff = null;
    diffLoaded = false;
    let alive = true;

    const load = () =>
      getActivity(id)
        .then((e) => {
          if (!alive || id !== sessionId) return;
          entries = e;
          loaded = true;
        })
        .catch(() => {});

    const loadDiff = () => {
      const capId = id;
      getDiff(capId)
        .then((r) => {
          if (!alive || capId !== sessionId) return;
          diff = r;
          diffLoaded = true;
        })
        .catch(() => {});
    };

    load();
    loadDiff();
    const stopActivity = pollWhileVisible(load, 5000); // skip hidden-tab ticks; refresh on return
    const stopDiff = pollWhileVisible(loadDiff, 15000);
    return () => {
      alive = false;
      stopActivity();
      stopDiff();
    };
  });

  // newest-first for display (server returns oldest→newest)
  const rows = $derived([...entries].reverse());
  const groups = $derived(groupActivity(rows));

  const hasFiles = $derived((diff?.files?.length ?? 0) > 0);
  const isEmpty = $derived(loaded && diffLoaded && rows.length === 0 && !hasFiles);
  const isLoading = $derived(!loaded && !diffLoaded);
</script>

<div class="feed">
  {#if isLoading}
    <p class="empty">{m.common_loading()}</p>
  {:else if isEmpty}
    <p class="empty">{m.activity_empty()}</p>
  {:else}
    {#if hasFiles}
      <div class="files-section">
        <FileTreeBlock
          block={{
            type: "file-tree",
            id: "activity-files",
            title: m.activity_files_changed(),
            entries: diffToFileTree(diff!.files),
          }}
        />
      </div>
    {/if}

    {#if rows.length}
      <ul aria-live="polite">
        {#each groups as group, i (group.kind + ":" + i)}
          <li class="kind-header">
            {kindLabel[group.kind]()}{group.entries.length > 1 ? ` (${group.entries.length})` : ""}
          </li>
          {#each group.entries as e, j (group.kind + ":" + i + ":" + j)}
            <li class:error={e.status === "error"} class:pending={e.status === "pending"}>
              <span class="time">{clock(e.ts)}</span>
              <span class="glyph" aria-hidden="true">{glyph(e.tool)}</span>
              <span class="summary">{e.summary}</span>
            </li>
          {/each}
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .feed {
    height: 100%;
    overflow-y: auto;
    padding: 8px 10px;
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .files-section {
    margin-bottom: 12px;
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
  li.kind-header {
    display: block;
    margin: 8px 0 2px;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
    white-space: normal;
  }
  li.kind-header:first-child {
    margin-top: 0;
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
