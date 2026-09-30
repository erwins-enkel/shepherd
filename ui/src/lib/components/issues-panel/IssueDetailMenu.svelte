<script lang="ts">
  // The reading detail's ⋯ menus for an epic: Import structure + Diagnose in the head (#2617),
  // End epic + Approve next in the run area (#2620). Small anchored, non-blocking popover — no
  // scrim; dismisses on outside-click, Esc or scroll. Same recipe (clamp, roving focus, focus
  // restore) as AddRepoMenu; the opener owns the open state and the actions.
  let {
    anchor,
    label,
    items,
    onclose,
  }: {
    anchor: HTMLElement;
    /** Accessible name of the menu. */
    label: string;
    items: { label: string; title?: string; onselect: () => void }[];
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  let pos = $state<{ left: number; top: number } | null>(null);
  // Visible (and focusable) from the first paint, before the measuring effect runs.
  const shown = $derived(
    pos ??
      (() => {
        const a = anchor.getBoundingClientRect();
        return { left: Math.max(8, a.right - 220), top: a.bottom + 4 };
      })(),
  );
  $effect(() => {
    const node = el;
    if (!node) return;
    const a = anchor.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(a.right - r.width, window.innerWidth - r.width - margin);
    const top = Math.min(a.bottom + 4, window.innerHeight - r.height - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    menuButtons()[0]?.focus();
  });

  function menuButtons(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".dm-item")) : [];
  }
  function onNav(e: KeyboardEvent) {
    // Handled here (on the menu, before it bubbles to the host dialog's Escape listener) and
    // marked defaultPrevented, so Esc closes only this menu — not the whole Repos dialog.
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
    // Keep the list's own ↑/↓ selection from reacting to menu navigation.
    e.stopPropagation();
    e.preventDefault();
    list[next]!.focus();
  }

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    function onPointer(e: Event) {
      if (el && !el.contains(e.target as Node) && !anchor.contains(e.target as Node)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      const target = anchor;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="detail-menu"
  role="menu"
  tabindex="-1"
  aria-label={label}
  style="left:{shown.left}px;top:{shown.top}px"
  onkeydown={onNav}
>
  {#each items as item (item.label)}
    <button
      class="dm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      title={item.title}
      onclick={item.onselect}
    >
      {item.label}
    </button>
  {/each}
</div>

<style>
  .detail-menu {
    position: fixed;
    z-index: 60;
    /* Fixed width so the measuring effect right-aligns against a stable size (see AddRepoMenu). */
    width: min(220px, calc(100vw - 16px));
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
  .detail-menu:focus {
    outline: none;
  }
  .dm-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 9px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .dm-item:hover,
  .dm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }

  @media (max-width: 768px) {
    .dm-item {
      min-height: 44px;
    }
  }
</style>
