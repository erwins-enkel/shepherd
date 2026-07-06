<script lang="ts">
  import { portal } from "$lib/portal";

  // Small anchored, non-blocking single-select picker opened by the Up Next sort
  // button. Positioning + dismiss mechanics mirror TaskIdMenu (portal so the
  // panel's overflow:auto can't clip it, JS-anchored under the trigger with a
  // flip-up when there's no room below, dismiss on Esc / outside-click / scroll,
  // focus-restore to the trigger). Semantics mirror LanguageSwitcher — a
  // role="listbox" with role="option" + a ✓ on the active mode. No scrim, per the
  // design system's anchored-popover rule. The parent owns open/close state.
  let {
    anchor,
    opener,
    current,
    options,
    label,
    onselect,
    onclose,
  }: {
    anchor: DOMRect;
    opener?: HTMLElement;
    current: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    label: string;
    onselect: (value: string) => void;
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
    // Right-align to the trigger (it lives at the header's right edge), then clamp.
    const left = Math.min(anchor.right - r.width, window.innerWidth - r.width - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    // Open with the active option focused (falling back to the first), per the menu pattern.
    (opts().find((b) => b.dataset.value === current) ?? opts()[0])?.focus();
  });

  function opts(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".usm-item")) : [];
  }
  // Arrow / Home / End roving focus; Tab is trapped (cycled) so focus can't escape
  // the open menu — Esc, a selection, or an outside click are the only ways out.
  function onNav(e: KeyboardEvent) {
    const list = opts();
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
      // Exclude the opener: a pointerdown on the sort button must NOT dismiss here,
      // or the button's own click would just toggle the menu back open.
      if (el && !el.contains(t) && !opener?.contains(t)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    // capture so we beat the trigger's own click; scroll dismisses (the anchor moves)
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      // Restore focus to the trigger on close, but only when focus fell to <body>.
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
  class="un-sortmenu"
  role="listbox"
  tabindex="-1"
  aria-label={label}
  style="left:{pos?.left ?? anchor.left}px;top:{pos?.top ?? anchor.bottom + 4}px"
  onkeydown={onNav}
>
  {#each options as opt (opt.value)}
    <button
      class="usm-item"
      type="button"
      role="option"
      tabindex="-1"
      data-value={opt.value}
      aria-selected={opt.value === current}
      class:active={opt.value === current}
      onclick={() => onselect(opt.value)}
    >
      <span class="usm-check" aria-hidden="true">{opt.value === current ? "✓" : ""}</span>
      {opt.label}
    </button>
  {/each}
</div>

<style>
  .un-sortmenu {
    position: fixed;
    z-index: 60;
    min-width: 180px;
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
  .un-sortmenu:focus {
    outline: none;
  }
  .usm-item {
    display: flex;
    align-items: center;
    gap: 8px;
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
  .usm-item:hover,
  .usm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .usm-item.active {
    color: var(--color-amber);
  }
  .usm-check {
    width: 1em;
    flex-shrink: 0;
    text-align: center;
    color: var(--color-amber);
  }
</style>
