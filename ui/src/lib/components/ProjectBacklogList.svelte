<script lang="ts">
  import type { BacklogProject } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import ProjectRow from "./ProjectRow.svelte";
  import { partitionRecents } from "./backlog-view";

  let {
    projects,
    pinnedPath,
    selectedPath,
    hasIssues,
    hasPRs,
    query,
    ontoggleissues,
    ontoggleprs,
    onsearch,
    onselect,
  }: {
    /** Already filtered by the parent (BacklogView) via filterProjects — the
     *  parent owns the filter state so it can keep the selection in sync. */
    projects: BacklogProject[];
    pinnedPath: string | null;
    selectedPath: string | null;
    hasIssues: boolean;
    hasPRs: boolean;
    query: string;
    ontoggleissues: () => void;
    ontoggleprs: () => void;
    onsearch: (q: string) => void;
    onselect: (path: string) => void;
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
  <div class="filter-chips">
    <button
      class="filter-chip"
      class:active={hasIssues}
      type="button"
      aria-pressed={hasIssues}
      onclick={ontoggleissues}
    >
      {m.backlog_filter_has_issues()}
    </button>
    <button
      class="filter-chip"
      class:active={hasPRs}
      type="button"
      aria-pressed={hasPRs}
      onclick={ontoggleprs}
    >
      {m.backlog_filter_has_prs()}
    </button>
  </div>
</div>

<!-- The parent only renders this list when there are forge repos, so an empty
     `projects` here always means the active chips or search matched nothing. -->
{#if projects.length === 0}
  <div class="filter-empty">
    <span class="filter-empty-label">{m.backlog_filter_none_match()}</span>
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
      />
    {/each}
  </div>
{/if}

<style>
  .filter-bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 4px 6px;
    margin-bottom: 2px;
    background: var(--color-inset);
    border-bottom: 1px solid var(--color-line);
  }

  .filter-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
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

  .filter-chips {
    display: flex;
    gap: 2px;
  }

  .filter-chip {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 0 10px;
    min-height: 36px;
    cursor: pointer;
    touch-action: manipulation;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .filter-chip:hover {
    color: var(--color-ink);
  }

  .filter-chip.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
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
