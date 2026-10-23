<script lang="ts">
  import type { BacklogProject } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import ProjectRow from "./ProjectRow.svelte";
  import AddRepoButton from "./AddRepoButton.svelte";
  import RepoFilterBar from "./RepoFilterBar.svelte";
  import type { RepoGroups } from "./backlog-view";

  let {
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
    /** Already filtered (filterProjects) and grouped (groupRepos) by the parent
     *  (BacklogView) — it owns the filter state so it can keep the selection in sync.
     *  `hidden` (the collapsible "Hidden" group) is gated by the parent to non-empty
     *  only when the group should render (Show-hidden on, or searching). */
    groups: RepoGroups;
    /** Total hidden repos (drives the chip badge; independent of search). */
    hiddenCount?: number;
    /** Whether the Show-hidden chip reads as active. */
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
    /** Hide/unhide a repo by path. */
    onhide?: (path: string) => void;
    /** Pin/unpin a repo by path. */
    onpin?: (path: string) => void;
    /** "+ Add repo" menu actions — open the already-mounted Clone/Fork/New-project
     *  modals. Bubbled up via BacklogView → BacklogOverlay → AppOverlays → +page. */
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
  } = $props();

  const searching = $derived(query.trim() !== "");

  // Pinned, then "recently worked on" (same ranking as the New Task picker), then the
  // rest — each repo keeps a single selectable row. A search flattens the list.
  const sections = $derived(
    [
      { key: "pinned", label: m.backlog_pinned_heading(), list: groups.pinned },
      { key: "recent", label: m.reposelect_recent_heading(), list: groups.recents },
      { key: "rest", label: null, list: groups.rest },
    ].filter((sec) => sec.list.length > 0),
  );
  const visibleCount = $derived(groups.pinned.length + groups.recents.length + groups.rest.length);
</script>

{#snippet row(project: BacklogProject, hidden: boolean)}
  <ProjectRow
    {project}
    {hidden}
    selected={project.path === selectedPath}
    onselect={() => onselect(project.path)}
    onhide={() => onhide(project.path)}
    onpin={() => onpin(project.path)}
  />
{/snippet}

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
{#if visibleCount === 0 && groups.hidden.length === 0}
  <div class="filter-empty">
    {#if hiddenCount > 0 && !showHidden && !searching}
      <span class="filter-empty-label">{m.backlog_filter_all_hidden()}</span>
    {:else}
      <span class="filter-empty-label">{m.backlog_filter_none_match()}</span>
    {/if}
  </div>
{:else}
  <div class="project-list">
    {#each sections as sec, i (sec.key)}
      {#if i > 0}
        <div class="recent-sep" role="presentation"></div>
      {/if}
      {#if sec.label}
        <div class="recent-label">{sec.label}</div>
      {/if}
      {#each sec.list as project (project.path)}
        {@render row(project, false)}
      {/each}
    {/each}
  </div>
{/if}

<!-- Hidden group: the parent passes a non-empty `groups.hidden` only when it should
     show (Show-hidden on, or an active search surfacing hidden matches). Dimmed rows
     whose eye control acts as unhide. -->
{#if groups.hidden.length > 0}
  <div class="hidden-group">
    <div class="recent-label">{m.backlog_hidden_heading()}</div>
    <div class="recent-sep" role="presentation"></div>
    <div class="project-list">
      {#each groups.hidden as project (project.path)}
        {@render row(project, true)}
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
