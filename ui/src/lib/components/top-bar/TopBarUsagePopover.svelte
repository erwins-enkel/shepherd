<script lang="ts">
  import type { Snippet } from "svelte";
  import { dialog } from "#lib/a11yDialog.js";
  import { portal } from "#lib/portal.js";
  import { compactTokens, formatReset, formatResetIn, relativeAge } from "#lib/format.js";
  import { m } from "#lib/paraglide/messages.js";
  import type {
    CreditWindow,
    ModelWeekWindow,
    ObservedLimitWindow,
    ObservedLimitWindows,
    UsageProviderSnapshot,
  } from "#lib/types.js";
  import {
    codexGaugeList,
    gaugeColor,
    modelDisplayName,
    windowResetPending,
    type GaugeKey,
    type Gauge,
    type HottestCapacityWindow,
  } from "../usage-gauges";
  import type { ProviderFailoverOffer } from "#lib/provider-capacity.js";
  import type { ProviderFailoverStatus } from "#lib/types.js";
  import CodexResetControls from "./CodexResetControls.svelte";
  import CreditDetail from "./CreditDetail.svelte";
  import UsageFailoverAction from "./UsageFailoverAction.svelte";
  import UsageRefreshButton from "./UsageRefreshButton.svelte";
  import UsageWindowRow from "./UsageWindowRow.svelte";

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

  // Claude vs Codex are distinct providers with their own labelled sections. The Claude heading
  // shows only when Claude has data (else a codex-only popover would show an empty section).
  const hasClaude = $derived(claudeAvailable);
  const observedEmpty = $derived(hasClaude && observed !== undefined && gauges.length === 0);

  // The hero. Promoting this window is the whole point of the layout: the limit that decides
  // whether you can start another agent used to be indistinguishable from three idle ones, and
  // could sit at the very bottom of the panel.
  const bindingColor = $derived(hottest ? gaugeColor(hottest.window.usedPct) : "");
  const bindingProvider = $derived(
    hottest?.provider === "codex" ? m.agent_provider_codex() : m.agent_provider_claude(),
  );
  // Only Claude's windows carry a provider confirmation, so only they can be awaiting one.
  const bindingPending = $derived(
    !!hottest &&
      hottest.provider === "claude" &&
      observed !== undefined &&
      hottest.window.resetAt <= nowMs,
  );

  // Holding compares Claude's 5-hour and weekly windows against the limit, so only a Claude hero
  // carries the tick; a hotter Codex window is measured by its own capacity check instead.
  const heroLimit = $derived(holdPct !== null && hottest?.provider === "claude" ? holdPct : null);
  const heroOver = $derived(heroLimit !== null && !!hottest && hottest.window.usedPct >= heroLimit);
  // Keep the tick's caption inside the bar near either end.
  const limitShift = $derived(
    heroLimit === null ? "-50%" : heroLimit >= 88 ? "-100%" : heroLimit <= 12 ? "0%" : "-50%",
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
  const codexAge = $derived(
    codexUsage?.updatedAt == null ? null : relativeAge(codexUsage.updatedAt, nowMs),
  );
  const codexWindows = $derived(codexGaugeList(codexUsage));

  // Rows get SHORT window names: their label column is 46px, and the shared `periodLabel` (used by
  // the hero, the gear menu and the usage dashboard, which all have room) is "wöchentlich" in
  // German — long enough to run into the bar.
  const shortPeriod = (k: GaugeKey) =>
    k === "5H" ? m.topbar_gauge_period_5h_short() : m.topbar_gauge_period_weekly_short();
  // A different clock from the token snapshot above, and only worth a line when it diverges.
  const codexLimitAge = $derived(
    codexUsage &&
      codexWindows.length > 0 &&
      codexUsage.rateLimitLatestEventAt != null &&
      codexUsage.rateLimitLatestEventAt !== codexUsage.updatedAt
      ? relativeAge(codexUsage.rateLimitLatestEventAt, nowMs)
      : null,
  );
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

{#snippet sectionRule(title: string, note: string | null)}
  <div class="section-rule">
    <span class="section-name">{title}</span>
    <span class="rule-line"></span>
    {#if note}<span class="section-note">{note}</span>{/if}
  </div>
{/snippet}

{#snippet windowRow(label: string, g: Gauge, ceiling: number | null)}
  <div class="gp-window">
    <UsageWindowRow
      {label}
      pct={g.w.pct}
      resetAt={g.w.resetAt}
      pending={windowResetPending(g.w, nowMs)}
      ceilingPct={ceiling}
      {nowMs}
    />
  </div>
{/snippet}

{#snippet observedRow(key: GaugeKey, w: ObservedLimitWindow | null)}
  <div class="gp-window">
    {#if w}
      <UsageWindowRow
        label={shortPeriod(key)}
        pct={w.pct}
        resetAt={w.resetAt}
        pending={windowResetPending(w, nowMs)}
        age={agesAgree ? null : relativeAge(w.scrapedAt, nowMs)}
        ceilingPct={holdPct}
        {nowMs}
      />
    {:else}
      <!-- A window the provider has never confirmed: name it and say so, rather than drawing an
           empty bar that reads as "0 % used". -->
      <div class="missing-window">
        <span class="missing-label">{shortPeriod(key)}</span>
        <span class="missing-value">{m.topbar_usage_no_observation()}</span>
      </div>
    {/if}
  </div>
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
    <!-- Hero. Deliberately ALSO left in its own section below: the sections stay complete lists
         while the hero moves between them as load shifts, so a promoted row must not leave a hole. -->
    <!-- Dimmed with its source row: `hottest.stale` is the staleness of the provider row the
         window was selected from, so the promoted copy and the copy still sitting in its section
         below always read the same. Without it a stale window would be shown at full strength up
         here while its twin below is dimmed. -->
    <div class="usage-hero" class:stale={hottest.stale}>
      <span class="hero-glow" aria-hidden="true"></span>
      <span class="hero-scan" aria-hidden="true"></span>
      <div class="hero-body">
        <div class="hero-eyebrow">{m.topbar_usage_binding_title()}</div>
        <div class="hero-head">
          <span class="hero-pct" style="color:{bindingColor}"
            >{hottest.window.usedPct}<span class="hero-unit">%</span></span
          >
          <span class="hero-window">{bindingProvider} · {periodLabel(hottest.window.key)}</span>
        </div>
        <!-- What the limit is doing right now, named beside the number that causes it. -->
        {#if pausedCount > 0 || heldCount > 0}
          <div class="hero-effects">
            {#if pausedCount > 0}
              <span class="effect effect-paused">
                <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"
                  ><rect x="2.5" y="2" width="2.5" height="8" /><rect
                    x="7"
                    y="2"
                    width="2.5"
                    height="8"
                  /></svg
                >{m.capacity_effect_paused()}
              </span>
            {/if}
            {#if heldCount > 0}
              <span class="effect effect-held">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 2h14M5 22h14" />
                  <path d="M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2" />
                  <path d="M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22" />
                </svg>{m.topbar_held_badge({ count: heldCount })}
              </span>
            {/if}
          </div>
        {:else if heroLimit !== null}
          <div class="hero-effects">
            <span class="effect-quiet"
              >{heroOver ? m.capacity_over_limit() : m.capacity_below_limit()}</span
            >
          </div>
        {/if}
        <div class="hero-track" class:limited={heroLimit !== null}>
          {#if heroLimit !== null}
            <span class="hero-limit-label" style="left:{heroLimit}%;--shift:{limitShift}"
              >{m.capacity_limit({ pct: heroLimit })}</span
            >
          {/if}
          <span class="hero-bar"
            ><span
              class="hero-fill"
              style="transform:scaleX({hottest.window.usedPct / 100});background:{bindingColor}"
            ></span>{#if heroOver && heroLimit !== null}<span
                class="hero-over"
                style="left:{heroLimit}%;width:{Math.min(hottest.window.usedPct, 100) - heroLimit}%"
                aria-hidden="true"
              ></span>{/if}</span
          >
          {#if heroLimit !== null}
            <span class="hero-tick" style="left:{heroLimit}%" aria-hidden="true"></span>
          {/if}
        </div>
        <div class="hero-foot">
          {#if bindingPending}
            <span>{m.topbar_usage_reset_checking()}</span>
          {:else}
            <span
              >{m.topbar_usage_free_in({ rel: formatResetIn(hottest.window.resetAt, nowMs) })}</span
            >
            <span>{formatReset(hottest.window.resetAt, nowMs, { withTime: true })}</span>
          {/if}
        </div>
        {@render failoverAction()}
      </div>
    </div>
  {:else if failover?.active}
    <!-- No window data at all (hero suppressed) but a failover is still in effect: render the
         revert on its own so the switch can never become unreachable from here. An OFFER cannot
         reach this branch — it needs measured windows on both providers, which implies a hero. -->
    {@render failoverAction()}
  {/if}
{/snippet}

{#snippet capacity()}
  {#if hasClaude || codexUsage}
    <div class="pop-capacity">
      <!-- `stale` (Claude limits staleness) dims ONLY this block — the Codex section below carries its
           own `codexUsage.stale`, so a stale Claude snapshot must not dim fresh Codex. -->
      {#if hasClaude}
        <div class="gauge-pop-claude" class:stale>
          {@render sectionRule(
            m.agent_provider_claude() + (stale ? m.topbar_gauge_stale_suffix() : ""),
            null,
          )}
          {#if observedEmpty}
            <div class="usage-empty">{m.topbar_usage_no_observation()}</div>
          {:else if observed !== undefined}
            {@render observedRow("5H", observed.session5h)}
            {@render observedRow("WK", observed.week)}
          {:else}
            {#each gauges as g (g.label)}
              {@render windowRow(shortPeriod(g.label), g, holdPct)}
            {/each}
          {/if}
          {#each perModel as entry (entry.model)}
            <!-- Per-model passthroughs render through the SAME row as the main windows, but keep
                 ModelWeekGauge untouched: it is shared with the usage dashboard and the gear menu,
                 where the long "Weekly window (Fable)" label is still the right one. No limit tick:
                 holding reads only the 5-hour and weekly windows. -->
            <div class="gp-window" class:stale={entry.stale}>
              <UsageWindowRow
                label={modelDisplayName(entry.model)}
                pct={entry.pct}
                resetAt={entry.resetAt}
                {nowMs}
              />
            </div>
          {/each}
          {#if credits}
            <div class="gp-window">
              <CreditDetail {credits} {creditFill} {creditColor} {creditAmount} {nowMs} />
            </div>
          {/if}
        </div>
      {/if}

      {#if codexUsage}
        <div class="token-window" class:stale={codexUsage.stale}>
          {@render sectionRule(
            m.agent_provider_codex(),
            codexAge === null
              ? null
              : codexAge === "now"
                ? m.topbar_codex_tokens_checked_now()
                : m.topbar_codex_tokens_checked_age({ age: codexAge }),
          )}
          <!-- The popover renders its own Codex body rather than reusing CodexTokenDetail: that
               component is shared with the usage dashboard, where the three labelled token rows and
               the per-bar reset lines have room. -->
          {#each codexWindows as g (g.label)}
            {@render windowRow(shortPeriod(g.label), g, null)}
          {/each}
          {#if codexWindows.length === 0}
            <div class="usage-empty">{m.topbar_codex_limits_unavailable()}</div>
          {/if}
          {#if codexLimitAge !== null}
            <div class="codex-limit-age">
              {codexLimitAge === "now"
                ? m.topbar_codex_limits_checked_now()
                : m.topbar_codex_limits_checked_age({ age: codexLimitAge })}
            </div>
          {/if}
          {#if codexUsage.tokenDataAvailable !== false}
            <div class="token-line">
              <span
                >{m.topbar_tokens_window({ period: "5H" })}
                <span class="token-value">{compactTokens(codexUsage.session5hTokens)}</span></span
              >
              <span
                >{m.topbar_tokens_window({ period: "WK" })}
                <span class="token-value">{compactTokens(codexUsage.weekTokens)}</span></span
              >
              <span
                >{m.topbar_tokens_total()}
                <span class="token-value">{compactTokens(codexUsage.totalTokens)}</span></span
              >
            </div>
          {/if}
          {#if codexUsage.resetStatus}<CodexResetControls status={codexUsage.resetStatus} />{/if}
        </div>
      {/if}
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
      {#if hasClaude}
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
  .gauge-pop-claude.stale,
  .token-window.stale,
  .usage-hero.stale,
  .gp-window.stale {
    opacity: 0.5;
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

  .usage-hero {
    position: relative;
    overflow: hidden;
    margin-bottom: 17px;
    padding: 12px 13px 13px;
    border: 1px solid color-mix(in srgb, var(--color-amber) 26%, var(--color-line-bright));
    border-radius: 2px;
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-amber) 7%, var(--color-panel-2)),
      var(--color-panel-2)
    );
  }
  .hero-glow {
    position: absolute;
    inset: 0;
    background: radial-gradient(
      120% 90% at 8% 30%,
      color-mix(in srgb, var(--color-amber) 20%, transparent),
      transparent 62%
    );
  }
  .hero-scan {
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      180deg,
      color-mix(in srgb, var(--color-amber) 6%, transparent) 0 1px,
      transparent 1px 3px
    );
  }
  .hero-body {
    position: relative;
  }
  .hero-eyebrow {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    margin-bottom: 7px;
  }
  .hero-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 11px;
    font-variant-numeric: tabular-nums;
  }
  .hero-pct {
    font-size: calc(2.125 * var(--fs-lg));
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .hero-unit {
    font-size: var(--fs-lg);
    font-weight: 400;
    margin-left: 3px;
    opacity: 0.72;
  }
  .hero-window {
    color: var(--color-ink);
    font-size: var(--fs-meta);
    text-align: right;
  }
  /* The consequence line: what the limit is holding back right now, beside the number. */
  .hero-effects {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    margin: -3px 0 12px;
  }
  .effect {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border: 1px solid;
    border-radius: var(--radius-chip);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .effect svg {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
  }
  /* Subordinate red (text + hairline + tint, no halo): a paused drain, not a blocked agent. */
  .effect-paused {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 50%, var(--color-line));
    background: color-mix(in srgb, var(--color-red) 10%, transparent);
  }
  .effect-held {
    color: var(--color-amber);
    border-color: color-mix(in srgb, var(--color-amber) 55%, var(--color-line));
    background: color-mix(in srgb, var(--color-amber) 8%, transparent);
  }
  .effect-quiet {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .hero-track {
    position: relative;
  }
  /* Room above the bar for the limit's caption. */
  .hero-track.limited {
    margin-top: 24px;
  }
  .hero-limit-label {
    position: absolute;
    bottom: calc(100% + 7px);
    transform: translateX(var(--shift));
    color: var(--color-ink-bright);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .hero-tick {
    position: absolute;
    top: -5px;
    bottom: -5px;
    width: 2px;
    margin-left: -1px;
    background: var(--color-ink-bright);
  }
  /* The share of the bar past the limit is hatched: the part that is holding work back. */
  .hero-over {
    position: absolute;
    top: 0;
    bottom: 0;
    background: repeating-linear-gradient(
      135deg,
      color-mix(in srgb, var(--color-bg) 60%, transparent) 0 2px,
      transparent 2px 4px
    );
  }
  .hero-bar {
    position: relative;
    display: block;
    height: 11px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .hero-fill {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: left;
    transition: transform 0.6s ease;
  }
  .hero-foot {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    margin-top: 9px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
  }

  .section-rule {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .section-name {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .rule-line {
    flex: 1;
    height: 1px;
    background: var(--color-line);
  }
  .section-note {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .gauge-pop-claude + .token-window {
    margin-top: 17px;
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
  .gp-window + .gp-window {
    margin-top: 10px;
  }
  .missing-window {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .missing-label {
    color: var(--color-ink);
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .missing-value {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    text-align: right;
  }
  .usage-empty {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    line-height: 1.45;
    padding: 2px 0 4px;
  }

  .codex-limit-age {
    margin-top: 8px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
  .token-line {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 11px;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-variant-numeric: tabular-nums;
  }
  .token-value {
    color: var(--color-muted);
    letter-spacing: 0;
    text-transform: none;
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
