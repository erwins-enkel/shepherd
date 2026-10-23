<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import type { RepoEntry } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { listRepos } from "#lib/api.js";
  import { basename } from "#lib/basename.js";
  import { displayStatus } from "#lib/display-status.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import type { AssistantEntry, AssistantLifecycle } from "#lib/operator-assistant.svelte.js";
  import AssistantBar from "./AssistantBar.svelte";
  import AssistantMark from "./AssistantMark.svelte";

  // The Operator Assistant dock (#1446): every assistant the operator has, stacked. The global one
  // is always first and is all a fresh install has; a repo assistant (started from a repo chip's
  // menu, or from + Repo assistant here) joins below it. One is open at a time; the others fold
  // into bars that keep their state and newest reply in view, and their order never moves, so a
  // bar is always where the operator last saw it. On a phone the stack becomes tabs in the open
  // assistant's header, since a phone has room for one conversation.
  let {
    entries,
    open,
    mobile = false,
    lifecycle,
    addable = true,
    workingBlocked = {},
    backgroundBusy = {},
    onopen,
    onstart,
    onclose,
    panel,
  }: {
    entries: AssistantEntry[];
    /** The open assistant's repo; null = the global one. */
    open: string | null;
    mobile?: boolean;
    lifecycle: AssistantLifecycle;
    /** Offer + Repo assistant (not in the demo, which runs no agents). */
    addable?: boolean;
    workingBlocked?: Record<string, boolean>;
    backgroundBusy?: Record<string, boolean>;
    /** Open (expand) an assistant already in the dock. */
    onopen: (repo: string | null) => void;
    /** Start a repo's assistant (or open it, when one runs). */
    onstart: (repo: string) => void;
    /** Close the dock (desktop). */
    onclose: () => void;
    /** The open assistant's panel; on a phone it gets the tabs to put in its header. */
    panel: Snippet<[AssistantEntry, Snippet | undefined]>;
  } = $props();

  const openEntry = $derived(entries.find((e) => e.repo === open) ?? entries[0]);
  const nameOf = (e: AssistantEntry) =>
    e.repo === null ? m.operator_assistant_title() : basename(e.repo);
  const pipOf = (e: AssistantEntry) => {
    if (!e.session) return null;
    const s = displayStatus(e.session, workingBlocked, backgroundBusy);
    return s === "running" ? "working" : s === "blocked" ? "blocked" : null;
  };

  // ── + Repo assistant ──────────────────────────────────────────────────────
  let menuOpen = $state(false);
  let repos = $state<RepoEntry[] | null>(null);
  let addBtn: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLDivElement | undefined = $state();
  const running = $derived(new Set(entries.map((e) => e.repo).filter((r) => r !== null)));
  const menuRepos = $derived(
    (repos ?? [])
      .filter((r) => !r.hidden || running.has(r.path))
      .toSorted((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
  );

  async function openMenu() {
    menuOpen = true;
    listRepos()
      .then((r) => (repos = r.repos))
      .catch(() => (repos ??= []));
    await tick();
    firstItem()?.focus();
  }
  function closeMenu(refocus = true) {
    menuOpen = false;
    if (refocus) addBtn?.focus();
  }
  function items(): HTMLElement[] {
    return [...(menuEl?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
  }
  const firstItem = () => items()[0];
  function pick(repo: string) {
    closeMenu(false);
    onstart(repo);
  }
  function onMenuKey(e: KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    }
  }
  // Outside click closes, the add button's own click toggles.
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuEl?.contains(t) && !addBtn?.contains(t)) closeMenu(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  });
</script>

{#snippet addButton(compact: boolean)}
  <button
    bind:this={addBtn}
    type="button"
    class="oad-add"
    class:compact
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-label={compact ? m.assistant_dock_add_aria() : undefined}
    use:coachTarget={"assistant-dock-add"}
    onclick={() => (menuOpen ? closeMenu(false) : void openMenu())}
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg
    >
    {#if !compact}<span>{m.assistant_dock_add()}</span>{/if}
  </button>
{/snippet}

{#snippet menu()}
  {#if menuOpen}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      bind:this={menuEl}
      class="oad-menu"
      class:phone={mobile}
      role="menu"
      aria-label={m.assistant_dock_menu_label()}
      onkeydown={onMenuKey}
    >
      <span class="oad-menu-head">{m.assistant_dock_menu_label()}</span>
      {#if repos === null}
        <span class="oad-menu-note">{m.common_loading()}</span>
      {:else if menuRepos.length === 0}
        <span class="oad-menu-note">{m.assistant_dock_menu_empty()}</span>
      {/if}
      {#each menuRepos as r (r.path)}
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="oad-menu-item"
          onclick={() => pick(r.path)}
        >
          <AssistantMark repo={r.path} size={20} />
          <span class="oad-menu-name">{r.name}</span>
          {#if running.has(r.path)}
            <span class="oad-menu-tag">{m.assistant_dock_running()}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet tabs()}
  <div class="oad-tabs-wrap">
    <div class="oad-tabs" role="tablist" aria-label={m.assistant_dock_label()}>
      {#each entries as e (e.repo ?? "")}
        <button
          type="button"
          role="tab"
          class="oad-tab"
          aria-selected={e === openEntry}
          onclick={() => onopen(e.repo)}
        >
          <AssistantMark repo={e.repo} pip={pipOf(e)} size={22} />
          <span>{e.repo === null ? m.assistant_dock_all_tab() : nameOf(e)}</span>
        </button>
      {/each}
      {#if addable}{@render addButton(true)}{/if}
    </div>
    {@render menu()}
  </div>
{/snippet}

{#if mobile}
  {@render panel(openEntry, tabs)}
{:else}
  <section class="oad" data-assistant-dock aria-label={m.assistant_dock_label()}>
    <div class="oad-strip">
      <span class="oad-label"
        >{entries.length > 1
          ? m.assistant_dock_count({ count: entries.length })
          : m.assistant_dock_label()}</span
      >
      {#if addable}{@render addButton(false)}{/if}
      <button
        type="button"
        class="icon-btn oad-close"
        aria-label={m.operator_assistant_close()}
        onclick={onclose}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg
        >
      </button>
      {@render menu()}
    </div>
    {#each entries as e (e.repo ?? "")}
      {#if e === openEntry}
        {@render panel(e, undefined)}
      {:else}
        <AssistantBar
          repo={e.repo}
          name={nameOf(e)}
          scope={e.repo === null ? m.assistant_dock_all_repos() : null}
          session={e.session}
          pending={lifecycle.pendingFor(e.repo)}
          failed={lifecycle.failedFor(e.repo)}
          {workingBlocked}
          {backgroundBusy}
          onexpand={() => onopen(e.repo)}
        />
      {/if}
    {/each}
  </section>
{/if}

<style>
  /* The desktop grid's third track: a column of cards, the open one taking what is left. */
  .oad {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .oad-strip {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding-left: 4px;
  }
  .oad-label {
    flex: 1;
    min-width: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  /* Button recipe (/design-system .gbtn), at the strip's size. */
  .oad-add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .oad-add svg {
    width: 12px;
    height: 12px;
  }
  .oad-add:hover,
  .oad-add[aria-expanded="true"] {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .oad-add:focus-visible,
  .oad-tab:focus-visible,
  .oad-menu-item:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .oad-add.compact {
    flex: none;
    justify-content: center;
    width: 44px;
    min-height: 44px;
    padding: 0;
    border-style: dashed;
    border-radius: var(--radius-chip);
  }
  .oad-add.compact svg {
    width: 16px;
    height: 16px;
  }
  .oad-close {
    color: var(--color-muted);
    margin-right: -4px;
  }
  /* Anchored, non-modal popover (no scrim): Escape or an outside click dismisses it. */
  .oad-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 32px;
    z-index: 20;
    width: min(300px, calc(100vw - 32px));
    max-height: min(420px, 60vh);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: var(--radius-chip);
    box-shadow: var(--shadow-popover);
  }
  .oad-menu.phone {
    right: 16px;
  }
  .oad-menu-head {
    padding: 6px 10px 4px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .oad-menu-note {
    padding: 6px 10px 8px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .oad-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 6px 10px;
    background: none;
    border: 0;
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .oad-menu-item:hover,
  .oad-menu-item:focus-visible {
    background: var(--color-sel);
    color: var(--color-ink-bright);
  }
  .oad-menu-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .oad-menu-tag {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  /* Phone: the stack as tabs in the open assistant's header, thumb-sized. */
  .oad-tabs-wrap {
    position: relative;
  }
  .oad-tabs {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 2px 0;
  }
  .oad-tab {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 12px 0 8px;
    background: none;
    border: 1px solid var(--color-line-bright);
    border-radius: var(--radius-chip);
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .oad-tab[aria-selected="true"] {
    background: var(--wash-assistant-bubble);
    border-color: var(--color-amber);
    color: var(--color-ink-bright);
  }
  @media (pointer: coarse) {
    .oad-menu-item {
      min-height: 44px;
    }
  }
</style>
