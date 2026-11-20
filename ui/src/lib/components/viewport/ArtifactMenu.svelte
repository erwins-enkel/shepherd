<script lang="ts">
  import { relativeTimeAgo } from "#lib/format.js";
  import { getLocale } from "#lib/i18n.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { portal } from "#lib/portal.js";
  import type { SessionArtifact } from "#lib/types.js";
  import { isArtifactUrl } from "../../../../../shared/artifact-url";

  // The session's artifacts menu (#3877): a small anchored, non-blocking popover (no scrim) above
  // the trigger in the artifact row or the merge row. "all" lists every artifact, newest first —
  // each one opens (the entry itself), copies its link or shows its publish in the Chat — and ends
  // with "Hide for this session"; "single" is the one-artifact row's ⋯ (show in Chat, hide).
  // Dismissed by Esc, an outside click or a scroll outside it; focus goes back to the trigger.
  // Title and url are agent data: text only, and an href only as a validated claude.ai artifact.
  let {
    anchor,
    opener,
    artifacts,
    mode = "all",
    touch = false,
    onshowinchat,
    onhide,
    onclose,
  }: {
    anchor: DOMRect;
    /** The trigger; focus returns here on close. */
    opener?: HTMLElement;
    /** Newest first; "single" acts on the first. */
    artifacts: SessionArtifact[];
    mode?: "all" | "single";
    /** Any touch device: 44px targets. */
    touch?: boolean;
    /** Show a publish in the Chat; absent hides the items. */
    onshowinchat?: (toolUseId: string | null) => void;
    /** Hide the row for this session; absent hides the item. */
    onhide?: () => void;
    onclose: () => void;
  } = $props();

  let el = $state<HTMLDivElement>();
  let pos = $state<{ left: number; top: number; maxHeight: number } | null>(null);

  // Above the trigger when it fits or has the more room (the rows sit at the bottom of the pane),
  // else below; right-aligned to the trigger and clamped inside the viewport. A long list scrolls.
  $effect(() => {
    const node = el;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const above = anchor.top - 4 - margin;
    const below = window.innerHeight - anchor.bottom - 4 - margin;
    const up = r.height <= above || above >= below;
    const maxHeight = Math.max(0, up ? above : below);
    const height = Math.min(r.height, maxHeight);
    const left = Math.min(anchor.right - r.width, window.innerWidth - r.width - margin);
    pos = {
      left: Math.max(margin, left),
      top: up ? anchor.top - 4 - height : anchor.bottom + 4,
      maxHeight,
    };
    items()[0]?.focus();
  });

  function items(): HTMLElement[] {
    return el ? Array.from(el.querySelectorAll<HTMLElement>(".am-item")) : [];
  }

  /** The menu's rows: an entry (Open, Copy, Chat) or a standalone item. */
  function rows(): HTMLElement[][] {
    if (!el) return [];
    return Array.from(el.querySelectorAll<HTMLElement>("[data-am-row]")).map((row) =>
      row.classList.contains("am-item")
        ? [row]
        : Array.from(row.querySelectorAll<HTMLElement>(".am-item")),
    );
  }

  // ↑/↓ move between rows (onto a row's first item), ←/→ within a row, Home/End to the first or
  // last row, Tab through every item in order. A key handled here goes no further.
  function onNav(e: KeyboardEvent) {
    const grid = rows().filter((row) => row.length > 0);
    if (grid.length === 0) return;
    const active = document.activeElement as HTMLElement;
    const r = grid.findIndex((row) => row.includes(active));
    const c = r < 0 ? -1 : grid[r]!.indexOf(active);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = grid[(r + 1) % grid.length]![0];
    else if (e.key === "ArrowUp") next = grid[(r - 1 + grid.length) % grid.length]![0];
    else if (e.key === "Home") next = grid[0]![0];
    else if (e.key === "End") next = grid[grid.length - 1]![0];
    else if (e.key === "ArrowRight" && r >= 0) next = grid[r]![(c + 1) % grid[r]!.length];
    else if (e.key === "ArrowLeft" && r >= 0)
      next = grid[r]![(c - 1 + grid[r]!.length) % grid[r]!.length];
    else if (e.key === "Tab") {
      const all = items();
      const i = all.indexOf(active);
      next = all[e.shiftKey ? (i - 1 + all.length) % all.length : (i + 1) % all.length];
    } else return;
    // Handled here only: the dashboard's window shortcut switches sessions on a plain ↑/↓.
    e.preventDefault();
    e.stopPropagation();
    next?.focus();
  }

  function pick(action: () => void) {
    onclose();
    action();
  }

  let copied = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let open = true;
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return; // clipboard blocked (insecure context / denied) — fail quietly, like the row
    }
    if (!open) return; // the menu closed meanwhile: nothing left to confirm on
    copied = url;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = null), 1500);
  }

  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onclose();
    }
    function onPointer(e: Event) {
      const t = e.target as Node;
      if (el && !el.contains(t) && !opener?.contains(t)) onclose();
    }
    // The list scrolls itself; only a scroll elsewhere moves the trigger away from the menu.
    function onScroll(e: Event) {
      if (!(e.target instanceof Node) || !el?.contains(e.target)) onclose();
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      open = false;
      clearTimeout(copiedTimer);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      const target = opener;
      queueMicrotask(() => {
        if (target?.isConnected && document.activeElement === document.body) target.focus();
      });
    };
  });

  const first = $derived(artifacts[0]);
</script>

<div
  bind:this={el}
  use:portal
  class={["am-menu", { touch, single: mode === "single" }]}
  role="menu"
  tabindex="-1"
  aria-label={m.artifactrow_menu_label()}
  style:left="{pos?.left ?? anchor.left}px"
  style:top="{pos?.top ?? anchor.top}px"
  style:max-height={pos ? `${pos.maxHeight}px` : undefined}
  onkeydown={onNav}
>
  {#if mode === "all"}
    <p class="am-head" aria-hidden="true">{m.artifactrow_menu_head()}</p>
    <div class="am-list">
      {#each artifacts as a (a.url)}
        <div class="am-entry" role="group" aria-label={a.title} data-am-row>
          <!-- eslint-disable svelte/no-navigation-without-resolve -- external claude.ai URL, not an app route -->
          <a
            class="am-item am-open"
            role="menuitem"
            tabindex="-1"
            href={isArtifactUrl(a.url) ? a.url : undefined}
            target="_blank"
            rel="noopener"
            onclick={onclose}
          >
            <span class="am-glyph" aria-hidden="true"></span>
            <span class="am-text">
              <span class="am-title">{a.title}</span>
              <span class="am-facts"
                >{m.artifactrow_menu_facts({
                  n: a.versions,
                  when: relativeTimeAgo(a.updatedAt, clock.current, getLocale()),
                })}</span
              >
            </span>
            <span class="am-go">{m.artifactrow_open()}</span>
          </a>
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
          <button
            class="am-item am-icon"
            type="button"
            role="menuitem"
            tabindex="-1"
            aria-label={copied === a.url ? m.artifactrow_copied() : m.artifactrow_copy()}
            onclick={() => copy(a.url)}
            ><span aria-hidden="true">{copied === a.url ? "✓" : "⧉"}</span></button
          >
          {#if onshowinchat}
            <button
              class="am-item am-icon"
              type="button"
              role="menuitem"
              tabindex="-1"
              aria-label={m.artifactrow_show_in_chat()}
              onclick={() => pick(() => onshowinchat(a.toolUseId))}
              ><span aria-hidden="true">↳</span></button
            >
          {/if}
        </div>
      {/each}
    </div>
  {:else if first && onshowinchat}
    <button
      class="am-item am-line"
      type="button"
      role="menuitem"
      tabindex="-1"
      data-am-row
      onclick={() => pick(() => onshowinchat(first.toolUseId))}
      >{m.artifactrow_show_in_chat()}</button
    >
  {/if}
  {#if onhide}
    <button
      class={["am-item am-line", { "am-foot": mode === "all" }]}
      type="button"
      role="menuitem"
      tabindex="-1"
      data-am-row
      onclick={() => pick(onhide)}>{m.artifactrow_hide()}</button
    >
  {/if}
</div>
<span class="am-status" role="status">{copied ? m.artifactrow_copied() : ""}</span>

<style>
  .am-menu {
    position: fixed;
    z-index: 60;
    width: 420px;
    max-width: calc(100vw - 16px);
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    box-shadow: 0 8px 24px color-mix(in srgb, var(--color-bg) 70%, transparent);
    display: flex;
    flex-direction: column;
    gap: 1px;
    box-sizing: border-box;
  }
  .am-menu.single {
    width: auto;
    min-width: 200px;
  }
  .am-menu:focus {
    outline: none;
  }
  .am-head {
    flex: none;
    margin: 0;
    padding: 7px 11px 5px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .am-list {
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .am-entry {
    display: flex;
    align-items: stretch;
    gap: 1px;
    min-width: 0;
  }
  .am-item {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 36px;
    padding: 7px 11px;
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
  .am-item:hover,
  .am-item:focus-visible {
    background: var(--color-hover);
    outline: none;
  }
  .am-open {
    flex: 1;
    min-width: 0;
  }
  .am-glyph {
    flex: none;
    width: 7px;
    height: 7px;
    background: var(--color-blue);
    transform: rotate(45deg);
  }
  .am-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .am-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .am-facts {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
  }
  .am-go {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .am-item:hover .am-go,
  .am-item:focus-visible .am-go {
    color: var(--color-amber);
  }
  .am-icon {
    flex: none;
    justify-content: center;
    width: 36px;
    padding: 0;
    color: var(--color-muted);
  }
  .am-icon:hover,
  .am-icon:focus-visible {
    color: var(--color-ink-bright);
  }
  .am-line {
    width: 100%;
  }
  .am-foot {
    flex: none;
    margin-top: 3px;
    border-top: 1px solid var(--color-line);
    border-radius: 0 0 2px 2px;
    color: var(--color-ink);
  }
  /* touch: every item is a full 44px target */
  .am-menu.touch .am-item {
    min-height: var(--mobile-actionbar-hit);
  }
  .am-menu.touch .am-icon {
    width: var(--mobile-actionbar-hit);
  }
  /* announces "Link copied" to assistive tech; never seen */
  .am-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
