<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { portal } from "$lib/portal";
  import type { AgentProvider } from "$lib/types";

  // Small anchored, non-blocking menu opened by clicking a card's task-id button.
  // Per the design system's popover rule it gets NO scrim/blur — it dismisses on
  // outside-click, Esc or scroll. Positioned under its anchor (flips above when
  // there's no room below). The parent owns open/close + the actions.
  let {
    anchor,
    opener,
    oncopy,
    onrecommend,
    onclose,
  }: {
    anchor: DOMRect;
    opener?: HTMLElement;
    oncopy: () => void;
    onrecommend: (provider: AgentProvider, model: string) => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  // Clamp inside the viewport: anchor below-left by default, flip above when the
  // menu would overflow the bottom. Measured after mount; until then a sensible
  // fallback (just under the anchor) keeps the first paint roughly placed.
  let pos = $state<{ left: number; top: number } | null>(null);
  $effect(() => {
    const node = el;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const below = anchor.bottom + 4;
    const above = anchor.top - r.height - 4;
    const top = below + r.height + margin > window.innerHeight && above > margin ? above : below;
    const left = Math.min(anchor.left, window.innerWidth - r.width - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    items()[0]?.focus(); // open with the first item focused, per the menu pattern
  });

  function items(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".tm-item")) : [];
  }
  // Arrow / Home / End roving focus; Tab is trapped (cycled) so focus can't escape
  // the open menu — Esc, an action, or an outside click are the only ways out.
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
    // capture so we beat the card's own click; scroll dismisses (the anchor moves)
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      // Restore focus to the trigger on every close path, but only when focus fell
      // to <body> — an action that moved focus (e.g. into the dialog) keeps it.
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  use:portal
  class="taskid-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.taskid_menu_label()}
  style="left:{pos?.left ?? anchor.left}px;top:{pos?.top ?? anchor.bottom + 4}px"
  onkeydown={onNav}
>
  <button class="tm-item" type="button" role="menuitem" tabindex="-1" onclick={oncopy}>
    <span class="tm-icon" aria-hidden="true">⧉</span>{m.taskid_copy()}
  </button>
  <button
    class="tm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    onclick={() => onrecommend("claude", "opus")}
  >
    <span class="tm-icon" aria-hidden="true">✦</span>{m.taskid_recommend_opus()}
  </button>
  <button
    class="tm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    onclick={() => onrecommend("codex", "gpt-5.5")}
  >
    <span class="tm-icon" aria-hidden="true">✦</span>{m.taskid_recommend_gpt()}
  </button>
</div>

<style>
  .taskid-menu {
    position: fixed;
    z-index: 60;
    min-width: 200px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .taskid-menu:focus {
    outline: none;
  }
  .tm-item {
    display: flex;
    align-items: center;
    gap: 9px;
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
  .tm-item:hover,
  .tm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .tm-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
    color: var(--color-muted);
  }
</style>
