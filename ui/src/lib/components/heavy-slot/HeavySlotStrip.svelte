<script lang="ts">
  import type { HeavySlotSnapshot, RemoteInstance, Session } from "#lib/types.js";
  import { SvelteSet } from "svelte/reactivity";
  import { m } from "#lib/paraglide/messages.js";
  import {
    LANE_WAITERS_SHOWN,
    activeLanes,
    brakeLine,
    chipModel,
    commandLabel,
    formatReadAt,
    hasMachineLanes,
    laneTotals,
    orderedWaiters,
    slotActive,
    slotLanes,
    type SlotLane,
  } from "./heavy-slot";

  let {
    heavySlot = null,
    machines = [],
    sessions = [],
    onselect,
    onopen,
  }: {
    heavySlot?: HeavySlotSnapshot | null;
    /** Connected machines: each one's reported slot joins this one in the strip, one lane each. */
    machines?: readonly RemoteInstance[];
    /** Local and mirrored sessions, to name holders and waiters on every machine. */
    sessions?: Pick<Session, "id" | "name">[];
    onselect?: (id: string) => void;
    /** Phone only: the label opens the host panel (the bar chip's job on desktop). */
    onopen?: () => void;
  } = $props();

  const nameOf = (id: string) =>
    sessions.find((s) => s.id === id)?.name ?? m.heavyslot_unknown_session();
  const lanes = $derived(slotLanes(heavySlot, machines));
  const byMachine = $derived(hasMachineLanes(lanes));
  const shown = $derived(byMachine ? activeLanes(lanes) : []);
  const totals = $derived(laneTotals(lanes));
  // Lanes whose whole queue is open although several lanes share the strip.
  const expanded = new SvelteSet<string>();
  const laneKey = (l: SlotLane) => l.instanceId ?? "own";
</script>

{#snippet rows(s: HeavySlotSnapshot, limit: number | null)}
  {@const waiters = orderedWaiters(s)}
  {@const visible = limit == null ? waiters : waiters.slice(0, limit)}
  {@const brake = brakeLine(s)}
  {#each s.holders as h, i (i)}
    <li>
      <button
        type="button"
        class="hs-row hs-holder"
        title={h.command}
        onclick={() => onselect?.(h.sessionId)}
      >
        <span class="hs-name">{nameOf(h.sessionId)}</span>
        <span class="hs-cmd">{m.heavyslot_strip_holder({ command: commandLabel(h.command) })}</span>
      </button>
    </li>
  {/each}
  {#each visible as w (w.sessionId)}
    <li>
      <button type="button" class="hs-row" onclick={() => onselect?.(w.sessionId)}>
        <span class="hs-name">◔ {nameOf(w.sessionId)}</span>
        <span>
          {w.reason === "pressure"
            ? m.heavyslot_strip_wait_pressure({ n: w.position })
            : m.heavyslot_strip_wait({ n: w.position })}
        </span>
      </button>
    </li>
  {/each}
  {#if brake}
    <li class="hs-brake" class:hs-pacing={!s.brake.active}>{brake}</li>
  {/if}
{/snippet}

{#snippet label(text: string, held: number, capacity: number, waiting: number)}
  {#if onopen}
    <button
      type="button"
      class="hs-label hs-open"
      aria-haspopup="dialog"
      aria-label={m.heavyslot_chip_aria({ held, capacity, waiting })}
      onclick={onopen}>▤ {text} ›</button
    >
  {:else}
    <span class="hs-label">▤ {text}</span>
  {/if}
{/snippet}

{#if byMachine && shown.length > 0}
  <!-- Every machine's slot in one strip, a lane each: a mirrored task waiting on another
       machine's slot shows here behind whom it waits. Only lanes with something going on. -->
  <div class="hs-strip hs-footer" role="status" aria-label={m.heavyslot_label_machines()}>
    <div class="hs-top">
      {@render label(m.heavyslot_label_machines(), totals.held, totals.capacity, totals.waiting)}
      <span class="hs-total">■ {totals.held}/{totals.capacity} · ◔ {totals.waiting}</span>
    </div>
    {#each shown as lane (laneKey(lane))}
      {@const key = laneKey(lane)}
      {@const c = chipModel(lane.snapshot)}
      {@const hidden = lane.snapshot.waiters.length - LANE_WAITERS_SHOWN}
      {@const capped = shown.length > 1 && hidden > 0 && !expanded.has(key)}
      {@const machine = lane.name ?? m.herd_machine_this()}
      <div class="hs-lane" class:hs-stale={lane.stale}>
        <span class="hs-dot" class:hs-own={!lane.color} style:background={lane.color}></span>
        <span class="hs-machine">{machine}</span>
        {#if lane.stale}
          <span class="hs-offline"
            >{m.heavyslot_lane_offline({ time: formatReadAt(lane.readAt) })}</span
          >
        {:else}
          <span class="hs-count">■ {c.held}/{c.capacity} · ◔ {c.waiting}</span>
        {/if}
      </div>
      <ul class="hs-rows hs-lane-rows" class:hs-stale={lane.stale}>
        {@render rows(lane.snapshot, capped ? LANE_WAITERS_SHOWN : null)}
        {#if shown.length > 1 && hidden > 0}
          <li>
            <button
              type="button"
              class="hs-row hs-more"
              aria-expanded={!capped}
              onclick={() => (capped ? expanded.add(key) : expanded.delete(key))}
            >
              {capped
                ? m.heavyslot_lane_more({ n: hidden, machine })
                : m.heavyslot_results_show_fewer()}
            </button>
          </li>
        {/if}
      </ul>
    {/each}
  </div>
{:else if !byMachine && slotActive(heavySlot) && heavySlot}
  <!-- Closes off the desktop Herd panel (the list viewport shortens, no row moves), never the
       page chrome, so a check starting or ending never pushes the main area. A phone folds the
       slot into the TopBar status line + Menu sheet instead. -->
  {@const c = chipModel(heavySlot)}
  <div class="hs-strip hs-footer" role="status" aria-label={m.heavyslot_label()}>
    {@render label(m.heavyslot_label(), c.held, c.capacity, c.waiting)}
    <ul class="hs-rows">
      {@render rows(heavySlot, null)}
    </ul>
  </div>
{/if}

<style>
  .hs-strip {
    box-sizing: border-box;
    display: flex;
    gap: 12px;
    background: var(--color-panel);
    min-width: 0;
  }
  /* Desktop: the Herd panel's last row, ruled off from the list above it. */
  .hs-footer {
    flex: none;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px 8px;
    border-top: 1px solid var(--color-line);
  }
  .hs-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .hs-open {
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 2px;
    background: transparent;
    font-family: inherit;
    cursor: pointer;
  }
  .hs-open:focus-visible {
    outline: 1px solid var(--color-amber);
  }
  .hs-rows {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
    max-width: 100%;
  }
  .hs-rows > li {
    max-width: 100%;
    min-width: 0;
  }
  .hs-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 2px;
    background: transparent;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    cursor: pointer;
    max-width: 100%;
    min-width: 0;
  }
  .hs-name {
    color: var(--color-ink-bright);
    font-weight: 500;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The command is shortened to its first real step (commandLabel) and cut to one line of at most
     40ch, the row's title carrying the full text. In a narrow sidebar it gives way first; the name
     only cuts once it is gone. */
  .hs-cmd {
    flex-shrink: 100;
    min-width: 0;
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hs-holder {
    color: var(--color-amber);
  }
  .hs-row:hover .hs-name {
    color: var(--color-amber);
  }
  .hs-row:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* The brake is the quieter red: type only, never a fill (a blocked agent stays the loudest red). */
  .hs-brake {
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    color: var(--color-red);
  }
  /* Brake let go, waiting starts follow one by one: still waiting, no longer red. */
  .hs-brake.hs-pacing {
    color: var(--color-amber);
  }
  /* Several machines: the label carries the summed counts, each lane its machine's. */
  .hs-top {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .hs-total,
  .hs-count {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    color: var(--color-muted);
    white-space: nowrap;
  }
  .hs-total {
    margin-left: auto;
  }
  .hs-lane {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-top: 4px;
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
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
  .hs-machine {
    font-weight: 600;
    color: var(--color-ink-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  /* Unreachable: its last known queue stays readable but steps back, the lane says since when. */
  .hs-offline {
    letter-spacing: 0.08em;
    color: var(--color-warn);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .hs-lane-rows {
    margin-left: 3px;
    padding-left: 12px;
    border-left: 1px solid var(--color-line);
  }
  .hs-lane-rows.hs-stale {
    border-left-style: dashed;
  }
  .hs-lane-rows.hs-stale .hs-name {
    color: var(--color-ink);
  }
  .hs-lane-rows.hs-stale .hs-holder {
    color: var(--color-muted);
  }
  .hs-more:hover {
    color: var(--color-amber);
  }
  @media (pointer: coarse) {
    .hs-row {
      min-height: 44px;
    }
  }
</style>
