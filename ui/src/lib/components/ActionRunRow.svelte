<script lang="ts">
  import { onDestroy } from "svelte";
  import type { WorkflowRun } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { rerunWorkflowRun, cancelWorkflowRun } from "$lib/api";

  let {
    repoPath,
    run,
    onchanged,
  }: {
    repoPath: string;
    run: WorkflowRun;
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
    {#if canCancel}
      <button
        class="act-btn"
        class:armed={armed === "cancel"}
        disabled={busy}
        onclick={() => act("cancel")}
        title={m.actionspanel_cancel_title()}
      >
        {armed === "cancel" ? m.actionspanel_cancel_confirm() : m.actionspanel_cancel()}
      </button>
    {:else if canRerun}
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
</style>
