<script lang="ts">
  import type { HeavySlotSnapshot } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { formatBytes, psiGauge, ramGauge, secondsLeft, slotStatus } from "./heavy-slot";

  // The host popover's first line per slot: can a heavy check start here now — green free, amber
  // every slot taken, red the brake holds starts back — and, when it can't, why and until when.
  let { heavySlot, nowMs }: { heavySlot: HeavySlotSnapshot; nowMs: number } = $props();

  const status = $derived(slotStatus(heavySlot, nowMs));
  const glyph = { free: "✓", full: "◔", brake: "⊘" };
  const title = $derived(
    status.kind === "free"
      ? m.heavyslot_status_free()
      : status.kind === "full"
        ? m.heavyslot_status_full()
        : m.heavyslot_status_blocked(),
  );
  /** Why the status is what it is, when the title alone doesn't say. */
  const note = $derived.by(() => {
    if (status.kind === "full")
      return status.waiting > 0
        ? m.heavyslot_status_full_waiting({ n: status.waiting })
        : m.heavyslot_status_full_next();
    if (status.kind !== "brake") return null;
    if (status.cause === "hold") return m.heavyslot_status_hold();
    const ram = ramGauge(heavySlot);
    if (status.cause === "ram" && ram?.minBytes != null)
      return m.heavyslot_status_ram({
        free: formatBytes(ram.freeBytes),
        min: formatBytes(ram.minBytes),
      });
    const psi = psiGauge(heavySlot);
    if (status.cause === "pressure" && psi)
      return m.heavyslot_status_pressure({ pct: psi.value, limit: psi.limit });
    return null;
  });
  const left = $derived(
    status.kind === "brake" && status.leftMs != null ? secondsLeft(status.leftMs) : null,
  );
  /** How far calm readings are through the brake's hold, in whole seconds. */
  const hold = $derived.by(() => {
    if (status.kind !== "brake" || left == null || !status.holdMs) return null;
    const total = Math.round(status.holdMs / 1000);
    return { done: Math.min(total, Math.max(0, total - left)), total };
  });
</script>

<div class="hp-status hp-status-{status.kind}">
  <p class="hp-status-head">
    <span class="hp-status-glyph" aria-hidden="true">{glyph[status.kind]}</span>
    <span class="hp-status-title">{title}</span>
    {#if left != null}
      <span class="hp-status-left">{m.heavyslot_status_left({ n: left })}</span>
    {/if}
  </p>
  {#if note}<p>{note}</p>{/if}
  {#if hold}
    <p class="hp-hold">
      <span class="hp-hold-track" aria-hidden="true"
        ><span class="hp-hold-fill" style:width="{(hold.done / hold.total) * 100}%"></span></span
      >
      <span class="hp-hold-label">{m.heavyslot_hold_progress(hold)}</span>
    </p>
  {/if}
</div>

<style>
  .hp-status {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
    padding: 8px 10px;
    border: 1px solid;
    border-radius: var(--radius-chip);
  }
  .hp-status p {
    margin: 0;
    line-height: 1.45;
  }
  .hp-status-free {
    border-color: color-mix(in srgb, var(--color-green) 45%, transparent);
    background: color-mix(in srgb, var(--color-green) 7%, transparent);
  }
  .hp-status-full {
    border-color: color-mix(in srgb, var(--color-amber) 45%, transparent);
    background: color-mix(in srgb, var(--color-amber) 7%, transparent);
  }
  .hp-status-brake {
    border-color: color-mix(in srgb, var(--color-red) 50%, transparent);
    background: color-mix(in srgb, var(--color-red) 8%, transparent);
  }
  .hp-status-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hp-status-title {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .hp-status-free .hp-status-glyph {
    color: var(--color-green);
  }
  .hp-status-full .hp-status-glyph {
    color: var(--color-amber);
  }
  .hp-status-brake .hp-status-glyph,
  .hp-status-left {
    /* Red lifted toward the ink so small type keeps its contrast on the panel. */
    color: color-mix(in srgb, var(--color-red) 75%, var(--color-ink-bright));
  }
  .hp-status-left {
    margin-left: auto;
    font-family: var(--font-mono);
    white-space: nowrap;
  }
  .hp-hold {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hp-hold-track {
    position: relative;
    flex: 1 1 auto;
    height: 4px;
    background: var(--color-line);
  }
  .hp-hold-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: var(--color-ink);
  }
  .hp-hold-label {
    font-family: var(--font-mono);
    color: var(--color-muted);
    white-space: nowrap;
  }
</style>
