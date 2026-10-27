<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { MergeMethod } from "#lib/types.js";

  // The "▾" beside an Up Next PR's Merge: lands this one PR with another method the repo allows.
  // Picking opens the merge confirmation for that method — nothing is remembered, the next merge
  // starts from the repo's default again. A method the repo turns off stays listed but inert, so
  // the menu says why it is missing. Same anchored, non-blocking recipe as UpNextSteerMenu (clamp,
  // roving focus, focus restore), aligned to whichever edge of the anchor the caller names.
  let {
    anchor,
    number,
    allowed,
    defaultMethod,
    align = "start",
    onpick,
    onclose,
  }: {
    anchor: HTMLElement;
    /** The PR number, woven into the menu's accessible name. */
    number: number;
    /** The methods the repo allows. */
    allowed: MergeMethod[];
    /** The method a plain Merge uses (marked as the default); null when unknown. */
    defaultMethod: MergeMethod | null;
    /** "end" for a button at the right edge (the list row), so the menu opens leftwards. */
    align?: "start" | "end";
    onpick: (method: MergeMethod) => void;
    onclose: () => void;
  } = $props();

  const ORDER: MergeMethod[] = ["squash", "rebase", "merge"];

  function hint(method: MergeMethod): string {
    if (!allowed.includes(method)) return m.mergemethod_hint_off();
    if (method === "squash") return m.mergemethod_hint_squash();
    if (method === "rebase") return m.mergemethod_hint_rebase();
    return m.mergemethod_hint_merge();
  }

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
    const want = align === "end" ? a.right - r.width : a.left;
    const left = Math.min(want, window.innerWidth - r.width - margin);
    const top = Math.min(a.bottom + 4, window.innerHeight - r.height - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
    menuButtons()[0]?.focus();
  });

  function menuButtons(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".mm-item")) : [];
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
</script>

<div
  bind:this={el}
  class="mm"
  role="menu"
  tabindex="-1"
  aria-label={m.mergemethod_menu_aria({ number })}
  style="left:{shown.left}px;top:{shown.top}px"
  onkeydown={onNav}
>
  <span class="mm-head" aria-hidden="true">{m.mergemethod_menu_head()}</span>
  {#each ORDER as method (method)}
    {@const off = !allowed.includes(method)}
    <!-- aria-disabled, not disabled: the item stays reachable so its hint can say why. -->
    <button
      class="mm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      aria-disabled={off ? "true" : undefined}
      onclick={() => {
        if (!off) onpick(method);
      }}
    >
      <span class="mm-tile" aria-hidden="true">
        {#if method === "squash"}
          <svg viewBox="0 0 16 16"
            ><circle cx="3" cy="3" r="1.4" /><circle cx="3" cy="8" r="1.4" /><circle
              cx="3"
              cy="13"
              r="1.4"
            /><path d="M4.4 3.7 10.4 7.3M4.4 8h6M4.4 12.3l6-3.6" /><circle
              class="mm-dot"
              cx="12.6"
              cy="8"
              r="2"
            /></svg
          >
        {:else if method === "rebase"}
          <svg viewBox="0 0 16 16"
            ><path d="M1 8h14" /><circle class="mm-hole" cx="3" cy="8" r="1.6" /><circle
              class="mm-hole"
              cx="6.5"
              cy="8"
              r="1.6"
            /><circle class="mm-dot" cx="10" cy="8" r="1.6" /><circle
              class="mm-dot"
              cx="13.5"
              cy="8"
              r="1.6"
            /></svg
          >
        {:else}
          <svg viewBox="0 0 16 16"
            ><path d="M1 12h14M3 12V7q0-3 3-3h4q3 0 3 3v5" /><circle
              class="mm-hole"
              cx="3"
              cy="12"
              r="1.6"
            /><circle class="mm-hole" cx="8" cy="4" r="1.6" /><circle
              class="mm-dot"
              cx="13"
              cy="12"
              r="2"
            /></svg
          >
        {/if}
      </span>
      <span class="mm-text">
        <span class="mm-name"
          >{method}{#if method === defaultMethod}<span class="mm-default"
              >{m.mergemethod_default()}</span
            >{/if}</span
        >
        <span class="mm-hint">{hint(method)}</span>
      </span>
    </button>
  {/each}
  <p class="mm-note" aria-hidden="true">{m.mergemethod_note()}</p>
</div>

<style>
  .mm {
    position: fixed;
    z-index: 60;
    /* Fixed width so the measuring effect clamps against a stable size (see AddRepoMenu). */
    width: min(320px, calc(100vw - 16px));
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
  .mm:focus {
    outline: none;
  }
  .mm-head {
    padding: 4px 10px 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .mm-item {
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
  .mm-item:hover,
  .mm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .mm-item[aria-disabled="true"] {
    cursor: not-allowed;
  }
  .mm-tile {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .mm-item[aria-disabled="true"] .mm-tile {
    border-style: dashed;
  }
  .mm-tile svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
  .mm-tile .mm-dot {
    fill: currentColor;
  }
  /* A commit that is not the landed one: hollow, punching the line it sits on. */
  .mm-tile .mm-hole {
    fill: var(--color-panel);
  }
  .mm-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .mm-name {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 700;
  }
  .mm-item[aria-disabled="true"] .mm-name {
    color: var(--color-muted);
  }
  .mm-default {
    padding: 0 4px;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-weight: 400;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .mm-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .mm-note {
    margin: 4px 0 0;
    padding: 6px 10px 4px;
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  @media (max-width: 768px), (pointer: coarse) {
    .mm-item {
      min-height: 44px;
    }
  }
</style>
