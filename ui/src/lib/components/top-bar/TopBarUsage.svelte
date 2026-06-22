<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { CreditWindow } from "$lib/types";
  import { gaugeColor, type GaugeKey } from "../usage-gauges";
  import type { Gauge } from "../usage-gauges";
  import { formatResetIn, formatReset } from "$lib/format";
  import { dialog } from "$lib/a11yDialog";
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
    onusage,
    popoverOpen = $bindable(),
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
    onusage?: () => void;
    popoverOpen: boolean;
    gaugeWrap: HTMLElement | null;
  } = $props();

  // Desktop compact rule: show 5H+WK percentages inline, but swap to the CR amount when a window
  // is pinned at its cap (% is uninformative there and the live credit € is the actionable number)
  // OR when there are no usage windows at all (credits-only state — otherwise the toggle is blank).
  const capped = $derived(gauges.some((g) => g.w.pct >= 100));
  const showCreditsInline = $derived((capped || gauges.length === 0) && !!credits);
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
  <!-- Desktop: the inline cluster is a click toggle (not hover) so the popover stays open while
       you move into it to reach REFRESH. Dismiss on Esc / outside-click is shared with the touch
       path (popoverOpen + gaugeWrap, handled in TopBar.svelte). -->
  <div class="gauges-wrap" bind:this={gaugeWrap}>
    <button
      type="button"
      class="gauges-link gauges-toggle"
      aria-haspopup="dialog"
      aria-expanded={popoverOpen}
      onclick={() => (popoverOpen = !popoverOpen)}
    >
      <!-- Phrasing-only content: a <button> may not contain block elements, so the
           gauge cluster + each gauge are <span>s (display:flex via class, blockified
           as flex items). Compact rule: percentages inline, swapped to the CR amount
           when capped or credits-only (see showCreditsInline). -->
      <span class="gauges" class:stale>
        {#if showCreditsInline}
          <CreditGauge {credits} {overspend} {creditFill} {creditColor} {creditAmount} />
        {:else}
          {#each gauges as g (g.label)}
            <span class="gauge">
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
        {/if}
      </span>
    </button>
    {#if popoverOpen}
      <div
        class="gauge-pop gauge-pop-desk"
        role="dialog"
        aria-label={m.topbar_gauge_popover_title()}
        class:stale
        use:dialog={{ onclose: () => (popoverOpen = false) }}
      >
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

<style>
  /* api-key mode: explicit fail-closed note in place of the usage meters. */
  .usage-sub-only {
    color: var(--color-muted);
    max-width: 22rem;
  }
  /* Desktop: clicking the gauges cluster toggles the breakdown popover. Full button-chrome
     reset so the <button> renders byte-identically to the former inline cluster (no native
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
  /* Subtle focus-visible ring so keyboard users see the toggle target; hover/expanded dim the
     cluster slightly to read as an actionable control without adding chrome that shifts layout. */
  .gauges-toggle:hover .gauges,
  .gauges-toggle[aria-expanded="true"] .gauges {
    opacity: 0.85;
  }
  .gauges-toggle:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: 3px;
    border-radius: 2px;
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
