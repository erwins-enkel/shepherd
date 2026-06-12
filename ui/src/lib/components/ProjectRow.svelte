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

  const issuesLabel = $derived(
    project.openIssues != null
      ? m.backlog_tab_issues_count({ count: project.openIssues })
      : m.backlog_tab_issues(),
  );
  const prsLabel = $derived(
    project.openPRs != null
      ? m.backlog_tab_prs_count({ count: project.openPRs })
      : m.backlog_tab_prs(),
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
        <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
          <path
            d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"
          />
        </svg>
      </span>
    {/if}
  </div>
  <div class="row-counts">
    <span class="count-item" title={issuesLabel} aria-label={issuesLabel}>
      {project.openIssues ?? "—"}
    </span>
    <span class="sep">·</span>
    {#if project.prKinds}
      <span
        class="count-item count-prs"
        class:prom={project.prKinds.regular > 0}
        title={m.backlog_code_prs_title()}
        aria-label={m.backlog_code_prs_count({ count: project.prKinds.regular })}
      >
        {project.prKinds.regular}
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
      <span
        class="count-item count-prs"
        class:prom={(project.openPRs ?? 0) > 0}
        title={prsLabel}
        aria-label={prsLabel}
      >
        {project.openPRs ?? "—"}
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
    min-width: 12ch;
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
    min-width: 0;
    overflow: hidden;
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
