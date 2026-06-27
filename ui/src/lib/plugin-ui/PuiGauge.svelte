<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { toneColor } from "./tones";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});

  const rawValue = $derived.by(() => {
    const v = Number(p.value ?? 0);
    return Number.isFinite(v) ? v : 0;
  });
  const max = $derived.by(() => {
    const m = Number(p.max ?? 100);
    return Math.max(1, Number.isFinite(m) ? m : 100);
  });
  const label = $derived(p.label != null ? String(p.label) : null);
  const caption = $derived(p.caption != null ? String(p.caption) : null);

  const ratio = $derived(Math.min(1, Math.max(0, rawValue / max)));
  const pct = $derived(Math.round(ratio * 100));
  const arcColor = $derived(toneColor(p.tone));

  const R = 38;
  const CIRCUMFERENCE = 2 * Math.PI * R;
  const dashOffset = $derived(CIRCUMFERENCE * (1 - ratio));
  const ariaLabel = $derived(label ?? caption ?? undefined);
</script>

<div class="pui-gauge">
  {#if label != null}
    <span class="pui-gauge-label">{label}</span>
  {/if}
  <svg
    class="pui-gauge-svg"
    viewBox="0 0 100 100"
    role="meter"
    aria-valuenow={rawValue}
    aria-valuemin={0}
    aria-valuemax={max}
    aria-label={ariaLabel}
  >
    {#if ariaLabel != null}
      <title>{ariaLabel}</title>
    {/if}
    <circle cx="50" cy="50" r={R} fill="none" stroke="var(--color-inset)" stroke-width="8" />
    <circle
      cx="50"
      cy="50"
      r={R}
      fill="none"
      stroke={arcColor}
      stroke-width="8"
      stroke-linecap="round"
      stroke-dasharray={CIRCUMFERENCE}
      stroke-dashoffset={dashOffset}
      transform="rotate(-90 50 50)"
    />
    <text
      x="50"
      y="42"
      text-anchor="middle"
      dominant-baseline="middle"
      font-size="18"
      font-weight="600"
      style="font-variant-numeric: tabular-nums; fill: {arcColor};">{pct}%</text
    >
    <text
      x="50"
      y="58"
      text-anchor="middle"
      dominant-baseline="middle"
      font-size="9"
      style="fill: var(--color-muted);">{rawValue}/{max}</text
    >
  </svg>
  {#if caption != null}
    <span class="pui-gauge-caption">{caption}</span>
  {/if}
</div>

<style>
  .pui-gauge {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .pui-gauge-label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-weight: 600;
  }
  .pui-gauge-svg {
    width: 100%;
    max-width: 120px;
    height: auto;
  }
  .pui-gauge-caption {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
</style>
