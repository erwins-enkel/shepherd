<script lang="ts">
  import type { BacklogProject } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import ProjectRow from "./ProjectRow.svelte";

  let {
    projects,
    pinnedPath,
    selectedPath,
    hasIssues,
    hasPRs,
    ontoggleissues,
    ontoggleprs,
    onselect,
  }: {
    /** Already filtered by the parent (BacklogView) via filterProjects — the
     *  parent owns the filter state so it can keep the selection in sync. */
    projects: BacklogProject[];
    pinnedPath: string | null;
    selectedPath: string | null;
    hasIssues: boolean;
    hasPRs: boolean;
    ontoggleissues: () => void;
    ontoggleprs: () => void;
    onselect: (path: string) => void;
  } = $props();
</script>

<div class="filter-bar">
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

<!-- The parent only renders this list when there are forge repos, so an empty
     `projects` here always means the active filter matched nothing. -->
{#if projects.length === 0}
  <div class="filter-empty">
    <span class="filter-empty-label">{m.backlog_filter_none_match()}</span>
  </div>
{:else}
  <div class="project-list">
    {#each projects as project (project.path)}
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
    gap: 2px;
    padding: 4px 4px 6px;
    margin-bottom: 2px;
    background: var(--color-inset);
    border-bottom: 1px solid var(--color-line);
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
