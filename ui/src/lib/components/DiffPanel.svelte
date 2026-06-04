<script lang="ts">
  import { getDiff } from "$lib/api";
  import { diffTotals } from "$lib/diff";
  import type { DiffResult } from "$lib/types";
  import DiffFileBlock from "$lib/components/DiffFileBlock.svelte";
  import { m } from "$lib/paraglide/messages";

  let { sessionId }: { sessionId: string } = $props();

  let result = $state<DiffResult | null>(null);
  let loaded = $state(false);
  let failed = $state(false);

  let alive = true;
  function load() {
    const id = sessionId; // the session this request is for
    getDiff(id)
      .then((r) => {
        if (!alive || id !== sessionId) return; // dropped or session switched
        result = r;
        loaded = true;
        failed = false;
      })
      .catch(() => {
        if (!alive || id !== sessionId) return;
        failed = true;
        loaded = true;
      });
  }

  // fetch on session change + poll every 15s while this panel is mounted (tab active)
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive dep
    sessionId;
    result = null;
    loaded = false;
    failed = false;
    alive = true;
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  });

  const totals = $derived(
    result ? diffTotals(result.files) : { files: 0, additions: 0, deletions: 0 },
  );
</script>

<div class="diff">
  <div class="bar">
    {#if result}
      <span class="summary">
        {totals.files} files <span class="add">+{totals.additions}</span>
        <span class="del">−{totals.deletions}</span>
      </span>
      {#if result.fetchFailed}
        <span class="stale" title={m.diff_stale({ base: result.base })}>⚠ {result.baseRef}</span>
      {/if}
    {/if}
    <div class="spacer"></div>
    <button class="refresh" type="button" onclick={load} aria-label={m.diff_refresh()}>↻</button>
  </div>

  <div class="body">
    {#if !loaded}
      <p class="msg">{m.common_loading()}</p>
    {:else if failed}
      <p class="msg">{m.diff_error()}</p>
    {:else if result && result.files.length}
      {#each result.files as file (file.path)}
        <DiffFileBlock {file} />
      {/each}
    {:else}
      <p class="msg">{m.diff_empty({ base: result?.baseRef ?? "" })}</p>
    {/if}
  </div>
</div>

<style>
  .diff {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
    font-size: var(--fs-meta);
    flex-shrink: 0;
  }
  .summary {
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }
  .summary .add {
    color: var(--color-green);
  }
  .summary .del {
    color: var(--color-red);
  }
  .stale {
    color: var(--color-amber);
    font-size: var(--fs-meta);
  }
  .spacer {
    flex: 1;
  }
  .refresh {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    padding: 1px 8px;
    cursor: pointer;
  }
  .refresh:hover {
    background: var(--color-hover);
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
  }
  .msg {
    color: var(--color-muted);
    margin: 0;
    padding: 4px 0;
    font-size: var(--fs-base);
  }
</style>
