<script lang="ts">
  import { onDestroy } from "svelte";
  import type { WorkflowRun } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { rerunWorkflowRun, cancelWorkflowRun, listWorkflowRunHistory } from "$lib/api";
  import ActionHistoryRow from "./ActionHistoryRow.svelte";

  let {
    repoPath,
    run,
    rerunnable,
    cancelable,
    onchanged,
  }: {
    repoPath: string;
    run: WorkflowRun;
    /** Forge exposes a REST re-run control (GitHub yes, Gitea no). */
    rerunnable: boolean;
    /** Forge exposes a REST cancel control (GitHub yes, Gitea no). */
    cancelable: boolean;
    /** Called after a re-run/cancel lands so the parent can re-poll live state. */
    onchanged: () => void;
  } = $props();

  // Re-run and cancel both touch CI, so they arm on first click and fire on the
  // second; the armed state self-disarms after a few seconds so a stray click
  // never leaves a hot button waiting. Only one of the two buttons is ever shown
  // at once (state-gated below), so a single descriptor covers both.
  let armed = $state<"rerun" | "cancel" | null>(null);
  let busy = $state(false);
  let failed = $state(false);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  // Cancel only makes sense while work is live; re-run only once it has settled.
  const canCancel = $derived(run.state === "pending");
  const canRerun = $derived(run.state === "success" || run.state === "failure");

  const ciStatus = $derived(m.gitrail_ci_status({ status: run.state }));

  function disarm() {
    armed = null;
    if (disarmTimer) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
  }

  // The row can unmount mid-arm (its workflow leaves the list); drop the timer so
  // it never fires disarm() against a destroyed instance.
  onDestroy(() => {
    if (disarmTimer) clearTimeout(disarmTimer);
  });

  async function act(kind: "rerun" | "cancel") {
    if (busy) return;
    failed = false;
    if (armed !== kind) {
      armed = kind;
      if (disarmTimer) clearTimeout(disarmTimer);
      disarmTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    busy = true;
    try {
      if (kind === "rerun") {
        // A failed run retries only its broken jobs; a green re-run has none to
        // single out, so it re-runs in full.
        await rerunWorkflowRun(repoPath, run.runId, run.state === "failure");
      } else {
        await cancelWorkflowRun(repoPath, run.runId);
      }
      onchanged();
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }

  // "Older runs" history: lazy, never polled. Fetched the first time the expander
  // opens; "load more" grows the limit and re-fetches from the top (replaces the
  // list — `gh run list` has no cursor), then drops the latest run (already shown
  // at the card head) so the list is strictly older runs.
  // Snapshot semantics: the list is filtered against `run.runId` at fetch time, so
  // if the card-head latest run advances via the live poll AFTER history loaded, the
  // now-superseded prior run won't appear in the cached list. Consistent with the
  // no-polling design — a fresh "load more" (or re-mount) re-lists and picks it up.
  const HISTORY_STEP = 10;
  const HISTORY_MAX = 50;

  let histOpen = $state(false);
  let history = $state<WorkflowRun[]>([]);
  let histLoading = $state(false);
  let histLoaded = $state(false);
  let histFailed = $state(false);
  let histLimit = $state(HISTORY_STEP);

  // More to fetch only while the server returned a full page and we're under cap.
  // The +1 accounts for filtering out this card's run; if that run isn't in the
  // page (e.g. a newer run started since last poll), it can trigger one extra
  // no-op fetch — harmless, capped by HISTORY_MAX.
  const canLoadMore = $derived(
    histLoaded && history.length + 1 >= histLimit && histLimit < HISTORY_MAX,
  );

  async function loadHistory() {
    histLoading = true;
    histFailed = false;
    try {
      const r = await listWorkflowRunHistory(repoPath, run.workflowId, histLimit);
      history = r.runs.filter((h) => h.runId !== run.runId);
      histLoaded = true;
    } catch {
      histFailed = true;
    } finally {
      histLoading = false;
    }
  }

  async function toggleHistory() {
    histOpen = !histOpen;
    if (histOpen && !histLoaded && !histLoading) await loadHistory();
  }

  async function loadMore() {
    if (histLoading) return;
    histLimit = Math.min(histLimit + HISTORY_STEP, HISTORY_MAX);
    await loadHistory();
  }
</script>

<div class="wf">
  <div class="wf-head">
    <span class="dot dot-{run.state}" title={ciStatus} aria-label={ciStatus}></span>
    <span class="wf-name">{run.workflowName}</span>
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
    <a
      class="wf-link"
      href={run.runUrl}
      target="_blank"
      rel="noopener"
      title={m.actionspanel_run_link()}>↗</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {#if failed}<span class="wf-err">{m.actionspanel_action_failed()}</span>{/if}
    {#if cancelable && canCancel}
      <button
        class="act-btn"
        class:armed={armed === "cancel"}
        disabled={busy}
        onclick={() => act("cancel")}
        title={m.actionspanel_cancel_title()}
      >
        {armed === "cancel" ? m.actionspanel_cancel_confirm() : m.actionspanel_cancel()}
      </button>
    {:else if rerunnable && canRerun}
      <button
        class="act-btn"
        class:armed={armed === "rerun"}
        disabled={busy}
        onclick={() => act("rerun")}
        title={m.actionspanel_rerun_title()}
      >
        {armed === "rerun" ? m.actionspanel_rerun_confirm() : m.actionspanel_rerun()}
      </button>
    {/if}
  </div>
  <div class="jobs">
    <!-- key includes the index: matrix builds can repeat a job name within
         one run, which would otherwise collide in the keyed each. -->
    {#each run.jobs as job, i (job.name + " " + i)}
      <div class="job">
        <span
          class="dot dot-{job.state}"
          title={m.gitrail_ci_status({ status: job.state })}
          aria-label={m.gitrail_ci_status({ status: job.state })}
        ></span>
        {#if job.url}
          <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
          <a
            class="job-name"
            href={job.url}
            target="_blank"
            rel="noopener"
            title={m.actionspanel_job_link()}>{job.name}</a
          >
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        {:else}
          <span class="job-name">{job.name}</span>
        {/if}
      </div>
    {/each}
  </div>
  {#if run.workflowId}
    <div class="history">
      <button class="hist-toggle" type="button" onclick={toggleHistory} aria-expanded={histOpen}>
        <span class="hist-caret" class:open={histOpen}>▸</span>
        {m.actionspanel_older_runs()}
      </button>
      {#if histOpen}
        {#if histLoading && !histLoaded}
          <div class="hist-muted">{m.common_loading()}</div>
        {:else if histFailed}
          <button class="hist-muted retry" type="button" onclick={loadHistory}
            >{m.actionspanel_history_failed()}</button
          >
        {:else if history.length === 0}
          <div class="hist-muted">{m.actionspanel_history_empty()}</div>
        {:else}
          <div class="hist-list">
            {#each history as h (h.runId)}
              <ActionHistoryRow {repoPath} run={h} />
            {/each}
          </div>
          {#if canLoadMore}
            <button class="hist-more" type="button" disabled={histLoading} onclick={loadMore}>
              {m.actionspanel_load_more()}
            </button>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .wf {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    padding: 7px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .wf-head {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .wf-name {
    flex: 1;
    font-size: 12.5px;
    color: var(--color-ink-bright);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .wf-link {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--color-faint);
    text-decoration: none;
    transition: color 0.12s;
  }
  .wf-link:hover {
    color: var(--color-ink-bright);
  }

  .wf-err {
    flex-shrink: 0;
    font-size: 9.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-red);
  }

  /* Action button: the muted-by-default → amber-on-arm vocabulary PrRow uses. */
  .act-btn {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .act-btn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* Armed: the one moment this control earns the amber accent + inset glow the
     doctrine reserves for a primary/active button. */
  .act-btn.armed {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .act-btn:disabled {
    color: var(--color-faint);
    border-color: var(--color-line);
    cursor: not-allowed;
  }

  .jobs {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-left: 13px;
  }

  .job {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 12px;
  }

  .job-name {
    font-size: 11.5px;
    color: var(--color-ink);
    text-decoration: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    transition: color 0.12s;
  }
  a.job-name:hover {
    color: var(--color-ink-bright);
  }

  /* CI dots: the shared four-light vocabulary (mirrors PrRow / GitRail). */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    background: var(--color-faint);
    flex-shrink: 0;
  }
  .dot-pending {
    background: var(--color-amber);
    /* live work pulses; intentionally overrides the reduced-motion blanket. */
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .dot-success {
    background: var(--color-green);
  }
  .dot-failure {
    background: var(--color-red);
  }

  @media (max-width: 768px) {
    .act-btn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }

  .history {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
    padding-top: 5px;
    border-top: 1px dashed var(--color-line);
  }

  .hist-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    transition: color 0.12s;
  }
  .hist-toggle:hover {
    color: var(--color-ink-bright);
  }

  .hist-caret {
    font-size: 9px;
    color: var(--color-faint);
    transition: transform 0.12s;
  }
  .hist-caret.open {
    transform: rotate(90deg);
  }

  .hist-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-left: 13px;
  }

  .hist-muted {
    font-size: 11px;
    color: var(--color-faint);
    padding: 2px 0 2px 13px;
    text-align: left;
  }
  .retry {
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--font-mono);
  }
  .retry:hover {
    color: var(--color-amber);
  }

  .hist-more {
    align-self: flex-start;
    margin-left: 13px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .hist-more:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .hist-more:disabled {
    color: var(--color-faint);
    cursor: not-allowed;
  }
</style>
