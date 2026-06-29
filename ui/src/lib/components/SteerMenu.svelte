<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // Small anchored, non-blocking context menu for a steer chip (right-click on
  // desktop). Per the design system's popover rule it gets NO scrim/blur — it
  // dismisses on outside-click, Esc or scroll instead. The bar owns its open/close
  // state; this component only positions + renders the two actions. Modelled on
  // CardMenu, trimmed to the steer's two choices: run it, or edit it.
  let {
    x,
    y,
    label,
    opener,
    onrun,
    onedit,
    onclose,
  }: {
    // viewport coordinates of the right-click that opened the menu
    x: number;
    y: number;
    // the steer's label, woven into the menu's accessible name
    label: string;
    // the chip that opened the menu — focus returns here on close
    opener?: HTMLElement;
    onrun: () => void;
    onedit: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  // Clamp the menu inside the viewport so it never spills off the bottom/right edge
  // when opened near them (the steer bar lives at the bottom, so the menu usually
  // opens upward from the clamp). Measured after mount; until then the template
  // falls back to the raw pointer position (x/y).
  let pos = $state<{ left: number; top: number } | null>(null);
  $effect(() => {
    const node = el;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(x, window.innerWidth - r.width - margin);
    const top = Math.min(y, window.innerHeight - r.height - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    items()[0]?.focus(); // open with the first item focused, per the menu pattern
  });

  function items(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".sm-item")) : [];
  }
  // Arrow / Home / End roving focus, as a role="menu" is expected to support. Tab is
  // trapped (cycled like the arrows) so focus can't escape the open menu — the only
  // ways out are Esc, an action, or an outside click, all of which close it.
  function onNav(e: KeyboardEvent) {
    const list = items();
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
    e.preventDefault();
    list[next]!.focus();
  }

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    function onPointer(e: Event) {
      if (el && !el.contains(e.target as Node)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    // capture so we beat the chip's own handlers; scroll dismisses (the anchor moves)
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      // Every close path unmounts the menu, so returning focus to the opener here
      // covers them all. Deferred to a microtask so the browser has applied any
      // click-driven focus first, then only restore when focus actually fell to
      // <body> — an action that moved focus elsewhere (e.g. into the editor) keeps it.
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="steer-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.steermenu_label({ label })}
  style="left:{pos?.left ?? x}px;top:{pos?.top ?? y}px"
  onkeydown={onNav}
>
  <button class="sm-item" type="button" role="menuitem" tabindex="-1" onclick={onrun}>
    <span class="sm-icon" aria-hidden="true">▷</span>{m.steermenu_run()}
  </button>
  <button class="sm-item" type="button" role="menuitem" tabindex="-1" onclick={onedit}>
    <span class="sm-icon" aria-hidden="true">✎</span>{m.steermenu_edit()}
  </button>
</div>

<style>
  .steer-menu {
    position: fixed;
    z-index: 60;
    min-width: 160px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches CardMenu/AutomationPanel) — no token exists */
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
    gap: 9px;
    width: 100%;
    padding: 8px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .sm-item:hover,
  .sm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .sm-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
  }
</style>
