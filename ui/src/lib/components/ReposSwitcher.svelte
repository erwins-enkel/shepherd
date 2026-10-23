<script lang="ts">
  import { on } from "svelte/events";
  import type { BacklogProject } from "#lib/types.js";
  import { anchorPopover } from "#lib/floating-anchor.js";
  import { m } from "#lib/paraglide/messages.js";
  import ProjectRow from "./ProjectRow.svelte";
  import RepoMark from "./RepoMark.svelte";
  import AddRepoButton from "./AddRepoButton.svelte";
  import RepoFilterBar from "./RepoFilterBar.svelte";
  import { repoOwnerName, type RepoGroups } from "./backlog-view";

  // The desktop Repos dialog's repo switcher: an owner/name button in the header that
  // opens an anchored, NON-modal popover (role="dialog", no aria-modal, no scrim — the
  // "small anchored, non-blocking popovers" exemption in ui-design-system.md) with the
  // search, the Pinned rows, recent tiles, the repo list, the Hidden group and "+ Add repo".
  // The parent (BacklogView) owns every piece of state; this only renders + routes.
  let {
    selected = null,
    groups,
    hiddenCount = 0,
    showHidden = false,
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
    onpin = () => {},
    onaddclone,
    onaddfork,
    onaddnewproject,
  }: {
    /** The repo whose detail is open — names the trigger. null → "Choose repo". */
    selected?: BacklogProject | null;
    /** Already scoped (chips + search) and grouped by the parent via groupRepos; `hidden`
     *  is non-empty only when the Hidden group should render. */
    groups: RepoGroups;
    hiddenCount?: number;
    showHidden?: boolean;
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
    onpin?: (path: string) => void;
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
  const empty = $derived(
    groups.pinned.length + groups.recents.length + groups.rest.length + groups.hidden.length === 0,
  );
  const id = $derived(selected ? repoOwnerName(selected) : null);

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

{#snippet rows(list: BacklogProject[], hidden: boolean)}
  <div class="rs-rows">
    {#each list as project (project.path)}
      <ProjectRow
        {project}
        {hidden}
        selected={project.path === selectedPath}
        onselect={() => pick(project.path)}
        onhide={() => onhide(project.path)}
        onpin={() => onpin(project.path)}
      />
    {/each}
  </div>
{/snippet}

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
  {#if selected && id}
    <RepoMark path={selected.path} name={id.name} favicon={selected.faviconUrl} />
  {/if}
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
      {#if empty}
        <div class="rs-empty">
          {#if hiddenCount > 0 && !showHidden && !searching}
            {m.backlog_filter_all_hidden()}
          {:else}
            {m.backlog_filter_none_match()}
          {/if}
        </div>
      {/if}

      {#if groups.pinned.length > 0}
        <div class="rs-label">{m.backlog_pinned_heading()}</div>
        {@render rows(groups.pinned, false)}
      {/if}

      {#if groups.recents.length > 0}
        <div class="rs-label">{m.reposelect_recent_heading()}</div>
        <div class="rs-tiles">
          {#each groups.recents as project (project.path)}
            {@const name = repoOwnerName(project).name}
            <button
              class="rs-tile"
              class:sel={project.path === selectedPath}
              type="button"
              onclick={() => pick(project.path)}
            >
              <span class="rs-tile-title">
                <RepoMark path={project.path} {name} favicon={project.faviconUrl} />
                <span class="rs-tile-name">{name}</span>
              </span>
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

      {#if groups.rest.length > 0}
        <div class="rs-label rs-label-cols">
          <span>{m.repos_switcher_all()}</span>
          <span class="rs-col-hint">{m.repos_switcher_col_issues()}</span>
        </div>
        {@render rows(groups.rest, false)}
      {/if}

      {#if groups.hidden.length > 0}
        <div class="rs-label">{m.backlog_hidden_heading()}</div>
        {@render rows(groups.hidden, true)}
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
    /* one column of rows: ~290px for the name next to the mark and the counts slot */
    width: min(420px, 92vw);
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
  /* "Alle Repos" head: the right-aligned hint names the rows' count column */
  .rs-label-cols {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding-right: 4px;
  }
  .rs-col-hint {
    color: var(--color-faint);
    text-transform: none;
    white-space: nowrap;
  }

  /* "Zuletzt bearbeitet": up to three tiles — name over `Issues · PRs`. */
  .rs-tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rs-tile {
    flex: 1 1 110px;
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
  .rs-tile-title {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .rs-tile-name {
    min-width: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 500;
    letter-spacing: 0.03em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rs-tile-counts {
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* One column, so a repo name gets the full row width before it ellipsizes. */
  .rs-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
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
