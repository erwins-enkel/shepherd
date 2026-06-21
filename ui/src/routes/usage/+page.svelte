<script lang="ts">
  import type { UsageRange } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { mockBreakdown, mockLimits, mockProjections } from "$lib/usage-mock";
  import SpendLens from "$lib/components/usage/SpendLens.svelte";
  import OverheadLens from "$lib/components/usage/OverheadLens.svelte";
  import LimitsLens from "$lib/components/usage/LimitsLens.svelte";

  type Tab = "spend" | "overhead" | "limits";

  let tab = $state<Tab>("spend");
  let range = $state<UsageRange>("7d");

  const breakdown = $derived(mockBreakdown(range));
</script>

<svelte:head>
  <title>{m.usage_page_title()}</title>
</svelte:head>

<main class="usage-page">
  <header class="usage-header">
    <h1 class="usage-title">{m.usage_page_title()}</h1>
    <p class="usage-prototype-note">{m.usage_prototype_note()}</p>
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
    {#if tab === "spend"}
      <SpendLens {breakdown} />
    {:else if tab === "overhead"}
      <OverheadLens {breakdown} />
    {:else}
      <LimitsLens limits={mockLimits()} projections={mockProjections()} />
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
    margin-bottom: 20px;
  }

  .usage-title {
    margin: 0 0 4px;
    font-size: var(--fs-xl);
    font-weight: 600;
    color: var(--color-ink);
  }

  .usage-prototype-note {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
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
</style>
