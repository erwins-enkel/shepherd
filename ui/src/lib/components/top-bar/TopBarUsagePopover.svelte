<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type { CreditWindow, ModelWeekWindow, UsageProviderSnapshot } from "$lib/types";
  import { type GaugeKey } from "../usage-gauges";
  import type { Gauge } from "../usage-gauges";
  import CodexTokenDetail from "./CodexTokenDetail.svelte";
  import CreditDetail from "./CreditDetail.svelte";
  import LimitGaugeRow from "./LimitGaugeRow.svelte";
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
        <LimitGaugeRow label={periodLabel(g.label)} limit={g.w} {nowMs} />
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
      <LimitGaugeRow label={g.label} limit={g.w} {nowMs} inline />
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
      <CodexTokenDetail usage={codexUsage} {nowMs} {periodLabel} />
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
  .token-window.stale {
    opacity: 0.5;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
