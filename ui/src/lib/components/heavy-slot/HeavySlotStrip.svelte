<script lang="ts">
  import type { HeavySlotSnapshot, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { chipModel, commandLabel, orderedWaiters, slotActive } from "./heavy-slot";

  let {
    heavySlot = null,
    sessions = [],
    onselect,
    onopen,
    variant = "footer",
  }: {
    heavySlot?: HeavySlotSnapshot | null;
    sessions?: Pick<Session, "id" | "name">[];
    onselect?: (id: string) => void;
    /** Phone only: the label opens the host panel (the bar chip's job on desktop). */
    onopen?: () => void;
    /** "footer" closes off the desktop Herd panel (the list viewport shortens, no row moves);
     *  "dock" floats above the phone's action bar. Neither sits in the page chrome, so a check
     *  starting or ending never pushes the main area. */
    variant?: "footer" | "dock";
  } = $props();

  const nameOf = (id: string) =>
    sessions.find((s) => s.id === id)?.name ?? m.heavyslot_unknown_session();
</script>

{#if slotActive(heavySlot) && heavySlot}
  <div
    class="hs-strip"
    class:hs-footer={variant === "footer"}
    class:hs-docked={variant === "dock"}
    role="status"
    aria-label={m.heavyslot_label()}
  >
    {#if onopen}
      {@const c = chipModel(heavySlot)}
      <button
        type="button"
        class="hs-label hs-open"
        aria-haspopup="dialog"
        aria-label={m.heavyslot_chip_aria({
          held: c.held,
          capacity: c.capacity,
          waiting: c.waiting,
        })}
        onclick={onopen}>▤ {m.heavyslot_label()} ›</button
      >
    {:else}
      <span class="hs-label">▤ {m.heavyslot_label()}</span>
    {/if}
    <ul class="hs-rows">
      {#each heavySlot.holders as h, i (i)}
        <li>
          <button
            type="button"
            class="hs-row hs-holder"
            title={h.command}
            onclick={() => onselect?.(h.sessionId)}
          >
            <span class="hs-name">{nameOf(h.sessionId)}</span>
            <span class="hs-cmd"
              >{m.heavyslot_strip_holder({ command: commandLabel(h.command) })}</span
            >
          </button>
        </li>
      {/each}
      {#each orderedWaiters(heavySlot) as w (w.sessionId)}
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
      {#if heavySlot.brake.active}
        <li class="hs-brake">{m.heavyslot_strip_brake()}</li>
      {/if}
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
  .hs-docked {
    position: fixed;
    left: var(--mobile-shell-pad);
    right: var(--mobile-shell-pad);
    bottom: calc(
      var(--mobile-actionbar-h) + max(var(--mobile-actionbar-pad), env(safe-area-inset-bottom)) +
        6px
    );
    z-index: 5;
    padding: 5px 10px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    align-items: center;
  }
  /* Docked is always one 44px row, whatever the width (a landscape phone is "mobile" by height
     but misses any max-width rule): the list reserves exactly --mobile-slotdock-h. */
  .hs-docked .hs-rows {
    flex-direction: row;
    align-items: center;
    gap: 14px;
    overflow-x: auto;
  }
  .hs-docked .hs-rows > li {
    flex-shrink: 0;
  }
  .hs-docked .hs-row,
  .hs-docked .hs-open {
    min-height: 44px;
  }
  .hs-docked .hs-holder {
    max-width: min(70vw, 40ch);
  }
  .hs-docked .hs-brake {
    white-space: nowrap;
  }
  @media (pointer: coarse) {
    .hs-row {
      min-height: 44px;
    }
  }
</style>
