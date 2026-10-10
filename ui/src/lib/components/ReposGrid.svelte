<script lang="ts">
  import { on } from "svelte/events";
  import type { BacklogProject, DrainStatus } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { projectIcons } from "#lib/projectIcons.svelte.js";
  import AddRepoButton from "./AddRepoButton.svelte";
  import { pausedText } from "./queue-strip";
  import {
    filterProjects,
    nearestInDirection,
    partitionRecents,
    repoOwnerName,
    repoRunState,
    sizeShare,
    sortProjects,
    type RepoSort,
  } from "./backlog-view";

  // The desktop Repos dialog's entry when no single repo is preselected (no dashboard
  // filter, or several repos filtered): a full-width grid instead of list + reading view.
  // "Recently edited" gets large tiles (counts + what the drain is doing), "All repos"
  // compact ones with a size bar. Search and sort are local — independent of the header
  // switcher's popover scope. The parent (BacklogView) owns the repo selection.
  let {
    projects,
    drain = undefined,
    filteredCount = 0,
    onselect,
    onaddclone,
    onaddfork,
    onaddnewproject,
  }: {
    /** Already scoped by the parent (visible repos, narrowed to the dashboard filter). */
    projects: BacklogProject[];
    /** Live drain status keyed by repo path — the tiles' "what is it doing" line. */
    drain?: Record<string, DrainStatus>;
    /** How many repos the dashboard filter narrowed the grid to; 0 → not narrowed. */
    filteredCount?: number;
    onselect: (path: string) => void;
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
  } = $props();

  let query = $state("");
  let sort = $state<RepoSort>("issues");
  let root = $state<HTMLElement>();
  let searchEl = $state<HTMLInputElement>();

  const searching = $derived(query.trim() !== "");
  const filtered = $derived(filterProjects(projects, { hasIssues: false, hasPRs: false, query }));
  // Same recents ranking as the switcher; a search flattens the list (no recents group).
  const grouped = $derived(partitionRecents(filtered, searching));
  const rest = $derived(sortProjects(grouped.rest, sort));
  const maxIssues = $derived(Math.max(0, ...projects.map((p) => p.openIssues ?? 0)));

  // The search takes the cursor — "just type" — but only inside the dialog: the inline
  // empty-herd panel must not steal focus, or the page's single-key shortcuts go quiet.
  $effect(() => {
    if (searchEl?.closest('[role="dialog"]')) searchEl.focus({ preventScroll: true });
  });

  const prCount = (p: BacklogProject) => p.prKinds?.regular ?? p.openPRs ?? "—";

  function counts(p: BacklogProject): string {
    const issues = p.openIssues ?? "—";
    const prs = prCount(p);
    return p.workflows === null
      ? m.repos_switcher_tile_counts({ issues, prs })
      : m.repos_grid_counts_actions({ issues, prs, actions: p.workflows });
  }

  function runLine(p: BacklogProject): { text: string; paused: boolean } | null {
    const d = drain?.[p.path];
    const s = repoRunState(d);
    if (!s || !d) return null;
    if (s.kind === "paused") return { text: pausedText(d), paused: true };
    const agents = s.inFlight > 0 ? m.drain_inflight({ count: s.inFlight, max: s.max }) : null;
    const lead = s.kind === "epic" ? m.repooverview_leading_only({ epic: s.epic }) : null;
    return { text: [lead, agents].filter((t) => t !== null).join(" · "), paused: false };
  }

  // Roving DOM focus over the tiles in document order. The search keeps the cursor while
  // typing; ↓ steps into the grid, ↵ opens the top match, ↑ from the first row returns to
  // the search. Native listener (svelte/events `on`), not onkeydown={…}: Svelte delegates
  // `keydown` to the app root, which runs after the dialog card's own Escape listener —
  // the card would close the whole dialog before a clear-the-search Escape was seen.
  function tiles(): HTMLElement[] {
    return root ? Array.from(root.querySelectorAll<HTMLElement>(".rg-tile")) : [];
  }

  function onSearchKey(e: KeyboardEvent) {
    const list = tiles();
    if (e.key === "Escape" && query !== "") {
      e.preventDefault();
      query = "";
    } else if (e.key === "ArrowDown" && list.length > 0) {
      e.preventDefault();
      list[0].focus();
    } else if (e.key === "Enter" && list.length > 0) {
      e.preventDefault();
      list[0].click();
    }
  }

  function onTileKey(e: KeyboardEvent, list: HTMLElement[], at: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      list[Math.max(0, Math.min(list.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)))].focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      const next = nearestInDirection(
        list.map((el) => el.getBoundingClientRect()),
        at,
        down ? 1 : -1,
      );
      if (next !== null) list[next].focus();
      else if (!down) searchEl?.focus();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target === searchEl) {
      onSearchKey(e);
      return;
    }
    const list = tiles();
    const at = target instanceof HTMLElement ? list.indexOf(target) : -1;
    if (at >= 0) onTileKey(e, list, at);
  }

  $effect(() => {
    const el = root;
    if (el) return on(el, "keydown", onKeydown);
  });
</script>

<section class="rg" bind:this={root} aria-label={m.repos_switcher_choose()}>
  <div class="rg-bar">
    <div class="rg-search-wrap">
      <span class="rg-search-icon" aria-hidden="true">⌕</span>
      <input
        bind:this={searchEl}
        bind:value={query}
        class="rg-search"
        type="text"
        autocomplete="off"
        spellcheck={false}
        placeholder={m.repos_grid_search()}
        aria-label={m.repos_grid_search()}
      />
      {#if searching}
        <button
          class="rg-search-clear"
          type="button"
          aria-label={m.backlog_filter_search_clear()}
          onclick={() => {
            query = "";
            searchEl?.focus();
          }}>×</button
        >
      {/if}
    </div>
    <select class="rg-sort" bind:value={sort} aria-label={m.repos_grid_sort_aria()}>
      <option value="issues">{m.repos_grid_sort_issues()}</option>
      <option value="name">{m.repos_grid_sort_name()}</option>
    </select>
    {#if filteredCount > 0}
      <span class="rg-badge">{m.repos_grid_filtered({ count: filteredCount })}</span>
    {/if}
    <span class="rg-add">
      <AddRepoButton onclone={onaddclone} onfork={onaddfork} onnewproject={onaddnewproject} />
    </span>
  </div>

  <div class="rg-scroll">
    {#if filtered.length === 0}
      <div class="rg-empty">{m.backlog_filter_none_match()}</div>
    {/if}

    {#if grouped.recents.length > 0}
      <div class="rg-label">{m.repos_grid_recent()}</div>
      <div class="rg-big">
        {#each grouped.recents as project (project.path)}
          {@const id = repoOwnerName(project)}
          {@const run = runLine(project)}
          <button class="rg-tile rg-tile-big" type="button" onclick={() => onselect(project.path)}>
            <span class="rg-title">
              <span class="rg-glyph" aria-hidden="true"
                >{projectIcons.iconFor(project.path) ?? "▣"}</span
              >
              <span class="rg-name">{id.name}</span>
            </span>
            {#if id.owner}<span class="rg-owner">{id.owner}</span>{/if}
            <span class="rg-counts">{counts(project)}</span>
            {#if run}
              <span class="rg-run" class:paused={run.paused}>
                <span aria-hidden="true">●</span>
                {run.text}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if rest.length > 0}
      <div class="rg-label">{m.repos_switcher_all()}</div>
      <div class="rg-small">
        {#each rest as project (project.path)}
          <button
            class="rg-tile rg-tile-small"
            type="button"
            onclick={() => onselect(project.path)}
          >
            <span class="rg-small-row">
              <span class="rg-name">{repoOwnerName(project).name}</span>
              <span class="rg-small-counts">
                {m.repos_switcher_tile_counts({
                  issues: project.openIssues ?? "—",
                  prs: prCount(project),
                })}
              </span>
            </span>
            <span class="rg-size" aria-hidden="true">
              <span
                class="rg-size-fill"
                style:width="{sizeShare(project.openIssues, maxIssues) * 100}%"
              ></span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="rg-foot">
    <span class="rg-hint" aria-hidden="true">{m.repos_switcher_hint()}</span>
  </div>
</section>

<style>
  .rg {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono);
    color: var(--color-ink);
  }

  .rg-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .rg-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }
  .rg-search {
    width: 100%;
    min-height: 40px;
    padding: 0 32px 0 32px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    letter-spacing: 0.03em;
    outline: none;
    transition: border-color 0.12s;
  }
  .rg-search::placeholder {
    color: var(--color-muted);
  }
  .rg-search:focus {
    border-color: var(--color-ink);
  }
  .rg-search-icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-muted);
    font-size: var(--fs-base);
    pointer-events: none;
  }
  .rg-search-clear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    min-height: 36px;
    padding: 0 8px;
    background: transparent;
    border: none;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    line-height: 1;
    cursor: pointer;
    touch-action: manipulation;
  }
  .rg-search-clear:hover {
    color: var(--color-ink);
  }

  .rg-sort {
    flex-shrink: 0;
    min-height: 40px;
    padding: 0 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    cursor: pointer;
  }
  .rg-sort:hover {
    border-color: var(--color-line-bright);
  }
  .rg-sort:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  .rg-badge {
    flex-shrink: 0;
    padding: 2px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .rg-add {
    flex-shrink: 0;
    display: inline-flex;
  }

  .rg-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 16px 16px;
  }

  .rg-label {
    padding: 14px 2px 6px;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .rg-big {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 8px;
  }
  .rg-small {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 6px;
  }

  .rg-tile {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
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
  .rg-tile:hover {
    border-color: var(--color-line-bright);
    background: var(--color-hover);
  }
  .rg-tile:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -1px;
    border-color: var(--color-line-bright);
    background: var(--color-sel);
  }

  .rg-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .rg-glyph {
    flex-shrink: 0;
    color: var(--color-faint);
    font-size: var(--fs-base);
    line-height: 1;
  }
  .rg-name {
    min-width: 0;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 500;
    letter-spacing: 0.03em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rg-owner {
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .rg-counts {
    color: var(--color-ink);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }
  .rg-run {
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
  }
  .rg-run > span:first-child {
    color: var(--status-running);
  }
  .rg-run.paused,
  .rg-run.paused > span:first-child {
    color: var(--status-blocked);
  }

  .rg-tile-small {
    gap: 6px;
    padding: 8px 10px;
  }
  .rg-small-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
  }
  .rg-small-counts {
    flex-shrink: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
  }
  .rg-size {
    display: block;
    height: 2px;
    background: var(--color-line);
  }
  .rg-size-fill {
    display: block;
    height: 100%;
    background: var(--color-line-bright);
  }

  .rg-empty {
    padding: 28px 8px;
    text-align: center;
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }

  .rg-foot {
    display: flex;
    justify-content: flex-end;
    padding: 6px 16px;
    border-top: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  .rg-hint {
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  @media (pointer: coarse) {
    .rg-tile {
      min-height: 44px;
    }
  }
</style>
