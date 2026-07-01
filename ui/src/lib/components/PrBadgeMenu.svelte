<script lang="ts">
  import { m } from "$lib/paraglide/messages";
  import { portal } from "$lib/portal";

  let {
    anchor,
    opener,
    isDraft,
    canOpen,
    canToggleDraft,
    autoFocus = true,
    busy = false,
    onopen,
    ontoggledraft,
    onclose,
  }: {
    anchor: DOMRect;
    opener?: HTMLElement;
    isDraft: boolean;
    canOpen: boolean;
    canToggleDraft: boolean;
    autoFocus?: boolean;
    busy?: boolean;
    onopen: () => void;
    ontoggledraft: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();
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
    if (autoFocus) enabledItems()[0]?.focus();
  });

  function items(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".pm-item")) : [];
  }
  function enabledItems(): HTMLButtonElement[] {
    return items().filter((item) => !item.disabled);
  }

  function onNav(e: KeyboardEvent) {
    const list = enabledItems();
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
      const t = e.target as Node;
      if (el && !el.contains(t) && !opener?.contains(t)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
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
  class="pr-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.prbadge_menu_label()}
  style="left:{pos?.left ?? anchor.left}px;top:{pos?.top ?? anchor.bottom + 4}px"
  onkeydown={onNav}
>
  <button
    class="pm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!canOpen}
    onclick={onopen}
  >
    <span class="pm-icon" aria-hidden="true">↗</span>{m.prbadge_open_pr()}
  </button>
  <button
    class="pm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={busy || !canToggleDraft}
    aria-busy={busy}
    title={!canToggleDraft ? m.prbadge_draft_unsupported() : undefined}
    onclick={ontoggledraft}
  >
    <span class="pm-icon" aria-hidden="true">{isDraft ? "✓" : "□"}</span>{isDraft
      ? m.prbadge_mark_ready()
      : m.prbadge_mark_draft()}
  </button>
</div>

<style>
  .pr-menu {
    position: fixed;
    z-index: 60;
    min-width: 190px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--color-bg) 70%, transparent);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .pr-menu:focus {
    outline: none;
  }
  .pm-item {
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
  .pm-item:hover:not(:disabled),
  .pm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .pm-item:disabled {
    cursor: not-allowed;
    color: var(--color-faint);
  }
  .pm-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
    color: var(--color-muted);
  }
</style>
