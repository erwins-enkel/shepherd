<script lang="ts">
  import type { HeavySlotSnapshot, RemoteInstance, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { portal } from "#lib/portal.js";
  import { dialog } from "#lib/a11yDialog.js";
  import { swipeBack } from "../swipe-back";
  import SlotSections from "./SlotSections.svelte";
  import { chipModel, formatReadAt, hasMachineLanes, slotLanes } from "./heavy-slot";

  let {
    heavySlot = null,
    machines = [],
    sessions = [],
    nowMs,
    onrelease,
    onsettings,
    onClose,
    variant = "anchored",
    left = null,
    el = $bindable(null),
  }: {
    /** This Shepherd's slot; null when it is switched off here while a machine reports one. */
    heavySlot?: HeavySlotSnapshot | null;
    /** Connected machines: each one's reported slot gets a section, its details folded. */
    machines?: readonly RemoteInstance[];
    sessions?: Pick<Session, "id" | "name">[];
    nowMs: number;
    onrelease: (sessionId: string) => Promise<void>;
    onsettings?: () => void;
    onClose: () => void;
    /** "anchored" drops from the desktop chip; "sheet" is the phone's full-screen dialog. */
    variant?: "anchored" | "sheet";
    /** Anchored only: px offset from the positioning box's left edge; null keeps it right-aligned. */
    left?: number | null;
    el?: HTMLDivElement | null;
  } = $props();

  const anchorStyle = $derived(left == null ? undefined : `left: ${left}px; right: auto`);
  const lanes = $derived(slotLanes(heavySlot, machines));
  const byMachine = $derived(hasMachineLanes(lanes));
  const title = $derived(byMachine ? m.heavyslot_label_machines() : m.heavyslot_popover_title());

  // Phone sheet: a rightward swipe closes it, like Settings and the command bar (see swipeBack).
  let sheetX = $state(0); // rubber-banded display offset (px, ≥ 0)
  const sheetSwipe = swipeBack({ onback: () => onClose(), onoffset: (px) => (sheetX = px) });
</script>

{#snippet body()}
  <header class="hp-head">
    <span class="hp-title">▤ {title}</span>
    <button type="button" class="hp-x" aria-label={m.heavyslot_close()} onclick={onClose}>×</button>
  </header>

  {#if byMachine}
    {#each lanes as lane (lane.instanceId ?? "own")}
      {@const c = chipModel(lane.snapshot)}
      {@const machine = lane.name ?? m.herd_machine_this()}
      <section class="hp-machine" aria-label={machine}>
        <div class="hp-lane">
          <span class="hp-dot" class:hp-own={!lane.color} style:background={lane.color}></span>
          <span class="hp-lane-name">{machine}</span>
          {#if lane.stale}
            <span class="hp-off"
              >{m.heavyslot_lane_offline({ time: formatReadAt(lane.readAt) })}</span
            >
          {:else}
            <span class="hp-lane-count"
              >■ {c.held}/{c.capacity} · ◔ {c.waiting}{#if c.ramPct != null}
                · {m.heavyslot_ram({ pct: c.ramPct })}{/if}</span
            >
          {/if}
        </div>
        <SlotSections
          heavySlot={lane.snapshot}
          own={lane.instanceId === null}
          folded
          {sessions}
          {nowMs}
          {onrelease}
        />
      </section>
    {/each}
  {:else if heavySlot}
    <SlotSections {heavySlot} {sessions} {nowMs} {onrelease} />
  {/if}

  {#if onsettings}
    <button type="button" class="hp-link" onclick={onsettings}
      >{m.heavyslot_settings_link()} →</button
    >
  {/if}
{/snippet}

{#if variant === "sheet"}
  <div class="hp-portal" use:portal>
    <div class="scrim" aria-hidden="true" onclick={onClose}></div>
    <div
      class="hp hp-sheet"
      class:swiping={sheetX > 0}
      style:transform={sheetX > 0 ? `translateX(${sheetX}px)` : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      bind:this={el}
      use:dialog={{ onclose: onClose }}
      {@attach sheetSwipe}
    >
      {@render body()}
    </div>
  </div>
{:else}
  <div class="hp" role="dialog" aria-label={title} tabindex="-1" style={anchorStyle} bind:this={el}>
    {@render body()}
  </div>
{/if}

<style>
  .hp {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 40;
    box-sizing: border-box;
    width: min(380px, calc(100vw - 32px));
    max-height: calc(100vh - 80px);
    overflow-y: auto;
    padding: 10px 12px;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    background: var(--color-panel);
    font-size: var(--fs-meta);
    color: var(--color-ink);
    text-align: left;
  }
  .hp-portal {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  /* Phone: a full-screen dialog in place of the anchored panel (the usage panel's pattern). */
  .hp.hp-sheet {
    position: fixed;
    inset: 0;
    z-index: 1;
    width: auto;
    max-height: none;
    border: 0;
    border-radius: 0;
    padding: calc(4px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom));
    font-size: var(--fs-base);
    transition: transform 0.18s ease-out;
  }
  /* Mid swipe-back: follows the finger 1:1, edge shadow over the uncovered page. */
  .hp.hp-sheet.swiping {
    transition: none;
    box-shadow: var(--shadow-popover);
  }
  .hp-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  /* Same micro caps as the sections' headings (SlotSections `h3`). */
  .hp-title {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* Several machines: a section each, headed by its dot, name and counts. */
  .hp-machine {
    margin-top: 12px;
  }
  .hp-machine + .hp-machine {
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .hp-lane {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--color-line);
  }
  .hp-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-sizing: border-box;
  }
  /* This Shepherd has no machine color: a hollow ring keeps it apart from the colored machines. */
  .hp-dot.hp-own {
    border: 1.5px solid var(--color-muted);
  }
  .hp-lane-name {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .hp-lane-count {
    margin-left: auto;
    font-family: var(--font-mono);
    color: var(--color-muted);
  }
  .hp-off {
    margin-left: auto;
    color: var(--color-warn);
  }
  .hp-x,
  .hp-link {
    min-height: 30px;
    padding: 0 8px;
    border-radius: var(--radius-chip);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    cursor: pointer;
  }
  .hp-x {
    border: 0;
    font-size: 16px;
  }
  .hp-link {
    margin-top: 10px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
  }
  .hp-link:hover {
    background: color-mix(in srgb, var(--color-amber) 10%, transparent);
  }
  .hp-x:focus-visible,
  .hp-link:focus-visible {
    outline: 1px solid var(--color-amber);
  }
  @media (max-width: 768px), (pointer: coarse) {
    .hp-x,
    .hp-link {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
