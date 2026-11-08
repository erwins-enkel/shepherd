<script lang="ts">
  import type { HeavySlotSnapshot, RemoteInstance, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import {
    activeLanes,
    chipModel,
    formatBytes,
    hasMachineLanes,
    laneTotals,
    pipKinds,
    popoverLeft,
    ramGauge,
    secondsLeft,
    slotActive,
    slotEnabled,
    slotLanes,
    slotStatus,
    statusShort,
    type SlotLane,
  } from "./heavy-slot";
  import HostPopover from "./HostPopover.svelte";
  import SlotPips from "./SlotPips.svelte";
  import ZoneBar from "./ZoneBar.svelte";

  let {
    heavySlot = null,
    machines = [],
    sessions = [],
    nowMs,
    compact = false,
    onrelease,
    onsettings,
  }: {
    heavySlot?: HeavySlotSnapshot | null;
    /** Connected machines: each one's reported slot gets its own segment while it has work. */
    machines?: readonly RemoteInstance[];
    /** Local and mirrored sessions, to name holders and waiters on every machine. */
    sessions?: Pick<Session, "id" | "name">[];
    nowMs: number;
    compact?: boolean;
    onrelease: (sessionId: string) => Promise<void>;
    onsettings?: () => void;
  } = $props();

  let open = $state(false);
  let wrap = $state<HTMLDivElement | null>(null);
  let btn = $state<HTMLButtonElement | null>(null);
  let pop = $state<HTMLDivElement | null>(null);
  let left = $state<number | null>(null);
  const lanes = $derived(slotLanes(heavySlot, machines));
  const byMachine = $derived(hasMachineLanes(lanes));
  // Several machines: the totals decide the chip's look, the lanes with work get a segment each.
  const model = $derived(
    byMachine ? laneTotals(lanes) : slotEnabled(heavySlot) ? chipModel(heavySlot) : null,
  );
  const segments = $derived(byMachine ? activeLanes(lanes) : []);
  const idle = $derived(byMachine ? segments.length === 0 : !slotActive(heavySlot));
  // One machine: what can start now, and how much RAM is left before the brake.
  const status = $derived(slotEnabled(heavySlot) ? slotStatus(heavySlot, nowMs) : null);
  const ram = $derived(slotEnabled(heavySlot) ? ramGauge(heavySlot) : null);
  /** "18 s" until the brake lets go, while calm readings run out its hold; null otherwise. */
  const holdText = (s: HeavySlotSnapshot) => {
    const st = slotStatus(s, nowMs);
    return st.kind === "brake" && st.leftMs != null
      ? m.heavyslot_seconds({ n: secondsLeft(st.leftMs) })
      : null;
  };
  /** One machine's status after its pips: in full on the wide chip, only a countdown compact. */
  const statusText = $derived(
    !status || !heavySlot ? null : compact ? holdText(heavySlot) : statusShort(status),
  );
  /** What a machine's segment adds after its pips: the brake's countdown, else its free RAM while
   *  the brake holds. */
  const laneExtra = (s: HeavySlotSnapshot) => {
    const hold = holdText(s);
    if (hold) return hold;
    const r = s.brake.active ? ramGauge(s) : null;
    return r ? `· ${m.heavyslot_ram_free({ bytes: formatBytes(r.freeBytes) })}` : null;
  };
  const machineName = (l: SlotLane) => l.name ?? m.herd_machine_this();
  const ariaLabel = $derived.by(() => {
    if (!model) return "";
    if (!byMachine)
      return m.heavyslot_chip_aria_status({
        status: status ? statusShort(status) : "",
        held: model.held,
        capacity: model.capacity,
        waiting: model.waiting,
      });
    const parts = lanes.map((l) =>
      l.stale
        ? m.heavyslot_chip_aria_lane_offline({ machine: machineName(l) })
        : m.heavyslot_chip_aria_lane({
            machine: machineName(l),
            held: l.snapshot.holders.length,
            capacity: l.snapshot.capacity,
            waiting: l.snapshot.waiters.length,
          }),
    );
    return m.heavyslot_chip_aria_machines({ lanes: parts.join("; ") });
  });

  // The master switch turning off while the popover is open takes the popover with it.
  $effect(() => {
    if (!model) open = false;
  });

  // Drop the popover under the chip rather than at the bar's right edge, clamped inside the bar.
  function place() {
    const box = pop?.offsetParent;
    if (!btn || !pop || !box) return;
    // `left` is measured from the box's padding edge, so leave its border out.
    const boxLeft = box.getBoundingClientRect().left + box.clientLeft;
    left = popoverLeft(btn.getBoundingClientRect().left, pop.offsetWidth, boxLeft, box.clientWidth);
  }
  $effect(() => {
    if (open && pop) place();
    else left = null;
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

{#snippet pips(s: HeavySlotSnapshot)}
  {@const kinds = pipKinds(s)}
  {#if kinds}<SlotPips {kinds} />{:else}<span>■ {s.holders.length}/{s.capacity}</span>{/if}
{/snippet}

<svelte:document onpointerdown={onDocPointer} onkeydown={onDocKey} />
<svelte:window onresize={() => open && place()} />

{#if model}
  <div class="hs-wrap" bind:this={wrap}>
    <button
      bind:this={btn}
      class="hs-chip"
      class:compact
      class:idle
      class:braking={model.braking}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={ariaLabel}
      onclick={() => (open = !open)}
    >
      <span class="hs-glyph" aria-hidden="true">▤</span>
      {#if byMachine}
        {#if !compact}<span class="hs-lbl">{m.heavyslot_label_machines()}</span>{/if}
        {#each segments as l, i (l.instanceId ?? "own")}
          {@const c = chipModel(l.snapshot)}
          {#if i > 0}<span class="hs-sep">│</span>{/if}
          <span class="hs-seg" class:hs-off={l.stale} class:hs-hot={!l.stale && c.braking}>
            <span class="hs-dot" class:hs-own={!l.color} style:background={l.color}></span>
            {#if l.stale}
              {m.heavyslot_offline()}
            {:else}
              {@const extra = laneExtra(l.snapshot)}
              {@render pips(l.snapshot)}
              {#if c.waiting > 0}<span>◔ {c.waiting}</span>{/if}
              {#if extra}<span>{extra}</span>{/if}
            {/if}
          </span>
        {:else}
          <span class="hs-ok"
            >{model.free > 0 ? m.heavyslot_free({ n: model.free }) : m.heavyslot_full()}</span
          >
        {/each}
      {:else if heavySlot && status}
        {#if !compact}<span class="hs-lbl">{m.heavyslot_label()}</span>{/if}
        {@render pips(heavySlot)}
        {#if statusText}<span class:hs-ok={status.kind === "free"}>{statusText}</span>{/if}
        {#if model.waiting > 0}<span class="hs-sep">│</span><span>◔ {model.waiting}</span>{/if}
        {#if !compact && ram}
          <span class="hs-sep">│</span><span class="hs-sep">{m.heavyslot_ram_row()}</span>
          <!-- RAM at a glance: grey used, green free before the brake, red the brake zone. -->
          <ZoneBar zones={ram.zones} mini />
          <span class={ram.short ? "hs-hot" : "hs-ok"}
            >{m.heavyslot_ram_free({ bytes: formatBytes(ram.freeBytes) })}</span
          >
        {/if}
      {/if}
    </button>
    {#if open}
      <HostPopover
        {heavySlot}
        {machines}
        {sessions}
        {nowMs}
        {onrelease}
        {onsettings}
        {left}
        bind:el={pop}
        onClose={close}
      />
    {/if}
  </div>
{/if}

<style>
  /* Deliberately unpositioned: the popover's positioning box is the bar (.hud), so `place()`
     can line it up under the chip yet clamp it inside the bar's edges on a narrow screen. */
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
  /* Nothing held, queued or braked: quiet, so amber only ever means a check is running or waiting. */
  .hs-chip.idle {
    border-color: var(--color-line-bright);
    color: var(--color-muted);
  }
  .hs-chip.idle:hover {
    background: var(--color-panel-2);
    color: var(--color-ink);
  }
  /* Brake: type and border only (the quieter red). */
  .hs-chip.braking {
    border-color: var(--color-red);
    color: var(--color-red);
  }
  .hs-hot {
    color: var(--color-red);
  }
  /* Free slots and free RAM read green wherever the chip shows them. */
  .hs-ok {
    color: var(--color-green);
  }
  .hs-seg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .hs-off {
    color: var(--color-muted);
  }
  /* One machine brakes: the frame and its segment turn red, the others keep their amber. */
  .hs-chip.braking .hs-seg:not(.hs-hot, .hs-off) {
    color: var(--color-amber);
  }
  .hs-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-sizing: border-box;
  }
  /* This Shepherd has no machine color: a hollow ring keeps it apart from the colored machines. */
  .hs-dot.hs-own {
    border: 1.5px solid var(--color-muted);
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
