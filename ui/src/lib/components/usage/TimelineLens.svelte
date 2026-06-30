<script lang="ts">
  import type { UsageTimeline } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import InfoTip from "$lib/components/InfoTip.svelte";
  import { formatUnits } from "./format";

  const { timeline }: { timeline: UsageTimeline } = $props();

  // Grid is capped so the "all" range can't grow a 365-row scroll that defeats the point
  // (spotting hot/cold periods). Older days still count toward peak/total — see the note line.
  const MAX_HEATMAP_DAYS = 35;
  const HOUR_TICKS = [0, 6, 12, 18, 23];

  const HOURS = Array.from({ length: 24 }, (_unused, i) => i);

  /** ms-epoch of the local midnight starting `ts`'s day. Plain Date — pure local math, not state. */
  function startOfLocalDay(ts: number): number {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Local midnight of the day before `dayStart` (DST-safe — decrements the calendar date). */
  function prevLocalDay(dayStart: number): number {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const d = new Date(dayStart);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // Locale-aware row label (weekday + date) — formatted, not a hardcoded string.
  const dayFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  interface Row {
    dayStart: number;
    label: string;
    cells: number[]; // 24 hour buckets of weighted units
  }

  const model = $derived.by(() => {
    const empty = { rows: [] as Row[], hiddenDays: 0 };
    if (timeline.hours.length === 0) return empty;

    // Fold hours into local day → hour-of-day units (DST collisions sum harmlessly).
    // Plain Map — pure computation inside $derived, not reactive UI state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const byDay = new Map<number, number[]>();
    for (const h of timeline.hours) {
      const dayStart = startOfLocalDay(h.hourStart);
      const hour = new Date(h.hourStart).getHours();
      let cells = byDay.get(dayStart);
      if (!cells) {
        cells = new Array(24).fill(0) as number[];
        byDay.set(dayStart, cells);
      }
      cells[hour] += h.units;
    }

    const dataDays = [...byDay.keys()].sort((a, b) => a - b);
    const earliest = dataDays[0]!;
    const latest = dataDays[dataDays.length - 1]!;

    // Contiguous calendar days, newest first, capped at MAX_HEATMAP_DAYS, never past earliest.
    const rows: Row[] = [];
    let day = latest;
    for (let i = 0; i < MAX_HEATMAP_DAYS; i++) {
      rows.push({
        dayStart: day,
        label: dayFmt.format(new Date(day)),
        cells: byDay.get(day) ?? (new Array(24).fill(0) as number[]),
      });
      if (day <= earliest) break;
      day = prevLocalDay(day);
    }

    const shownEarliest = rows[rows.length - 1]!.dayStart;
    const hiddenDays = dataDays.filter((d) => d < shownEarliest).length;
    return { rows, hiddenDays };
  });

  const peak = $derived(timeline.peakHourUnits > 0 ? timeline.peakHourUnits : 1);

  /** Color-mix percentage for a cell (0 ⇒ inset; nonzero floored to 8% so it stays visible). */
  function intensity(units: number): number {
    if (units <= 0) return 0;
    return Math.min(100, 8 + 92 * (units / peak));
  }

  function hourLabel(h: number): string {
    return `${String(h).padStart(2, "0")}:00`;
  }
</script>

<div class="timeline-lens">
  <div class="tl-header">
    <h2 class="tl-heading">{m.usage_timeline_heading()}</h2>
    <span class="tl-units-label">
      <span>{m.usage_units_label()}</span>
      <InfoTip
        text={m.gloss_weighted_units_def()}
        label={m.newtask_info_aria({ topic: m.gloss_weighted_units_term() })}
      />
    </span>
    <span class="tl-stats">
      {m.usage_timeline_peak({ units: formatUnits(timeline.peakHourUnits) })} ·
      {m.usage_timeline_total({ units: formatUnits(timeline.totalUnits) })}
    </span>
  </div>

  {#if model.rows.length === 0}
    <p class="tl-empty">{m.usage_timeline_empty()}</p>
  {:else}
    <div class="tl-grid-wrap">
      <!-- Column ticks (hour-of-day) -->
      <div class="tl-axis" aria-hidden="true">
        <span class="tl-row-label"></span>
        <div class="tl-ticks">
          {#each HOURS as h (h)}
            <span class="tl-tick">{HOUR_TICKS.includes(h) ? hourLabel(h) : ""}</span>
          {/each}
        </div>
      </div>

      <!-- Day rows -->
      {#each model.rows as row (row.dayStart)}
        <div class="tl-row">
          <span class="tl-row-label">{row.label}</span>
          <div class="tl-cells">
            {#each row.cells as units, h (h)}
              {@const label = m.usage_timeline_cell_aria({
                day: row.label,
                hour: hourLabel(h),
                units: formatUnits(units),
              })}
              <span
                class="tl-cell"
                style="--i: {intensity(units)}"
                role="img"
                aria-label={label}
                title={label}
              ></span>
            {/each}
          </div>
        </div>
      {/each}
    </div>

    {#if model.hiddenDays > 0}
      <p class="tl-more">{m.usage_timeline_more_days({ count: model.hiddenDays })}</p>
    {/if}

    <!-- Legend -->
    <div class="tl-legend" aria-hidden="true">
      <span class="tl-legend-label">{m.usage_timeline_legend_low()}</span>
      {#each [0, 25, 50, 75, 100] as p (p)}
        <span class="tl-swatch" style="--i: {p === 0 ? 0 : 8 + 0.92 * p}"></span>
      {/each}
      <span class="tl-legend-label">{m.usage_timeline_legend_high()}</span>
    </div>
  {/if}
</div>

<style>
  .timeline-lens {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .tl-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .tl-heading {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--color-ink-bright);
    margin: 0;
  }

  .tl-units-label {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .tl-stats {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }

  .tl-grid-wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tl-axis,
  .tl-row {
    display: grid;
    grid-template-columns: 3.5rem 1fr;
    align-items: center;
    gap: 0.5rem;
  }

  .tl-row-label {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .tl-ticks,
  .tl-cells {
    display: grid;
    grid-template-columns: repeat(24, 1fr);
    gap: 2px;
  }

  .tl-tick {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    text-align: left;
    overflow: visible;
    white-space: nowrap;
  }

  .tl-cell {
    aspect-ratio: 1;
    min-height: 10px;
    border-radius: 2px;
    background: color-mix(in oklab, var(--color-amber) calc(var(--i) * 1%), var(--color-inset));
  }

  .tl-more {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    font-style: italic;
    margin: 0;
  }

  .tl-empty {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    margin: 24px 0 8px;
  }

  .tl-legend {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 0.25rem;
  }

  .tl-legend-label {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }

  .tl-swatch {
    width: 14px;
    height: 14px;
    border-radius: 2px;
    background: color-mix(in oklab, var(--color-amber) calc(var(--i) * 1%), var(--color-inset));
  }

  @media (max-width: 480px) {
    .tl-axis,
    .tl-row {
      grid-template-columns: 2.75rem 1fr;
      gap: 0.3rem;
    }
    .tl-cell {
      min-height: 8px;
    }
  }
</style>
