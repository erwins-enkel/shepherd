<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // Small anchored, non-blocking popover listing the three repo-acquisition
  // actions (New project · Clone · Fork). Per the design system's popover rule it
  // gets NO scrim/blur — it dismisses on outside-click, Esc or scroll. Modeled on
  // RedrawMenu.svelte (a deliberate, equivalent substitution for the issue-named
  // AutomationPanel .auto-pop: same scrim-exempt anchored-popover recipe, simpler
  // fit for a plain action menu). The opener (AddRepoButton) owns the open state
  // and the actions; this component only positions + renders.
  let {
    anchor,
    onnewproject,
    onclone,
    onfork,
    onclose,
  }: {
    // the "+ Add repo" button that opened the menu — the popover right-aligns under
    // it, and focus returns here on close
    anchor: HTMLElement;
    onnewproject: () => void;
    onclone: () => void;
    onfork: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  // Right-align under the anchor button, clamped inside the viewport (same clamp
  // approach as RedrawMenu/CardMenu); measured by the effect below once mounted.
  let pos = $state<{ left: number; top: number } | null>(null);
  // Until the measuring effect runs, fall back to a concrete estimate from the
  // anchor rect (220 = the menu's CSS width) so the menu is visible — and
  // focusable — from its very first paint. Never visibility:hidden: a hidden
  // element refuses focus, which would break the first-item-focused contract.
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
    items()[0]?.focus(); // open with the first item focused, per the menu pattern
  });

  function items(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".ar-item:not(:disabled)")) : [];
  }
  // Arrow / Home / End roving focus; Tab is trapped (cycled) — same contract as
  // RedrawMenu, so the menus behave identically under the keyboard.
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
      // the anchor's own click toggles the menu — let it handle itself
      if (el && !el.contains(e.target as Node) && !anchor.contains(e.target as Node)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      // restore focus to the trigger on any close path, unless the close itself
      // moved focus somewhere real (same microtask dance as RedrawMenu)
      const target = anchor;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="add-repo-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.backlog_add_repo_menu()}
  style="left:{shown.left}px;top:{shown.top}px"
  onkeydown={onNav}
>
  <button class="ar-item" type="button" role="menuitem" tabindex="-1" onclick={onnewproject}>
    {m.newproject_trigger()}
  </button>
  <button class="ar-item" type="button" role="menuitem" tabindex="-1" onclick={onclone}>
    {m.clonerepo_trigger()}
  </button>
  <button class="ar-item" type="button" role="menuitem" tabindex="-1" onclick={onfork}>
    {m.forkrepo_trigger()}
  </button>
</div>

<style>
  .add-repo-menu {
    position: fixed;
    z-index: 60;
    /* A FIXED width (not max-width + shrink-to-fit): a position:fixed element with
       width:auto sizes against the space from `left` to the viewport's right edge,
       so its wrapping width would depend on `left` — and the measuring effect would
       right-align against a stale width. A concrete width decouples geometry from
       position (mirrors RedrawMenu). */
    width: min(220px, calc(100vw - 16px));
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches RedrawMenu/CardMenu/AutomationPanel) — no token exists */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .add-repo-menu:focus {
    outline: none;
  }
  .ar-item {
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
  .ar-item:hover,
  .ar-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }

  @media (max-width: 768px) {
    .ar-item {
      min-height: 44px;
    }
  }
</style>
