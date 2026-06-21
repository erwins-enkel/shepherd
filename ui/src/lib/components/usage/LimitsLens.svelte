<script lang="ts">
  import type { UsageLimits, UsageProjection } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { gaugeList, gaugeColor } from "$lib/components/usage-gauges";
  import { formatResetIn } from "$lib/format";
  import { formatUnits } from "./format";

  const { limits, projections }: { limits: UsageLimits; projections: UsageProjection[] } = $props();

  const nowMs = $derived(Date.now());
  const gauges = $derived(gaugeList(limits));

  function windowLabel(label: "5H" | "WK"): string {
    return label === "5H" ? m.usage_limits_window_5h() : m.usage_limits_window_week();
  }

  function findProjection(label: "5H" | "WK"): UsageProjection | undefined {
    return projections.find((p) => p.window === label);
  }
</script>

<div class="limits-lens panel">
  {#if gauges.length === 0}
    <p class="no-data">{m.usage_limits_no_data()}</p>
  {:else}
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
  {/if}
</div>

<style>
  .limits-lens {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
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
</style>
