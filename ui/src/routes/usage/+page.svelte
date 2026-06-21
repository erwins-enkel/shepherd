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

  // Retry re-fetches BOTH tracks so either failure surface recovers. Rebaseline the
  // scrape signal after the limits/history loads so the next poll tick doesn't see a
  // stale signal and trigger a redundant /api/usage/history refetch.
  async function retry() {
    loadBreakdown(range);
    await loadLimits();
    await loadHistory();
    lastScrapeSig = scrapeSig();
  }
</script>

<svelte:head>
  <title>{m.usage_page_title()}</title>
</svelte:head>

<main class="usage-page">
  <header class="usage-header">
    <a class="usage-back" href={resolve("/")} aria-label={m.viewport_back_aria()}
      >{m.viewport_back_button()}</a
    >
    <h1 class="usage-title">{m.usage_page_title()}</h1>
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
    /* Horizontal padding lives on the header + lens body (so the sticky title bar
       and the segmented controls can run full-bleed); only the bottom safe-area
       inset belongs on the page itself. */
    padding: 0 0 calc(40px + env(safe-area-inset-bottom));
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* Sticky title bar: stays pinned so the back affordance is always reachable —
     on a small-screen PWA the page used to scroll the only exit out of view. The
     top inset clears the notch / Dynamic Island; the opaque head background hides
     content scrolling underneath. */
  .usage-header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: calc(10px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 10px
      max(16px, env(safe-area-inset-left));
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }

  /* Prominent, unmistakable exit — a bordered, filled, touch-sized button rather
     than a dim glyph. Mirrors the Viewport `.back` idiom; navigates home (the herd). */
  .usage-back {
    display: inline-flex;
    align-items: center;
    min-height: 40px;
    padding: 0 14px;
    border: 1px solid var(--color-line-bright);
    border-radius: 6px;
    background: var(--color-inset);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    letter-spacing: 0.04em;
    text-decoration: none;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .usage-back:hover {
    background: var(--color-hover);
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .usage-back:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .usage-title {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: 600;
    color: var(--color-ink-bright);
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
    padding: 16px max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left));
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
