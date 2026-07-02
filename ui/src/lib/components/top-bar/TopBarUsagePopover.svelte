<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { formatResetIn, formatReset } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  import type { CreditWindow, ModelWeekWindow, UsageProviderSnapshot } from "$lib/types";
  import { gaugeColor, type GaugeKey } from "../usage-gauges";
  import type { Gauge } from "../usage-gauges";
  import CodexTokenDetail from "./CodexTokenDetail.svelte";
  import CreditDetail from "./CreditDetail.svelte";
  import ModelWeekGauge from "../usage/ModelWeekGauge.svelte";

  let {
    desktop,
    stale,
    gauges,
    perModel,
    credits,
    codexUsage,
    creditFill,
    creditColor,
    creditAmount,
    nowMs,
    refreshing,
    refreshError,
    onRefresh,
    periodLabel,
    onClose,
    onOpenUsage,
  }: {
    desktop: boolean;
    stale: boolean;
    gauges: Gauge[];
    perModel: ModelWeekWindow[];
    credits: CreditWindow | null;
    codexUsage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    nowMs: number;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    periodLabel: (k: GaugeKey) => string;
    onClose: () => void;
    onOpenUsage: () => void;
  } = $props();

  function optionalDialog(node: HTMLElement) {
    return desktop ? dialog(node, { onclose: onClose }) : {};
  }
</script>

<div
  class="gauge-pop"
  class:gauge-pop-desk={desktop}
  role="dialog"
  aria-label={m.topbar_gauge_popover_title()}
  class:stale
  use:optionalDialog
>
  <div class="gauge-pop-title micro">
    {m.topbar_gauge_popover_title()}{stale ? m.topbar_gauge_stale_suffix() : ""}
  </div>
  {#if desktop}
    {#each gauges as g (g.label)}
      <div class="gp-window">
        <div class="gp-head">
          <span class="gp-period">{periodLabel(g.label)}</span>
          <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
        </div>
        <span class="g-bar g-bar-wide"
          ><span
            class="g-fill"
            style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) /
              100});background:{gaugeColor(g.w.pct)}"
          ></span></span
        >
        <div class="gauge-pop-reset micro">
          {m.topbar_gauge_reset_rel({
            rel: formatResetIn(g.w.resetAt, nowMs),
            abs: formatReset(g.w.resetAt, nowMs),
          })}
        </div>
      </div>
    {/each}
    {#each perModel as entry (entry.model)}
      <div class="gp-window">
        <ModelWeekGauge {entry} {nowMs} />
      </div>
    {/each}
    {#if credits}
      <div class="gp-window">
        <CreditDetail
          {credits}
          {creditFill}
          {creditColor}
          {creditAmount}
          {nowMs}
          {refreshing}
          {refreshError}
          {onRefresh}
        />
      </div>
    {/if}
  {:else}
    {#each gauges as g (g.label)}
      <div class="gauge-pop-row">
        <span class="g-label micro">{g.label}</span>
        <span class="g-bar g-bar-wide"
          ><span
            class="g-fill"
            style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) /
              100});background:{gaugeColor(g.w.pct)}"
          ></span></span
        >
        <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
      </div>
      <div class="gauge-pop-reset micro">
        {m.topbar_gauge_reset_rel({
          rel: formatResetIn(g.w.resetAt, nowMs),
          abs: formatReset(g.w.resetAt, nowMs),
        })}
      </div>
    {/each}
    {#each perModel as entry (entry.model)}
      <div class="gauge-pop-row-model">
        <ModelWeekGauge {entry} {nowMs} />
      </div>
    {/each}
    <CreditDetail
      {credits}
      {creditFill}
      {creditColor}
      {creditAmount}
      {nowMs}
      {refreshing}
      {refreshError}
      {onRefresh}
    />
  {/if}
  {#if codexUsage}
    <div class="gp-window token-window" class:stale={codexUsage.stale}>
      <CodexTokenDetail usage={codexUsage} />
    </div>
  {/if}
  <button type="button" class="gauge-pop-link" aria-haspopup="dialog" onclick={onOpenUsage}>
    {m.topbar_usage_link()}
  </button>
</div>

<style>
  .gauge-pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 50;
    min-width: 200px;
    max-width: min(280px, 85vw);
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
    padding: 10px 11px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .gauge-pop.stale {
    opacity: 0.5;
  }
  .gauge-pop-title {
    margin-bottom: 6px;
  }
  .gauge-pop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .gauge-pop-row .g-bar-wide {
    flex: 1;
    width: auto;
    height: 6px;
  }
  .gauge-pop-row .g-pct {
    min-width: 34px;
  }
  .gauge-pop-reset {
    margin: 0 0 6px 30px;
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-faint);
  }
  .gauge-pop-reset:last-child {
    margin-bottom: 0;
  }
  .gauge-pop-row-model {
    margin-bottom: 6px;
  }
  .gauge-pop-link {
    appearance: none;
    -webkit-appearance: none;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    display: block;
    width: 100%;
    margin-top: 8px;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    text-align: right;
  }
  .gauge-pop-link:hover,
  .gauge-pop-link:focus-visible {
    color: var(--color-ink);
  }
  .gauge-pop-desk {
    gap: 0;
  }
  .gp-window {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .gp-window + .gp-window {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .gp-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .gp-period {
    color: var(--color-text);
    font-size: var(--fs-meta);
    text-transform: capitalize;
  }
  .token-window.stale {
    opacity: 0.5;
  }
  .gauge-pop-desk .g-bar-wide {
    width: 100%;
    height: 6px;
  }
  .gauge-pop-desk .gauge-pop-reset {
    margin: 0;
  }
  .g-label {
    color: var(--color-muted);
  }
  .g-bar {
    width: 46px;
    height: 5px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .g-fill {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left;
    transition: transform 0.6s ease;
  }
  .g-pct {
    font-size: var(--fs-meta);
    min-width: 30px;
    text-align: right;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
