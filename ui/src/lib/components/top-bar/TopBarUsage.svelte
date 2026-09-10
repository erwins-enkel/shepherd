<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import type {
    CreditWindow,
    ModelWeekWindow,
    ObservedLimitWindows,
    ProviderFailoverStatus,
  } from "$lib/types";
  import type { ProviderFailoverOffer } from "$lib/provider-capacity";
  import type { UsageProviderSnapshot } from "$lib/types";
  import { formatTokenLabel } from "$lib/format";
  import {
    gaugeColor,
    modelDisplayName,
    type GaugeKey,
    type HottestCapacityWindow,
  } from "../usage-gauges";
  import type { CompactUsageView } from "../usage-gauges";
  import type { Gauge } from "../usage-gauges";
  import CreditGauge from "./CreditGauge.svelte";
  import TopBarUsagePopover from "./TopBarUsagePopover.svelte";

  let {
    subscriptionOnly,
    touch,
    stale,
    gauges,
    perModel,
    credits,
    codexUsage,
    claudeAvailable,
    observed,
    hottest,
    activeCompactUsageView,
    compactUsageRotating,
    overspend,
    creditFill,
    creditColor,
    creditAmount,
    nowMs,
    refreshing,
    refreshError,
    onRefresh,
    onOpenPopover,
    periodLabel,
    failoverOffer,
    failover,
    failoverBusy,
    failoverFailed,
    onEngageFailover,
    onReleaseFailover,
    onusage,
    popoverOpen = $bindable(),
    gaugeWrap = $bindable(null),
  }: {
    subscriptionOnly: boolean;
    touch: boolean;
    stale: boolean;
    gauges: Gauge[];
    perModel: ModelWeekWindow[];
    credits: CreditWindow | null;
    codexUsage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null;
    claudeAvailable: boolean;
    hottest: HottestCapacityWindow | null;
    observed: ObservedLimitWindows | undefined;
    activeCompactUsageView: CompactUsageView | null;
    compactUsageRotating: boolean;
    overspend: boolean;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    nowMs: number;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    onOpenPopover: () => void;
    periodLabel: (k: GaugeKey) => string;
    /** Capacity failover: the switch worth offering right now, and the one already in effect. */
    failoverOffer: ProviderFailoverOffer | null;
    failover: ProviderFailoverStatus | null;
    failoverBusy: boolean;
    failoverFailed: boolean;
    onEngageFailover: () => void;
    onReleaseFailover: () => void;
    onusage?: () => void;
    popoverOpen: boolean;
    gaugeWrap: HTMLElement | null;
  } = $props();

  const activeHotGauge = $derived(
    activeCompactUsageView?.mode === "limits"
      ? activeCompactUsageView.gauges.reduce((hot, g) => (g.w.pct >= hot.w.pct ? g : hot))
      : null,
  );
  const activeStale = $derived(activeCompactUsageView?.stale ?? false);
  const activeProviderShort = $derived(
    activeCompactUsageView?.provider === "claude"
      ? m.topbar_usage_provider_short_claude()
      : activeCompactUsageView?.provider === "codex"
        ? m.topbar_usage_provider_short_codex()
        : "",
  );
  const activeProviderName = $derived(
    activeCompactUsageView?.provider === "claude"
      ? m.agent_provider_claude()
      : activeCompactUsageView?.provider === "codex"
        ? m.agent_provider_codex()
        : "",
  );
  const activeHotGaugeLabel = $derived(
    activeHotGauge
      ? m.topbar_gauge_toggle_aria({
          period: periodLabel(activeHotGauge.label),
          pct: activeHotGauge.w.pct,
        })
      : "",
  );
  const activeTouchLimitLabel = $derived(
    compactUsageRotating ? `${activeProviderName} · ${activeHotGaugeLabel}` : activeHotGaugeLabel,
  );
  function gaugeValue(gauge: Gauge): string {
    return "scrapedAt" in gauge.w && gauge.w.resetAt <= nowMs
      ? m.topbar_usage_before_reset({ pct: gauge.w.pct })
      : `${gauge.w.pct}%`;
  }
  function togglePopover() {
    const opening = !popoverOpen;
    popoverOpen = opening;
    if (opening) onOpenPopover();
  }
  function closePopover() {
    popoverOpen = false;
  }
  function openUsage() {
    popoverOpen = false;
    onusage?.();
  }
</script>

{#snippet usagePopover(desktop: boolean)}
  <TopBarUsagePopover
    {desktop}
    {stale}
    {gauges}
    {perModel}
    {credits}
    {codexUsage}
    {claudeAvailable}
    {observed}
    {hottest}
    {creditFill}
    {creditColor}
    {creditAmount}
    {nowMs}
    {refreshing}
    {refreshError}
    {onRefresh}
    {periodLabel}
    {failoverOffer}
    {failover}
    {failoverBusy}
    {failoverFailed}
    {onEngageFailover}
    {onReleaseFailover}
    onClose={closePopover}
    onOpenUsage={openUsage}
  />
{/snippet}

{#if subscriptionOnly && !codexUsage}
  <span class="usage-sub-only micro">{m.usage_subscription_only()}</span>
{:else if touch}
  {#if activeCompactUsageView}
    <!-- touch: collapse to the hotter window (or the CR gauge when credits are the
         only signal, or a per-model bar when Fable is the only signal); tap for the
         full breakdown. The collapsed button carries an alert state while extra
         credits are being spent. -->
    <div class="gauge-wrap" bind:this={gaugeWrap}>
      {#if activeCompactUsageView.mode === "limits" && activeHotGauge}
        <button
          class="gauge gauge-btn"
          class:stale={activeStale}
          class:alert={overspend}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-label={activeTouchLimitLabel}
          onclick={togglePopover}
        >
          {#if compactUsageRotating}<span class="g-provider micro">{activeProviderShort}</span>{/if}
          <span class="g-label micro">{activeHotGauge.label}</span>
          <span class="g-bar"
            ><span
              class="g-fill"
              style="transform:scaleX({Math.min(Math.max(activeHotGauge.w.pct, 0), 100) /
                100});background:{gaugeColor(activeHotGauge.w.pct)}"
            ></span></span
          >
          <span class="g-pct" style="color:{gaugeColor(activeHotGauge.w.pct)}"
            >{gaugeValue(activeHotGauge)}</span
          >
        </button>
      {:else if activeCompactUsageView.mode === "credit" || activeCompactUsageView.mode === "tokens"}
        <!-- credits-only or codex token-only: no normal compact limit window, but usage data exists -->
        <button
          class="gauge gauge-btn"
          class:stale={activeStale}
          class:alert={overspend}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-label={activeCompactUsageView.mode === "credit"
            ? overspend
              ? m.topbar_credits_alert_aria({ amount: creditAmount })
              : `${m.topbar_credits_period()} · ${creditAmount}`
            : `${activeProviderName} · ${formatTokenLabel(activeCompactUsageView.totalTokens)}`}
          onclick={togglePopover}
        >
          {#if compactUsageRotating}<span class="g-provider micro">{activeProviderShort}</span>{/if}
          {#if activeCompactUsageView.mode === "credit"}
            <span class="g-label micro">CR</span>
            <span class="g-bar"
              ><span class="g-fill" style="transform:scaleX({creditFill});background:{creditColor}"
              ></span></span
            >
            <span class="g-pct credit-amount" style="color:{creditColor}">{creditAmount}</span>
          {:else}
            <span class="g-pct credit-amount"
              >{formatTokenLabel(activeCompactUsageView.totalTokens)}</span
            >
          {/if}
        </button>
      {:else if activeCompactUsageView.mode === "model"}
        <!-- per-model-only (e.g. Fable): the sole usage signal — collapse to its bar so the
             popover (with the full per-model breakdown) can be opened. -->
        <button
          class="gauge gauge-btn"
          class:stale={activeCompactUsageView.stale}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-label={`${m.usage_limits_window_week_model({
            model: modelDisplayName(activeCompactUsageView.model.model),
          })} · ${activeCompactUsageView.model.pct}%`}
          onclick={togglePopover}
        >
          {#if compactUsageRotating}<span class="g-provider micro">{activeProviderShort}</span>{/if}
          <span class="g-label micro">{modelDisplayName(activeCompactUsageView.model.model)}</span>
          <span class="g-bar"
            ><span
              class="g-fill"
              style="transform:scaleX({Math.min(
                Math.max(activeCompactUsageView.model.pct, 0),
                100,
              ) / 100});background:{gaugeColor(activeCompactUsageView.model.pct)}"
            ></span></span
          >
          <span class="g-pct" style="color:{gaugeColor(activeCompactUsageView.model.pct)}"
            >{activeCompactUsageView.model.pct}%</span
          >
        </button>
      {:else if activeCompactUsageView.mode === "empty"}
        <button
          class="gauge gauge-btn empty"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
          aria-label={m.topbar_usage_provider_title({ provider: m.agent_provider_claude() })}
          onclick={togglePopover}
        >
          <span class="g-provider micro">{m.topbar_usage_provider_short_claude()}</span>
          <span class="g-pct empty-value">—</span>
        </button>
      {/if}
      {#if popoverOpen}
        {@render usagePopover(false)}
      {/if}
    </div>
  {/if}
{:else if activeCompactUsageView}
  <!-- Desktop: the inline cluster is a click toggle (not hover) so the popover stays open while
       you move into it to reach REFRESH. Dismiss on Esc / outside-click is shared with the touch
       path (popoverOpen + gaugeWrap, handled in TopBar.svelte). -->
  <div class="gauges-wrap" bind:this={gaugeWrap}>
    <button
      type="button"
      class="gauges-link gauges-toggle"
      aria-haspopup="dialog"
      aria-expanded={popoverOpen}
      onclick={togglePopover}
    >
      <!-- Phrasing-only content: a <button> may not contain block elements, so the
           gauge cluster + each gauge are <span>s (display:flex via class, blockified
           as flex items). Compact rule: percentages inline, swapped to the CR amount
           when capped or credits-only (see showCreditsInline). -->
      <span class="gauges" class:stale={activeStale}>
        {#if compactUsageRotating}<span class="g-provider micro">{activeProviderShort}</span>{/if}
        {#if activeCompactUsageView.mode === "credit"}
          <CreditGauge {credits} {overspend} {creditFill} {creditColor} {creditAmount} />
        {:else if activeCompactUsageView.mode === "tokens"}
          <span class="gauge">
            <span class="g-pct credit-amount"
              >{formatTokenLabel(activeCompactUsageView.totalTokens)}</span
            >
          </span>
        {:else if activeCompactUsageView.mode === "limits"}
          {#each activeCompactUsageView.gauges as g (g.label)}
            <span class="gauge">
              <span class="g-label micro">{g.label}</span>
              <span class="g-bar"
                ><span
                  class="g-fill"
                  style="transform:scaleX({Math.min(Math.max(g.w.pct, 0), 100) /
                    100});background:{gaugeColor(g.w.pct)}"
                ></span></span
              >
              <span class="g-pct" style="color:{gaugeColor(g.w.pct)}">{gaugeValue(g)}</span>
            </span>
          {/each}
        {:else if activeCompactUsageView.mode === "model"}
          <!-- per-model-only (e.g. Fable): the sole usage signal — inline its bar so the toggle
               isn't blank and its popover breakdown can be opened. -->
          <span class="gauge">
            <span class="g-label micro">{modelDisplayName(activeCompactUsageView.model.model)}</span
            >
            <span class="g-bar"
              ><span
                class="g-fill"
                style="transform:scaleX({Math.min(
                  Math.max(activeCompactUsageView.model.pct, 0),
                  100,
                ) / 100});background:{gaugeColor(activeCompactUsageView.model.pct)}"
              ></span></span
            >
            <span class="g-pct" style="color:{gaugeColor(activeCompactUsageView.model.pct)}"
              >{activeCompactUsageView.model.pct}%</span
            >
          </span>
        {:else if activeCompactUsageView.mode === "empty"}
          <span class="gauge empty">
            <span class="g-provider micro">{m.topbar_usage_provider_short_claude()}</span>
            <span class="g-pct empty-value">—</span>
          </span>
        {/if}
      </span>
    </button>
    {#if popoverOpen}
      {@render usagePopover(true)}
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
  .g-provider {
    color: var(--color-faint);
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
  .empty-value {
    color: var(--color-faint);
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
