<script lang="ts">
  import type { Steer } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  // Small anchored, non-blocking context menu for an issue row (desktop right-click
  // or touch long-press, both via issueMenuTrigger). Per the design system's popover
  // rule it gets NO scrim/blur — it dismisses on outside-click, Esc or scroll.
  // Modelled on CardMenu/SteerMenu, with one critical difference: it renders INSIDE
  // a11yDialog modals (NewTask, BacklogOverlay), so its Escape handler runs in
  // CAPTURE phase and preventDefault()s — otherwise a11yDialog (which yields only on
  // defaultPrevented, and listens on an ancestor node in the bubble phase) would also
  // close the host dialog and lose the composed prompt.
  let {
    x,
    y,
    number,
    steers,
    canSteer,
    opener,
    onopenissue,
    ondetails,
    onsteer,
    onclose,
  }: {
    // viewport coordinates of the right-click / long-press that opened the menu
    x: number;
    y: number;
    // the issue number, woven into the menu's accessible name
    number: number;
    // issue-scoped steers to offer as inject actions
    steers: Steer[];
    // false for epic-parent rows → the steer items are omitted (launching an epic
    // via a manual task collides with the Epic Runner)
    canSteer: boolean;
    // the row that opened the menu — focus returns here on close
    opener?: HTMLElement;
    onopenissue: () => void;
    ondetails: () => void;
    onsteer: (steer: Steer) => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();

  // Clamp the menu inside the viewport so it never spills off the bottom/right edge.
  // Measured after mount; until then the template falls back to the raw pointer (x/y).
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

  function items(): HTMLButtonElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLButtonElement>(".im-item")) : [];
  }
  // Arrow / Home / End roving focus; Tab is trapped (cycled) so focus can't escape.
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
      if (e.key !== "Escape") return;
      // Capture phase + preventDefault + stopPropagation: beat a11yDialog's ancestor
      // (bubble-phase) Escape handler so Esc closes only this menu, not the host dialog.
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
    function onPointer(e: Event) {
      if (el && !el.contains(e.target as Node)) onclose();
    }
    window.addEventListener("keydown", onKeydown, { capture: true });
    // capture so we beat the row's own handlers; scroll dismisses (the anchor moves)
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onclose, true);
    return () => {
      window.removeEventListener("keydown", onKeydown, { capture: true });
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onclose, true);
      // Return focus to the opener once the menu unmounts, but only when focus fell to
      // <body> — an action that moved focus elsewhere (into the details popover, into
      // the prompt textarea) keeps it.
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="issue-menu"
  role="menu"
  tabindex="-1"
  aria-label={m.issuemenu_aria({ number })}
  style="left:{pos?.left ?? x}px;top:{pos?.top ?? y}px"
  onkeydown={onNav}
>
  <button class="im-item" type="button" role="menuitem" tabindex="-1" onclick={onopenissue}>
    <span class="im-icon" aria-hidden="true">↗</span>{m.issuemenu_open()}
  </button>
  <button class="im-item" type="button" role="menuitem" tabindex="-1" onclick={ondetails}>
    <span class="im-icon" aria-hidden="true">≡</span>{m.issuemenu_details()}
  </button>
  {#if canSteer && steers.length > 0}
    <div class="im-sep" role="separator"></div>
    {#each steers as s (s.id)}
      <button
        class="im-item"
        type="button"
        role="menuitem"
        tabindex="-1"
        title={s.text}
        aria-label={m.issuemenu_inject_aria({ label: s.label })}
        onclick={() => onsteer(s)}
      >
        <span class="im-icon" aria-hidden="true">{s.emoji ?? "▷"}</span><span class="im-label"
          >{s.label}</span
        >
      </button>
    {/each}
  {/if}
</div>

<style>
  .issue-menu {
    position: fixed;
    z-index: 60;
    min-width: 180px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    /* established popover shadow (matches CardMenu/SteerMenu) — no token exists */
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .issue-menu:focus {
    outline: none;
  }
  .im-item {
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
  .im-item:hover,
  .im-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .im-icon {
    font-size: var(--fs-meta);
    width: 1em;
    text-align: center;
    flex-shrink: 0;
  }
  /* Steer label — the steer's text rides in the title/aria; cap a long label so the
     menu keeps a sane width. */
  .im-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .im-sep {
    height: 1px;
    margin: 3px 6px;
    background: var(--color-line);
  }
</style>
