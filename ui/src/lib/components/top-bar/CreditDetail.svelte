<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatReset, relativeAge } from "$lib/format";
  import type { CreditWindow } from "$lib/types";

  let {
    credits,
    creditFill,
    creditColor,
    creditAmount,
    nowMs,
    refreshing,
    refreshError,
    onRefresh,
    wide = false,
  }: {
    credits: CreditWindow | null;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    nowMs: number;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    wide?: boolean;
  } = $props();
</script>

{#if credits}
  <div class="credit-detail" class:stale={credits.stale}>
    <div class="gp-head">
      <span class="gp-period">{m.topbar_credits_period()}</span>
      <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
    </div>
    <span class="g-bar g-bar-wide {wide ? 'wide' : ''}"
      ><span class="g-fill" style="transform:scaleX({creditFill});background:{creditColor}"
      ></span></span
    >
    <div class="credit-sub micro">
      {m.topbar_credits_amount({
        spent: `${credits.currency}${credits.spent.toFixed(2)}`,
        cap: `${credits.currency}${credits.cap.toFixed(2)}`,
      })}
    </div>
    {#if credits.resetAt !== null}
      <div class="gauge-pop-reset micro">
        {m.topbar_gauge_reset({ reset: formatReset(credits.resetAt, nowMs) })}
      </div>
    {/if}
    <div class="gauge-pop-reset micro">
      {m.topbar_credits_age({ age: relativeAge(credits.scrapedAt, nowMs) })}
    </div>
    {#if credits.stale}
      <div class="credit-stale micro">{m.topbar_credits_stale()}</div>
    {/if}
    <button
      type="button"
      class="credit-refresh micro"
      disabled={refreshing}
      aria-busy={refreshing}
      onclick={onRefresh}
    >
      {refreshing ? m.common_loading() : m.topbar_credits_refresh()}
    </button>
    {#if refreshError}
      <div class="credit-error micro" role="alert">{m.common_retry()}</div>
    {/if}
  </div>
{/if}

<style>
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
  .g-bar.wide {
    width: 100%;
    height: 6px;
  }
  .credit-amount {
    min-width: max-content;
    white-space: nowrap;
  }
  .credit-detail {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .credit-detail.stale {
    opacity: 0.5;
  }
  .credit-sub {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-ink);
  }
  .credit-stale {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-amber);
  }
  .credit-error {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-red);
  }
  .credit-refresh {
    align-self: flex-start;
    margin-top: 2px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    text-transform: none;
    letter-spacing: 0.04em;
    padding: 4px 9px;
    cursor: pointer;
  }
  .credit-refresh:hover:not(:disabled) {
    background: var(--color-inset);
  }
  .credit-refresh:disabled {
    cursor: default;
    opacity: 0.5;
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
  .gauge-pop-reset {
    margin: 0 0 6px 30px;
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-faint);
  }
  .gauge-pop-reset:last-child {
    margin-bottom: 0;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
