<script lang="ts">
  import type { WorkflowRun, WorkflowJob } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { listRunJobs } from "$lib/api";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";

  let { repoPath, run }: { repoPath: string; run: WorkflowRun } = $props();

  // Jobs are fetched lazily the first time this row is expanded; thereafter the
  // result is cached (`loaded`) so re-expanding never re-hits `gh`.
  let open = $state(false);
  let jobs = $state<WorkflowJob[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let failed = $state(false);

  const age = $derived(relativeAge(run.createdAt, clock.current));
  const shortSha = $derived(run.headSha.slice(0, 7));
  const ciStatus = $derived(m.gitrail_ci_status({ status: run.state }));

  async function loadJobs() {
    loading = true;
    failed = false;
    try {
      const r = await listRunJobs(repoPath, run.runId);
      jobs = r.jobs;
      loaded = true;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  async function toggle() {
    open = !open;
    if (open && !loaded && !loading) await loadJobs();
  }
</script>

<div class="hist-run">
  <div class="hist-head">
    <button
      class="hist-summary"
      onclick={toggle}
      aria-expanded={open}
      title={ciStatus}
      type="button"
    >
      <span class="dot dot-{run.state}" aria-label={ciStatus}></span>
      <span class="hist-num">#{run.runId}</span>
      <span class="hist-age">{age}</span>
      <span class="hist-sha">{shortSha}</span>
      <span class="hist-caret" class:open>▸</span>
    </button>
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
    <a
      class="hist-link"
      href={run.runUrl}
      target="_blank"
      rel="noopener"
      title={m.actionspanel_run_link()}>↗</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </div>

  {#if open}
    {#if loading && !loaded}
      <div class="muted">{m.common_loading()}</div>
    {:else if failed}
      <button class="muted retry" type="button" onclick={loadJobs}
        >{m.actionspanel_history_failed()}</button
      >
    {:else}
      <div class="jobs">
        {#each jobs as job, i (job.name + " " + i)}
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
    {/if}
  {/if}
</div>

<style>
  .hist-run {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .hist-head {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .hist-summary {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: none;
    padding: 1px 0;
    cursor: pointer;
    font-family: var(--font-mono);
    color: var(--color-ink);
    text-align: left;
  }
  .hist-summary:hover .hist-num {
    color: var(--color-ink-bright);
  }

  .hist-num {
    font-size: 11.5px;
    color: var(--color-ink);
  }
  .hist-age,
  .hist-sha {
    font-size: 10.5px;
    color: var(--color-faint);
  }
  .hist-sha {
    font-variant-ligatures: none;
  }

  .hist-caret {
    margin-left: auto;
    font-size: 9px;
    color: var(--color-faint);
    transition: transform 0.12s;
  }
  .hist-caret.open {
    transform: rotate(90deg);
  }

  .hist-link {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--color-faint);
    text-decoration: none;
    transition: color 0.12s;
  }
  .hist-link:hover {
    color: var(--color-ink-bright);
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

  .muted {
    font-size: 11px;
    color: var(--color-faint);
    padding: 2px 0 2px 13px;
  }
  .retry {
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--font-mono);
    text-align: left;
  }
  .retry:hover {
    color: var(--color-amber);
  }

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
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .dot-success {
    background: var(--color-green);
  }
  .dot-failure {
    background: var(--color-red);
  }
</style>
