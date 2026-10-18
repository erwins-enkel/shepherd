<script lang="ts">
  import {
    DECISION_MODEL_FEATURE_COUNT,
    activeFeatureCount,
    decisionModelState,
    formatUsd,
    keyRejection,
    type DecisionModelFeatures,
  } from "#lib/decision-model.js";
  import { formatAgo } from "#lib/format.js";
  import type { JudgeConnectionStatus } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";

  // The status strip of Settings → Decision model (#3071): the state `decision-model.ts` derives,
  // one line on what it means, and today's spend against the daily ceiling.
  let {
    connection,
    features,
  }: { connection: JudgeConnectionStatus | null; features: DecisionModelFeatures } = $props();

  const dmState = $derived(decisionModelState(connection, features));

  function stateLabel(): string {
    switch (dmState) {
      case "notConnected":
        return m.settings_dm_state_not_connected();
      case "ready":
        return m.settings_dm_state_ready();
      case "active":
        return m.settings_dm_state_active();
      case "limitReached":
        return m.settings_dm_state_limit();
      case "keyRejected":
        return m.settings_dm_state_rejected();
    }
  }

  function activeHint(s: JudgeConnectionStatus | null): string {
    const line = m.settings_dm_state_active_hint({
      count: activeFeatureCount(features),
      total: DECISION_MODEL_FEATURE_COUNT,
      model: s?.model ?? "",
    });
    if (!s?.lastOkAt) return line;
    return `${line} · ${m.settings_dm_state_last_answer({ age: formatAgo(Date.now() - s.lastOkAt) })}`;
  }

  function rejectedHint(s: JudgeConnectionStatus | null): string {
    const r = s ? keyRejection(s) : null;
    return m.settings_dm_state_rejected_hint({
      status: String(r?.status ?? "—"),
      time: r ? new Date(r.at).toLocaleTimeString(undefined, { timeStyle: "short" }) : "—",
    });
  }

  function stateHint(): string {
    switch (dmState) {
      case "notConnected":
        return m.settings_dm_state_not_connected_hint();
      case "ready":
        return m.settings_dm_state_ready_hint();
      case "active":
        return activeHint(connection);
      case "limitReached":
        return m.settings_dm_state_limit_hint();
      case "keyRejected":
        return rejectedHint(connection);
    }
  }

  const spendPct = $derived.by(() => {
    const t = connection?.today;
    if (!t) return 0;
    if (t.ceilingUsd <= 0) return 100;
    return Math.min(100, Math.round((t.usd / t.ceilingUsd) * 100));
  });
</script>

<section class="dm-status" data-state={dmState} aria-label={m.settings_dm_status_aria()}>
  <span class="dot" aria-hidden="true"></span>
  <div class="dm-status-text">
    <span class="dm-state">{stateLabel()}</span>
    <span class="dm-state-hint">{stateHint()}</span>
  </div>
  {#if connection?.today && dmState !== "notConnected"}
    <div class="dm-spend">
      <div class="dm-spend-line">
        <span class="dm-today">{m.settings_dm_today()}</span>
        <span class="dm-usd"
          >{formatUsd(connection.today.usd)} / {formatUsd(connection.today.ceilingUsd)}</span
        >
      </div>
      <div class="dm-bar" role="img" aria-label={m.settings_dm_spend_aria({ pct: spendPct })}>
        <div class="dm-bar-fill" style:width={`${spendPct}%`}></div>
      </div>
    </div>
  {/if}
</section>

<style>
  .dm-status {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    margin-bottom: 18px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid var(--color-faint);
  }
  .dm-status-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .dm-state {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .dm-state-hint {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
  }
  [data-state="ready"] .dot {
    border-color: var(--color-ink-bright);
  }
  [data-state="ready"] .dm-state {
    color: var(--color-ink-bright);
  }
  [data-state="active"] .dot {
    background: var(--color-amber);
    border-color: var(--color-amber);
  }
  [data-state="active"] .dm-state {
    color: var(--color-amber);
  }
  [data-state="limitReached"] {
    border-color: var(--color-warn);
  }
  [data-state="limitReached"] .dot {
    background: var(--color-warn);
    border-color: var(--color-warn);
  }
  [data-state="limitReached"] .dm-state,
  [data-state="limitReached"] .dm-usd {
    color: var(--color-warn);
  }
  [data-state="keyRejected"] {
    border-color: var(--color-red);
  }
  [data-state="keyRejected"] .dot {
    background: var(--color-red);
    border-color: var(--color-red);
  }
  [data-state="keyRejected"] .dm-state {
    color: var(--color-red);
  }
  [data-state="limitReached"] .dm-state-hint,
  [data-state="keyRejected"] .dm-state-hint {
    color: var(--color-ink);
  }
  .dm-spend {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 170px;
    flex-shrink: 0;
  }
  .dm-spend-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .dm-today {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .dm-usd {
    margin-left: auto;
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    font-variant-numeric: tabular-nums;
  }
  .dm-bar {
    height: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
  }
  .dm-bar-fill {
    height: 100%;
    background: var(--color-amber);
  }
  [data-state="limitReached"] .dm-bar-fill {
    background: var(--color-warn);
  }

  @media (max-width: 768px) {
    .dm-status {
      flex-wrap: wrap;
    }
    .dm-spend {
      width: 100%;
    }
    .dm-state-hint {
      font-size: var(--fs-base);
    }
  }
</style>
