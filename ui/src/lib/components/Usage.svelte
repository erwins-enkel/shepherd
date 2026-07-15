<script lang="ts">
  import type {
    UsageBreakdown,
    UsageTimeline,
    UsageLimits,
    UsageProjection,
    UsageRange,
    GithubRateLimit,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import {
    getUsageBreakdown,
    getUsageTimeline,
    getUsageLimits,
    getGithubRateLimit,
  } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import { formatTokenLabel } from "$lib/format";
  import { codexTokenUsage } from "$lib/components/usage-gauges";
  import SpendLens from "$lib/components/usage/SpendLens.svelte";
  import OverheadLens from "$lib/components/usage/OverheadLens.svelte";
  import LimitsLens from "$lib/components/usage/LimitsLens.svelte";
  import GithubLens from "$lib/components/usage/GithubLens.svelte";
  import TimelineLens from "$lib/components/usage/TimelineLens.svelte";
  import ModelsLens from "$lib/components/usage/ModelsLens.svelte";

  let { onclose }: { onclose?: () => void } = $props();

  type Tab = "spend" | "overhead" | "timeline" | "models" | "limits" | "github";

  let tab = $state<Tab>("spend");
  let range = $state<UsageRange>("7d");

  let breakdown = $state<UsageBreakdown | null>(null);
  let timeline = $state<UsageTimeline | null>(null);
  let timelineError = $state(false);
  let limits = $state<UsageLimits | null>(null);
  let projections = $state<UsageProjection[]>([]);
  let github = $state<GithubRateLimit | null>(null);
  let githubError = $state(false);
  let loading = $state(true);
  let error = $state(false);
  // Limits has its own error track (the Limits tab doesn't use `breakdown`), so a
  // limits-endpoint failure surfaces an error + Retry instead of loading forever.
  let limitsError = $state(false);
  const codexUsage = $derived(codexTokenUsage(limits));

  // Fetch limits once on mount (range-independent). `limits === null && !limitsError`
  // ⇒ still loading.
  async function loadLimits() {
    limitsError = false;
    try {
      const res = await getUsageLimits();
      limits = res.limits;
      projections = res.projections;
    } catch {
      limitsError = true;
    }
  }
  $effect(() => {
    loadLimits();
  });

  // GitHub rate-limit buckets (range-independent). `github === null && !githubError`
  // ⇒ still loading.
  async function loadGithub() {
    githubError = false;
    try {
      github = await getGithubRateLimit();
    } catch {
      githubError = true;
    }
  }
  $effect(() => {
    loadGithub();
  });

  // Monotonic token: latest request always wins; stale requests discard their results.
  let reqToken = 0;

  async function loadBreakdown(r: UsageRange) {
    const my = ++reqToken;
    loading = true;
    error = false;
    try {
      const b = await getUsageBreakdown(r);
      if (my !== reqToken) return;
      breakdown = b;
    } catch {
      if (my !== reqToken) return;
      error = true;
    } finally {
      if (my === reqToken) loading = false;
    }
  }

  // Fetch breakdown on mount and whenever range changes.
  $effect(() => {
    loadBreakdown(range);
  });

  // Timeline is range-dependent and loaded lazily (only while its tab is active), with its own
  // monotonic token so a stale range's response can't overwrite a newer one.
  let timelineReqToken = 0;

  async function loadTimeline(r: UsageRange) {
    const my = ++timelineReqToken;
    timelineError = false;
    try {
      const t = await getUsageTimeline(r);
      if (my !== timelineReqToken) return;
      timeline = t;
    } catch {
      if (my !== timelineReqToken) return;
      timelineError = true;
    }
  }

  $effect(() => {
    if (tab === "timeline") loadTimeline(range);
  });

  // Retry re-fetches ALL tracks so any failure surface recovers.
  function retry() {
    loadBreakdown(range);
    loadTimeline(range);
    loadLimits();
    loadGithub();
  }

  // Template-state derivations (kept out of the markup to keep the template's
  // branching shallow). Spend, Overhead, Timeline, and Models share the range selector.
  const showRange = $derived(
    tab === "spend" || tab === "overhead" || tab === "timeline" || tab === "models",
  );
  // Non-blocking refetch banner — breakdown-backed lenses share one error track.
  const showBreakdownError = $derived(
    error && (tab === "spend" || tab === "overhead" || tab === "models"),
  );
  const showTimelineError = $derived(timelineError && tab === "timeline");
  // The active tab has data to render its lens (else we show loading/error chrome).
  const hasContent = $derived(
    ((tab === "spend" || tab === "overhead" || tab === "models") && !!breakdown) ||
      (tab === "timeline" && !!timeline) ||
      (tab === "limits" && !!limits) ||
      (tab === "github" && !!github),
  );
  // No content yet, and the failing fetch for this tab errored (not still loading).
  // (Spend/Overhead/Timeline surface their error via the banner above, never inline.)
  const bodyError = $derived(
    !hasContent && ((tab === "limits" && limitsError) || (tab === "github" && githubError)),
  );
  const bodyLoading = $derived(
    ((tab === "spend" || tab === "overhead" || tab === "models") && !breakdown && loading) ||
      (tab === "timeline" && !timeline && !timelineError) ||
      (tab === "limits" && !limits && !limitsError) ||
      (tab === "github" && !github && !githubError),
  );
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose?.();
  }}
>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.usage_page_title()}
    use:dialog={{ onclose: () => onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{m.usage_page_title()}</span>
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    <!-- Tab switcher -->
    <div class="seg-row tab-row">
      <button
        type="button"
        class="seg-btn"
        class:seg-active={tab === "spend"}
        aria-pressed={tab === "spend"}
        onclick={() => (tab = "spend")}>{m.usage_spend_tab()}</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-active={tab === "overhead"}
        aria-pressed={tab === "overhead"}
        onclick={() => (tab = "overhead")}>{m.usage_overhead_tab()}</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-active={tab === "timeline"}
        aria-pressed={tab === "timeline"}
        onclick={() => (tab = "timeline")}>{m.usage_timeline_tab()}</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-active={tab === "models"}
        aria-pressed={tab === "models"}
        onclick={() => (tab = "models")}>{m.usage_models_tab()}</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-active={tab === "limits"}
        aria-pressed={tab === "limits"}
        onclick={() => (tab = "limits")}>{m.usage_limits_tab()}</button
      >
      <button
        type="button"
        class="seg-btn"
        class:seg-active={tab === "github"}
        aria-pressed={tab === "github"}
        onclick={() => (tab = "github")}>{m.usage_github_tab()}</button
      >
    </div>

    <!-- Range selector for every range-backed lens -->
    {#if showRange}
      <div class="seg-row range-row" role="group" aria-label={m.usage_range_label()}>
        <button
          type="button"
          class="seg-btn"
          class:seg-active={range === "24h"}
          aria-pressed={range === "24h"}
          onclick={() => (range = "24h")}>{m.usage_range_24h()}</button
        >
        <button
          type="button"
          class="seg-btn"
          class:seg-active={range === "7d"}
          aria-pressed={range === "7d"}
          onclick={() => (range = "7d")}>{m.usage_range_7d()}</button
        >
        <button
          type="button"
          class="seg-btn"
          class:seg-active={range === "30d"}
          aria-pressed={range === "30d"}
          onclick={() => (range = "30d")}>{m.usage_range_30d()}</button
        >
        <button
          type="button"
          class="seg-btn"
          class:seg-active={range === "all"}
          aria-pressed={range === "all"}
          onclick={() => (range = "all")}>{m.usage_range_all()}</button
        >
      </div>
    {/if}

    {#if codexUsage && tab !== "limits" && tab !== "models"}
      <div class="provider-strip" class:provider-stale={codexUsage.stale}>
        <span class="provider-name">{m.agent_provider_codex()}</span>
        <span class="provider-metric">
          <span>{m.topbar_tokens_window({ period: "5H" })}</span>
          <strong>{formatTokenLabel(codexUsage.session5hTokens)}</strong>
        </span>
        <span class="provider-metric">
          <span>{m.topbar_tokens_window({ period: "WK" })}</span>
          <strong>{formatTokenLabel(codexUsage.weekTokens)}</strong>
        </span>
        <span class="provider-metric provider-total">
          <span>{m.topbar_tokens_total()}</span>
          <strong>{formatTokenLabel(codexUsage.totalTokens)}</strong>
        </span>
      </div>
    {/if}

    <!-- Lens body -->
    <div class="lens-body">
      <!-- Breakdown-error banner for breakdown-backed tabs. Shown even when a stale
           `breakdown` is still present (a failed range-change refetch) so the user isn't
           silently left on old-range data with no indication the new range failed. -->
      {#if showBreakdownError || showTimelineError}
        <div class="usage-error-banner" role="alert">
          <span class="usage-status-line usage-error">{m.usage_load_error()}</span>
          <button type="button" class="gbtn gbtn-secondary" onclick={retry}
            >{m.common_retry()}</button
          >
        </div>
      {/if}

      {#if tab === "spend" && breakdown}
        <SpendLens {breakdown} />
      {:else if tab === "overhead" && breakdown}
        <OverheadLens {breakdown} />
      {:else if tab === "timeline" && timeline}
        <TimelineLens {timeline} />
      {:else if tab === "models" && breakdown}
        <ModelsLens models={breakdown.models} />
      {:else if tab === "limits" && limits}
        <LimitsLens {limits} {projections} {codexUsage} />
      {:else if tab === "github" && github}
        <GithubLens data={github} />
      {:else if bodyError}
        <p class="usage-status-line usage-error">{m.usage_load_error()}</p>
        <button type="button" class="gbtn gbtn-secondary" onclick={retry}>{m.common_retry()}</button
        >
      {:else if bodyLoading}
        <p class="usage-status-line">{m.common_loading()}</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }

  .card {
    position: relative;
    width: min(760px, 94vw);
    max-height: 86vh;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    border: 1px solid var(--color-line-bright);
  }

  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }

  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }

  .chead {
    display: flex;
    align-items: center;
    margin-bottom: 16px;
  }

  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .x:hover {
    color: var(--color-ink);
  }

  .x:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* Segmented controls — full-bleed: negate the card's 16px horizontal padding
     so borders/hairlines span edge-to-edge of the card. */
  .seg-row {
    display: flex;
    border-bottom: 1px solid var(--color-line);
    margin-inline: -16px;
  }

  .seg-btn {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-base);
    cursor: pointer;
    padding: 0 2px;
    color: var(--color-muted);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }

  .seg-btn:last-child {
    border-right: 0;
  }

  .seg-btn:hover {
    color: var(--color-ink);
  }

  .seg-btn.seg-active {
    color: var(--color-amber);
    background: var(--color-inset);
    box-shadow: inset 0 -2px 0 var(--color-amber);
  }

  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .range-row {
    /* Slightly smaller to visually subordinate the range picker under tabs */
    border-top: 1px solid var(--color-line);
  }

  .range-row .seg-btn {
    min-height: 36px;
    font-size: var(--fs-meta);
  }

  .provider-strip {
    display: grid;
    grid-template-columns: auto repeat(3, minmax(0, 1fr));
    align-items: center;
    gap: 8px 14px;
    margin-inline: -16px;
    padding: 9px 16px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-inset);
    color: var(--color-muted);
  }

  .provider-strip.provider-stale {
    opacity: 0.72;
  }

  .provider-name {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .provider-metric {
    min-width: 0;
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: 6px;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    white-space: nowrap;
  }

  .provider-metric strong {
    color: var(--color-ink);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .provider-total strong {
    color: var(--color-amber);
  }

  .lens-body {
    flex: 1;
    overflow-y: auto;
    margin-top: 0;
  }

  .usage-status-line {
    margin: 24px 0 8px;
    font-size: var(--fs-base);
    color: var(--color-muted);
  }

  .usage-error {
    color: var(--color-red);
  }

  /* Non-blocking refetch-error banner: sits above stale lens content so a failed
     range change is visible without discarding the previous range's data. */
  .usage-error-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 16px;
  }

  .usage-error-banner .usage-status-line {
    margin: 0;
  }

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }

    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      max-height: none;
      border: 0;
      overflow: hidden;
    }

    .provider-strip {
      grid-template-columns: 1fr 1fr;
      gap: 7px 12px;
    }

    .provider-name {
      grid-column: 1 / -1;
    }

    .provider-metric {
      justify-content: space-between;
    }

    .provider-total {
      grid-column: 1 / -1;
    }
  }
</style>
