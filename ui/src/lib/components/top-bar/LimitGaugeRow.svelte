<script lang="ts">
  import { formatReset, formatResetIn } from "$lib/format";
  import { m } from "$lib/paraglide/messages";
  import type { LimitWindow } from "$lib/types";
  import { gaugeColor } from "../usage-gauges";

  let {
    label,
    limit,
    nowMs,
    inline = false,
  }: {
    label: string;
    limit: LimitWindow;
    nowMs: number;
    inline?: boolean;
  } = $props();

  const fill = $derived(Math.min(Math.max(limit.pct, 0), 100) / 100);
  const color = $derived(gaugeColor(limit.pct));
</script>

{#if inline}
  <div class="gauge-pop-row">
    <span class="g-label micro">{label}</span>
    <span class="g-bar g-bar-wide"
      ><span class="g-fill" style="transform:scaleX({fill});background:{color}"></span></span
    >
    <span class="g-pct" style="color:{color}">{limit.pct}%</span>
  </div>
  <div class="gauge-pop-reset micro">
    {m.topbar_gauge_reset_rel({
      rel: formatResetIn(limit.resetAt, nowMs),
      abs: formatReset(limit.resetAt, nowMs),
    })}
  </div>
{:else}
  <div class="sheet-gauge-row">
    <div class="sheet-gauge-head">
      <span class="gp-period">{label}</span>
      <span class="g-pct" style="color:{color}">{limit.pct}%</span>
    </div>
    <span class="g-bar g-bar-wide"
      ><span class="g-fill" style="transform:scaleX({fill});background:{color}"></span></span
    >
    <div class="gauge-pop-reset micro">
      {m.topbar_gauge_reset_rel({
        rel: formatResetIn(limit.resetAt, nowMs),
        abs: formatReset(limit.resetAt, nowMs),
      })}
    </div>
  </div>
{/if}

<style>
  .sheet-gauge-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .sheet-gauge-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .gauge-pop-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-variant-numeric: tabular-nums;
  }
  .g-label {
    color: var(--color-muted);
  }
  .gp-period {
    color: var(--color-text);
    font-size: var(--fs-meta);
    text-transform: capitalize;
  }
  .g-bar {
    width: 46px;
    height: 5px;
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    overflow: hidden;
  }
  .g-bar-wide {
    width: 100%;
    height: 6px;
  }
  .gauge-pop-row .g-bar-wide {
    flex: 1;
    width: auto;
    height: 6px;
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
  .sheet-gauge-row .g-bar-wide {
    width: 100%;
    height: 6px;
  }
  .sheet-gauge-row .gauge-pop-reset {
    margin: 0 0 6px;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
</style>
