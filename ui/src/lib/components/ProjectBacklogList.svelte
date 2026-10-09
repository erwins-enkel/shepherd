<script lang="ts">
  import type { BacklogProject } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import ProjectRow from "./ProjectRow.svelte";
  import AddRepoButton from "./AddRepoButton.svelte";
  import RepoFilterPopover from "./RepoFilterPopover.svelte";
  import { partitionRecents } from "./backlog-view";

  let {
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
    /** Already filtered by the parent (BacklogView) via filterProjects — the
     *  parent owns the filter state so it can keep the selection in sync. */
    projects: BacklogProject[];
    /** Hidden repos to show in the collapsible "Hidden" group; the parent gates this
     *  to non-empty only when the group should render (Show-hidden on, or searching). */
    hiddenProjects?: BacklogProject[];
    /** Total hidden repos (drives the chip badge; independent of search). */
    hiddenCount?: number;
    /** Whether the Show-hidden chip reads as active. */
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
    /** Hide/unhide a repo by path. */
    onhide?: (path: string) => void;
    /** "+ Add repo" menu actions — open the already-mounted Clone/Fork/New-project
     *  modals. Bubbled up via BacklogView → BacklogOverlay → AppOverlays → +page. */
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
  } = $props();

  const searching = $derived(query.trim() !== "");

  // "Recently worked on" group at the top — same ranking criteria as the New
  // Task repo picker's pinned recents (see partitionRecents). Hoisted, not
  // duplicated, so each repo keeps a single selectable row. Suppressed while
  // searching so the results read as a flat search list.
  const grouped = $derived(partitionRecents(projects, searching));
</script>

<div class="filter-bar">
  <div class="filter-search-wrap">
    <span class="filter-search-icon" aria-hidden="true">⌕</span>
    <input
      class="filter-search"
      type="text"
      autocomplete="off"
      spellcheck={false}
      value={query}
      placeholder={m.backlog_filter_search_placeholder()}
      aria-label={m.backlog_filter_search_placeholder()}
      oninput={(e) => onsearch(e.currentTarget.value)}
      onkeydown={(e) => {
        if (e.key === "Escape" && query !== "") {
          e.stopPropagation();
          e.preventDefault();
          onsearch("");
        }
      }}
    />
    {#if searching}
      <button
        class="filter-search-clear"
        type="button"
        aria-label={m.backlog_filter_search_clear()}
        onclick={() => onsearch("")}>×</button
      >
    {/if}
  </div>
  <RepoFilterPopover {hasIssues} {hasPRs} {ontoggleissues} {ontoggleprs} />
  {#if hiddenCount > 0}
    <!-- Compact Show-hidden toggle: stays visible (not in the filter popover) so
         parked repos remain discoverable; not counted in the filter badge. -->
    <button
      class="filter-chip hidden-toggle"
      class:active={showHidden}
      type="button"
      aria-pressed={showHidden}
      aria-label={m.backlog_filter_hidden({ count: hiddenCount })}
      title={m.backlog_filter_hidden({ count: hiddenCount })}
      onclick={ontogglehidden}
    >
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
        <path
          d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C9.74 7.13 10.35 7 12 7zM2.71 3.16a.996.996 0 0 0 0 1.41l1.97 1.97A11.86 11.86 0 0 0 1 12.5C2.73 16.89 7 20 12 20c1.52 0 2.97-.3 4.31-.82l2.72 2.72a.996.996 0 1 0 1.41-1.41L4.13 3.16a.996.996 0 0 0-1.42 0zM12 17c-2.76 0-5-2.24-5-5 0-.77.18-1.5.49-2.14l1.57 1.57c-.03.18-.06.37-.06.57a3 3 0 0 0 3 3c.2 0 .38-.03.57-.07l1.57 1.57c-.65.32-1.37.5-2.14.5z"
        />
      </svg>
      <span class="hidden-count" aria-hidden="true">{hiddenCount}</span>
    </button>
  {/if}
</div>

<!-- The parent only renders this list when there are forge repos, so an empty
     visible `projects` here means the active chips/search matched nothing — OR every
     repo is hidden and Show-hidden is off (a distinct, less-confusing hint). Suppress
     the banner entirely when the Hidden group below is populated (e.g. a search that
     only matches hidden repos), so "No repos match" never sits above visible rows. -->
{#if projects.length === 0 && hiddenProjects.length === 0}
  <div class="filter-empty">
    {#if hiddenCount > 0 && !showHidden && !searching}
      <span class="filter-empty-label">{m.backlog_filter_all_hidden()}</span>
    {:else}
      <span class="filter-empty-label">{m.backlog_filter_none_match()}</span>
    {/if}
  </div>
{:else}
  <div class="project-list">
    {#if grouped.recents.length > 0}
      <div class="recent-label">{m.reposelect_recent_heading()}</div>
      {#each grouped.recents as project (project.path)}
        <ProjectRow
          {project}
          pinned={project.path === pinnedPath}
          selected={project.path === selectedPath}
          onselect={() => onselect(project.path)}
          onhide={() => onhide(project.path)}
        />
      {/each}
      {#if grouped.rest.length > 0}
        <div class="recent-sep" role="presentation"></div>
      {/if}
    {/if}
    {#each grouped.rest as project (project.path)}
      <ProjectRow
        {project}
        pinned={project.path === pinnedPath}
        selected={project.path === selectedPath}
        onselect={() => onselect(project.path)}
        onhide={() => onhide(project.path)}
      />
    {/each}
  </div>
{/if}

<!-- Hidden group: the parent passes a non-empty `hiddenProjects` only when it should
     show (Show-hidden on, or an active search surfacing hidden matches). Dimmed rows
     whose eye control acts as unhide. -->
{#if hiddenProjects.length > 0}
  <div class="hidden-group">
    <div class="recent-label">{m.backlog_hidden_heading()}</div>
    <div class="recent-sep" role="presentation"></div>
    <div class="project-list">
      {#each hiddenProjects as project (project.path)}
        <ProjectRow
          {project}
          hidden
          pinned={project.path === pinnedPath}
          selected={project.path === selectedPath}
          onselect={() => onselect(project.path)}
          onhide={() => onhide(project.path)}
        />
      {/each}
    </div>
  </div>
{/if}

<!-- "+ Add repo" as a fixed foot: sits after the last row, and sticks to the
     pane's bottom edge once the list overflows. -->
<div class="list-footer">
  <AddRepoButton onclone={onaddclone} onfork={onaddfork} onnewproject={onaddnewproject} />
</div>

<style>
  /* z-index 2: each row carries statusTip's position:relative + z-index:1, which
     would otherwise paint scrolled rows over this sticky header. */
  .filter-bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 4px 6px;
    margin-bottom: 2px;
    background: var(--color-inset);
    border-bottom: 1px solid var(--color-line);
  }

  .filter-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }

  .filter-search {
    width: 100%;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    padding: 0 28px 0 26px;
    min-height: 36px;
    outline: none;
    transition: border-color 0.12s;
  }

  .filter-search-icon {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    pointer-events: none;
  }

  .filter-search::placeholder {
    color: var(--color-muted);
  }

  .filter-search:focus {
    border-color: var(--color-line-bright);
  }

  .filter-search-clear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 0 8px;
    min-height: 36px;
    cursor: pointer;
    line-height: 1;
    touch-action: manipulation;
  }

  .filter-search-clear:hover {
    color: var(--color-ink);
  }

  /* Compact Show-hidden toggle (eye-off + count) — the .filter-chip look. */
  .filter-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 0 6px;
    min-height: 36px;
    cursor: pointer;
    touch-action: manipulation;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .filter-chip svg {
    font-size: var(--fs-base);
  }

  .filter-chip:hover {
    color: var(--color-ink);
  }

  .filter-chip.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
  }

  .filter-chip:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 2px;
  }

  .hidden-count {
    font-variant-numeric: tabular-nums;
  }

  @media (pointer: coarse) {
    .filter-chip {
      min-width: 44px;
      min-height: 44px;
    }
  }

  /* Sticky foot: after the last row, pinned to the pane's bottom once the list
     overflows. Above the rows' statusTip z-index:1, like the filter bar. */
  .list-footer {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: flex;
    padding: 6px 4px;
    margin-top: 2px;
    background: var(--color-inset);
    border-top: 1px solid var(--color-line);
  }

  .project-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* "recently worked on" group heading + divider — mirrors the rs-group-label /
     rs-group-sep recipe in RepoSelect so both recent-repo groups read alike. */
  .recent-label {
    padding: 6px 12px 4px;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .recent-sep {
    height: 0;
    border-top: 1px solid var(--color-line-bright);
    margin: 4px 0;
  }

  .filter-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 8px;
  }

  .filter-empty-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
</style>
