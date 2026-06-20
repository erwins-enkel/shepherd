<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { CreditWindow } from "$lib/types";

  let {
    credits,
    overspend,
    creditFill,
    creditColor,
    creditAmount,
  }: {
    credits: CreditWindow | null;
    overspend: boolean;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
  } = $props();
</script>

{#if credits}
  <div
    class="gauge credit-gauge"
    class:stale={credits.stale}
    class:alert={overspend}
    aria-label={overspend
      ? m.topbar_credits_alert_aria({ amount: creditAmount })
      : `${m.topbar_credits_period()} · ${creditAmount}`}
  >
    <span class="g-label micro">CR</span>
    <span class="g-bar"
      ><span class="g-fill" style="transform:scaleX({creditFill});background:{creditColor}"
      ></span></span
    >
    <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
  </div>
{/if}

<style>
  .gauge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
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
  /* CR credit gauge: reuses the .gauge recipe. The amount text is wider than a
     percentage, so it gets a larger min-width and rides on the same tabular nums. */
  .credit-gauge.alert .g-label {
    color: var(--color-amber);
  }
  .credit-gauge.stale {
    opacity: 0.5;
  }
  .credit-amount {
    min-width: max-content;
    white-space: nowrap;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
