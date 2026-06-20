<script lang="ts">
  import { listIssues, getEpics, getEpic } from "$lib/api";
  import { steers } from "$lib/steers.svelte";
  import type { Issue, Steer, EpicSummary, Epic } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { filterIssues, hideOthers, hideActive } from "./issues-panel";
  import { issuesFilter } from "$lib/issues-filter.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import IssueRow from "./issues-panel/IssueRow.svelte";
  import RepoLink from "./RepoLink.svelte";
  import { SvelteSet, SvelteMap } from "svelte/reactivity";
  import { tick } from "svelte";

  // ACTIVE_LABEL (used in IssueRow) is the label the drain stamps on an issue it has
  // claimed (auto session or human-linked task). Highlighted so a claimed issue reads
  // as "already taken" at a glance in the backlog.

  let {
    repoPath,
    onnewtask,
    onquick = undefined,
    bodyPreview = false,
    age = false,
    epics = undefined,
    expandEpic = null,
  }: {
    repoPath: string;
    onnewtask: (issue: Issue) => void;
    /** Quick-launch: spawn a session with the picked issue action's prompt + this
     *  issue, skipping the New Task dialog. Omitted → no action buttons are shown. */
    onquick?: (issue: Issue, action: Steer) => void;
    bodyPreview?: boolean;
    age?: boolean;
    /** Live epic record from the store, keyed `${repoPath}#${parentIssueNumber}`.
     *  When present, WS-pushed updates refresh open panels without a re-fetch. */
    epics?: Record<string, Epic>;
    /** When set (e.g. from an EPIC badge click), expand that epic's row and scroll
     *  it into view — used to land the user on a specific epic in the backlog. */
    expandEpic?: number | null;
  } = $props();

  // Issue-scoped steers render as one quick-launch button each on every row.
  const issueActions = $derived(steers.list.filter((s) => s.onIssues));

  let issues = $state<Issue[]>([]);
  let slug = $state<string | null>(null);
  let repoUrl = $state<string | null>(null);
  let viewer = $state<string | null>(null);
  let loading = $state(true);
  let filter = $state("");
  // Compose the assignee filter (#824) → "hide in progress" filter → text filter.
  // The mine chip only shows when `viewer` is known, so hideOthers is a no-op
  // identity otherwise (fail open); hideActive is viewer-agnostic.
  let assigneeFiltered = $derived(hideOthers(issues, viewer, issuesFilter.hideOthers));
  let activeFiltered = $derived(hideActive(assigneeFiltered, issuesFilter.hideActive));
  let visibleIssues = $derived(filterIssues(activeFiltered, filter));
  // True when there ARE open issues but the assignee filter hid them all — drives
  // the distinct "all assigned to others" empty state (vs the text no-match state).
  let allHiddenByAssignee = $derived(
    issues.length > 0 && assigneeFiltered.length === 0 && viewer != null && issuesFilter.hideOthers,
  );
  // The active filter emptied the remainder the assignee filter left behind.
  let allHiddenByActive = $derived(
    !allHiddenByAssignee &&
      assigneeFiltered.length > 0 &&
      activeFiltered.length === 0 &&
      issuesFilter.hideActive,
  );

  // Epic summaries for this repo: number → EpicSummary.
  let epicByNumber = $state<Map<number, EpicSummary>>(new Map());
  // Set of expanded epic issue numbers (SvelteSet for fine-grained reactivity).
  const expanded = new SvelteSet<number>();
  // One-shot fetch cache: issue number → fetched Epic (avoids re-fetching on re-render).
  const fetched = new SvelteMap<number, Epic>();

  $effect(() => {
    const rp = repoPath;
    loading = true;
    filter = "";
    expanded.clear();
    epicByNumber = new Map();
    fetched.clear();
    listIssues(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        slug = r.slug;
        repoUrl = r.webUrl;
        issues = r.issues;
        viewer = r.viewer;
        loading = false;
      })
      .catch(() => {
        loading = false;
      });
    getEpics(rp)
      .then((summaries) => {
        if (rp !== repoPath) return;
        epicByNumber = new Map(summaries.map((s) => [s.parentIssueNumber, s]));
      })
      .catch(() => {
        /* leave empty — epics are an enhancement, not blocking */
      });
  });

  /** Return the live store value for an epic if available, else the cached fetch result. */
  function epicFor(n: number): Epic | undefined {
    return epics?.[`${repoPath}#${n}`] ?? fetched.get(n);
  }

  /** Expand an epic's panel + one-shot fetch its record if the store lacks it. */
  function expandEpicRow(number: number) {
    expanded.add(number);
    // Trigger a one-shot fetch if the live store doesn't have this epic yet.
    if (!epics?.[`${repoPath}#${number}`] && !fetched.has(number)) {
      getEpic(repoPath, number)
        .then((e) => fetched.set(number, e))
        .catch(() => {});
    }
  }

  function toggleEpic(number: number) {
    if (expanded.has(number)) {
      expanded.delete(number);
    } else {
      expandEpicRow(number);
    }
  }

  // Targeted expand+scroll driven by the `expandEpic` prop (e.g. EPIC badge click).
  // The expand fires as soon as a target is set; the scroll waits until the issue
  // row exists in the DOM (issues load async). Both are one-shot per target value.
  let scrolledTo = $state<number | null>(null);
  let appliedExpand = $state<number | null>(null);
  $effect(() => {
    const target = expandEpic;
    if (target == null) {
      appliedExpand = null;
      scrolledTo = null;
      return;
    }
    // Expand exactly once per target value. Keying off `appliedExpand` (NOT the
    // reactive `expanded` membership) means a later user collapse of the targeted
    // epic no longer re-fires this effect into re-expanding it.
    if (target !== appliedExpand) {
      appliedExpand = target;
      if (!expanded.has(target)) expandEpicRow(target);
    }
    // Scroll once the targeted row is actually rendered (its issue is loaded).
    if (target !== scrolledTo && issues.some((i) => i.number === target)) {
      scrolledTo = target;
      tick().then(() => {
        const el = document.getElementById(`epic-issue-row-${target}`);
        el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      });
    }
  });
</script>

<div class="issues-panel">
  <div class="issues-header">
    {m.issuespanel_title()}<RepoLink {slug} webUrl={repoUrl} />
  </div>

  <div class="issues-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if slug === null}
      <div class="muted">{m.issuespanel_no_host()}</div>
    {:else if issues.length === 0}
      <div class="muted">{m.common_no_open_issues()}</div>
    {:else}
      <div class="filter-bar">
        <input
          class="issue-filter"
          type="search"
          bind:value={filter}
          placeholder={m.issuespanel_filter_placeholder()}
          aria-label={m.issuespanel_filter_placeholder()}
        />
        {#if viewer != null}
          <button
            class="filter-chip"
            class:active={issuesFilter.hideOthers}
            type="button"
            aria-pressed={issuesFilter.hideOthers}
            title={m.issues_filter_mine_title()}
            onclick={() => issuesFilter.toggle()}
            use:coachTarget={"issues-filter-toggle"}
          >
            {m.issues_filter_mine_label()}
          </button>
        {/if}
        <button
          class="filter-chip"
          class:active={issuesFilter.hideActive}
          type="button"
          aria-pressed={issuesFilter.hideActive}
          title={m.issues_filter_active_title()}
          onclick={() => issuesFilter.toggleActive()}
          use:coachTarget={"issues-filter-active"}
        >
          {m.issues_filter_active_label()}
        </button>
      </div>
      {#if allHiddenByAssignee}
        <div class="muted">{m.issues_filter_all_assigned_to_others()}</div>
      {:else if allHiddenByActive}
        <div class="muted">{m.issues_filter_all_in_progress()}</div>
      {:else if visibleIssues.length === 0}
        <div class="muted">{m.issuespanel_no_match()}</div>
      {/if}
      {#each visibleIssues as issue (issue.number)}
        {@const isExpanded = expanded.has(issue.number)}
        <IssueRow
          {issue}
          epicSummary={epicByNumber.get(issue.number)}
          {isExpanded}
          epic={isExpanded ? epicFor(issue.number) : undefined}
          {repoPath}
          {bodyPreview}
          {age}
          {issueActions}
          {onnewtask}
          {onquick}
          ontoggleepic={toggleEpic}
        />
      {/each}
    {/if}
  </div>
</div>

<style>
  .issues-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .issues-header {
    padding: 6px 12px;
    margin-bottom: 8px; /* gap below the border to the flush sticky filter — margin (outside the border), not padding */
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .issues-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .issues-list::-webkit-scrollbar {
    width: 4px;
  }
  .issues-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .issues-list::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  /* Search field + "mine & unassigned" chip pinned above the scrolling rows. */
  .filter-bar {
    position: sticky;
    top: 0;
    z-index: 1;
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    gap: 6px;
    background: var(--color-inset);
  }

  /* Search field — same recipe as the command filter in PromptSources (.cmd-filter). */
  .issue-filter {
    flex: 1;
    min-width: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 4px 8px;
    border-radius: 2px;
  }

  .issue-filter:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  /* "Mine & unassigned" toggle — the .filter-chip recipe from ProjectBacklogList. */
  .filter-chip {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 0 10px;
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

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 4px 0;
  }

  @media (max-width: 768px) {
    .issues-list {
      -webkit-overflow-scrolling: touch;
    }
  }
</style>
