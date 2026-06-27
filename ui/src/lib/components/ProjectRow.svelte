<script lang="ts">
  import type { BacklogProject } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    project,
    pinned,
    selected,
    hidden = false,
    onselect,
    onhide,
  }: {
    project: BacklogProject;
    pinned: boolean;
    selected: boolean;
    /** Rendered in the dimmed "Hidden" group — the eye control acts as unhide. */
    hidden?: boolean;
    onselect: () => void;
    /** Toggle this repo's hidden state (hide when visible, unhide when in the Hidden group). */
    onhide: () => void;
  } = $props();

  // Keyboard activation for the role=button row (Enter/Space → select), matching
  // native <button> semantics now that the root is a <div> (a real <button> can't
  // legally nest the eye <button>).
  function onRowKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onselect();
    }
  }

  function onEyeClick(e: MouseEvent) {
    e.stopPropagation(); // never also select the row
    onhide();
  }

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

<div
  class="project-row"
  class:sel={selected}
  class:dim={hidden}
  role="button"
  tabindex="0"
  onclick={onselect}
  onkeydown={onRowKeydown}
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
  <button
    class="row-hide"
    type="button"
    onclick={onEyeClick}
    title={hidden ? m.backlog_unhide_repo() : m.backlog_hide_repo()}
    aria-label={hidden ? m.backlog_unhide_repo() : m.backlog_hide_repo()}
  >
    {#if hidden}
      <!-- eye (open): unhide -->
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
        <path
          d="M12 5c-5 0-9.27 3.11-11 7.5C2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
        />
      </svg>
    {:else}
      <!-- eye-off: hide -->
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
        <path
          d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C9.74 7.13 10.35 7 12 7zM2.71 3.16a.996.996 0 0 0 0 1.41l1.97 1.97A11.86 11.86 0 0 0 1 12.5C2.73 16.89 7 20 12 20c1.52 0 2.97-.3 4.31-.82l2.72 2.72a.996.996 0 1 0 1.41-1.41L4.13 3.16a.996.996 0 0 0-1.42 0zM12 17c-2.76 0-5-2.24-5-5 0-.77.18-1.5.49-2.14l1.57 1.57c-.03.18-.06.37-.06.57a3 3 0 0 0 3 3c.2 0 .38-.03.57-.07l1.57 1.57c-.65.32-1.37.5-2.14.5z"
        />
      </svg>
    {/if}
  </button>
</div>

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

  .project-row:focus-visible {
    outline: 1px solid var(--color-line-bright);
    outline-offset: -1px;
  }

  .project-row.sel {
    border-color: var(--color-line-bright);
    background: var(--color-sel);
  }

  /* dimmed row in the Hidden group — reads as parked, not active */
  .project-row.dim {
    opacity: 0.55;
  }
  .project-row.dim .row-name {
    color: var(--color-ink);
    font-weight: 400;
  }

  /* eye-off / unhide control: hidden until row hover/focus on fine pointers;
     always shown on coarse (touch) pointers where hover is unreachable. */
  .row-hide {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 4px;
    color: var(--color-faint);
    font-size: var(--fs-base);
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 0.12s,
      color 0.12s;
  }
  .project-row:hover .row-hide,
  .project-row:focus-within .row-hide,
  .row-hide:focus-visible {
    opacity: 1;
  }
  .row-hide:hover {
    color: var(--color-red);
  }
  /* in the Hidden group the control is the primary affordance — always lit */
  .project-row.dim .row-hide {
    opacity: 1;
    color: var(--color-muted);
  }
  .project-row.dim .row-hide:hover {
    color: var(--color-ink-bright);
  }

  @media (pointer: coarse) {
    .row-hide {
      opacity: 1;
      min-width: 44px;
      min-height: 44px;
    }
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
