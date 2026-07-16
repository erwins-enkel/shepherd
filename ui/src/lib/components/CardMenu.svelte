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
    opener,
    onmergepr,
    onresume,
    onrename,
    onrelaunch,
    onrelaunchElsewhere,
    onvariant,
    onreplace,
    ondecommission,
    onclose,
  }: {
    // viewport coordinates of the pointer/long-press that opened the menu
    x: number;
    y: number;
    // whether the Resume action applies to this session right now
    resumable: boolean;
    // the element that opened the menu (the card hit-target) — focus returns here on close
    opener?: HTMLElement;
    // when provided, a two-step armed "Merge PR" item appears at the top (the session's PR is
    // eligible to merge). Positive but consequential, so it arms amber (not the red danger wash) —
    // the parent's handler closes over the session id + runs the merge, like the badge menu.
    onmergepr?: () => void;
    onresume?: () => void;
    onrename?: () => void;
    // when provided, a two-step armed Relaunch item appears between Resume and
    // Decommission (the parent closes over the session id, like onresume/ondecommission)
    onrelaunch?: () => void;
    // when provided, a one-click "Relaunch elsewhere" item appears below Relaunch —
    // no two-step arm (the composer dialog + explicit submit is the confirmation)
    onrelaunchElsewhere?: () => void;
    // when provided, "Start as variant…" / "Continue with…" items appear — each opens the
    // provider/model picker (its explicit confirm is the confirmation, so no two-step arm here)
    onvariant?: () => void;
    onreplace?: () => void;
    ondecommission?: () => void;
    onclose: () => void;
  } = $props();

  // Two-step arm → confirm for Relaunch: relaunch is irreversible (it discards the
  // original's worktree), so the first click arms (label switches to the confirm
  // text) and only a second click within the window fires it. Auto-disarms after the
  // window; the timer is cleared on unmount (the menu tears down on Esc / outside-click
  // / scroll, and a dangling timer must not fire after teardown).
  const RELAUNCH_ARM_MS = 3000;
  let relaunchArmed = $state(false);
  let relaunchTimer: ReturnType<typeof setTimeout> | undefined;
  function onRelaunchClick() {
    if (relaunchArmed) {
      clearTimeout(relaunchTimer);
      relaunchArmed = false;
      onrelaunch?.();
      return;
    }
    relaunchArmed = true;
    clearTimeout(relaunchTimer);
    relaunchTimer = setTimeout(() => (relaunchArmed = false), RELAUNCH_ARM_MS);
  }
  $effect(() => () => clearTimeout(relaunchTimer));

  // Two-step arm → confirm for Merge PR (GitRail/PrBadge parity): merging is consequential, so the
  // first click arms (label swaps to the confirm text) and only a second click within the window
  // fires it. Same 3s window + unmount cleanup as Relaunch, but armed amber (positive, not danger).
  const MERGE_ARM_MS = 3000;
  let mergeArmed = $state(false);
  let mergeTimer: ReturnType<typeof setTimeout> | undefined;
  function onMergeClick() {
    if (mergeArmed) {
      clearTimeout(mergeTimer);
      mergeArmed = false;
      onmergepr?.();
      return;
    }
    mergeArmed = true;
    clearTimeout(mergeTimer);
    mergeTimer = setTimeout(() => (mergeArmed = false), MERGE_ARM_MS);
  }
  $effect(() => () => clearTimeout(mergeTimer));

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
  // Arrow / Home / End roving focus, as a role="menu" is expected to support. Tab
  // is trapped (cycled like the arrows) so focus can't escape the open menu — the
  // only ways out are Esc, an action, or an outside click, all of which close it.
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
      // Every close path (Esc / action / outside-click / scroll) unmounts the menu,
      // so returning focus to the trigger here covers them all. Deferred to a
      // microtask so the browser has applied any click-driven focus first, then
      // only restore when focus actually fell to <body> — an outside-click on a
      // focusable element keeps its focus, an action that moved focus (e.g. into the
      // resumed terminal) keeps that, and a decommissioned row's detached button
      // no-ops via isConnected.
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
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
  {#if onmergepr}
    <button
      class="cm-item"
      class:merge-armed={mergeArmed}
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={onMergeClick}
    >
      <span class="cm-icon" aria-hidden="true">⇥</span>{mergeArmed
        ? m.prbadge_confirm_merge()
        : m.prbadge_merge()}
    </button>
  {/if}
  {#if resumable && onresume}
    <button class="cm-item" type="button" role="menuitem" tabindex="-1" onclick={onresume}>
      <span class="cm-icon" aria-hidden="true">↻</span>{m.cardmenu_resume()}
    </button>
  {/if}
  {#if onrename}
    <button class="cm-item" type="button" role="menuitem" tabindex="-1" onclick={onrename}>
      <span class="cm-icon" aria-hidden="true">✎</span>{m.cardmenu_rename()}
    </button>
  {/if}
  {#if onrelaunch}
    <button
      class="cm-item"
      class:armed={relaunchArmed}
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={onRelaunchClick}
    >
      <span class="cm-icon" aria-hidden="true">{relaunchArmed ? "⚠" : "♻"}</span>{relaunchArmed
        ? m.cardmenu_relaunch_confirm()
        : m.cardmenu_relaunch()}
    </button>
  {/if}
  {#if onrelaunchElsewhere}
    <button
      class="cm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      onclick={onrelaunchElsewhere}
    >
      <span class="cm-icon" aria-hidden="true">⇄</span>{m.cardmenu_relaunch_elsewhere()}
    </button>
  {/if}
  {#if onvariant}
    <button class="cm-item" type="button" role="menuitem" tabindex="-1" onclick={onvariant}>
      <span class="cm-icon" aria-hidden="true">⎌</span>{m.cardmenu_start_variant()}
    </button>
  {/if}
  {#if onreplace}
    <button class="cm-item" type="button" role="menuitem" tabindex="-1" onclick={onreplace}>
      <span class="cm-icon" aria-hidden="true">⇆</span>{m.cardmenu_replace_with()}
    </button>
  {/if}
  {#if ondecommission}
    <button
      class="cm-item danger"
      type="button"
      role="menuitem"
      tabindex="-1"
      title={m.viewport_decommission_title()}
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
    /* Never wider than the viewport minus the JS clamp's 8px margin per side,
       so the position clamp above can always fit the menu on narrow phones
       (long labels wrap instead of overflowing). */
    max-width: calc(100vw - 16px);
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
  /* Armed relaunch: the first click only arms the two-step confirm (label swaps to
     the confirm text + the ⚠ glyph). Without a colour shift the change was too quiet
     to read as "click again to confirm" — operators saw the label toggle and thought
     relaunch did nothing. The danger wash marks it hot so the second click is obvious. */
  .cm-item.armed {
    color: var(--color-red);
    background: color-mix(in srgb, var(--color-red) 14%, var(--color-panel));
  }
  .cm-item.armed:hover,
  .cm-item.armed:focus-visible {
    background: color-mix(in srgb, var(--color-red) 22%, var(--color-panel));
  }
  /* Armed merge: positive-but-consequential, so it arms amber (like .gbtn.armed / PrBadgeMenu's
     merge), not the red danger wash relaunch uses. The wash marks it hot so the second click reads
     as "click again to confirm". */
  .cm-item.merge-armed {
    color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 14%, var(--color-panel));
  }
  .cm-item.merge-armed:hover,
  .cm-item.merge-armed:focus-visible {
    background: color-mix(in srgb, var(--color-amber) 22%, var(--color-panel));
  }
  .cm-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
  }
</style>
