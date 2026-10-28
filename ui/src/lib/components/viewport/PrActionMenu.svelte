<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { portal } from "#lib/portal.js";

  // The merge row's ⋯ menu (#3540): the row's secondary PR actions. A small anchored,
  // non-blocking popover (no scrim) — dismissed by Esc, an outside click or a scroll. The row
  // owns the open state and every action; this only positions and renders. Each item renders
  // only while the row offers it.
  let {
    anchor,
    opener,
    ready,
    showReady,
    issueHref,
    showSummary,
    reviewLabel,
    onready,
    onsummary,
    onreview,
    onclose,
  }: {
    anchor: DOMRect;
    /** The ⋯ button; focus returns here on close. */
    opener?: HTMLElement;
    ready: boolean;
    showReady: boolean;
    /** The linked issue's safe URL; null hides the item. */
    issueHref: string | null;
    showSummary: boolean;
    /** The critic trigger's label; null hides the item (it lives in the row on wide layouts). */
    reviewLabel: string | null;
    onready: () => void;
    onsummary: () => void;
    onreview: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();
  let pos = $state<{ left: number; top: number } | null>(null);

  // Below the anchor when it fits, else above (the row sits at the bottom of the pane, so it
  // usually opens upward); clamped inside the viewport.
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
    items()[0]?.focus();
  });

  function items(): HTMLElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLElement>(".pm-item")) : [];
  }

  function onNav(e: KeyboardEvent) {
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
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

  function pick(action: () => void) {
    onclose();
    action();
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
  class="pra-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.prbadge_menu_label()}
  style="left:{pos?.left ?? anchor.left}px;top:{pos?.top ?? anchor.bottom + 4}px"
  onkeydown={onNav}
>
  {#if showReady}
    <button
      class="pm-item"
      type="button"
      role="menuitemcheckbox"
      aria-checked={ready}
      tabindex="-1"
      title={ready ? m.gitrail_ready_on_title() : m.gitrail_ready_off_title()}
      onclick={() => pick(onready)}
    >
      <span class="pm-icon" class:on={ready} aria-hidden="true">{ready ? "✓" : "□"}</span
      >{m.prrow_menu_mark_ready()}
    </button>
  {/if}
  {#if issueHref}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
    <a
      class="pm-item"
      role="menuitem"
      tabindex="-1"
      href={issueHref}
      target="_blank"
      rel="noopener"
      onclick={onclose}>{m.gitrail_open_issue()}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {/if}
  {#if showSummary}
    <button
      class="pm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={() => pick(onsummary)}
    >
      {m.prrow_menu_summary()}
    </button>
  {/if}
  {#if reviewLabel}
    <button
      class="pm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={() => pick(onreview)}
    >
      {reviewLabel}
    </button>
  {/if}
</div>

<style>
  .pra-menu {
    position: fixed;
    z-index: 60;
    min-width: 200px;
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
  .pra-menu:focus {
    outline: none;
  }
  .pm-item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 36px;
    padding: 9px 11px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    box-sizing: border-box;
  }
  .pm-item:hover,
  .pm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .pm-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
    color: var(--color-muted);
  }
  .pm-icon.on {
    color: var(--color-green);
  }
  /* touch: every item is a full 44px target */
  @media (pointer: coarse) {
    .pm-item {
      min-height: var(--mobile-actionbar-hit);
    }
  }
</style>
