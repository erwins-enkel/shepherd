<script lang="ts">
  interface Point {
    t: number; // ms epoch, time-sorted ASC
    v: number; // plotted value (e.g. pct 0–100)
  }

  let {
    points,
    color,
    width = 120,
    height = 28,
    ariaLabel,
    liveLast = false,
    domain,
  }: {
    points: Point[];
    color: string;
    width?: number;
    height?: number;
    ariaLabel: string;
    liveLast?: boolean;
    // Fixed y-axis range. Pass {min:0,max:100} for percentage series so cross-cycle
    // magnitude is comparable (and the inline curve shares the gauge meter's scale).
    // Omitted → auto-scale to the series' own min/max.
    domain?: { min: number; max: number };
  } = $props();

  // Padding so markers at extremes don't get clipped
  const PAD = 4;

  type Coord = { x: number; y: number };

  function mapCoords(pts: Point[]): Coord[] {
    if (pts.length === 0) return [];

    const tMin = pts[0].t;
    const tMax = pts[pts.length - 1].t;
    const vMin = domain ? domain.min : Math.min(...pts.map((p) => p.v));
    const vMax = domain ? domain.max : Math.max(...pts.map((p) => p.v));

    const tRange = tMax - tMin || 1;
    const vRange = vMax - vMin || 1;

    const innerW = width - PAD * 2;
    const innerH = height - PAD * 2;
    // Clamp the normalized value into [0,1] so an out-of-domain point (e.g. credit
    // spend over budget vs a fixed 0–100) renders at the edge, never outside the svg.
    const norm = (v: number) => Math.max(0, Math.min(1, (v - vMin) / vRange));

    return pts.map((p) => ({
      x: PAD + ((p.t - tMin) / tRange) * innerW,
      // SVG y axis is inverted: low v → high y
      y: PAD + (1 - norm(p.v)) * innerH,
    }));
  }

  const coords = $derived(mapCoords(points));

  const polylinePoints = $derived(
    coords.length >= 2 ? coords.map((c) => `${c.x},${c.y}`).join(" ") : "",
  );

  // Marker radius: regular scrape markers vs the distinct live-last marker
  const R_SCRAPE = 2;
  const R_LIVE = 3.5;
</script>

{#if points.length === 0}
  <!-- Empty: render a fixed-size placeholder so layout stays stable -->
  <svg
    role="img"
    aria-label={ariaLabel}
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    style="display:block;overflow:visible"
  ></svg>
{:else if points.length === 1}
  <!-- Single point: just a dot, no polyline -->
  <svg
    role="img"
    aria-label={ariaLabel}
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    style="display:block;overflow:visible"
  >
    <circle cx={width / 2} cy={height / 2} r={R_LIVE} fill={color} stroke="none" />
  </svg>
{:else}
  <svg
    role="img"
    aria-label={ariaLabel}
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    style="display:block;overflow:visible"
  >
    <!-- Series line -->
    <polyline
      points={polylinePoints}
      fill="none"
      stroke={color}
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />

    <!-- Scrape-point markers (all except the last when liveLast is set) -->
    {#each coords as c, i (i)}
      {@const isLast = i === coords.length - 1}
      {#if !isLast}
        <circle cx={c.x} cy={c.y} r={R_SCRAPE} fill={color} opacity="0.65" />
      {:else if liveLast}
        <!-- Distinct terminal "now" point: filled, larger, full opacity -->
        <circle
          cx={c.x}
          cy={c.y}
          r={R_LIVE}
          fill={color}
          stroke="var(--color-panel)"
          stroke-width="1"
        />
      {:else}
        <!-- Last point without liveLast: same as scrape marker -->
        <circle cx={c.x} cy={c.y} r={R_SCRAPE} fill={color} opacity="0.65" />
      {/if}
    {/each}
  </svg>
{/if}
