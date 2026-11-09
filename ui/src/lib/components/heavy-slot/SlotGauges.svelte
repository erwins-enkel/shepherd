<script lang="ts">
  import type { HeavySlotSnapshot } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import ZoneBar from "./ZoneBar.svelte";
  import { formatBytes, psiGauge, ramGauge, type Zones } from "./heavy-slot";

  // RAM and memory pressure against the brake, each a bar cut at the brake line with a ✓/✕ for
  // whether it holds the brake, then swap, CPU pressure and memory by origin.
  let { heavySlot }: { heavySlot: HeavySlotSnapshot } = $props();

  const p = $derived(heavySlot.pressure);
  const src = $derived(heavySlot.memoryBySource);
  const ram = $derived(ramGauge(heavySlot));
  const psi = $derived(psiGauge(heavySlot));
  /** The legend under the RAM bar: used, then free before the brake or how far use reaches past
   *  it, then the brake zone itself. */
  const legend = $derived.by(() => {
    if (!ram) return [];
    const rows: { zone: keyof Zones; text: string }[] = [
      { zone: "used", text: m.heavyslot_legend_used({ bytes: formatBytes(ram.usedBytes) }) },
    ];
    if (ram.short && ram.minBytes != null)
      rows.push({
        zone: "over",
        text: m.heavyslot_legend_over({ bytes: formatBytes(ram.minBytes - ram.freeBytes) }),
      });
    else if (ram.usableBytes != null)
      rows.push({
        zone: "free",
        text: m.heavyslot_legend_usable({ bytes: formatBytes(ram.usableBytes) }),
      });
    if (ram.minBytes != null)
      rows.push({
        zone: "reserve",
        text: m.heavyslot_legend_reserve({ bytes: formatBytes(ram.minBytes) }),
      });
    return rows;
  });
</script>

{#snippet mark(bad: boolean)}
  <span class="g-mark" class:g-bad={bad} aria-hidden="true">{bad ? "✕" : "✓"}</span>
{/snippet}

<section>
  <div class="g-head">
    {#if ram}{@render mark(ram.short)}{/if}
    <h3>{m.heavyslot_ram_row()}</h3>
    <span class="g-val" class:g-bad={ram?.short}
      >{ram ? m.heavyslot_ram_free({ bytes: formatBytes(ram.freeBytes) }) : "–"}</span
    >
    {#if ram}
      <span class="g-dim g-mono"
        >{m.heavyslot_of_total({ total: formatBytes(ram.totalBytes) })}</span
      >
    {/if}
  </div>
  {#if ram}
    <ZoneBar zones={ram.zones} />
    <p class="g-legend">
      {#each legend as row (row.zone)}<span><ZoneBar swatch={row.zone} />{row.text}</span>{/each}
    </p>
  {/if}
</section>

<section>
  <div class="g-head">
    {#if psi}{@render mark(psi.over)}{/if}
    <h3>{m.heavyslot_mem_psi()}</h3>
    <span class="g-val" class:g-bad={psi?.over}
      >{p.memFullAvg10 == null ? "–" : `${p.memFullAvg10} %`}</span
    >
    {#if psi}
      <span class="g-dim">{m.heavyslot_mem_psi_limit({ limit: psi.limit })}</span>
    {/if}
  </div>
  {#if psi}<ZoneBar zones={psi.zones} />{/if}
  <dl class="g-kv">
    <dt>{m.heavyslot_swap_row()}</dt>
    <dd>{formatBytes(p.swapUsedBytes)} / {formatBytes(p.swapTotalBytes)}</dd>
    <dt>{m.heavyslot_cpu_psi()}</dt>
    <dd>{p.cpuSomeAvg10 == null ? "–" : `${p.cpuSomeAvg10} %`}</dd>
  </dl>
</section>

<section>
  <h3>{m.heavyslot_source()}</h3>
  <dl class="g-kv">
    <dt>{m.heavyslot_source_agents()}</dt>
    <dd>{formatBytes(src.agentsBytes)}</dd>
    <dt>{m.heavyslot_source_foreign()}</dt>
    <dd>{formatBytes(src.foreignBytes)}</dd>
    {#each src.foreignTop as f (f.name)}
      <dt class="g-dim g-mono">{f.name}</dt>
      <dd class="g-dim">{formatBytes(f.bytes)}</dd>
    {/each}
  </dl>
</section>

<style>
  /* Same micro caps as the other sections' headings (SlotSections `h3`). */
  h3 {
    margin: 10px 0 4px;
    font-size: var(--fs-micro);
    font-weight: 400;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* Heading with its readout on one line: the value pushed right, the total after it. */
  .g-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 10px 0 4px;
  }
  .g-head h3 {
    margin: 0;
  }
  .g-val {
    margin-left: auto;
    font-family: var(--font-mono);
    font-weight: 500;
    color: var(--color-green);
  }
  .g-mark {
    color: var(--color-green);
  }
  .g-bad,
  .g-val.g-bad {
    /* Red lifted toward the ink so small type keeps its contrast on the panel. */
    color: color-mix(in srgb, var(--color-red) 75%, var(--color-ink-bright));
  }
  .g-dim {
    color: var(--color-muted);
  }
  .g-mono {
    font-family: var(--font-mono);
  }
  .g-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
    margin: 0 0 2px;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .g-kv {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 3px 12px;
    margin: 0;
  }
  .g-kv dd {
    margin: 0;
    font-family: var(--font-mono);
  }
</style>
