<script lang="ts">
  import type { PluginUINode } from "$lib/types";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const rawValue = $derived(Number(p.value ?? 0));
  const max = $derived(Math.max(1, Number(p.max ?? 100)));
  const label = $derived(p.label != null ? String(p.label) : null);
  const caption = $derived(p.caption != null ? String(p.caption) : null);

  // Clamp ratio to [0, 1]
  const ratio = $derived(Math.min(1, Math.max(0, rawValue / max)));
  const pct = $derived(Math.round(ratio * 100));

  type MeterTone = "neutral" | "ok" | "warn" | "error" | "info";
  const TONE_COLOR: Record<MeterTone, string> = {
    neutral: "var(--color-muted)",
    ok: "var(--color-green)",
    warn: "var(--status-warn)",
    error: "var(--color-red)",
    info: "var(--color-blue)",
  };

  const rawTone = $derived(p.tone as string | undefined);
  const barColor = $derived(
    rawTone && rawTone in TONE_COLOR ? TONE_COLOR[rawTone as MeterTone] : TONE_COLOR.neutral,
  );
</script>

<div class="pui-meter">
  {#if label}
    <div class="pui-meter-header">
      <span class="pui-meter-label">{label}</span>
      <span class="pui-meter-value" style:color={barColor}>{rawValue}/{max}</span>
    </div>
  {/if}
  <div
    class="pui-meter-track"
    role="meter"
    aria-valuenow={rawValue}
    aria-valuemin={0}
    aria-valuemax={max}
  >
    <div class="pui-meter-fill" style:width="{pct}%" style:background={barColor}></div>
  </div>
  {#if caption}
    <span class="pui-meter-caption">{caption}</span>
  {/if}
</div>

<style>
  .pui-meter {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pui-meter-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .pui-meter-label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-weight: 600;
  }
  .pui-meter-value {
    font-size: var(--fs-micro);
    font-variant-numeric: tabular-nums;
  }
  .pui-meter-track {
    height: 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }
  .pui-meter-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.2s ease;
  }
  .pui-meter-caption {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
</style>
