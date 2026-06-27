<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { toneColor } from "./tones";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const caption = $derived(p.caption != null ? String(p.caption) : null);
  const kind = $derived(p.kind === "area" ? "area" : "line");

  interface SeriesEntry {
    label: string;
    tone: unknown;
    points: number[];
  }

  const series = $derived.by((): SeriesEntry[] => {
    if (!Array.isArray(p.series)) return [];
    return (p.series as unknown[]).map((e): SeriesEntry => {
      const entry = e != null && typeof e === "object" ? (e as Record<string, unknown>) : {};
      return {
        label: String(entry.label ?? ""),
        tone: entry.tone,
        points: Array.isArray(entry.points)
          ? (entry.points as unknown[]).map(Number).filter(Number.isFinite)
          : [],
      };
    });
  });

  const hasData = $derived(series.some((s) => s.points.length > 0));

  const yMax = $derived.by(() => {
    const raw = Number(p.yMax);
    if (Number.isFinite(raw) && raw > 0) return raw;
    const allPoints = series.flatMap((s) => s.points);
    return allPoints.length > 0 ? Math.max(1, ...allPoints) : 1;
  });

  const W = 100;
  const H = 40;
  const PAD = 2;

  function polylinePoints(points: number[], yMaxVal: number): string {
    const n = points.length;
    if (n === 0) return "";
    if (n === 1) return `0.00,${(H / 2).toFixed(2)} ${W}.00,${(H / 2).toFixed(2)}`;
    return points
      .map((v, i) => {
        const x = (i / (n - 1)) * W;
        const y = PAD + (1 - v / yMaxVal) * (H - PAD * 2);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  function polygonPoints(points: number[], yMaxVal: number): string {
    const n = points.length;
    if (n === 0) return "";
    const line = polylinePoints(points, yMaxVal);
    if (n === 1) {
      return `0.00,${H} ${line} ${W}.00,${H}`;
    }
    return `0.00,${H} ${line} ${W.toFixed(2)},${H}`;
  }

  const ariaLabel = $derived.by((): string => {
    const labels = series
      .map((s) => s.label)
      .filter(Boolean)
      .join(", ");
    if (labels) return labels;
    if (caption) return caption;
    return m.plugin_ui_timeseries_label();
  });

  const labelledSeries = $derived(series.filter((s) => s.label.length > 0));
</script>

{#if !hasData}
  <p class="pui-timeseries-empty">{m.plugin_ui_timeseries_empty()}</p>
{:else}
  <div class="pui-timeseries">
    <svg
      class="pui-timeseries-svg"
      viewBox="0 0 {W} {H}"
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <title>{ariaLabel}</title>
      {#each series as s, i (i)}
        {#if s.points.length > 0}
          {#if kind === "area"}
            <polygon
              points={polygonPoints(s.points, yMax)}
              fill={toneColor(s.tone)}
              fill-opacity="0.15"
              stroke="none"
            />
          {/if}
          <polyline
            points={polylinePoints(s.points, yMax)}
            fill="none"
            stroke={toneColor(s.tone)}
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        {/if}
      {/each}
    </svg>
    {#if labelledSeries.length > 0}
      <div class="pui-timeseries-legend">
        {#each labelledSeries as s, i (i)}
          <span class="pui-timeseries-legend-item">
            <span class="pui-timeseries-swatch" style:background={toneColor(s.tone)}></span>
            <span class="pui-timeseries-legend-label">{s.label}</span>
          </span>
        {/each}
      </div>
    {/if}
    {#if caption != null}
      <span class="pui-timeseries-caption">{caption}</span>
    {/if}
  </div>
{/if}

<style>
  .pui-timeseries-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .pui-timeseries {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pui-timeseries-svg {
    width: 100%;
    height: 40px;
    display: block;
  }
  .pui-timeseries-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .pui-timeseries-legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .pui-timeseries-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .pui-timeseries-legend-label {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .pui-timeseries-caption {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
</style>
