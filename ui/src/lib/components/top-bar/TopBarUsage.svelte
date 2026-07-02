<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type { CreditWindow, ModelWeekWindow } from "$lib/types";
  import type { UsageProviderSnapshot } from "$lib/types";
  import { formatTokenLabel } from "$lib/format";
  import { gaugeColor, type GaugeKey } from "../usage-gauges";
  import type { Gauge } from "../usage-gauges";
  import CreditGauge from "./CreditGauge.svelte";
  import TopBarUsagePopover from "./TopBarUsagePopover.svelte";

  let {
    subscriptionOnly,
    touch,
    stale,
    hotter,
    gauges,
    perModel,
    credits,
    codexUsage,
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
    perModel: ModelWeekWindow[];
    credits: CreditWindow | null;
    codexUsage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null;
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

{#if subscriptionOnly && !codexUsage}
  <span class="usage-sub-only micro">{m.usage_subscription_only()}</span>
{:else if touch}
  {#if hotter || credits || codexUsage}
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
        <!-- credits-only or codex-only: no usage windows scraped, but another provider has data -->
        <button
          class="gauge gauge-btn"
          class:stale={credits ? credits.stale : codexUsage?.stale}
          class:alert={overspend}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-label={credits
            ? overspend
              ? m.topbar_credits_alert_aria({ amount: creditAmount })
              : `${m.topbar_credits_period()} · ${creditAmount}`
            : `${m.agent_provider_codex()} · ${formatTokenLabel(codexUsage?.totalTokens ?? 0)}`}
          onclick={() => (popoverOpen = !popoverOpen)}
        >
          {#if credits}
            <span class="g-label micro">CR</span>
            <span class="g-bar"
              ><span class="g-fill" style="transform:scaleX({creditFill});background:{creditColor}"
              ></span></span
            >
            <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
          {:else}
            <span class="g-label micro">{m.agent_provider_codex()}</span>
            <span class="g-pct credit-amount">{formatTokenLabel(codexUsage?.totalTokens ?? 0)}</span
            >
          {/if}
        </button>
      {/if}
      {#if popoverOpen}
        <TopBarUsagePopover
          desktop={false}
          {stale}
          {gauges}
          {perModel}
          {credits}
          {codexUsage}
          {creditFill}
          {creditColor}
          {creditAmount}
          {nowMs}
          {refreshing}
          {refreshError}
          {onRefresh}
          {periodLabel}
          onClose={() => (popoverOpen = false)}
          onOpenUsage={() => {
            popoverOpen = false;
            onusage?.();
          }}
        />
      {/if}
    </div>
  {/if}
{:else if gauges.length || credits || codexUsage}
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
        {:else if codexUsage && gauges.length === 0}
          <span class="gauge">
            <span class="g-label micro">{m.agent_provider_codex()}</span>
            <span class="g-pct credit-amount">{formatTokenLabel(codexUsage.totalTokens)}</span>
          </span>
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
      <TopBarUsagePopover
        desktop={true}
        {stale}
        {gauges}
        {perModel}
        {credits}
        {codexUsage}
        {creditFill}
        {creditColor}
        {creditAmount}
        {nowMs}
        {refreshing}
        {refreshError}
        {onRefresh}
        {periodLabel}
        onClose={() => (popoverOpen = false)}
        onOpenUsage={() => {
          popoverOpen = false;
          onusage?.();
        }}
      />
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
  @media (pointer: coarse) {
    .gauge-btn {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
