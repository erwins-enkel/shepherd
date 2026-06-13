<script lang="ts">
  import { m } from "$lib/paraglide/messages";

  // Small anchored, non-blocking popover listing the terminal-redraw repair
  // variants (squished-history fix candidates — see PR; the losing variants get
  // removed after field-testing). Per the design system's popover rule it gets
  // NO scrim/blur — it dismisses on outside-click, Esc or scroll. The Viewport
  // owns the open state and the actions; this component only positions + renders.
  let {
    anchor,
    live,
    resuming,
    onnudge,
    onreattach,
    onfullscreen,
    onresume,
    onclose,
  }: {
    // the ↔ button that opened the menu — the popover right-aligns under it,
    // and focus returns here on close
    anchor: HTMLElement;
    // whether the PTY connection is live (gates the variants that need one)
    live: boolean;
    // a forced resume is already in flight — gate the resume item
    resuming: boolean;
    onnudge: () => void;
    onreattach: () => void;
    onfullscreen: () => void;
    onresume: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  // Right-align under the anchor button, clamped inside the viewport (same
  // clamp approach as CardMenu); measured by the effect below once mounted.
  let pos = $state<{ left: number; top: number } | null>(null);
  // Until the measuring effect runs, fall back to a concrete estimate from the
  // anchor rect (320 = the menu's CSS width) so the menu is visible — and
  // focusable — from its very first paint. Never visibility:hidden: a hidden
  // element refuses focus, which would break the first-item-focused contract.
  const shown = $derived(
    pos ??
      (() => {
        const a = anchor.getBoundingClientRect();
        return { left: Math.max(8, a.right - 320), top: a.bottom + 4 };
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
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".rm-item:not(:disabled)")) : [];
  }
  // Arrow / Home / End roving focus; Tab is trapped (cycled) — same contract as
  // CardMenu, so the two menus behave identically under the keyboard.
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
      // moved focus somewhere real (same microtask dance as CardMenu)
      const target = anchor;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="redraw-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.redrawmenu_label()}
  style="left:{shown.left}px;top:{shown.top}px"
  onkeydown={onNav}
>
  <button
    class="rm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!live}
    onclick={onnudge}
  >
    <span class="rm-label">{m.redrawmenu_nudge()}</span>
    <span class="rm-hint">{m.redrawmenu_nudge_hint()}</span>
  </button>
  <button class="rm-item" type="button" role="menuitem" tabindex="-1" onclick={onreattach}>
    <span class="rm-label">{m.redrawmenu_reattach()}</span>
    <span class="rm-hint">{m.redrawmenu_reattach_hint()}</span>
  </button>
  <button
    class="rm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!live}
    onclick={onfullscreen}
  >
    <span class="rm-label">{m.redrawmenu_fullscreen()}</span>
    <span class="rm-hint">{m.redrawmenu_fullscreen_hint()}</span>
  </button>
  <button
    class="rm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={resuming}
    onclick={onresume}
  >
    <span class="rm-label">{m.redrawmenu_resume()}</span>
    <span class="rm-hint">{m.redrawmenu_resume_hint()}</span>
  </button>
</div>

<style>
  .redraw-menu {
    position: fixed;
    z-index: 60;
    /* A FIXED width (not max-width + shrink-to-fit): a position:fixed element with
       width:auto sizes against the space from `left` to the viewport's right edge,
       so its wrapping width would depend on `left` — and the measuring effect would
       right-align against a stale width, leaving the menu off the anchor / spilling
       past the edge. A concrete width decouples geometry from position. */
    width: min(320px, calc(100vw - 16px));
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
  .redraw-menu:focus {
    outline: none;
  }
  .rm-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 7px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rm-item:hover,
  .rm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .rm-item:disabled {
    cursor: default;
    opacity: 0.45;
  }
  .rm-item:disabled:hover {
    background: transparent;
  }
  .rm-label {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .rm-hint {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    line-height: 1.35;
  }
</style>
