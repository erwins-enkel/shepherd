<script lang="ts">
  import type { BacklogProject } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    project,
    pinned,
    selected,
    onselect,
  }: {
    project: BacklogProject;
    pinned: boolean;
    selected: boolean;
    onselect: () => void;
  } = $props();

  // Show the repo name (path basename), not the full path — far easier to scan.
  // Fall back to slug/display only if the path has no usable trailing segment.
  const displayName = $derived(
    project.path.replace(/\/+$/, "").split("/").pop() || project.slug || project.display,
  );
</script>

<button
  class="project-row"
  class:sel={selected}
  onclick={onselect}
  type="button"
  title={project.display}
>
  <div class="row-main">
    <span class="row-name">{displayName}</span>
    {#if pinned}
      <span class="pinned-badge">{m.backlog_pinned_label()}</span>
    {/if}
  </div>
  <div class="row-counts">
    <span class="count-item">
      {project.openIssues ?? "—"}
      {m.backlog_tab_issues()}
    </span>
    <span class="sep">·</span>
    <span class="count-item">
      {project.openPRs ?? "—"}
      {m.backlog_tab_prs()}
    </span>
  </div>
</button>

<style>
  .project-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid transparent;
    border-radius: 2px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-family: var(--font-mono);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.12s,
      background 0.12s;
  }

  .project-row:hover {
    border-color: var(--color-line);
    background: var(--color-hover);
  }

  .project-row.sel {
    border-color: var(--color-line-bright);
    background: var(--color-sel);
  }

  .row-main {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1;
  }

  .row-name {
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    font-weight: 500;
    letter-spacing: 0.03em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .pinned-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-amber);
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    padding: 1px 5px;
    flex-shrink: 0;
  }

  .row-counts {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
  }

  .sep {
    color: var(--color-faint);
  }
</style>
