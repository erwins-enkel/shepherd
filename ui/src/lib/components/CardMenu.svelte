<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // Small anchored, non-blocking context menu for a session card (right-click on
  // desktop, long-press → native `contextmenu` on touch). Per the design system's
  // popover rule it gets NO scrim/blur — it dismisses on outside-click, Esc or
  // scroll instead. The card owns its open/close state and the resumable check;
  // this component only positions + renders the actions it's handed.
  let {
    x,
    y,
    resumable,
    onresume,
    ondecommission,
    onclose,
  }: {
    // viewport coordinates of the pointer/long-press that opened the menu
    x: number;
    y: number;
    // whether the Resume action applies to this session right now
    resumable: boolean;
    onresume?: () => void;
    ondecommission?: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  // Clamp the menu inside the viewport so it never spills off the bottom/right
  // edge when opened near them. Measured after mount; until then the template
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

  // The menu items, in DOM order (only the ones actually rendered).
  function items(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".cm-item")) : [];
  }
  // Arrow / Home / End roving focus, as a role="menu" is expected to support.
  function onNav(e: KeyboardEvent) {
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
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
    // capture so we beat the card's own click; scroll dismisses (the anchor moves)
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
    };
  });
</script>

<div
  bind:this={el}
  class="card-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.cardmenu_label()}
  style="left:{pos?.left ?? x}px;top:{pos?.top ?? y}px"
  onkeydown={onNav}
>
  {#if resumable && onresume}
    <button class="cm-item" type="button" role="menuitem" tabindex="-1" onclick={onresume}>
      <span class="cm-icon" aria-hidden="true">↻</span>{m.cardmenu_resume()}
    </button>
  {/if}
  {#if ondecommission}
    <button
      class="cm-item danger"
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={ondecommission}
    >
      <span class="cm-icon" aria-hidden="true">✕</span>{m.cardmenu_decommission()}
    </button>
  {/if}
</div>

<style>
  .card-menu {
    position: fixed;
    z-index: 60;
    min-width: 180px;
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches AutomationPanel/RepoSelect) — no token exists */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .card-menu:focus {
    outline: none;
  }
  .cm-item {
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
  .cm-item:hover,
  .cm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .cm-item.danger {
    color: var(--color-red);
  }
  .cm-item.danger:hover,
  .cm-item.danger:focus-visible {
    background: color-mix(in srgb, var(--color-red) 14%, var(--color-panel));
  }
  .cm-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
  }
</style>
