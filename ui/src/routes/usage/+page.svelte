<script lang="ts">
  import type {
    UsageBreakdown,
    UsageLimits,
    UsageProjection,
    UsageRange,
    UsageHistoryResponse,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { getUsageBreakdown, getUsageLimits, getUsageHistory } from "$lib/api";
  import { pollWhileVisible } from "$lib/visibility";
  import { resolve } from "$app/paths";
  import SpendLens from "$lib/components/usage/SpendLens.svelte";
  import OverheadLens from "$lib/components/usage/OverheadLens.svelte";
  import LimitsLens from "$lib/components/usage/LimitsLens.svelte";

  type Tab = "spend" | "overhead" | "limits";

  let tab = $state<Tab>("spend");
  let range = $state<UsageRange>("7d");

  let breakdown = $state<UsageBreakdown | null>(null);
  let limits = $state<UsageLimits | null>(null);
  let projections = $state<UsageProjection[]>([]);
  let history = $state<UsageHistoryResponse | null>(null);
  let loading = $state(true);
  let error = $state(false);
  // Limits has its own error track (the Limits tab doesn't use `breakdown`), so a
  // limits-endpoint failure surfaces an error + Retry instead of loading forever.
  let limitsError = $state(false);

  // Last-seen scrape signal — history only moves on a scrape, so the 30s poll
  // re-fetches /api/usage/history ONLY when this advances (never every tick).
  let lastScrapeSig = "";
  function scrapeSig(): string {
    return `${limits?.calibratedAt}:${limits?.credits?.scrapedAt}`;
  }

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

  // History augments the lens — a failed load must NOT blank it. Quiet on error.
  async function loadHistory() {
    try {
      history = await getUsageHistory();
    } catch {
      /* augmentation only — leave prior history untouched */
    }
  }
  $effect(() => {
    // Async IIFE so the `scrapeSig()` baseline read happens AFTER the awaits — reading
    // `limits` synchronously here would make this effect depend on `limits`, and since
    // loadLimits() assigns a fresh object each call it would re-invalidate → refetch loop.
    void (async () => {
      await loadLimits();
      // Initial unconditional history load; baseline the signal so the first poll
      // tick doesn't redundantly refetch.
      await loadHistory();
      lastScrapeSig = scrapeSig();
    })();
  });

  // Live refresh while visible: gauges + projection every tick (cheap recompute);
  // history only when the scrape signal advanced.
  async function refresh() {
    await loadLimits();
    const sig = scrapeSig();
    if (sig !== lastScrapeSig) {
      lastScrapeSig = sig;
      loadHistory();
    }
  }
  $effect(() => pollWhileVisible(refresh, 30_000));

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

  // Retry re-fetches BOTH tracks so either failure surface recovers.
  function retry() {
    loadBreakdown(range);
    loadLimits();
    loadHistory();
  }
</script>

<svelte:head>
  <title>{m.usage_page_title()}</title>
</svelte:head>

<main class="usage-page">
  <header class="usage-header">
    <h1 class="usage-title">{m.usage_page_title()}</h1>
    <a class="usage-close" href={resolve("/")} aria-label={m.common_close()}>✕</a>
  </header>

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
      class:seg-active={tab === "limits"}
      aria-pressed={tab === "limits"}
      onclick={() => (tab = "limits")}>{m.usage_limits_tab()}</button
    >
  </div>

  <!-- Range selector (Spend + Overhead only) -->
  {#if tab !== "limits"}
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

  <!-- Lens body -->
  <div class="lens-body">
    <!-- Breakdown-error banner for the Spend/Overhead tabs. Shown even when a stale
         `breakdown` is still present (a failed range-change refetch) so the user isn't
         silently left on old-range data with no indication the new range failed. -->
    {#if error && tab !== "limits"}
      <div class="usage-error-banner" role="alert">
        <span class="usage-status-line usage-error">{m.usage_load_error()}</span>
        <button type="button" class="gbtn gbtn-secondary" onclick={retry}>{m.common_retry()}</button
        >
      </div>
    {/if}

    {#if tab === "spend"}
      {#if breakdown}
        <SpendLens {breakdown} />
      {:else if loading}
        <p class="usage-status-line">{m.common_loading()}</p>
      {/if}
    {:else if tab === "overhead"}
      {#if breakdown}
        <OverheadLens {breakdown} />
      {:else if loading}
        <p class="usage-status-line">{m.common_loading()}</p>
      {/if}
    {:else if limits}
      <LimitsLens {limits} {projections} {history} />
    {:else if limitsError}
      <p class="usage-status-line usage-error">{m.usage_load_error()}</p>
      <button type="button" class="gbtn gbtn-secondary" onclick={retry}>{m.common_retry()}</button>
    {:else}
      <p class="usage-status-line">{m.common_loading()}</p>
    {/if}
  </div>
</main>

<style>
  .usage-page {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 16px 48px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .usage-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 20px;
  }

  .usage-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    font-size: var(--fs-lg);
    color: var(--color-muted);
    text-decoration: none;
    flex-shrink: 0;
  }

  .usage-close:hover {
    color: var(--color-ink);
  }

  .usage-close:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .usage-title {
    margin: 0 0 4px;
    font-size: var(--fs-xl);
    font-weight: 600;
    color: var(--color-ink);
  }

  /* Segmented controls */
  .seg-row {
    display: flex;
    border-bottom: 1px solid var(--color-line);
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

  .lens-body {
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
</style>
