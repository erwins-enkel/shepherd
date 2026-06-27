<script lang="ts">
  import type { PluginUINode } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { toneColor } from "./tones";

  let { node }: { node: PluginUINode } = $props();

  const p = $derived(node.props ?? {});
  const orientation = $derived(p.orientation === "vertical" ? "vertical" : "horizontal");

  interface BarEntry {
    label: string;
    value: number;
    tone: unknown;
    pct: number;
    color: string;
  }

  const rawBars = $derived.by(() => {
    if (!Array.isArray(p.bars)) return [];
    return (p.bars as unknown[]).map((b) => {
      const bar = b != null && typeof b === "object" ? (b as Record<string, unknown>) : {};
      const v = Number(bar.value);
      return {
        label: String(bar.label ?? ""),
        value: Number.isFinite(v) ? v : 0,
        tone: bar.tone,
      };
    });
  });

  const max = $derived.by(() => {
    const raw = Number(p.max);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return Math.max(1, ...rawBars.map((b) => b.value));
  });

  const bars = $derived<BarEntry[]>(
    rawBars.map((b) => ({
      ...b,
      pct: Math.round(Math.min(1, Math.max(0, b.value / max)) * 100),
      color: toneColor(b.tone),
    })),
  );
</script>

{#if bars.length === 0}
  <p class="pui-barchart-empty">{m.plugin_ui_barchart_empty()}</p>
{:else if orientation === "horizontal"}
  <div class="pui-barchart pui-barchart--horiz" role="list">
    {#each bars as bar, i (i)}
      <div class="pui-barchart-row" role="listitem" aria-label="{bar.label}: {bar.value}">
        <span class="pui-barchart-row-label">{bar.label}</span>
        <div class="pui-barchart-track">
          <div
            class="pui-barchart-fill"
            style:width="{bar.pct}%"
            style:background={bar.color}
          ></div>
        </div>
        <span class="pui-barchart-row-value">{bar.value}</span>
      </div>
    {/each}
  </div>
{:else}
  <div class="pui-barchart pui-barchart--vert" role="list">
    <div class="pui-barchart-cols">
      {#each bars as bar, i (i)}
        <div class="pui-barchart-vcol" role="listitem" aria-label="{bar.label}: {bar.value}">
          <div class="pui-barchart-vcol-track">
            <div
              class="pui-barchart-bar pui-barchart-bar--vert"
              style:height="{bar.pct}%"
              style:background={bar.color}
            ></div>
          </div>
          <span class="pui-barchart-vcol-label">{bar.label}</span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .pui-barchart-empty {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    margin: 0;
  }

  /* HORIZONTAL */
  .pui-barchart--horiz {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pui-barchart-row {
    display: grid;
    grid-template-columns: 6rem 1fr auto;
    align-items: center;
    gap: 8px;
  }
  .pui-barchart-row-label {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pui-barchart-track {
    height: 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }
  .pui-barchart-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.2s ease;
  }
  .pui-barchart-row-value {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* VERTICAL */
  .pui-barchart--vert {
    width: 100%;
  }
  .pui-barchart-cols {
    display: flex;
    gap: 4px;
    height: 80px;
  }
  .pui-barchart-vcol {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    gap: 4px;
    height: 100%;
  }
  .pui-barchart-vcol-track {
    flex: 1;
    width: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 3px;
    overflow: hidden;
  }
  .pui-barchart-bar--vert {
    width: 100%;
    border-radius: 2px 2px 0 0;
    transition: height 0.2s ease;
  }
  .pui-barchart-vcol-label {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    text-align: center;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 100%;
  }
</style>
