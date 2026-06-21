<script lang="ts">
  import type { UsageBreakdown, UsageLimits, UsageProjection, UsageRange } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { getUsageBreakdown, getUsageLimits } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import SpendLens from "$lib/components/usage/SpendLens.svelte";
  import OverheadLens from "$lib/components/usage/OverheadLens.svelte";
  import LimitsLens from "$lib/components/usage/LimitsLens.svelte";

  let { onclose }: { onclose?: () => void } = $props();

  type Tab = "spend" | "overhead" | "limits";

  let tab = $state<Tab>("spend");
  let range = $state<UsageRange>("7d");

  let breakdown = $state<UsageBreakdown | null>(null);
  let limits = $state<UsageLimits | null>(null);
  let projections = $state<UsageProjection[]>([]);
  let loading = $state(true);
  let error = $state(false);
  // Limits has its own error track (the Limits tab doesn't use `breakdown`), so a
  // limits-endpoint failure surfaces an error + Retry instead of loading forever.
  let limitsError = $state(false);

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
  }
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
          <button type="button" class="gbtn gbtn-secondary" onclick={retry}
            >{m.common_retry()}</button
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
        <LimitsLens {limits} {projections} />
      {:else if limitsError}
        <p class="usage-status-line usage-error">{m.usage_load_error()}</p>
        <button type="button" class="gbtn gbtn-secondary" onclick={retry}>{m.common_retry()}</button
        >
      {:else}
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
  }
</style>
