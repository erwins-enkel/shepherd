<script lang="ts">
  import type { HeavySlotSnapshot, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { chipModel, slotEnabled } from "./heavy-slot";
  import HostPopover from "./HostPopover.svelte";

  let {
    heavySlot = null,
    sessions = [],
    nowMs,
    compact = false,
    onrelease,
    onsettings,
  }: {
    heavySlot?: HeavySlotSnapshot | null;
    sessions?: Pick<Session, "id" | "name">[];
    nowMs: number;
    compact?: boolean;
    onrelease: (sessionId: string) => Promise<void>;
    onsettings?: () => void;
  } = $props();

  let open = $state(false);
  let wrap = $state<HTMLDivElement | null>(null);
  let btn = $state<HTMLButtonElement | null>(null);
  const model = $derived(slotEnabled(heavySlot) ? chipModel(heavySlot) : null);

  // The master switch turning off while the popover is open takes the popover with it.
  $effect(() => {
    if (!model) open = false;
  });

  function onDocPointer(e: PointerEvent) {
    if (open && wrap && !wrap.contains(e.target as Node)) open = false;
  }
  function onDocKey(e: KeyboardEvent) {
    if (open && e.key === "Escape") close();
  }
  function close() {
    open = false;
    btn?.focus();
  }
</script>

<svelte:document onpointerdown={onDocPointer} onkeydown={onDocKey} />

{#if model && heavySlot}
  <div class="hs-wrap" bind:this={wrap}>
    <button
      bind:this={btn}
      class="hs-chip"
      class:compact
      class:braking={model.braking}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={m.heavyslot_chip_aria({
        held: model.held,
        capacity: model.capacity,
        waiting: model.waiting,
      })}
      onclick={() => (open = !open)}
    >
      <span class="hs-glyph" aria-hidden="true">▤</span>
      {#if !compact}<span class="hs-lbl">{m.heavyslot_label()}</span>{/if}
      <span>■ {model.held}/{model.capacity}</span>
      {#if !compact || model.waiting > 0}<span class="hs-sep">│</span><span>◔ {model.waiting}</span
        >{/if}
      {#if !compact && model.ramPct != null}
        <span class="hs-sep">│</span><span class:hs-hot={model.braking}
          >{m.heavyslot_ram({ pct: model.ramPct })}</span
        >
      {/if}
    </button>
    {#if open}
      <HostPopover {heavySlot} {sessions} {nowMs} {onrelease} {onsettings} onClose={close} />
    {/if}
  </div>
{/if}

<style>
  .hs-wrap {
    position: relative;
  }
  .hs-chip {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: var(--topbar-ctl-h);
    padding: 0 8px;
    border: 1px solid var(--color-amber);
    border-radius: var(--radius-chip);
    background: transparent;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
  }
  .hs-chip:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  .hs-chip:focus-visible {
    outline: 1px solid var(--color-amber);
    outline-offset: 1px;
  }
  .hs-lbl {
    text-transform: uppercase;
  }
  .hs-sep {
    color: var(--color-muted);
  }
  /* Brake: type and border only (the quieter red). */
  .hs-chip.braking {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .hs-hot {
    color: var(--color-red);
  }
  .hs-chip.compact {
    letter-spacing: 0;
    padding: 0 8px;
  }
  @media (max-width: 768px), (pointer: coarse) {
    .hs-chip {
      min-height: 44px;
      min-width: 44px;
      justify-content: center;
    }
  }
</style>
