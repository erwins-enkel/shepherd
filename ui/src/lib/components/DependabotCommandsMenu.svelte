<script lang="ts">
  import type { DependabotCommand } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import { DEPENDABOT_IGNORE_COMMANDS, dependabotLevel } from "./up-next-pr-copy";

  // The "Dependabot ▾" beside an Up Next PR's actions: the comment commands Dependabot takes on its
  // own PR. Rebase posts at once; the rest go through the caller's confirmation. Same anchored,
  // non-blocking recipe as MergeMethodMenu (clamp, roving focus, focus restore).
  let {
    anchor,
    number,
    showRebase,
    rebaseRequested,
    targets,
    onrebase,
    onpick,
    onclose,
  }: {
    anchor: HTMLElement;
    /** The PR number, woven into the menu's accessible name. */
    number: number;
    /** False while Rebase is already the PR's primary action. */
    showRebase: boolean;
    /** Dependabot is asked to rebase once per PR. */
    rebaseRequested: boolean;
    /** One ignore row each (`dependabotIgnoreTargets`); null while the description loads. */
    targets: (string | null)[] | null;
    onrebase: () => void;
    onpick: (command: DependabotCommand, dependency?: string) => void;
    onclose: () => void;
  } = $props();

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
  // Measured again when the description's dependencies arrive and change the menu's height.
  $effect(() => {
    void targets;
    const node = el;
    if (!node) return;
    const a = anchor.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(a.left, window.innerWidth - r.width - margin);
    const top = Math.min(a.bottom + 4, window.innerHeight - r.height - margin);
    pos = { left: Math.max(margin, left), top: Math.max(margin, top) };
  });
  $effect(() => {
    if (el) menuButtons()[0]?.focus();
  });

  function menuButtons(): HTMLButtonElement[] {
    return el
      ? Array.from(el.querySelectorAll<HTMLButtonElement>("button:not([aria-disabled='true'])"))
      : [];
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
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = fwd;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = back;
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
    // A long dependency list scrolls inside the menu; only a scroll outside moves the anchor.
    function onScroll(e: Event) {
      if (!el?.contains(e.target as Node)) onclose();
    }
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      const target = anchor;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });
</script>

<div
  bind:this={el}
  class="dm"
  role="menu"
  tabindex="-1"
  aria-label={m.depcmd_menu_aria({ number })}
  style="left:{shown.left}px;top:{shown.top}px"
  onkeydown={onNav}
>
  {#if showRebase}
    <button
      class="dm-item"
      type="button"
      role="menuitem"
      tabindex="-1"
      aria-disabled={rebaseRequested ? "true" : undefined}
      onclick={() => {
        if (!rebaseRequested) onrebase();
      }}
    >
      <span class="dm-name"
        >{rebaseRequested ? m.prspanel_rebase_requested() : m.depcmd_rebase()}</span
      >
      <span class="dm-hint">{m.depcmd_rebase_hint()}</span>
    </button>
  {/if}
  <button
    class="dm-item"
    type="button"
    role="menuitem"
    tabindex="-1"
    onclick={() => onpick("recreate")}
  >
    <span class="dm-name">{m.depcmd_recreate()}</span>
    <span class="dm-hint">{m.depcmd_recreate_hint()}</span>
  </button>
  <span class="dm-head" aria-hidden="true">{m.depcmd_ignore_head()}</span>
  {#if targets === null}
    <p class="dm-note" role="status">{m.depcmd_loading()}</p>
  {:else if targets.length === 0}
    <p class="dm-note">{m.depcmd_unavailable()}</p>
  {:else}
    <div class="dm-rows">
      {#each targets as target (target)}
        {@const name = target ?? m.depcmd_this_update()}
        <div class="dm-row">
          <span class="dm-dep" class:mono={target !== null} title={name}>{name}</span>
          <span class="dm-levels">
            {#each DEPENDABOT_IGNORE_COMMANDS as command (command)}
              <button
                class="dm-level"
                type="button"
                role="menuitem"
                tabindex="-1"
                aria-label={m.depcmd_ignore_aria({ level: dependabotLevel(command), name })}
                onclick={() => onpick(command, target ?? undefined)}
                >{dependabotLevel(command)}</button
              >
            {/each}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .dm {
    position: fixed;
    z-index: 60;
    /* Fixed width so the measuring effect clamps against a stable size (see AddRepoMenu). */
    width: min(380px, calc(100vw - 16px));
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
  .dm:focus {
    outline: none;
  }
  .dm-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
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
  .dm-item:hover,
  .dm-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .dm-item[aria-disabled="true"] {
    cursor: not-allowed;
  }
  .dm-name {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 700;
  }
  .dm-item[aria-disabled="true"] .dm-name {
    color: var(--color-muted);
  }
  .dm-hint {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .dm-head {
    margin-top: 4px;
    padding: 6px 10px 2px;
    border-top: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .dm-note {
    margin: 0;
    padding: 6px 10px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .dm-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 220px;
    overflow-y: auto;
  }
  .dm-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 4px 10px;
  }
  .dm-dep {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink);
    font-size: var(--fs-meta);
  }
  .dm-dep.mono {
    font-family: var(--font-mono);
  }
  .dm-levels {
    flex: none;
    display: flex;
    gap: 4px;
  }
  .dm-level {
    padding: 3px 7px;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    text-transform: capitalize;
    cursor: pointer;
  }
  .dm-level:hover,
  .dm-level:focus-visible {
    background: var(--color-hover);
    outline: none;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .dm-item {
      min-height: 44px;
    }
    .dm-level {
      min-height: 44px;
      min-width: 44px;
    }
  }
</style>
