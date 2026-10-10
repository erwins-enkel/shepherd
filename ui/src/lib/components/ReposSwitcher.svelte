<script lang="ts">
  import { on } from "svelte/events";
  import type { BacklogProject } from "#lib/types.js";
  import { anchorPopover } from "#lib/floating-anchor.js";
  import { m } from "#lib/paraglide/messages.js";
  import { projectIcons } from "#lib/projectIcons.svelte.js";
  import ProjectRow from "./ProjectRow.svelte";
  import AddRepoButton from "./AddRepoButton.svelte";
  import RepoFilterBar from "./RepoFilterBar.svelte";
  import { partitionRecents, repoOwnerName } from "./backlog-view";

  // The desktop Repos dialog's repo switcher: an owner/name button in the header that
  // opens an anchored, NON-modal popover (role="dialog", no aria-modal, no scrim — the
  // "small anchored, non-blocking popovers" exemption in ui-design-system.md) with the
  // search, recent tiles, the two-column repo list, the Hidden group and "+ Add repo".
  // The parent (BacklogView) owns every piece of state; this only renders + routes.
  let {
    selected = null,
    projects,
    hiddenProjects = [],
    hiddenCount = 0,
    showHidden = false,
    pinnedPath,
    selectedPath,
    hasIssues,
    hasPRs,
    query,
    ontoggleissues,
    ontoggleprs,
    ontogglehidden = () => {},
    onsearch,
    onselect,
    onhide = () => {},
    onaddclone,
    onaddfork,
    onaddnewproject,
  }: {
    /** The repo whose detail is open — names the trigger. null → "Choose repo". */
    selected?: BacklogProject | null;
    /** Already scoped (chips + search) by the parent via filterProjects. */
    projects: BacklogProject[];
    hiddenProjects?: BacklogProject[];
    hiddenCount?: number;
    showHidden?: boolean;
    pinnedPath: string | null;
    selectedPath: string | null;
    hasIssues: boolean;
    hasPRs: boolean;
    query: string;
    ontoggleissues: () => void;
    ontoggleprs: () => void;
    ontogglehidden?: () => void;
    onsearch: (q: string) => void;
    onselect: (path: string) => void;
    onhide?: (path: string) => void;
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
  } = $props();

  // SSR-stable per-instance id for aria-controls wiring.
  const popoverId = $props.id();

  let open = $state(false);
  let btn = $state<HTMLButtonElement>();
  let pop = $state<HTMLDivElement>();
  let bar = $state<ReturnType<typeof RepoFilterBar>>();

  const searching = $derived(query.trim() !== "");
  // Same ranking as the old sidebar / New Task picker; hoisted so each repo keeps a
  // single selectable row. A search flattens the list (no recents group).
  const grouped = $derived(partitionRecents(projects, searching));
  const id = $derived(selected ? repoOwnerName(selected) : null);
  const icon = $derived(selected ? (projectIcons.iconFor(selected.path) ?? "▣") : null);

  /** Open the popover (the `R` shortcut + the trigger share this). Starts from an
   *  empty search so a stale query never narrows the list on re-open. */
  export function openPanel() {
    if (open) return;
    onsearch("");
    open = true;
  }

  /** Close; `restoreFocus` returns focus to the trigger (Esc / pick) but not on an
   *  outside click, where the user's click already chose the next focus target. */
  function close(restoreFocus: boolean) {
    if (!open) return;
    open = false;
    if (restoreFocus) btn?.focus({ preventScroll: true });
  }

  function pick(path: string) {
    onsearch("");
    close(true);
    onselect(path);
  }

  // Show in the top layer, anchor under the trigger, and put the cursor in the search.
  $effect(() => {
    if (!open || !btn || !pop) return;
    try {
      pop.showPopover();
    } catch {
      return; // not connected this tick — effect re-runs once `pop` mounts
    }
    queueMicrotask(() => bar?.focusSearch());
    return anchorPopover(btn, pop, 6, "bottom-start");
  });

  // Outside pointerdown dismisses. Attached one tick after open so the opening click
  // can't immediately close it. Escape is handled on the elements themselves (below).
  $effect(() => {
    if (!open) return;
    function onPointerdown(e: PointerEvent) {
      const t = e.target as Node;
      if (pop && !pop.contains(t) && btn && !btn.contains(t)) close(false);
    }
    const tid = setTimeout(() => window.addEventListener("pointerdown", onPointerdown), 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("pointerdown", onPointerdown);
    };
  });

  /** Escape closes only the popover — never the dialog behind it (use:dialog on the
   *  card closes on any Escape not yet `defaultPrevented`). Skipped when an inner
   *  handler (the nested filter popover) already consumed it; in the search field with
   *  text it clears the text first. */
  function onEscape(e: KeyboardEvent): boolean {
    if (e.key !== "Escape" || e.defaultPrevented) return false;
    e.preventDefault();
    const t = e.target;
    if (t instanceof HTMLInputElement && t.classList.contains("filter-search") && query !== "") {
      e.stopPropagation();
      onsearch("");
      return true;
    }
    close(true);
    return true;
  }

  // These two listen NATIVELY (svelte/events `on`), not via onkeydown={…}: Svelte
  // delegates `keydown` to the app root, which runs after the dialog card's own native
  // listener — the card would have closed the whole dialog before we saw the Escape.
  $effect(() => {
    const el = pop;
    if (el) return on(el, "keydown", onPopKeydown);
  });
  $effect(() => {
    const el = btn;
    if (el) return on(el, "keydown", (e) => open && onEscape(e));
  });

  // Roving DOM focus over the tiles + rows in document order. The search keeps the
  // cursor while typing; ↓ steps into the list, ↵ opens the top match, ↑ on the first
  // item returns to the search. Nested controls (filter checkboxes, the eye button)
  // are not list items, so arrows inside them are left alone.
  function items(): HTMLElement[] {
    return pop ? Array.from(pop.querySelectorAll<HTMLElement>(".rs-tile, .project-row")) : [];
  }

  /** The search field: ↓ steps into the list, ↵ opens the top match. */
  function onSearchKey(e: KeyboardEvent, list: HTMLElement[]) {
    if (list.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list[0].focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      list[0].click();
    }
  }

  /** A tile / row: ↑↓ move through the list, ↑ on the first returns to the search. */
  function onItemKey(e: KeyboardEvent, list: HTMLElement[], at: number) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list[Math.min(at + 1, list.length - 1)].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at === 0) bar?.focusSearch();
      else list[at - 1].focus();
    }
  }

  function onPopKeydown(e: KeyboardEvent) {
    if (onEscape(e) || e.isComposing) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const list = items();
    if (target instanceof HTMLInputElement && target.classList.contains("filter-search")) {
      onSearchKey(e, list);
      return;
    }
    const at = list.indexOf(target);
    if (at >= 0) onItemKey(e, list, at);
  }

  const prCount = (p: BacklogProject) => p.prKinds?.regular ?? p.openPRs ?? "—";
</script>

<button
  bind:this={btn}
  class="rs-trigger"
  class:open
  type="button"
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls={popoverId}
  aria-keyshortcuts="R"
  aria-label={id ? m.repos_switcher_aria({ repo: id.name }) : m.repos_switcher_choose()}
  onclick={() => (open ? close(true) : openPanel())}
>
  <span class="rs-glyph" aria-hidden="true">{icon ?? "▣"}</span>
  <span class="rs-id">
    {#if id?.owner}<span class="rs-owner">{id.owner}</span>{/if}
    <span class="rs-name">{id ? id.name : m.repos_switcher_choose()}</span>
  </span>
  <span class="rs-caret" aria-hidden="true">▾</span>
  <kbd class="rs-key" aria-hidden="true">R</kbd>
</button>

{#if open}
  <!-- popover="manual": native top layer, escapes the card's overflow:hidden. Non-modal:
       no aria-modal, no scrim. position:fixed + inset:auto + margin:0 so Floating UI's
       left/top drive placement. -->
  <div
    id={popoverId}
    bind:this={pop}
    class="rs-pop"
    role="dialog"
    aria-label={m.repos_switcher_dialog_aria()}
    popover="manual"
    tabindex="-1"
  >
    <RepoFilterBar
      bind:this={bar}
      {query}
      {hasIssues}
      {hasPRs}
      {hiddenCount}
      {showHidden}
      {ontoggleissues}
      {ontoggleprs}
      {ontogglehidden}
      {onsearch}
    />

    <div class="rs-scroll">
      {#if projects.length === 0 && hiddenProjects.length === 0}
        <div class="rs-empty">
          {#if hiddenCount > 0 && !showHidden && !searching}
            {m.backlog_filter_all_hidden()}
          {:else}
            {m.backlog_filter_none_match()}
          {/if}
        </div>
      {/if}

      {#if grouped.recents.length > 0}
        <div class="rs-label">{m.reposelect_recent_heading()}</div>
        <div class="rs-tiles">
          {#each grouped.recents as project (project.path)}
            <button
              class="rs-tile"
              class:sel={project.path === selectedPath}
              type="button"
              onclick={() => pick(project.path)}
            >
              <span class="rs-tile-name">{repoOwnerName(project).name}</span>
              <span class="rs-tile-counts">
                {m.repos_switcher_tile_counts({
                  issues: project.openIssues ?? "—",
                  prs: prCount(project),
                })}
              </span>
            </button>
          {/each}
        </div>
      {/if}

      {#if grouped.rest.length > 0}
        <div class="rs-label">{m.repos_switcher_all()}</div>
        <div class="rs-cols">
          {#each grouped.rest as project (project.path)}
            <ProjectRow
              {project}
              pinned={project.path === pinnedPath}
              selected={project.path === selectedPath}
              onselect={() => pick(project.path)}
              onhide={() => onhide(project.path)}
            />
          {/each}
        </div>
      {/if}

      {#if hiddenProjects.length > 0}
        <div class="rs-label">{m.backlog_hidden_heading()}</div>
        <div class="rs-cols">
          {#each hiddenProjects as project (project.path)}
            <ProjectRow
              {project}
              hidden
              pinned={project.path === pinnedPath}
              selected={project.path === selectedPath}
              onselect={() => pick(project.path)}
              onhide={() => onhide(project.path)}
            />
          {/each}
        </div>
      {/if}
    </div>

    <div class="rs-foot">
      <AddRepoButton
        onclone={() => {
          close(false);
          onaddclone();
        }}
        onfork={() => {
          close(false);
          onaddfork();
        }}
        onnewproject={() => {
          close(false);
          onaddnewproject();
        }}
      />
      <span class="rs-hint" aria-hidden="true">{m.repos_switcher_hint()}</span>
    </div>
  </div>
{/if}

<style>
  /* Trigger: owner small above the repo name, then ▾ and the shortcut keycap. */
  .rs-trigger {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    /* The recents chips clip first; the trigger keeps its name readable. */
    flex-shrink: 0;
    max-width: min(280px, 100%);
    padding: 4px 10px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    transition:
      border-color 0.12s,
      background 0.12s;
  }
  .rs-trigger:hover,
  .rs-trigger.open {
    border-color: var(--color-ink);
    background: var(--color-inset);
  }
  .rs-trigger:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  .rs-glyph {
    flex-shrink: 0;
    color: var(--color-faint);
    font-size: var(--fs-base);
    line-height: 1;
  }

  .rs-id {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.15;
  }
  .rs-owner {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rs-name {
    font-size: var(--fs-base);
    font-weight: 500;
    letter-spacing: 0.03em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .rs-caret {
    flex-shrink: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  /* Shortcut hint: aria-hidden keycap (the trigger carries aria-keyshortcuts). */
  .rs-key {
    flex-shrink: 0;
    font: inherit;
    font-size: var(--fs-micro);
    line-height: 1;
    color: var(--color-muted);
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 2px 5px;
  }
  @media (pointer: coarse) {
    .rs-key {
      display: none;
    }
  }

  /* Top-layer popover: position:fixed + inset:auto + margin:0 lets Floating UI drive
     left/top without fighting the browser's default centering. */
  [popover].rs-pop {
    position: fixed;
    inset: auto;
    margin: 0;
    display: flex;
    flex-direction: column;
    width: min(560px, 92vw);
    max-height: min(70vh, 560px);
    padding: 0;
    overflow: visible;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    color: var(--color-ink);
    font: inherit;
    font-family: var(--font-mono);
  }
  [popover].rs-pop:focus {
    outline: none;
  }
  @keyframes rs-in {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  [popover].rs-pop:popover-open {
    animation: rs-in 120ms ease-out;
  }

  .rs-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 8px;
  }

  .rs-label {
    padding: 8px 4px 4px;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* "Zuletzt bearbeitet": up to three tiles — name over `Issues · PRs`. */
  .rs-tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rs-tile {
    flex: 1 1 140px;
    min-width: 0;
    min-height: 44px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 6px 10px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: inherit;
    font: inherit;
    font-family: var(--font-mono);
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    transition:
      border-color 0.12s,
      background 0.12s;
  }
  .rs-tile:hover {
    border-color: var(--color-line-bright);
    background: var(--color-hover);
  }
  .rs-tile:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -1px;
  }
  .rs-tile.sel {
    border-color: var(--color-line-bright);
    background: var(--color-sel);
  }
  .rs-tile-name {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 500;
    letter-spacing: 0.03em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rs-tile-counts {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }

  /* "Alle Repos": two columns, filled column by column so DOM (= focus) order is the
     visual top-to-bottom order and ↓ walks down the first column before the second. */
  .rs-cols {
    column-count: 2;
    column-gap: 8px;
  }
  .rs-cols > :global(*) {
    break-inside: avoid;
    margin-bottom: 2px;
  }
  @media (max-width: 480px) {
    .rs-cols {
      column-count: 1;
    }
  }

  .rs-empty {
    padding: 20px 8px;
    text-align: center;
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }

  .rs-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 8px;
    border-top: 1px solid var(--color-line);
  }
  .rs-hint {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
</style>
