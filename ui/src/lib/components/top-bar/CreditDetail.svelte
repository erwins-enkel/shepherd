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
  }: {
    credits: CreditWindow | null;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    nowMs: number;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
  } = $props();

  // relativeAge returns the "now" sentinel for <60s; branch it to a natural phrase
  // ("scraped just now") rather than feeding "now" into the "scraped {age} ago" template.
  const age = $derived(credits ? relativeAge(credits.scrapedAt, nowMs) : "");
</script>

{#if credits}
  <div class="credit-detail" class:stale={credits.stale}>
    <div class="gp-head">
      <span class="gp-period">{m.topbar_credits_period()}</span>
      <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
    </div>
    <span class="g-bar"
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
      {age === "now" ? m.topbar_credits_age_now() : m.topbar_credits_age({ age })}
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
    width: 100%;
    height: 6px;
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
    gap: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .gp-period {
    color: var(--color-text);
    font-size: var(--fs-meta);
    text-transform: capitalize;
    white-space: nowrap;
  }
  .gauge-pop-reset {
    margin: 0;
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-faint);
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
