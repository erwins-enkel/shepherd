<script lang="ts">
  import { listWorkflowRuns } from "$lib/api";
  import type { WorkflowRun } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import ActionRunRow from "./ActionRunRow.svelte";

  let { repoPath }: { repoPath: string } = $props();

  let runs = $state<WorkflowRun[]>([]);
  let slug = $state<string | null>(null);
  let loading = $state(true);
  // Server-reported forge capabilities. `supportsActions` defaults true so the
  // first load doesn't flash the "unavailable" message before the response lands;
  // the rerun/cancel controls default off until the forge confirms it has them.
  let supportsActions = $state(true);
  let canRerun = $state(false);
  let canCancel = $state(false);

  // Any in-flight run or job keeps the silent poll alive. Once everything has
  // settled (all green/red), there is nothing left to update, so we stop
  // polling rather than burn idle `gh` round-trips on a static tab.
  let hasPending = $derived(
    runs.some((r) => r.state === "pending" || r.jobs.some((j) => j.state === "pending")),
  );

  // Background refreshes (silent) leave the spinner untouched and swap `runs` in
  // place; only the initial per-repo load shows the loading state.
  function load(rp: string, silent = false) {
    if (!silent) loading = true;
    listWorkflowRuns(rp)
      .then((r) => {
        if (rp !== repoPath) return; // stale response for a since-changed repo
        slug = r.slug;
        runs = r.runs;
        supportsActions = r.supportsActions;
        canRerun = r.canRerun;
        canCancel = r.canCancel;
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath) return; // a stale failure must not clear the current spinner
        loading = false;
      });
  }

  // Brisk enough to feel live, slow enough to stay civil to the `gh` CLI — CI
  // state turns over on the order of minutes.
  const REFRESH_MS = 12_000;

  // Spinner-backed load whenever the selected repo changes.
  $effect(() => {
    load(repoPath);
  });

  // Silent poll, gated on `hasPending`. Re-runs when `hasPending` flips OR when
  // `repoPath` changes (read at `rp` below) — the latter is load-bearing: it
  // tears down the old interval on a repo switch and re-arms against the new
  // repo, so don't "optimise" that read out. A steady `true` does not re-run
  // this (the derived memoises by value), so the interval keeps a steady cadence
  // while work is live and is torn down the moment everything settles.
  $effect(() => {
    if (!hasPending) return;
    const rp = repoPath;
    const timer = setInterval(() => load(rp, true), REFRESH_MS);
    return () => clearInterval(timer);
  });
</script>

<div class="actions-panel">
  <div class="actions-header">
    {#if slug}{m.actionspanel_title_with_slug({ slug })}{:else}{m.actionspanel_title()}{/if}
  </div>

  <div class="actions-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if !supportsActions}
      <div class="muted">{m.actionspanel_unavailable()}</div>
    {:else if runs.length === 0}
      <div class="muted">{m.actionspanel_no_runs()}</div>
    {:else}
      {#each runs as run (run.workflowName)}
        <ActionRunRow
          {repoPath}
          {run}
          rerunnable={canRerun}
          cancelable={canCancel}
          onchanged={() => load(repoPath, true)}
        />
      {/each}
    {/if}
  </div>
</div>

<style>
  .actions-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .actions-header {
    padding: 6px 12px;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .actions-list {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .actions-list::-webkit-scrollbar {
    width: 4px;
  }
  .actions-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .actions-list::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  .muted {
    font-size: 12px;
    color: var(--color-faint);
    padding: 4px 0;
  }

  @media (max-width: 768px) {
    .actions-list {
      -webkit-overflow-scrolling: touch;
    }
  }
</style>
