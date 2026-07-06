<script lang="ts">
  import type {
    UsageLimits,
    UsageProjection,
    UsageHistoryResponse,
    UsageProviderSnapshot,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { gaugeList, gaugeColor, modelWeekList } from "$lib/components/usage-gauges";
  import { formatResetIn } from "$lib/format";
  import { formatUnits } from "./format";
  import Sparkline from "./Sparkline.svelte";
  import ModelWeekGauge from "./ModelWeekGauge.svelte";
  import UsageHistoryPanel from "./UsageHistoryPanel.svelte";
  import CodexTokenDetail from "../top-bar/CodexTokenDetail.svelte";

  const {
    limits,
    projections,
    codexUsage = null,
    history = null,
  }: {
    limits: UsageLimits;
    projections: UsageProjection[];
    codexUsage?: Extract<UsageProviderSnapshot, { provider: "codex"; kind: "tokens" }> | null;
    history?: UsageHistoryResponse | null;
  } = $props();

  // Window period lengths (ms) — used to scope an inline sparkline to the current cycle.
  const PERIOD_MS = { session5h: 5 * 3_600_000, week: 7 * 24 * 3_600_000 } as const;

  const nowMs = $derived(Date.now());
  const gauges = $derived(gaugeList(limits));
  // Per-model weekly passthrough sub-limits (e.g. Fable) — rendered as their own bars below the
  // calibrated 5H/WK windows. Kept out of `gaugeList` (no cap-inversion, no projection/sparkline).
  const perModel = $derived(modelWeekList(limits));
  const hasClaude = $derived(gauges.length > 0 || perModel.length > 0);

  let showHistory = $state(false);

  // Toggle is offered only when there's actually recorded history to show.
  const hasHistory = $derived(
    !!history &&
      (history.caps.session5h.length > 0 ||
        history.caps.week.length > 0 ||
        history.credit.length > 0),
  );

  function windowLabel(label: "5H" | "WK"): string {
    return label === "5H" ? m.usage_limits_window_5h() : m.usage_limits_window_week();
  }

  function windowKey(label: "5H" | "WK"): "session5h" | "week" {
    return label === "5H" ? "session5h" : "week";
  }

  function findProjection(label: "5H" | "WK"): UsageProjection | undefined {
    return projections.find((p) => p.window === label);
  }

  /** Current-cycle inline series: in-cycle scrape samples + a synthetic live "now"
   *  endpoint at the gauge's live pct, so the curve terminates at the number above it. */
  function inlinePoints(label: "5H" | "WK", livePct: number, resetAt: number) {
    const key = windowKey(label);
    const cutoff = resetAt - PERIOD_MS[key];
    const samples = history
      ? history.caps[key]
          .filter((p) => p.scrapedAt >= cutoff)
          .map((p) => ({ t: p.scrapedAt, v: p.pct }))
      : [];
    return [...samples, { t: nowMs, v: livePct }];
  }
</script>

<div class="limits-lens panel">
  {#if !hasClaude && !codexUsage}
    <p class="no-data">{m.usage_limits_no_data()}</p>
  {:else}
    {#if hasClaude}
      <div class="provider-section provider-claude">
        <div class="provider-heading micro">
          {m.topbar_usage_provider_title({ provider: m.agent_provider_claude() })}
        </div>
        {#each gauges as gauge (gauge.label)}
          {@const pct = Math.min(Math.max(gauge.w.pct, 0), 100)}
          {@const color = gaugeColor(gauge.w.pct)}
          {@const proj = findProjection(gauge.label)}
          {@const projPct = proj ? Math.min(Math.max(proj.projectedPct, 0), 100) : null}
          {@const willExceed = proj ? proj.projectedPct > 100 : false}

          <div class="window-block">
            <div class="window-header">
              <span class="window-label">{windowLabel(gauge.label)}</span>
              <span class="micro">{gauge.label}</span>
              <span class="window-pct" style="color:{color}">{gauge.w.pct}%</span>
            </div>

            <div
              class="meter-wrap"
              role="meter"
              aria-valuenow={gauge.w.pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={windowLabel(gauge.label)}
            >
              <div class="meter-track">
                <!-- Current fill -->
                <div class="meter-fill" style="width:{pct}%;background:{color}"></div>
                <!-- Projection tick -->
                {#if projPct !== null}
                  <div class="proj-tick" style="left:{projPct}%" aria-hidden="true"></div>
                {/if}
              </div>
            </div>

            <!-- Recorded current-cycle trend: scrape samples + a live "now" endpoint. -->
            <div class="spark-row">
              <Sparkline
                points={inlinePoints(gauge.label, gauge.w.pct, gauge.w.resetAt)}
                {color}
                liveLast={true}
                domain={{ min: 0, max: 100 }}
                ariaLabel={m.usage_history_inline_label({ window: windowLabel(gauge.label) })}
              />
            </div>

            <div class="window-meta">
              <span class="reset-time"
                >{m.usage_limits_resets_in({ time: formatResetIn(gauge.w.resetAt, nowMs) })}</span
              >
              {#if proj}
                <span class="proj-info" class:will-exceed={willExceed}>
                  {m.usage_limits_projected({ pct: proj.projectedPct })}
                  {#if willExceed}
                    &nbsp;—&nbsp;<span class="exceed-label">{m.usage_limits_will_exceed()}</span>
                  {/if}
                </span>
                <span class="burn-rate"
                  >{m.usage_limits_burn_rate({ rate: formatUnits(proj.burnRatePerHour) })}</span
                >
              {/if}
            </div>
          </div>
        {/each}

        {#if perModel.length > 0}
          <div class="model-week-block">
            {#each perModel as entry (entry.model)}
              <ModelWeekGauge {entry} {nowMs} />
            {/each}
          </div>
        {/if}

        {#if hasHistory}
          <div class="history-toggle-row">
            <button
              type="button"
              class="gbtn"
              aria-expanded={showHistory}
              onclick={() => (showHistory = !showHistory)}
            >
              {showHistory ? m.usage_history_hide() : m.usage_history_view()}
            </button>
          </div>
          {#if showHistory && history}
            <UsageHistoryPanel {history} />
          {/if}
        {/if}
      </div>
    {/if}

    {#if codexUsage}
      <div class="provider-section provider-codex" class:stale={codexUsage.stale}>
        <div class="provider-heading micro">
          {m.topbar_usage_provider_title({ provider: m.agent_provider_codex() })}
        </div>
        <CodexTokenDetail usage={codexUsage} {nowMs} periodLabel={windowLabel} />
      </div>
    {/if}
  {/if}
</div>

<style>
  .limits-lens {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .provider-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .provider-section.stale {
    opacity: 0.5;
  }

  .provider-heading {
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--color-line);
  }

  .no-data {
    color: var(--color-muted);
    font-size: var(--fs-base);
    margin: 0;
  }

  .window-block {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .window-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .window-label {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
    flex: 1;
  }

  .window-pct {
    font-size: var(--fs-lg);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    min-width: 3.5rem;
    text-align: right;
  }

  .meter-wrap {
    width: 100%;
  }

  .meter-track {
    position: relative;
    width: 100%;
    height: 10px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    overflow: visible;
  }

  .meter-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 3px 0 0 3px;
    transition: width 0.4s ease;
  }

  .proj-tick {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    background: var(--color-faint);
    border-radius: 1px;
    transform: translateX(-50%);
    opacity: 0.7;
  }

  .window-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
  }

  .reset-time {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }

  .proj-info {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }

  .proj-info.will-exceed {
    color: var(--color-red);
  }

  .exceed-label {
    color: var(--color-red);
  }

  .burn-rate {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }

  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .spark-row {
    display: flex;
    align-items: center;
  }

  .model-week-block {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .history-toggle-row {
    display: flex;
  }

  /* Canonical .gbtn recipe (design-system) */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }

  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
