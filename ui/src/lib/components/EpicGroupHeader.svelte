<script lang="ts">
  import type { Epic } from "$lib/types";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { m } from "$lib/paraglide/messages";
  import EpicBadge from "./EpicBadge.svelte";

  let {
    epic,
    collapsed,
    cues,
    ontoggle,
    onepic,
  }: {
    epic: Epic;
    collapsed: boolean;
    // per-stage tallies derived from the group's children; each chip renders
    // only when its count > 0, so a collapsed group still signals attention
    cues: {
      ciFailed: number;
      needsRework: number;
      branchProtectionBlocked: number;
      ready: number;
      blocked: number;
    };
    ontoggle: () => void;
    // an epic badge was clicked → open the backlog on this repo, scrolled to the epic
    onepic?: (repoPath: string, issueNumber: number) => void;
  } = $props();

  // repo the epic lives in — last path segment of its repoPath (e.g. "community-map")
  const repoName = $derived(epic.repoPath.split("/").filter(Boolean).at(-1) ?? epic.repoPath);
  const repoIcon = $derived(projectIcons.iconFor(epic.repoPath));
</script>

<div class="epic-head micro">
  <!-- A real <button> is the toggle; the EpicBadge is a SIBLING (not nested) so
       there are no nested interactive elements. EpicBadge stops propagation and
       opens the backlog on its own. -->
  <button
    type="button"
    class="epic-toggle"
    aria-expanded={!collapsed}
    aria-label={collapsed
      ? m.epic_group_expand_aria({ number: epic.parentIssueNumber })
      : m.epic_group_collapse_aria({ number: epic.parentIssueNumber })}
    onclick={ontoggle}
  >
    <span class="chev" class:collapsed aria-hidden="true">▾</span>
    {#if repoIcon}
      <span class="repo-icon" aria-hidden="true">{repoIcon}</span>
    {/if}
    <span class="repo" title={repoName}>{repoName}</span>
    <span class="title">{epic.parentTitle}</span>
    <span class="num">#{epic.parentIssueNumber}</span>
  </button>

  <EpicBadge live={epic} repoPath={epic.repoPath} issueNumber={epic.parentIssueNumber} {onepic} />

  <span class="cues">
    {#if cues.ciFailed > 0}
      <span
        class="cue cue-ci"
        title={m.epic_group_cue_ci_failed({ count: cues.ciFailed })}
        aria-label={m.epic_group_cue_ci_failed({ count: cues.ciFailed })}
        ><span class="cue-glyph" aria-hidden="true">✕</span>{cues.ciFailed}</span
      >
    {/if}
    {#if cues.ready > 0}
      <span
        class="cue cue-ready"
        title={m.epic_group_cue_ready({ count: cues.ready })}
        aria-label={m.epic_group_cue_ready({ count: cues.ready })}
        ><span class="cue-glyph" aria-hidden="true">✓</span>{cues.ready}</span
      >
    {/if}
    {#if cues.needsRework > 0}
      <span
        class="cue cue-needs-rework"
        title={m.epic_group_cue_changes_requested({ count: cues.needsRework })}
        aria-label={m.epic_group_cue_changes_requested({ count: cues.needsRework })}
        ><span class="cue-glyph" aria-hidden="true">!</span>{cues.needsRework}</span
      >
    {/if}
    {#if cues.branchProtectionBlocked > 0}
      <span
        class="cue cue-branch-blocked"
        title={m.epic_group_cue_merge_blocked({ count: cues.branchProtectionBlocked })}
        aria-label={m.epic_group_cue_merge_blocked({ count: cues.branchProtectionBlocked })}
        ><span class="cue-glyph" aria-hidden="true">!</span>{cues.branchProtectionBlocked}</span
      >
    {/if}
    {#if cues.blocked > 0}
      <span
        class="cue cue-blocked"
        title={m.epic_group_cue_blocked({ count: cues.blocked })}
        aria-label={m.epic_group_cue_blocked({ count: cues.blocked })}
        ><span class="cue-glyph" aria-hidden="true">!</span>{cues.blocked}</span
      >
    {/if}
  </span>
</div>

<style>
  /* Blue section header for an epic group — blue is epics' semantic hue (mirrors
     the EpicBadge + the backlog). Matches the .ci-head/.ready-head section-header
     conventions (flex row, top rule, padded). */
  .epic-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-blue);
    border-top: 1px solid color-mix(in srgb, var(--color-blue) 30%, var(--color-line));
  }

  /* The toggle owns the row's leading text; it takes the slack so the badge +
     cues sit at the right edge. */
  .epic-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    text-align: left;
    cursor: pointer;
    padding: 0;
  }
  .epic-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .chev {
    flex: none;
    transition: transform 0.12s ease;
  }
  .chev.collapsed {
    transform: rotate(-90deg);
  }

  .repo-icon {
    flex: none;
    font-size: var(--fs-base);
  }
  /* repo basename — quiet identity marker ahead of the epic title */
  .repo {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--color-muted);
    max-width: 16ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--color-ink-bright);
  }
  /* No overflow rule here — clipped by the parent .epic-toggle's overflow: hidden
     at extreme widths. */
  .num {
    flex: none;
    color: var(--color-blue);
  }

  .cues {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  /* Non-interactive tally chips (text + title/aria only). Match the .badge recipe:
     outlined, micro, uppercase tracking. Hue is semantic per stage. */
  .cue {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    font-weight: 600;
    padding: 1px 6px;
    border: 1px solid currentColor;
    border-radius: 2px;
    white-space: nowrap;
  }
  /* Leading shape mark so two same-hue chips (ci-failed + blocked are both red
     per --status-blocked) stay distinguishable at a glance. Inherits the chip's
     --fs-micro; aria-hidden so the chip's title/aria-label still own the meaning. */
  .cue-glyph {
    margin-right: 0.35em;
  }
  /* CI failed — red (mirrors the .ci-failed-head / failed-CI dot). */
  .cue-ci {
    color: var(--color-red);
  }
  /* Ready to merge — green (the reserved actionable-complete hue). */
  .cue-ready {
    color: var(--color-green);
  }
  .cue-needs-rework,
  .cue-branch-blocked {
    color: var(--color-amber);
  }
  /* Needs you / blocked — the canonical blocked status token (--status-blocked). */
  .cue-blocked {
    color: var(--status-blocked);
  }
</style>
