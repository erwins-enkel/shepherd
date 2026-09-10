<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import type {
    CreditWindow,
    ModelWeekWindow,
    ObservedLimitWindow,
    ObservedLimitWindows,
    UsageProviderSnapshot,
  } from "$lib/types";
  import { type GaugeKey } from "../usage-gauges";
  import type { Gauge } from "../usage-gauges";
  import CodexTokenDetail from "./CodexTokenDetail.svelte";
  import CreditDetail from "./CreditDetail.svelte";
  import LimitGaugeRow from "./LimitGaugeRow.svelte";
  import ModelWeekGauge from "../usage/ModelWeekGauge.svelte";
  import UsageRefreshButton from "./UsageRefreshButton.svelte";

  let {
    desktop,
    stale,
    gauges,
    perModel,
    credits,
    codexUsage,
    claudeAvailable,
    observed,
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
    claudeAvailable: boolean;
    observed: ObservedLimitWindows | undefined;
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

  // Claude vs Codex are distinct providers with their own labelled sections. The Claude heading
  // shows only when Claude has data (else a codex-only popover would show an empty section).
  const hasClaude = $derived(claudeAvailable);
  const observedEmpty = $derived(hasClaude && observed !== undefined && gauges.length === 0);
</script>

{#snippet observedWindow(label: GaugeKey, limit: ObservedLimitWindow | null, inline: boolean)}
  <div class="gp-window">
    {#if limit}
      <LimitGaugeRow label={periodLabel(label)} {limit} {nowMs} {inline} />
    {:else}
      <div class="missing-window-label">{periodLabel(label)}</div>
      <div class="missing-window-value">{m.topbar_usage_no_observation()}</div>
    {/if}
  </div>
{/snippet}

{#snippet mainWindows(inline: boolean)}
  {#if observedEmpty}
    <div class="usage-empty">{m.topbar_usage_no_observation()}</div>
  {:else if observed !== undefined}
    {@render observedWindow("5H", observed.session5h, inline)}
    {@render observedWindow("WK", observed.week, inline)}
  {:else}
    {#each gauges as g (g.label)}
      {#if inline}
        <LimitGaugeRow label={g.label} limit={g.w} {nowMs} inline />
      {:else}
        <div class="gp-window">
          <LimitGaugeRow label={periodLabel(g.label)} limit={g.w} {nowMs} />
        </div>
      {/if}
    {/each}
  {/if}
{/snippet}

<div
  class="gauge-pop"
  class:gauge-pop-desk={desktop}
  role="dialog"
  aria-label={m.topbar_gauge_popover_title()}
  use:optionalDialog
>
  <div class="popover-heading">{m.topbar_gauge_popover_title()}</div>
  <!-- Claude section. `stale` (Claude limits staleness) dims ONLY this block — the Codex section
       below carries its own `codexUsage.stale`, so a stale Claude snapshot must not dim fresh Codex. -->
  {#if hasClaude}
    <div class="gauge-pop-claude" class:stale>
      <div class="gauge-pop-title micro">
        {m.agent_provider_claude()}{stale ? m.topbar_gauge_stale_suffix() : ""}
      </div>
      {#if desktop}
        {@render mainWindows(false)}
        {#each perModel as entry (entry.model)}
          <div class="gp-window">
            <ModelWeekGauge {entry} {nowMs} />
          </div>
        {/each}
        {#if credits}
          <div class="gp-window">
            <CreditDetail {credits} {creditFill} {creditColor} {creditAmount} {nowMs} />
          </div>
        {/if}
      {:else}
        {@render mainWindows(true)}
        {#each perModel as entry (entry.model)}
          <div class="gauge-pop-row-model">
            <ModelWeekGauge {entry} {nowMs} />
          </div>
        {/each}
        <CreditDetail {credits} {creditFill} {creditColor} {creditAmount} {nowMs} />
      {/if}
    </div>
  {/if}
  {#if codexUsage}
    <div class="gauge-pop-title micro codex-heading">
      {m.agent_provider_codex()}
    </div>
    <div class="gp-window token-window" class:stale={codexUsage.stale}>
      <CodexTokenDetail usage={codexUsage} {nowMs} {periodLabel} />
    </div>
  {/if}
  <footer class="usage-footer">
    {#if hasClaude}
      <div class="usage-refresh-scope">{m.topbar_usage_refresh_scope()}</div>
    {/if}
    <div class="usage-footer-actions">
      <button type="button" class="gauge-pop-link" aria-haspopup="dialog" onclick={onOpenUsage}>
        {m.topbar_usage_link()}
      </button>
      {#if hasClaude}
        <div class="gp-refresh">
          <UsageRefreshButton {refreshing} {refreshError} {onRefresh} />
        </div>
      {/if}
    </div>
  </footer>
</div>

<style>
  .gauge-pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 50;
    width: 320px;
    max-width: calc(100vw - 24px);
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    padding: 14px 15px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* Claude section wrapper: column layout inheriting the pop's row gap so wrapping the Claude
     blocks doesn't change their spacing. `.stale` dims ONLY this section. */
  .gauge-pop-claude {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .gauge-pop-desk .gauge-pop-claude {
    gap: 0;
  }
  .gauge-pop-claude.stale {
    opacity: 0.5;
  }
  .popover-heading {
    color: var(--color-ink-bright);
    font-size: var(--fs-lg);
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 16px;
  }
  .gauge-pop-title {
    margin-bottom: 6px;
  }
  .usage-empty {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    line-height: 1.45;
    padding: 8px 0 4px;
  }
  .missing-window-label {
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .missing-window-value {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    line-height: 1.4;
    margin-top: 4px;
  }
  /* Codex is a separate provider section — set it off from the Claude block above. */
  .codex-heading {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
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
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    text-align: left;
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
    margin-top: 13px;
  }
  .token-window.stale {
    opacity: 0.5;
  }
  .usage-footer {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .usage-refresh-scope {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    margin-bottom: 8px;
  }
  .usage-footer-actions {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
  }
  .gp-refresh {
    margin-left: auto;
    min-width: 0;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
