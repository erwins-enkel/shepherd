<script lang="ts">
  import type { OriginCounts, SessionOrigin } from "#lib/session-origin.js";
  import { anchorPopover } from "#lib/floating-anchor.js";
  import { HOVER_OPEN_DELAY_MS } from "#lib/tooltips/statusTip.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import HerdOriginBar from "../herd/HerdOriginBar.svelte";

  // The herd's origin filter (#3999) on desktop / touch-wide: a small non-modal popover anchored
  // to the HERD total tally (no scrim — exempt per the design-system rule), plus a clearable chip
  // beside the tallies while a filter is on. Hover opens it (after the shared intent delay) and
  // leaving trigger + panel closes it; `open` is bindable so the trigger's click can pin it open
  // (keyboard / touch access). Esc and an outside pointerdown dismiss.
  let {
    trigger,
    open = $bindable(false),
    pinned = $bindable(false),
    offered,
    filter,
    counts,
    onfilter,
    touch = false,
  }: {
    /** The HERD total tally the panel anchors to. */
    trigger: HTMLElement | undefined;
    open?: boolean;
    /** Opened by a click: pointer leave no longer closes it. */
    pinned?: boolean;
    /** False hides the popover (lens lists no sessions, or a manual-only herd). */
    offered: boolean;
    filter: SessionOrigin | null;
    counts: OriginCounts;
    onfilter: (origin: SessionOrigin | null) => void;
    /** Coarse pointer (touch-wide): 44px chip targets. */
    touch?: boolean;
  } = $props();

  const LEAVE_GRACE_MS = 200;

  let popEl = $state<HTMLDivElement>();
  let chipEl = $state<HTMLButtonElement>();
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const label = $derived(
    filter === "scheduled"
      ? m.herd_origin_scheduled()
      : filter === "drain"
        ? m.herd_origin_drain()
        : m.herd_origin_manual(),
  );

  function clearTimers() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
  }
  function close() {
    clearTimers();
    open = false;
    pinned = false;
  }
  // Hover intent from a mouse/pen: touch has no hover, its tap is the trigger's click.
  function enter(e: PointerEvent) {
    if (e.pointerType === "touch" || !offered) return;
    clearTimeout(closeTimer);
    if (!open) openTimer = setTimeout(() => (open = true), HOVER_OPEN_DELAY_MS);
  }
  function leave(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    clearTimeout(openTimer);
    if (open && !pinned) closeTimer = setTimeout(close, LEAVE_GRACE_MS);
  }

  $effect(() => {
    if (!trigger) return;
    const t = trigger;
    t.addEventListener("pointerenter", enter);
    t.addEventListener("pointerleave", leave);
    return () => {
      t.removeEventListener("pointerenter", enter);
      t.removeEventListener("pointerleave", leave);
    };
  });

  $effect(() => {
    if (!offered && open) close();
  });

  $effect(() => () => clearTimers());

  $effect(() => {
    if (!open || !popEl || !trigger) return;
    const pop = popEl;
    const anchor = trigger;
    try {
      pop.showPopover();
    } catch {
      return;
    }
    const stop = anchorPopover(anchor, pop, 6, "bottom-start");
    // A pinned (clicked / Enter) open moves focus into the chips, so the keyboard lands there.
    if (pinned) {
      (
        pop.querySelector<HTMLElement>("[aria-pressed='true']") ?? pop.querySelector("button")
      )?.focus();
    }
    // Esc is consumed (and focus returned) only when the panel owns the keyboard: pinned, or
    // focus on the trigger / in the panel. A hover-only open just closes, so an Escape typed in
    // the terminal or a field still reaches it.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      const owns = pinned || anchor.contains(active) || pop.contains(active);
      close();
      if (!owns) return;
      e.stopPropagation();
      anchor.focus();
    };
    const onPointerdown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (pop.contains(target) || anchor.contains(target) || chipEl?.contains(target)) return;
      close();
    };
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("pointerdown", onPointerdown, true);
    return () => {
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("pointerdown", onPointerdown, true);
      stop();
    };
  });
</script>

{#if filter != null}
  <button
    bind:this={chipEl}
    type="button"
    class="origin-chip"
    aria-label={m.topbar_origin_clear_aria({ origin: label })}
    onpointerenter={enter}
    onpointerleave={leave}
    onclick={() => onfilter(null)}
  >
    <span class="lb">{label}</span><span class="x" aria-hidden="true">×</span>
  </button>
{/if}

{#if open}
  <div
    bind:this={popEl}
    class="origin-pop"
    popover="manual"
    role="dialog"
    tabindex="-1"
    aria-label={m.herd_origins_label()}
    onpointerenter={enter}
    onpointerleave={leave}
  >
    <HerdOriginBar {filter} {counts} {onfilter} {touch} inPopover />
  </div>
{/if}

<style>
  .origin-chip {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 1;
    min-width: 0;
    max-width: 14rem;
    min-height: var(--topbar-ctl-h);
    padding: 0 8px;
    border: 1px solid var(--color-amber);
    border-radius: 6px;
    background: var(--color-inset);
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    line-height: 1;
    cursor: pointer;
  }
  /* Coarse-pointer touch floor, like the other top-bar controls (.ctally, Assist). */
  @media (pointer: coarse) {
    .origin-chip {
      min-height: 44px;
    }
  }
  .origin-chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .lb {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .x {
    flex: none;
  }
  .origin-pop {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 0;
    max-width: calc(100vw - 16px);
    border: 1px solid var(--color-line-bright);
    border-radius: 8px;
    background: var(--color-panel);
    color: inherit;
  }
</style>
