<script lang="ts">
  import type { BacklogProject } from "$lib/types";
  import ProjectRow from "./ProjectRow.svelte";

  let {
    projects,
    pinnedPath,
    selectedPath,
    onselect,
  }: {
    projects: BacklogProject[];
    pinnedPath: string | null;
    selectedPath: string | null;
    onselect: (path: string) => void;
  } = $props();
</script>

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

<style>
  .project-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
