<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { CreditWindow } from "$lib/types";
  import { gaugeColor, type GaugeKey } from "../usage-gauges";
  import type { Gauge } from "../usage-gauges";
  import { formatResetIn, formatReset } from "$lib/format";
  import CreditGauge from "./CreditGauge.svelte";
  import CreditDetail from "./CreditDetail.svelte";

  let {
    subscriptionOnly,
    touch,
    stale,
    hotter,
    gauges,
    credits,
    overspend,
    creditFill,
    creditColor,
    creditAmount,
    nowMs,
    refreshing,
    refreshError,
    onRefresh,
    periodLabel,
    gaugeTip,
    onusage,
    popoverOpen = $bindable(),
    detailOpen = $bindable(),
    gaugeWrap = $bindable(null),
  }: {
    subscriptionOnly: boolean;
    touch: boolean;
    stale: boolean;
    hotter: Gauge | null;
    gauges: Gauge[];
    credits: CreditWindow | null;
    overspend: boolean;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    nowMs: number;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    periodLabel: (k: GaugeKey) => string;
    gaugeTip: (k: GaugeKey, pct: number, resetAt: number) => string;
    onusage?: () => void;
    popoverOpen: boolean;
    detailOpen: boolean;
    gaugeWrap: HTMLElement | null;
  } = $props();
</script>

{#if subscriptionOnly}
  <span class="usage-sub-only micro">{m.usage_subscription_only()}</span>
{:else if touch}
  {#if hotter || credits}
    <!-- touch: collapse to the hotter window (or the CR gauge when credits are the
         only signal); tap for the full breakdown. The collapsed button carries an
         alert state while extra credits are being spent. -->
    <div class="gauge-wrap" bind:this={gaugeWrap}>
      {#if hotter}
        <button
          class="gauge gauge-btn"
          class:stale
          class:alert={overspend}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-label={m.topbar_gauge_toggle_aria({
            period: periodLabel(hotter.label),
            pct: hotter.w.pct,
          })}
          onclick={() => (popoverOpen = !popoverOpen)}
        >
          <span class="g-label micro">{hotter.label}</span>
          <span class="g-bar"
            ><span
              class="g-fill"
              style="transform:scaleX({Math.min(Math.max(hotter.w.pct, 0), 100) /
                100});background:{gaugeColor(hotter.w.pct)}"
            ></span></span
          >
          <span class="g-pct" style="color:{gaugeColor(hotter.w.pct)}">{hotter.w.pct}%</span>
        </button>
      {:else}
        <!-- credits-only: no usage windows scraped, but extra spend exists -->
        <button
          class="gauge gauge-btn"
          class:stale={credits?.stale}
          class:alert={overspend}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-label={overspend
            ? m.topbar_credits_alert_aria({ amount: creditAmount })
            : `${m.topbar_credits_period()} · ${creditAmount}`}
          onclick={() => (popoverOpen = !popoverOpen)}
        >
          <span class="g-label micro">CR</span>
          <span class="g-bar"
            ><span class="g-fill" style="transform:scaleX({creditFill});background:{creditColor}"
            ></span></span
          >
          <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
        </button>
      {/if}
      {#if popoverOpen}
        <div
          class="gauge-pop"
          role="dialog"
          aria-label={m.topbar_gauge_popover_title()}
          class:stale
        >
          <div class="gauge-pop-title micro">
            {m.topbar_gauge_popover_title()}{stale ? m.topbar_gauge_stale_suffix() : ""}
          </div>
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
          <button
            type="button"
            class="gauge-pop-link"
            aria-haspopup="dialog"
            onclick={() => {
              popoverOpen = false;
              onusage?.();
            }}
          >
            {m.topbar_usage_link()}
          </button>
        </div>
      {/if}
    </div>
  {/if}
{:else if gauges.length || credits}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="gauges-wrap"
    onmouseenter={() => (detailOpen = true)}
    onmouseleave={() => (detailOpen = false)}
  >
    <button
      type="button"
      class="gauges-link"
      aria-haspopup="dialog"
      aria-label={m.topbar_usage_link_aria()}
      onclick={() => onusage?.()}
    >
      <!-- Phrasing-only content: a <button> may not contain block elements, so the
           gauge cluster + each gauge are <span>s (display:flex via class, blockified
           as flex items — layout is identical to the former <a>-wrapped <div>s). -->
      <span class="gauges" class:stale>
        {#each gauges as g (g.label)}
          <span class="gauge" aria-label={gaugeTip(g.label, g.w.pct, g.w.resetAt)}>
            <span class="g-label micro">{g.label}</span>
            <span class="g-bar"
              ><span
                class="g-fill"
                style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) /
                  100});background:{gaugeColor(g.w.pct)}"
              ></span></span
            >
            <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{g.w.pct}%</span>
          </span>
        {/each}
        <CreditGauge {credits} {overspend} {creditFill} {creditColor} {creditAmount} />
      </span>
    </button>
    {#if detailOpen}
      <div class="gauge-pop gauge-pop-desk" role="tooltip" class:stale>
        <div class="gauge-pop-title micro">
          {m.topbar_gauge_popover_title()}{stale ? m.topbar_gauge_stale_suffix() : ""}
        </div>
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
              wide
            />
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* api-key mode: explicit fail-closed note in place of the usage meters. */
  .usage-sub-only {
    color: var(--color-muted);
    max-width: 22rem;
  }
  /* Desktop: clicking the gauges cluster opens the Usage modal. Full button-chrome
     reset so the <button> renders byte-identically to the former <a> (no native
     padding/border/background/font shift the gauges layout). */
  .gauges-link {
    appearance: none;
    -webkit-appearance: none;
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: inherit;
    display: block;
  }
  /* Touch popover: quiet Usage-modal trigger at the bottom of the breakdown popover.
     Button-chrome reset so it reads as the former quiet link, not a native button. */
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
  .gauges-wrap {
    position: relative;
  }
  .gauges {
    display: flex;
    gap: 14px;
    align-items: center;
  }
  .gauges.stale {
    opacity: 0.5;
  }
  .gauge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  /* Shared base-class rules (also in parent for sibling regions) */
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
  /* CR collapsed touch button + popover detail when extra credits are being spent. */
  .gauge-btn.alert {
    border-color: var(--color-amber);
  }
  /* Touch: a single collapsed gauge rendered as a tappable button. */
  .gauge-wrap {
    position: relative;
  }
  .gauge-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    font: inherit;
    /* finger-sized tap target, matching the gear on touch HUDs */
    min-height: 40px;
    padding: 0 8px;
  }
  .gauge-btn:hover,
  .gauge-btn[aria-expanded="true"] {
    border-color: var(--color-line-bright);
  }
  .gauge-btn.stale {
    opacity: 0.5;
  }
  /* Popover: full breakdown of every window, anchored under the gauge. */
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
  /* Desktop hover detail card: one block per window — period name + percentage
     on a header row, a full-width bar below, reset time as a faint subline. */
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
  .gauge-pop-desk .g-bar-wide {
    width: 100%;
    height: 6px;
  }
  .gauge-pop-desk .gauge-pop-reset {
    margin: 0;
  }
  @media (pointer: coarse) {
    .gauge-btn {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
