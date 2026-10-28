<script lang="ts">
  import type { HeavySlotSnapshot, Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { orderedWaiters, slotActive } from "./heavy-slot";

  let {
    heavySlot = null,
    sessions = [],
    onselect,
  }: {
    heavySlot?: HeavySlotSnapshot | null;
    sessions?: Pick<Session, "id" | "name">[];
    onselect?: (id: string) => void;
  } = $props();

  const nameOf = (id: string) =>
    sessions.find((s) => s.id === id)?.name ?? m.heavyslot_unknown_session();
</script>

{#if slotActive(heavySlot) && heavySlot}
  <div class="hs-strip" role="status" aria-label={m.heavyslot_label()}>
    <span class="hs-label">▤ {m.heavyslot_label()}</span>
    <ul class="hs-rows">
      {#each heavySlot.holders as h (h.sessionId)}
        <li>
          <button type="button" class="hs-row hs-holder" onclick={() => onselect?.(h.sessionId)}>
            <span class="hs-name">{nameOf(h.sessionId)}</span>
            <span>{m.heavyslot_strip_holder({ command: h.command })}</span>
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
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 5px 10px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-panel);
    font-family: var(--font-mono);
    align-self: flex-start;
    max-width: 100%;
    min-width: 0;
  }
  .hs-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    flex-shrink: 0;
    padding-top: 2px;
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
  }
  .hs-name {
    color: var(--color-ink-bright);
    font-weight: 500;
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
  /* Phone: one line, scrolling sideways; 44px tap targets. */
  @media (max-width: 768px) {
    .hs-strip {
      align-self: stretch;
      align-items: center;
    }
    .hs-rows {
      flex-direction: row;
      align-items: center;
      gap: 14px;
      overflow-x: auto;
    }
    .hs-row {
      min-height: 44px;
    }
    .hs-brake {
      white-space: nowrap;
    }
  }
  @media (pointer: coarse) {
    .hs-row {
      min-height: 44px;
    }
  }
</style>
