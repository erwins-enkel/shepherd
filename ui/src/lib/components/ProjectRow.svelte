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
      <span class="pin-icon" role="img" aria-label={m.backlog_pinned_label()}>
        <svg
          viewBox="0 0 16 16"
          width="1em"
          height="1em"
          fill="currentColor"
          fill-rule="evenodd"
          aria-hidden="true"
        >
          <path
            d="M8 1.4a4.3 4.3 0 0 0-4.3 4.3c0 3.2 4.3 8.6 4.3 8.6s4.3-5.4 4.3-8.6A4.3 4.3 0 0 0 8 1.4Zm0 6a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Z"
          />
        </svg>
      </span>
    {/if}
  </div>
  <div class="row-counts">
    <span class="count-item">
      {project.openIssues ?? "—"}
      {m.backlog_tab_issues()}
    </span>
    <span class="sep">·</span>
    {#if project.prKinds}
      <span
        class="count-item count-prs"
        class:prom={project.prKinds.regular > 0}
        title={m.backlog_code_prs_title()}
        aria-label={m.backlog_code_prs_title()}
      >
        {project.prKinds.regular}
        {m.backlog_tab_prs()}
      </span>
      {#if project.prKinds.dependabot > 0}
        <span
          class="bot-note"
          title={m.prkind_dependabot_title({ count: project.prKinds.dependabot })}
        >
          {m.prkind_dependabot_badge({ count: project.prKinds.dependabot })}
        </span>
      {/if}
      {#if project.prKinds.release > 0}
        <span class="bot-note" title={m.prkind_release_title({ count: project.prKinds.release })}>
          {m.prkind_release_badge({ count: project.prKinds.release })}
        </span>
      {/if}
    {:else}
      <span class="count-item">
        {project.openPRs ?? "—"}
        {m.backlog_tab_prs()}
      </span>
    {/if}
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

  .pin-icon {
    display: inline-flex;
    align-items: center;
    color: var(--color-amber);
    font-size: var(--fs-base);
    flex-shrink: 0;
  }

  .pin-icon svg {
    vertical-align: -0.125em;
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

  .count-prs.prom {
    color: var(--color-ink-bright);
    font-weight: 500;
  }

  .bot-note {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    letter-spacing: 0.04em;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
