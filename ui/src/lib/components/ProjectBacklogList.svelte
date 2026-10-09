<script lang="ts">
  import type { BacklogProject } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import ProjectRow from "./ProjectRow.svelte";
  import AddRepoButton from "./AddRepoButton.svelte";
  import RepoFilterBar from "./RepoFilterBar.svelte";
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

<RepoFilterBar
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
