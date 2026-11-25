<script lang="ts">
  // Steering report (#4175): how the operator's own typed prompts and steers played out. Loads the
  // latest stored report on open; the `steering:report` WS event (store.svelte.ts → steeringReport)
  // flips the running state and drops in the finished report on every client.
  import { onMount } from "svelte";
  import { m } from "#lib/paraglide/messages.js";
  import InfoTip from "#lib/components/InfoTip.svelte";
  import { steeringReport } from "#lib/steering-report.svelte.js";
  import SteeringReportBody from "./SteeringReportBody.svelte";
  import SteeringTrend from "./SteeringTrend.svelte";
  import { failureText, skippedCount, steeringExplanation } from "./steering";

  onMount(() => {
    steeringReport.load();
  });

  // Opening the lens reads the weekly digest (#4176): clear the unread dots, including for a
  // digest that lands while the lens is open.
  $effect(() => {
    if (steeringReport.unread) void steeringReport.markSeen();
  });

  const report = $derived(steeringReport.report);
  const running = $derived(steeringReport.running);
  const failure = $derived(report?.status === "failed" ? failureText(report.error) : null);
  const skipped = $derived(report ? skippedCount(report) : 0);
  const day = (t: number) => new Date(t).toLocaleDateString();
</script>

<div class="steering-lens">
  <section class="panel steering-section">
    <div class="head-row">
      <h2 class="section-heading">{m.usage_steering_heading()}</h2>
      <InfoTip text={steeringExplanation()} label={m.usage_steering_explain_label()} />
      <button
        type="button"
        class="gbtn primary run"
        disabled={running}
        aria-busy={running}
        onclick={() => steeringReport.run()}
      >
        {#if running}<span class="spinner" aria-hidden="true"
          ></span>{m.usage_steering_running()}{:else}{m.usage_steering_run()}{/if}
      </button>
    </div>
    <p class="caption">{m.usage_steering_caption()}</p>

    {#if report}
      <p class="meta">
        <span>
          {m.usage_steering_window({ start: day(report.windowStart), end: day(report.windowEnd) })}
        </span>
        {#if report.sample}
          <span>{m.usage_steering_sessions({ n: report.sample.considered })}</span>
          {#if report.sample.capped}<span>
              {m.usage_steering_capped({ n: report.sample.considered })}
            </span>{/if}
          {#if skipped > 0}<span>{m.usage_steering_skipped({ n: skipped })}</span>{/if}
        {/if}
        <span>
          {m.usage_steering_generated({ when: new Date(report.createdAt).toLocaleString() })}
        </span>
        {#if report.model}<span class="model">
            {m.usage_steering_model({ model: report.model })}
          </span>{/if}
      </p>
    {/if}

    {#if steeringReport.runError}
      <p class="error" role="alert">{m.usage_steering_run_error()}</p>
    {/if}
  </section>

  {#if !report && steeringReport.loadError}
    <div class="notice" role="alert">
      <span class="error">{m.usage_load_error()}</span>
      <button type="button" class="gbtn" onclick={() => steeringReport.load()}>
        {m.common_retry()}
      </button>
    </div>
  {:else if !report && !steeringReport.loaded}
    <p class="muted">{m.common_loading()}</p>
  {:else if !report}
    <section class="panel steering-section none">
      <p class="lead">{m.usage_steering_none()}</p>
      <p class="caption">{m.usage_steering_none_body()}</p>
      {#if !running}
        <button type="button" class="gbtn primary cta" onclick={() => steeringReport.run()}>
          {m.usage_steering_run()}
        </button>
      {/if}
    </section>
  {:else if failure}
    <div class="notice failed" role="alert">
      <span class="error">{m.usage_steering_failed()} {failure.text}</span>
      {#if failure.detail}<span class="detail">
          {m.usage_steering_err_detail({ detail: failure.detail })}
        </span>{/if}
    </div>
  {:else if report.status === "empty" || !report.tables}
    <p class="muted empty">{m.usage_steering_empty()}</p>
  {:else}
    {#if report.status === "thin"}
      <p class="notice thin" role="note">{m.usage_steering_thin()}</p>
    {/if}
    <SteeringReportBody {report} tables={report.tables} />
  {/if}

  {#if steeringReport.trend.length > 0}
    <SteeringTrend trend={steeringReport.trend} />
  {/if}
</div>

<style>
  .steering-lens {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding-top: 1rem;
  }

  .steering-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .head-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .section-heading {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color-ink-bright);
    margin: 0;
  }

  .run {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .caption {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }

  .cta {
    align-self: flex-start;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin: 0;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }

  .model {
    font-family: var(--font-mono);
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    margin: 0;
  }

  .lead {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
  }

  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-line);
    border-radius: 0.375rem;
    background: var(--color-inset);
    font-size: var(--fs-meta);
  }

  .notice.thin {
    border-color: var(--color-amber);
    color: var(--color-ink);
  }

  .notice.failed {
    flex-direction: column;
    align-items: flex-start;
    border-color: var(--color-red);
  }

  .error {
    color: var(--color-red);
    font-size: var(--fs-meta);
    margin: 0;
  }

  .detail {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }

  .spinner {
    width: 0.8em;
    height: 0.8em;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: steering-spin 0.8s linear infinite;
  }

  @keyframes steering-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    min-height: 32px;
    cursor: pointer;
  }

  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
</style>
