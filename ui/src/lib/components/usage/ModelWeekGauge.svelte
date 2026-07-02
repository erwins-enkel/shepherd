<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { formatResetIn } from "$lib/format";
  import { gaugeColor, modelDisplayName } from "$lib/components/usage-gauges";
  import type { ModelWeekWindow } from "$lib/types";

  // A per-model weekly sub-limit ("Current week (Fable)") as its own passthrough bar. Deliberately
  // NOT a gaugeList Gauge — it carries a nullable resetAt + its own staleness and must never feed
  // hotterGauge/touch-collapse.
  let { entry, nowMs = Date.now() }: { entry: ModelWeekWindow; nowMs?: number } = $props();

  const label = $derived(
    m.usage_limits_window_week_model({ model: modelDisplayName(entry.model) }),
  );
  const pct = $derived(Math.min(Math.max(entry.pct, 0), 100));
  const color = $derived(gaugeColor(entry.pct));
</script>

<div class="mw-gauge" class:stale={entry.stale}>
  <div class="mw-head">
    <span class="mw-label">{label}</span>
    <span class="mw-pct" style="color:{color}">{entry.pct}%</span>
  </div>
  <span
    class="mw-bar"
    role="meter"
    aria-valuenow={entry.pct}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-label={label}><span class="mw-fill" style="width:{pct}%;background:{color}"></span></span
  >
  {#if entry.resetAt != null}
    <div class="mw-reset micro">
      {m.usage_limits_resets_in({ time: formatResetIn(entry.resetAt, nowMs) })}
    </div>
  {/if}
</div>

<style>
  .mw-gauge {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-variant-numeric: tabular-nums;
  }
  .mw-gauge.stale {
    opacity: 0.5;
  }
  .mw-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .mw-label {
    color: var(--color-text);
    font-size: var(--fs-meta);
  }
  .mw-pct {
    font-size: var(--fs-meta);
    min-width: 30px;
    text-align: right;
  }
  .mw-bar {
    display: block;
    width: 100%;
    height: 6px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .mw-fill {
    display: block;
    height: 100%;
    transition: width 0.6s ease;
  }
  .mw-reset {
    text-transform: none;
    letter-spacing: 0.04em;
    color: var(--color-faint);
  }
  .micro {
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
</style>
