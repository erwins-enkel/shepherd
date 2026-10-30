<script lang="ts">
  import type { Steer } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { providerLabel } from "#lib/reviewer-env.js";
  import {
    quickStartAria,
    quickStartEffortText,
    quickStartHoldText,
    quickStartModelText,
    type QuickStartChip,
  } from "#lib/up-next-quick-start.js";
  import { gaugeColor } from "./usage-gauges";

  // The Up Next preview's "▾" beside Start, shown once the action row is too narrow for every
  // issue steer: plain Start plus ALL steers (not just the clipped ones, so the list never
  // shifts as the pane resizes). Small anchored, non-blocking popover — no scrim; dismisses
  // on outside-click, Esc or scroll. Same recipe (clamp, roving focus, focus restore) as
  // IssueDetailMenu, but left-aligned under the Start button it extends.
  let {
    anchor,
    number,
    steers,
    onstart,
    onsteer,
    onmanage = undefined,
    onclose,
    startLabel = undefined,
    startHint = undefined,
    quickStarts = [],
    onquick = undefined,
    onmanagequickstarts = undefined,
    nowMs = 0,
  }: {
    anchor: HTMLElement;
    /** The issue number, woven into the menu's accessible name. */
    number: number;
    steers: Steer[];
    onstart: () => void;
    onsteer: (steer: Steer) => void;
    /** Open Settings on the steers editor; omitted → no "Manage steers" item. */
    onmanage?: () => void;
    onclose: () => void;
    /** The plain item's label; defaults to Start (a PR's fix passes "Start fix"). */
    startLabel?: string;
    /** The plain item's hint; defaults to "without a steer, as before". */
    startHint?: string;
    /** Quick-start chips, listed between Start… and the steers (the issue preview only). */
    quickStarts?: QuickStartChip[];
    onquick?: (chip: QuickStartChip) => void;
    /** Open Settings on the Coding CLI panel; omitted → no "Manage quick starts" item. */
    onmanagequickstarts?: () => void;
    nowMs?: number;
  } = $props();

  let el = $state<HTMLDivElement>();

  let pos = $state<{ left: number; top: number } | null>(null);
  // Visible (and focusable) from the first paint, before the measuring effect runs.
  const shown = $derived(
    pos ??
      (() => {
        const a = anchor.getBoundingClientRect();
        return { left: a.left, top: a.bottom + 4 };
      })(),
  );
  $effect(() => {
    const node = el;
    if (!node) return;
    const a = anchor.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(a.left, window.innerWidth - r.width - margin);
    const top = Math.min(a.bottom + 4, window.innerHeight - r.height - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    menuButtons()[0]?.focus();
  });

  function menuButtons(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".sm-item")) : [];
  }
  function onNav(e: KeyboardEvent) {
    // Marked defaultPrevented, so the preview's own Esc (close the preview) leaves it alone.
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
      return;
    }
    const list = menuButtons();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const fwd = (i + 1) % list.length;
    const back = (i - 1 + list.length) % list.length;
    let next: number;
    if (e.key === "ArrowDown") next = fwd;
    else if (e.key === "ArrowUp") next = back;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") next = e.shiftKey ? back : fwd;
    else return;
    e.stopPropagation();
    e.preventDefault();
    list[next]!.focus();
  }

  $effect(() => {
    function onPointer(e: Event) {
      if (el && !el.contains(e.target as Node) && !anchor.contains(e.target as Node)) onclose();
    }
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      const target = anchor;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });

  // The menu shows the prompt's opening, the way the Settings row does; the tile holds the
  // steer's emoji, or the Steers nav glyph when it has none.
  const excerpt = (text: string) => text.replace(/\s+/g, " ").trim();
</script>

<div
  bind:this={el}
  class="steer-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.upnext_preview_menu_aria({ number })}
  style="left:{shown.left}px;top:{shown.top}px"
  onkeydown={onNav}
>
  <button class="sm-item" type="button" role="menuitem" tabindex="-1" onclick={onstart}>
    <span class="sm-text">
      <span class="sm-name">{startLabel ?? m.upnext_start()}</span>
      <span class="sm-hint">{startHint ?? m.upnext_preview_menu_start_hint()}</span>
    </span>
  </button>
  {#if quickStarts.length > 0}
    <div class="sm-sep" role="separator"></div>
    <span class="sm-head" aria-hidden="true">{m.upnext_quickstart_menu_head()}</span>
    {#each quickStarts as chip (chip.provider)}
      <button
        class="sm-item sm-quick"
        class:sm-hold={chip.state === "hold"}
        class:sm-blocked={chip.state === "blocked"}
        type="button"
        role="menuitem"
        tabindex="-1"
        aria-label={quickStartAria(chip)}
        aria-disabled={chip.state === "blocked" ? "true" : undefined}
        onclick={() => chip.state !== "blocked" && onquick?.(chip)}
      >
        <span class="sm-tile sm-bolt" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12"
            ><path d="M9.5 1 3 9h4l-1 6 7-8.5H9z" fill="currentColor" /></svg
          >
        </span>
        <span class="sm-text">
          <span class="sm-name">{providerLabel(chip.provider)}</span>
          <span class="sm-hint"
            >{chip.state === "blocked"
              ? m.upnext_quickstart_blocked()
              : chip.state === "hold"
                ? quickStartHoldText(chip, nowMs)
                : `${quickStartModelText(chip)} · ${quickStartEffortText(chip)}`}</span
          >
        </span>
        {#if chip.usedPct !== null}
          <i
            class="sm-bar"
            aria-hidden="true"
            style:width="{Math.min(Math.max(chip.usedPct, 0), 100)}%"
            style:background={chip.state === "hold"
              ? "var(--color-warn)"
              : gaugeColor(chip.usedPct)}
          ></i>
        {/if}
      </button>
    {/each}
  {/if}
  {#if steers.length > 0}
    <div class="sm-sep" role="separator"></div>
    <span class="sm-head" aria-hidden="true">{m.upnext_preview_menu_steers()}</span>
  {/if}
  {#each steers as s (s.id)}
    <button
      class="sm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      aria-label={m.issuespanel_action_aria({ label: s.label })}
      onclick={() => onsteer(s)}
    >
      <span class="sm-tile" aria-hidden="true">{s.emoji || "⇥"}</span>
      <span class="sm-text">
        <span class="sm-name">{s.label}</span>
        <span class="sm-hint">{excerpt(s.text)}</span>
      </span>
    </button>
  {/each}
  {#if onmanage || (onmanagequickstarts && quickStarts.length > 0)}
    <div class="sm-sep" role="separator"></div>
  {/if}
  {#if onmanagequickstarts && quickStarts.length > 0}
    <button
      class="sm-item sm-manage"
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={onmanagequickstarts}>{m.upnext_quickstart_manage()} ›</button
    >
  {/if}
  {#if onmanage}
    <button class="sm-item sm-manage" type="button" role="menuitem" tabindex="-1" onclick={onmanage}
      >{m.upnext_preview_manage_steers()} ›</button
    >
  {/if}
</div>

<style>
  .steer-menu {
    position: fixed;
    z-index: 60;
    /* Fixed width so the measuring effect clamps against a stable size (see AddRepoMenu). */
    width: min(360px, calc(100vw - 16px));
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches AddRepoMenu/RedrawMenu/CardMenu) — no token exists */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .steer-menu:focus {
    outline: none;
  }
  .sm-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    padding: 7px 10px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .sm-item:hover,
  .sm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .sm-tile {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1;
  }
  .sm-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .sm-name {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 700;
  }
  .sm-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .sm-head {
    padding: 4px 10px 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .sm-sep {
    height: 1px;
    margin: 4px 0;
    background: var(--color-line);
  }
  .sm-quick {
    position: relative;
    overflow: hidden;
  }
  .sm-bolt {
    color: var(--color-amber);
  }
  .sm-hold .sm-bolt,
  .sm-hold .sm-hint {
    color: var(--color-warn);
  }
  .sm-blocked {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .sm-bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
  }
  .sm-manage {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  @media (max-width: 768px), (pointer: coarse) {
    .sm-item {
      min-height: 44px;
    }
  }
</style>
