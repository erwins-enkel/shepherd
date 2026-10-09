<script lang="ts">
  import type { Epic, EpicSummary, Issue } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { chipFor, progress, type EpicRole } from "../epic-panel";
  import { activate } from "../issues-panel";
  import EpicRoleBadge from "./EpicRoleBadge.svelte";

  // Compact epic header of the backlog list (#2617), two lines: chevron, number and the wrapping
  // title on top; below it the role badge, a segmented progress bar and "m/n". Segments are per
  // child (tinted by state) once the epic's record is loaded; before that they come from the list
  // summary (merged vs. rest).
  let {
    issue,
    summary = undefined,
    epic = undefined,
    role = null,
    position = null,
    expanded,
    selected,
    optionId,
    onselect,
    ontoggle,
  }: {
    issue: Issue;
    summary?: EpicSummary;
    epic?: Epic;
    /** Role in the repo's run (#2620) — "leads" / "winding down"; null → no badge. */
    role?: EpicRole | null;
    /** 1-based place in the repo's epic queue (#2624), shown on a "queued" badge. */
    position?: number | null;
    expanded: boolean;
    selected: boolean;
    optionId: string;
    onselect: () => void;
    ontoggle: () => void;
  } = $props();

  // Prefer the record's authoritative (native-first) counts over the markdown-first summary,
  // which can go stale after a restructure — same rule as the former row badge.
  const counts = $derived(
    epic ? progress(epic.children) : { merged: summary?.merged ?? 0, total: summary?.total ?? 0 },
  );
  const segments = $derived(
    epic
      ? [...epic.children].sort((a, b) => a.order - b.order).map((c) => chipFor(c.state).tone)
      : Array.from({ length: counts.total }, (_, i) => (i < counts.merged ? "done" : "empty")),
  );
</script>

<div
  class="issue-row epic-row"
  class:selected
  class:expanded
  id={optionId}
  role="option"
  aria-selected={selected}
  tabindex="-1"
  onclick={onselect}
  onkeydown={(e) => activate(e, onselect)}
>
  <div class="line">
    <button
      class="chevron epic-toggle"
      type="button"
      tabindex="-1"
      aria-expanded={expanded}
      aria-label={expanded
        ? m.epic_badge_collapse_aria({ parent: issue.number })
        : m.epic_badge_expand_aria({ parent: issue.number })}
      onclick={(e) => {
        e.stopPropagation();
        ontoggle();
      }}>{expanded ? "▾" : "▸"}</button
    >
    <span class="num" id={`epic-issue-row-${issue.number}`}>#{issue.number}</span>
    <span class="title issue-title">{issue.title}</span>
  </div>
  <div class="line sub">
    {#if role}<EpicRoleBadge {role} {position} />{/if}
    {#if counts.total > 0}
      <span class="bar" aria-hidden="true">
        {#each segments as tone, i (i)}<span class="seg seg-{tone}"></span>{/each}
      </span>
    {/if}
    <span class="count" title={m.epic_progress({ merged: counts.merged, total: counts.total })}
      >{counts.merged}/{counts.total}</span
    >
  </div>
</div>

<style>
  .epic-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 5px 8px 5px 4px;
    border: 1px solid color-mix(in srgb, var(--status-running) 30%, var(--color-line));
    border-radius: 2px;
    background: color-mix(in oklab, var(--status-running) 6%, var(--color-inset));
    color: var(--color-ink);
    font-size: var(--fs-base);
    cursor: pointer;
  }
  .epic-row:hover {
    background: color-mix(in oklab, var(--status-running) 10%, var(--color-inset));
  }
  .epic-row.selected {
    border-color: var(--status-running);
    background: color-mix(in oklab, var(--status-running) 16%, var(--color-inset));
    color: var(--color-ink-bright);
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  /* Status line, indented under the title (past the chevron). */
  .sub {
    align-items: center;
    padding-left: 24px;
  }

  .chevron {
    flex: none;
    width: 18px;
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--status-running);
    font: inherit;
    cursor: pointer;
  }

  .num {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .bar {
    display: flex;
    flex: 1;
    gap: 1px;
    min-width: 40px;
    max-width: 140px;
    height: 6px;
  }
  .seg {
    flex: 1;
    min-width: 1px;
    border-radius: 1px;
    background: var(--color-line);
  }
  .seg-done {
    background: var(--status-done);
  }
  .seg-review {
    background: var(--color-blue);
  }
  .seg-running {
    background: var(--status-running);
  }
  .seg-ready {
    background: var(--color-green);
  }
  .seg-muted {
    background: var(--color-faint);
  }

  .count {
    flex: none;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .epic-row {
      min-height: var(--mobile-actionbar-hit);
    }
    .chevron {
      width: 32px;
      min-height: 32px;
    }
    .sub {
      padding-left: 38px;
    }
  }
</style>
