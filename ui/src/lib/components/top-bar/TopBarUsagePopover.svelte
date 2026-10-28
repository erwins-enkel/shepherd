<script lang="ts">
  import type { Snippet } from "svelte";
  import { dialog } from "#lib/a11yDialog.js";
  import { portal } from "#lib/portal.js";
  import { relativeAge } from "#lib/format.js";
  import { m } from "#lib/paraglide/messages.js";
  import type {
    CreditWindow,
    ModelWeekWindow,
    ObservedLimitWindows,
    UsageProviderSnapshot,
  } from "#lib/types.js";
  import { type GaugeKey, type Gauge, type HottestCapacityWindow } from "../usage-gauges";
  import type { ProviderFailoverOffer } from "#lib/provider-capacity.js";
  import type { ProviderFailoverStatus } from "#lib/types.js";
  import UsageFailoverAction from "./UsageFailoverAction.svelte";
  import UsageHero from "./UsageHero.svelte";
  import UsageCapacity from "./UsageCapacity.svelte";
  import UsageRefreshButton from "./UsageRefreshButton.svelte";

  // The usage panel: the numbers on one side and, through `wait`, everything they currently hold
  // back on the other. "desktop" is an anchored modal over a dimmed bar, "touch" the same panel
  // without the focus trap (as before), "sheet" the phone's full-screen dialog.
  type Variant = "desktop" | "touch" | "sheet";

  let {
    variant,
    stale,
    gauges,
    perModel,
    credits,
    codexUsage,
    claudeAvailable,
    observed,
    hottest,
    creditFill,
    creditColor,
    creditAmount,
    nowMs,
    refreshing,
    refreshError,
    onRefresh,
    periodLabel,
    failoverOffer,
    failover,
    failoverBusy,
    failoverFailed,
    onEngageFailover,
    onReleaseFailover,
    holdPct,
    heldCount,
    pausedCount,
    wait,
    onClose,
    onOpenUsage,
    el = $bindable(null),
  }: {
    variant: Variant;
    stale: boolean;
    gauges: Gauge[];
    perModel: ModelWeekWindow[];
    credits: CreditWindow | null;
    codexUsage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null;
    claudeAvailable: boolean;
    observed: ObservedLimitWindows | undefined;
    /** Nearest-its-cap window across both CLIs, selected by `hottestCapacityWindow`. */
    hottest: HottestCapacityWindow | null;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    nowMs: number;
    refreshing: boolean;
    refreshError: boolean;
    onRefresh: () => void;
    periodLabel: (k: GaugeKey) => string;
    /** Capacity failover: the switch worth offering right now, and the one already in effect. */
    failoverOffer: ProviderFailoverOffer | null;
    failover: ProviderFailoverStatus | null;
    failoverBusy: boolean;
    failoverFailed: boolean;
    onEngageFailover: () => void;
    onReleaseFailover: () => void;
    /** The hold limit (`usageHoldPct`) drawn on Claude's 5-hour and weekly bars; null = none. */
    holdPct: number | null;
    /** What the limit is holding back right now — the hero names it beside the number. */
    heldCount: number;
    pausedCount: number;
    /** The waiting column; called with `true` for the phone sheet's larger layout. */
    wait: Snippet<[boolean]>;
    onClose: () => void;
    onOpenUsage: () => void;
    el?: HTMLElement | null;
  } = $props();

  const sheet = $derived(variant === "sheet");

  function optionalDialog(node: HTMLElement) {
    return variant === "touch" ? {} : dialog(node, { onclose: onClose });
  }

  // Only Claude's windows carry a provider confirmation, so only they can be awaiting one.
  const bindingPending = $derived(
    !!hottest &&
      hottest.provider === "claude" &&
      observed !== undefined &&
      hottest.window.resetAt <= nowMs,
  );

  // Claude's per-window provider-confirmation ages. Collapsing them into ONE header stamp is what
  // buys the layout four lines back — but it is only honest when every main window actually shares
  // that age. A window with no sample, or an older one, must never borrow a fresher sibling's
  // timestamp, so in that case the stamp is dropped and each row carries its own age instead.
  const observedWindows = $derived(
    observed === undefined ? [] : [observed.session5h, observed.week],
  );
  const windowAges = $derived(
    observedWindows.map((w) => (w ? relativeAge(w.scrapedAt, nowMs) : null)),
  );
  const agesAgree = $derived(
    windowAges.length > 0 && windowAges.every((a) => a !== null && a === windowAges[0]),
  );
  const claudeAge = $derived(agesAgree ? windowAges[0]! : null);
</script>

{#snippet failoverAction()}
  <UsageFailoverAction
    offer={failoverOffer}
    {failover}
    busy={failoverBusy}
    failed={failoverFailed}
    onEngage={onEngageFailover}
    onRelease={onReleaseFailover}
  />
{/snippet}

{#snippet heading()}
  <div class="popover-heading">
    <span id="usage-pop-title" class="heading-text">{m.topbar_gauge_popover_title()}</span>
    {#if claudeAge !== null}
      <span class="freshness">
        <span class="freshness-dot" aria-hidden="true"></span>
        {claudeAge === "now"
          ? m.topbar_usage_observed_now()
          : m.topbar_usage_observed_age({ age: claudeAge })}
      </span>
    {/if}
    <button type="button" class="pop-close" aria-label={m.common_close()} onclick={onClose}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M18 6 6 18" />
        <path d="M6 6l12 12" />
      </svg>
    </button>
  </div>
{/snippet}

{#snippet hero()}
  {#if hottest}
    <UsageHero
      {hottest}
      pending={bindingPending}
      {nowMs}
      {periodLabel}
      {holdPct}
      {heldCount}
      {pausedCount}
      action={failoverAction}
    />
  {:else if failover?.active}
    <!-- No window data at all (hero suppressed) but a failover is still in effect: render the
         revert on its own so the switch can never become unreachable from here. An OFFER cannot
         reach this branch — it needs measured windows on both providers, which implies a hero. -->
    {@render failoverAction()}
  {/if}
{/snippet}

{#snippet capacity()}
  {#if claudeAvailable || codexUsage}
    <div class="pop-capacity">
      <UsageCapacity
        {stale}
        {gauges}
        {perModel}
        {credits}
        {codexUsage}
        {claudeAvailable}
        {observed}
        rowAges={!agesAgree}
        {creditFill}
        {creditColor}
        {creditAmount}
        {nowMs}
        {holdPct}
      />
    </div>
  {/if}
{/snippet}

{#snippet body()}
  {@render heading()}
  {@render hero()}
  <!-- Cause beside effect: the windows, and what they currently hold back. On the phone the
       effect leads — it is what the operator came to act on. -->
  <div class="pop-cols">
    {#if sheet}
      <div class="pop-wait">{@render wait(true)}</div>
      {@render capacity()}
    {:else}
      {@render capacity()}
      <div class="pop-wait">{@render wait(false)}</div>
    {/if}
  </div>

  <footer class="usage-footer">
    <div class="usage-footer-actions">
      <button type="button" class="gauge-pop-link" aria-haspopup="dialog" onclick={onOpenUsage}>
        {m.topbar_usage_link()}
      </button>
      {#if claudeAvailable}
        <div class="gp-refresh">
          <UsageRefreshButton {refreshing} {refreshError} {onRefresh} />
        </div>
      {/if}
    </div>
  </footer>
{/snippet}

{#if sheet}
  <div class="pop-portal" use:portal>
    <div class="pop-scrim scrim" aria-hidden="true" onclick={onClose}></div>
    <div
      bind:this={el}
      class="gauge-pop sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="usage-pop-title"
      tabindex="-1"
      use:dialog={{ onclose: onClose }}
    >
      {@render body()}
    </div>
  </div>
{:else}
  {#if variant === "desktop"}
    <!-- Blocking dim+blur backdrop: the panel spans most of the bar and carries actions, so it is an
         honest modal (aria-modal + use:dialog focus trap/Esc/restore) over a receded app. -->
    <div class="pop-scrim-anchored scrim" aria-hidden="true" onclick={onClose}></div>
  {/if}
  <div
    bind:this={el}
    class="gauge-pop"
    class:gauge-pop-desk={variant === "desktop"}
    role="dialog"
    aria-modal={variant === "desktop"}
    aria-label={m.topbar_gauge_popover_title()}
    use:optionalDialog
  >
    {@render body()}
  </div>
{/if}

<style>
  .gauge-pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 50;
    width: min(920px, calc(100vw - 24px));
    max-height: calc(100dvh - 96px);
    overflow-y: auto;
    box-sizing: border-box;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    padding: 14px 16px 12px;
    display: flex;
    flex-direction: column;
  }
  /* .scrim (app.css) supplies the fixed inset:0, dim and blur; only the stacking is ours. */
  .pop-scrim-anchored {
    z-index: 49;
  }
  .pop-portal {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .pop-scrim {
    z-index: 0;
  }
  /* Phone: a full-screen dialog in place of the anchored panel. */
  .gauge-pop.sheet {
    position: fixed;
    inset: 0;
    z-index: 1;
    width: auto;
    max-height: none;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding: calc(4px + env(safe-area-inset-top)) 16px calc(12px + env(safe-area-inset-bottom));
    -webkit-overflow-scrolling: touch;
  }
  .popover-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }
  .pop-close {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    margin-left: auto;
    padding: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    cursor: pointer;
  }
  .pop-close svg {
    width: 14px;
    height: 14px;
  }
  .pop-close:hover,
  .pop-close:focus-visible {
    background: var(--color-hover);
    color: var(--color-ink-bright);
  }
  .sheet .pop-close {
    width: 44px;
    height: 44px;
    border-color: transparent;
  }
  @media (pointer: coarse) {
    .pop-close {
      width: 44px;
      height: 44px;
    }
  }
  .heading-text {
    color: var(--color-ink-bright);
    font-size: var(--fs-lg);
    font-weight: 700;
    line-height: 1.2;
  }
  .freshness {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .freshness-dot {
    display: block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-ink);
  }

  /* Cause beside effect; stacked when the panel is too narrow for both. */
  .pop-cols {
    display: flex;
    align-items: flex-start;
  }
  .pop-capacity {
    flex: 1 1 300px;
    min-width: 0;
    padding-right: 20px;
  }
  .pop-wait {
    flex: 1.5 1 380px;
    min-width: 0;
    padding-left: 20px;
    border-left: 1px solid var(--color-line);
  }
  /* Without measured windows the waiting column stands alone. */
  .pop-wait:only-child {
    padding-left: 0;
    border-left: 0;
  }
  @media (max-width: 760px) {
    .pop-cols {
      flex-direction: column;
      align-items: stretch;
    }
    .pop-capacity {
      padding-right: 0;
    }
    .pop-wait {
      margin-top: 18px;
      padding: 16px 0 0;
      border-left: 0;
      border-top: 1px solid var(--color-line);
    }
  }
  .sheet .pop-cols {
    flex-direction: column;
    align-items: stretch;
  }
  .sheet .pop-wait {
    margin-top: 0;
    padding: 0;
    border: 0;
  }
  .sheet .pop-capacity {
    margin-top: 20px;
    padding: 16px 0 0;
    border-top: 1px solid var(--color-line);
  }

  .usage-footer {
    margin-top: 14px;
    padding-top: 11px;
    border-top: 1px solid var(--color-line);
  }
  .usage-footer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
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
  .gp-refresh {
    margin-left: auto;
    min-width: 0;
  }
</style>
