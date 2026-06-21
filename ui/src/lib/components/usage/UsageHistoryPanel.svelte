<script lang="ts">
  import type { UsageHistoryResponse, CapHistoryPoint, CreditHistoryPoint } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { gaugeColor } from "$lib/components/usage-gauges";
  import { formatReset } from "$lib/format";
  import Sparkline from "./Sparkline.svelte";

  const { history }: { history: UsageHistoryResponse } = $props();

  const nowMs = $derived(Date.now());

  interface Cycle {
    /** Reset-boundary key grouping the points; null = the open/last cycle. */
    resetAt: number | null;
    points: { t: number; v: number }[];
  }

  /** A renderable series: its chart cycles + headline stats, or null if empty. */
  interface Series {
    label: string;
    cycles: Cycle[];
    latest: number;
    peak: number;
    spanFrom: number;
    spanTo: number;
  }

  /** Group time-ASC points into per-reset-cycle segments so a polyline never
   *  connects across a reset boundary. Points sharing a resetAt are one cycle;
   *  a null resetAt collapses into a single trailing cycle. */
  function segment(points: { t: number; v: number; resetAt: number | null }[]): Cycle[] {
    const cycles: Cycle[] = [];
    for (const p of points) {
      const last = cycles[cycles.length - 1];
      if (last && last.resetAt === p.resetAt) {
        last.points.push({ t: p.t, v: p.v });
      } else {
        cycles.push({ resetAt: p.resetAt, points: [{ t: p.t, v: p.v }] });
      }
    }
    return cycles;
  }

  function capSeries(label: string, rows: CapHistoryPoint[]): Series | null {
    if (rows.length === 0) return null;
    const mapped = rows.map((r) => ({ t: r.scrapedAt, v: r.pct, resetAt: r.resetAt }));
    return buildSeries(label, mapped);
  }

  function creditSeries(rows: CreditHistoryPoint[]): Series | null {
    if (rows.length === 0) return null;
    // Gauge pct rounds down to 0 while money is spent — plot the spend ratio instead.
    const mapped = rows.map((r) => ({
      t: r.scrapedAt,
      v: r.cap > 0 ? (r.spent / r.cap) * 100 : 0,
      resetAt: r.resetAt,
    }));
    return buildSeries(m.usage_history_credit_label(), mapped);
  }

  function buildSeries(
    label: string,
    mapped: { t: number; v: number; resetAt: number | null }[],
  ): Series {
    const cycles = segment(mapped);
    const current = cycles[cycles.length - 1];
    const latest = current.points[current.points.length - 1].v;
    const peak = Math.max(...current.points.map((p) => p.v));
    return {
      label,
      cycles,
      latest,
      peak,
      spanFrom: mapped[0].t,
      spanTo: mapped[mapped.length - 1].t,
    };
  }

  const series = $derived(
    [
      capSeries(m.usage_limits_window_5h(), history.caps.session5h),
      capSeries(m.usage_limits_window_week(), history.caps.week),
      creditSeries(history.credit),
    ].filter((s): s is Series => s !== null),
  );

  const allEmpty = $derived(series.length === 0);
</script>

<div class="history-panel panel">
  {#if allEmpty}
    <p class="empty">{m.usage_history_empty()}</p>
  {:else}
    {#each series as s (s.label)}
      <section class="series">
        <div class="series-head">
          <span class="series-label">{s.label}</span>
          <span class="series-stat"
            >{m.usage_history_latest({ pct: Math.round(s.latest) })} ·
            {m.usage_history_peak({ pct: Math.round(s.peak) })}</span
          >
        </div>

        <div class="cycles" aria-hidden="true">
          {#each s.cycles as cycle, i (cycle.resetAt ?? `open-${i}`)}
            {@const isCurrent = i === s.cycles.length - 1}
            <Sparkline
              points={cycle.points}
              color={isCurrent ? gaugeColor(s.latest) : "var(--color-faint)"}
              ariaLabel={s.label}
              liveLast={isCurrent}
            />
          {/each}
        </div>

        <span class="span"
          >{m.usage_history_span({
            from: formatReset(s.spanFrom, nowMs),
            to: formatReset(s.spanTo, nowMs),
          })}</span
        >
      </section>
    {/each}
  {/if}
</div>

<style>
  .panel {
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 14px 16px;
  }

  .history-panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .empty {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    margin: 0;
  }

  .series {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .series-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .series-label {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }

  .series-stat {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }

  .cycles {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .span {
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
</style>
