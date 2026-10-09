<script lang="ts">
  import type { Steer } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";

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
      <span class="sm-name">{m.upnext_start()}</span>
      <span class="sm-hint">{m.upnext_preview_menu_start_hint()}</span>
    </span>
  </button>
  <div class="sm-sep" role="separator"></div>
  <span class="sm-head" aria-hidden="true">{m.upnext_preview_menu_steers()}</span>
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
  {#if onmanage}
    <div class="sm-sep" role="separator"></div>
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
