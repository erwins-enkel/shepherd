<script lang="ts">
  import { compactTokens, relativeAge } from "#lib/format.js";
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
    modelDisplayName,
    windowResetPending,
    type GaugeKey,
    type Gauge,
  } from "../usage-gauges";
  import CodexResetControls from "./CodexResetControls.svelte";
  import CreditDetail from "./CreditDetail.svelte";
  import UsageWindowRow from "./UsageWindowRow.svelte";

  // The usage panel's capacity column: every window per provider, Claude's 5-hour and weekly rows
  // carrying the hold limit as a tick (the only windows the hold rule and drain ceiling read).
  let {
    stale,
    gauges,
    perModel,
    credits,
    codexUsage,
    claudeAvailable,
    observed,
    rowAges,
    creditFill,
    creditColor,
    creditAmount,
    nowMs,
    holdPct,
  }: {
    stale: boolean;
    gauges: Gauge[];
    perModel: ModelWeekWindow[];
    credits: CreditWindow | null;
    codexUsage: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null;
    claudeAvailable: boolean;
    observed: ObservedLimitWindows | undefined;
    /** The windows' confirmation ages disagree, so each row carries its own (see the panel head). */
    rowAges: boolean;
    creditFill: number;
    creditColor: string;
    creditAmount: string;
    nowMs: number;
    holdPct: number | null;
  } = $props();

  // Claude vs Codex are distinct providers with their own labelled sections. The Claude heading
  // shows only when Claude has data (else a codex-only popover would show an empty section).
  const hasClaude = $derived(claudeAvailable);
  const observedEmpty = $derived(hasClaude && observed !== undefined && gauges.length === 0);

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
        age={rowAges ? relativeAge(w.scrapedAt, nowMs) : null}
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

<style>
  .gauge-pop-claude.stale,
  .token-window.stale,
  .gp-window.stale {
    opacity: 0.5;
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
</style>
