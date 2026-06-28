<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { toneColor } from "./tones";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});

  const label = $derived(p.label != null && String(p.label).trim() !== "" ? String(p.label) : null);
  const caption = $derived(
    p.caption != null && String(p.caption).trim() !== "" ? String(p.caption) : null,
  );
  const lineColor = $derived(toneColor(p.tone));

  const points = $derived(
    Array.isArray(p.points) ? (p.points as unknown[]).map(Number).filter(Number.isFinite) : [],
  );

  const W = 100;
  const H = 28;
  const PAD = 2;

  const polylinePoints = $derived.by(() => {
    const n = points.length;
    if (n === 0) return "";
    if (n === 1) return `0,${H / 2} ${W},${H / 2}`;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min;
    return points
      .map((v, i) => {
        const x = (i / (n - 1)) * W;
        const y = range === 0 ? H / 2 : PAD + (1 - (v - min) / range) * (H - PAD * 2);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  });

  const ariaLabel = $derived(label ?? caption ?? m.plugin_ui_sparkline_label());
</script>

{#if points.length === 0}
  <p class="pui-spark-empty">{m.plugin_ui_sparkline_empty()}</p>
{:else}
  <div class="pui-spark">
    {#if label != null}
      <span class="pui-spark-label">{label}</span>
    {/if}
    <svg
      class="pui-spark-svg"
      viewBox="0 0 {W} {H}"
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <title>{ariaLabel}</title>
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={lineColor}
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    {#if caption != null}
      <span class="pui-spark-caption">{caption}</span>
    {/if}
  </div>
{/if}

<style>
  .pui-spark-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }
  .pui-spark {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pui-spark-label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-weight: 600;
  }
  .pui-spark-svg {
    width: 100%;
    height: 28px;
    display: block;
  }
  .pui-spark-caption {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
</style>
