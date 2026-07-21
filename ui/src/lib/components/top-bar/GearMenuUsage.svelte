<script lang="ts">
  import type { UsageLimits } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { formatTokenLabel } from "$lib/format";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import {
    codexGaugeList,
    codexTokenUsage,
    gaugeList,
    hottestCapacityWindow,
    modelWeekList,
    providerCapacityRows,
    type GaugeKey,
  } from "../usage-gauges";
  import LimitGaugeRow from "./LimitGaugeRow.svelte";
  import ModelWeekGauge from "../usage/ModelWeekGauge.svelte";
  import CreditDetail from "./CreditDetail.svelte";
  import UsageRefreshButton from "./UsageRefreshButton.svelte";

  let {
    limits,
    nowMs,
    mobile = false,
    expanded = $bindable(false),
    creditFill,
    creditColor,
    creditAmount,
    refreshing,
    refreshError,
    onRefresh,
    periodLabel,
    onOpenUsage,
    coachId = "",
  }: {
    limits: UsageLimits | null;
    nowMs: number;
    mobile?: boolean;
    expanded?: boolean;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    periodLabel: (k: GaugeKey) => string;
    /** Click-through on the block body → the full usage view (parent closes the menu). */
    onOpenUsage: () => void;
    /** Coachmark anchor id for the block body ("" = not an anchor; only ONE instance may claim an id). */
    coachId?: string;
  } = $props();

  // All usage math lives in the tested model layer (usage-gauges.ts) — this component
  // only renders its output.
  const hottest = $derived(hottestCapacityWindow(providerCapacityRows(limits)));
  const gauges = $derived(gaugeList(limits));
  const perModel = $derived(modelWeekList(limits));
  const credits = $derived(limits?.credits ?? null);
  const codexUsage = $derived(codexTokenUsage(limits));
  const codexWindows = $derived(codexGaugeList(codexUsage));
  const subscriptionOnly = $derived(limits?.subscriptionOnly === true);
  const hasClaude = $derived(gauges.length > 0 || perModel.length > 0 || !!credits);
  // Window designation (CC·5H / CX·WK …): provider abbreviation + raw window key —
  // data-style codes, not translated chrome. Prefixes match selectedProviderCapacity
  // (the New Task capacity line) so the same provider never carries two codes.
  const windowCode = $derived(
    hottest ? `${hottest.provider === "codex" ? "CX" : "CC"}·${hottest.window.key}` : "",
  );

  const breakdownId = $derived(mobile ? "gear-usage-breakdown-mobile" : "gear-usage-breakdown");
</script>

<!-- The block body is one button (→ usage view); "all ▾" is a SIBLING overlay button
     (never nested) that toggles the inline per-window breakdown. -->
<div class="gm" class:mobile data-stale={hottest?.stale ? "true" : undefined}>
  <button
    type="button"
    class="gm-open"
    data-gear-row
    aria-haspopup="dialog"
    aria-label={m.topbar_usage_link()}
    use:coachTarget={coachId}
    onclick={onOpenUsage}
  >
    <span class="gm-label">{m.gearmenu_usage_label()}</span>
    {#if hottest}
      <span class="gm-line">
        <span class="gm-code">{windowCode}</span>
        <span class="gm-bar" aria-hidden="true">
          <span class="gm-fill" style="width:{hottest.window.remainingPct}%"></span>
        </span>
        <span class="gm-free">{m.gearmenu_pct_free({ pct: hottest.window.remainingPct })}</span>
      </span>
    {/if}
  </button>
  <button
    type="button"
    class="gm-all"
    data-gear-row
    aria-expanded={expanded}
    aria-controls={breakdownId}
    aria-label={m.gearmenu_usage_all_aria()}
    onclick={() => (expanded = !expanded)}
  >
    {m.gearmenu_usage_all()}
    {expanded ? "▴" : "▾"}
  </button>
  {#if expanded}
    <div class="gm-breakdown" id={breakdownId}>
      {#if subscriptionOnly && !codexUsage}
        <div class="gm-note">{m.usage_subscription_only()}</div>
      {:else}
        {#if hasClaude}
          <div class="gm-section">
            {m.topbar_usage_provider_title({ provider: m.agent_provider_claude() })}
          </div>
          <div class="gm-rows" class:stale={limits?.stale}>
            {#each gauges as g (g.label)}
              <LimitGaugeRow label={periodLabel(g.label)} limit={g.w} {nowMs} />
            {/each}
            {#each perModel as entry (entry.model)}
              <ModelWeekGauge {entry} {nowMs} />
            {/each}
            <CreditDetail {credits} {creditFill} {creditColor} {creditAmount} {nowMs} />
          </div>
        {/if}
        {#if codexUsage}
          <div class="gm-section">
            {m.topbar_usage_provider_title({ provider: m.agent_provider_codex() })}
          </div>
          <div class="gm-rows" class:stale={codexUsage.stale}>
            {#each codexWindows as g (g.label)}
              <LimitGaugeRow label={periodLabel(g.label)} limit={g.w} {nowMs} />
            {/each}
            {#if codexWindows.length === 0}
              <div class="gm-note">{m.topbar_codex_limits_unavailable()}</div>
            {/if}
            <div class="gm-token-line">
              <span>{m.topbar_tokens_window({ period: "5H" })}</span>
              <span>{formatTokenLabel(codexUsage.session5hTokens)}</span>
            </div>
            <div class="gm-token-line">
              <span>{m.topbar_tokens_window({ period: "WK" })}</span>
              <span>{formatTokenLabel(codexUsage.weekTokens)}</span>
            </div>
            <div class="gm-token-line">
              <span>{m.topbar_tokens_total()}</span>
              <span>{formatTokenLabel(codexUsage.totalTokens)}</span>
            </div>
          </div>
        {/if}
        <UsageRefreshButton {refreshing} {refreshError} {onRefresh} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .gm {
    position: relative;
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--color-line);
  }
  .gm-open {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 9px 12px;
    background: transparent;
    border: 0;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .gm-open:hover {
    background: var(--color-hover);
  }
  .gm-open:focus-visible,
  .gm-all:focus-visible {
    outline: none;
    background: var(--color-hover);
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
  }
  .gm-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-faint);
    /* keep clear of the overlaid "all ▾" toggle */
    padding-right: 44px;
  }
  .gm-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Stale selected window: same dim treatment the sheet's gauge sections use. */
  .gm[data-stale] .gm-line {
    opacity: 0.5;
  }
  .gm-code {
    letter-spacing: 0.08em;
  }
  .gm-bar {
    flex: 1;
    height: 4px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
  }
  /* Handoff-required healthy-headroom fill: green at % free (the reference's
     --green "healthy/live" role), not the utilization severity ladder — the
     severity colors live on the used-capacity gauges in the expansion below. */
  .gm-fill {
    display: block;
    height: 100%;
    background: var(--color-green);
  }
  .gm-all {
    position: absolute;
    top: 5px;
    right: 8px;
    padding: 2px 4px;
    background: transparent;
    border: 0;
    font: inherit;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    cursor: pointer;
  }
  .gm-all:hover {
    color: var(--color-ink);
    background: var(--color-hover);
  }
  .gm-breakdown {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 12px 9px;
  }
  .gm-section {
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    padding-top: 4px;
  }
  .gm-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .gm-rows.stale {
    opacity: 0.5;
  }
  .gm-note {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    letter-spacing: 0.08em;
    line-height: 1.35;
  }
  .gm-token-line {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-variant-numeric: tabular-nums;
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }
  .gm-token-line span:first-child {
    color: var(--color-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* Mobile sheet scale: 11px labels, 5px bar, 20px horizontal padding, ≥44px block. */
  .gm.mobile .gm-open {
    padding: 12px 20px;
    gap: 8px;
    min-height: 44px;
  }
  .gm.mobile .gm-label,
  .gm.mobile .gm-line,
  .gm.mobile .gm-all,
  .gm.mobile .gm-section,
  .gm.mobile .gm-note,
  .gm.mobile .gm-token-line {
    font-size: var(--fs-meta);
  }
  .gm.mobile .gm-bar {
    height: 5px;
  }
  .gm.mobile .gm-all {
    top: 8px;
    right: 12px;
    min-height: 44px;
    min-width: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .gm.mobile .gm-breakdown {
    padding: 2px 20px 12px;
  }
</style>
