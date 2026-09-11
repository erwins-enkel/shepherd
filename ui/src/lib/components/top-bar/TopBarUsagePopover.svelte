<script lang="ts">
  import { dialog } from "$lib/a11yDialog";
  import { compactTokens, formatReset, formatResetIn, relativeAge } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  import type {
    CreditWindow,
    ModelWeekWindow,
    ObservedLimitWindow,
    ObservedLimitWindows,
    UsageProviderSnapshot,
  } from "$lib/types";
  import {
    codexGaugeList,
    gaugeColor,
    modelDisplayName,
    windowResetPending,
    type GaugeKey,
    type Gauge,
    type HottestCapacityWindow,
  } from "../usage-gauges";
  import type { ProviderFailoverOffer } from "$lib/provider-capacity";
  import type { ProviderFailoverStatus } from "$lib/types";
  import CreditDetail from "./CreditDetail.svelte";
  import UsageFailoverAction from "./UsageFailoverAction.svelte";
  import UsageRefreshButton from "./UsageRefreshButton.svelte";
  import UsageWindowRow from "./UsageWindowRow.svelte";

  let {
    desktop,
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

{#snippet windowRow(label: string, g: Gauge)}
  <div class="gp-window">
    <UsageWindowRow
      {label}
      pct={g.w.pct}
      resetAt={g.w.resetAt}
      pending={windowResetPending(g.w, nowMs)}
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

<div
  class="gauge-pop"
  class:gauge-pop-desk={desktop}
  role="dialog"
  aria-label={m.topbar_gauge_popover_title()}
  use:optionalDialog
>
  <div class="popover-heading">
    <span class="heading-text">{m.topbar_gauge_popover_title()}</span>
    {#if claudeAge !== null}
      <span class="freshness">
        <span class="freshness-dot" aria-hidden="true"></span>
        {claudeAge === "now"
          ? m.topbar_usage_observed_now()
          : m.topbar_usage_observed_age({ age: claudeAge })}
      </span>
    {/if}
  </div>

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
        <span class="hero-bar"
          ><span
            class="hero-fill"
            style="transform:scaleX({hottest.window.usedPct / 100});background:{bindingColor}"
          ></span></span
        >
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
          {@render windowRow(shortPeriod(g.label), g)}
        {/each}
      {/if}
      {#each perModel as entry (entry.model)}
        <!-- Per-model passthroughs render through the SAME row as the main windows, but keep
             ModelWeekGauge untouched: it is shared with the usage dashboard and the gear menu,
             where the long "Weekly window (Fable)" label is still the right one. -->
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
        {@render windowRow(shortPeriod(g.label), g)}
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
    </div>
  {/if}

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
  }
  /* In the mobile sheet the popover is a plain block in the flow, not an anchored overlay. Only
     the positioning differs now — desktop and touch share one layout. */
  .gauge-pop:not(.gauge-pop-desk) {
    position: static;
    width: auto;
    max-width: none;
    border: 0;
    box-shadow: none;
    padding: 0;
  }
  .gauge-pop-claude.stale,
  .token-window.stale,
  .usage-hero.stale,
  .gp-window.stale {
    opacity: 0.5;
  }
  .popover-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
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
  .hero-bar {
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
  .token-window {
    margin-top: 17px;
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
