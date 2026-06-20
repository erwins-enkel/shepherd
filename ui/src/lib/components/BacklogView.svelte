<script lang="ts">
  import { untrack } from "svelte";
  import type { BacklogPayload, DrainStatus, Epic, Issue, PullRequest, Steer } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import ProjectBacklogList from "./ProjectBacklogList.svelte";
  import IssuesPanel from "./IssuesPanel.svelte";
  import PrsPanel from "./PrsPanel.svelte";
  import ActionsPanel from "./ActionsPanel.svelte";
  import ReadinessPanel from "./ReadinessPanel.svelte";
  import AutomationSettings from "./AutomationSettings.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { actionsTabState, filterProjects } from "./backlog-view";
  import { pullMainAndToast } from "$lib/pull-offer";

  let {
    payload,
    mobile,
    onissue,
    onquick = undefined,
    onpr,
    onadopt,
    onlaunchtrain,
    flow = false,
    epics = undefined,
    inTrainPrs = new Set(),
    target = null,
    drain = undefined,
  }: {
    payload: BacklogPayload | null;
    mobile: boolean;
    onissue: (repoPath: string, issue: Issue) => void;
    /** Quick-launch an issue with the configured standard command, skipping the
     *  New Task dialog. Omitted → no quick button is shown on the issues. */
    onquick?: (repoPath: string, issue: Issue, action: Steer) => void;
    /** Open a review task seeded with a PR (PRs tab → New Task). */
    onpr: (repoPath: string, pr: PullRequest) => void;
    /** Seed a New Task with the AI-readiness install prescription (Readiness tab). */
    onadopt: (repoPath: string, prompt: string) => void;
    /** Launch a merge train from a hand-picked PR multi-selection (PRs tab). */
    onlaunchtrain: (repoPath: string, prs: PullRequest[]) => void;
    /** When true, renders at natural height for parent-page scrolling (mobile list);
     *  default false preserves existing viewport-filling behavior. */
    flow?: boolean;
    /** Live epic record from the store, threaded down to IssuesPanel. */
    epics?: Record<string, Epic>;
    /** PR identity keys (`${repoPath}#${number}`) owned by a running merge train,
     *  forwarded to PrsPanel → PrRow for the in-train badge + merge lock. */
    inTrainPrs?: Set<string>;
    /** When set (EPIC badge click), select that repo, switch to the Issues tab,
     *  and expand+scroll the epic's row. Applied once per distinct value. */
    target?: { repoPath: string; issueNumber: number } | null;
    /** Live drain status keyed by repoPath (store.drain), forwarded to the
     *  Automation tab so its epic banner + drain-cap reflect reality without a task. */
    drain?: Record<string, DrainStatus>;
  } = $props();

  type Tab = "issues" | "prs" | "actions" | "readiness" | "automation";
  let activeTab = $state<Tab>("issues");
  let ffInFlight = $state(false);

  async function handleFf() {
    if (!selectedPath || ffInFlight) return;
    ffInFlight = true;
    try {
      await pullMainAndToast(selectedPath);
    } finally {
      ffInFlight = false;
    }
  }

  // selectedPath: initialized from pinnedPath once payload arrives;
  // user selection is not clobbered (only set when currently null).
  // Shared across tabs so switching Issues ↔ PRs keeps the chosen project.
  let selectedPath = $state<string | null>(null);

  // Repo-list filter (chips + search input live in ProjectBacklogList, state
  // owned here so the selection effects below can stay in sync with what the
  // list actually shows).
  let hasIssues = $state(false);
  let hasPRs = $state(false);
  let query = $state("");
  let visibleProjects = $derived(
    payload ? filterProjects(payload.projects, { hasIssues, hasPRs, query }) : [],
  );

  // Tab badges count the SELECTED repo's items — the same repo the detail pane
  // shows — not the all-repos `payload.totals` (which made "PRs · 5" sit over a
  // repo with no open PRs). null when nothing is selected → bare tab labels.
  let selected = $derived(
    selectedPath === null ? null : (payload?.projects.find((p) => p.path === selectedPath) ?? null),
  );

  // Actions tab display state — shared failure > count > bare precedence with the
  // actionsTabLabel helper (its single source of truth), so markup + tests agree.
  let actionsState = $derived(actionsTabState(selected));

  // Use untrack to read selectedPath without subscribing to it, so that
  // dismissDetail() (which sets selectedPath = null) does not re-fire this
  // effect and immediately re-seed the overlay from pinnedPath.
  //
  // Desktop only: pre-seeding fills the always-visible detail pane harmlessly.
  // On mobile the detail is a full-screen overlay that hides the project list
  // and the tab toggle, so auto-seeding would drop the user straight into a
  // repo's items on load — skip it and let mobile open from the list on tap.
  //
  // Skip the seed when the filter currently hides the pinned repo — otherwise it
  // would re-select a repo absent from the list (and fight the clear effect
  // below on every poll). visibleProjects is read untracked so a filter toggle
  // alone never auto-seeds; seeding stays tied to payload/pinned changes.
  $effect(() => {
    const pinned = payload?.pinnedPath;
    if (
      pinned &&
      !mobile &&
      untrack(() => selectedPath === null && visibleProjects.some((p) => p.path === pinned))
    ) {
      selectedPath = pinned;
    }
  });

  // Desktop: if an active filter hides the currently selected repo, drop the
  // selection so the detail pane can't keep showing a repo that's no longer in
  // the list. Mobile selects from the visible list and can't toggle filters
  // while the detail overlay covers the list, so it never needs this.
  $effect(() => {
    if (!mobile && selectedPath !== null && !visibleProjects.some((p) => p.path === selectedPath)) {
      selectedPath = null;
    }
  });

  // Apply an externally-supplied target (EPIC badge click) once per distinct
  // value: select its repo + switch to the Issues tab. This is an EXPLICIT user
  // action, so seeding selectedPath on mobile is desired (it opens the detail
  // overlay) — unlike the pinned-repo seed above which deliberately skips mobile.
  // appliedTargetKey is read untracked so the effect depends only on `target`,
  // never self-retriggering and never clobbering a later manual repo switch.
  let appliedTargetKey = $state<string | null>(null);
  $effect(() => {
    if (!target) {
      appliedTargetKey = null; // reset so reopening the SAME epic re-applies
      return;
    }
    const key = `${target.repoPath}#${target.issueNumber}`;
    if (key === untrack(() => appliedTargetKey)) return; // already applied
    appliedTargetKey = key;
    selectedPath = target.repoPath;
    activeTab = "issues";
  });

  // On mobile, a set selectedPath means the detail overlay is open.
  // Clearing it goes back to the project list.
  function dismissDetail() {
    selectedPath = null;
  }
</script>

<div class="backlog-view" class:mobile class:flow>
  {#if payload === null}
    <!-- loading state -->
    <div class="state-full">
      <span class="skeleton-pulse">{m.backlog_loading()}</span>
    </div>
  {:else if payload.projects.length === 0}
    <!-- intentional empty state -->
    <div class="state-full">
      <span class="empty-label">{m.backlog_no_forge_repos()}</span>
    </div>
  {:else if mobile}
    <!-- mobile: a single project list (the same list serves both tabs, so a
         standalone top tab bar would be a dead toggle here). Selecting a project
         opens a full-screen detail overlay; the overlay covers the top of the
         view, so the Issues/PRs toggle lives in the overlay header — the only
         place on a phone where flipping it actually changes what's on screen,
         since list and detail are never co-visible. -->
    <div class="mobile-master">
      <ProjectBacklogList
        projects={visibleProjects}
        pinnedPath={payload.pinnedPath}
        {selectedPath}
        {hasIssues}
        {hasPRs}
        {query}
        ontoggleissues={() => (hasIssues = !hasIssues)}
        ontoggleprs={() => (hasPRs = !hasPRs)}
        onsearch={(q) => (query = q)}
        onselect={(p) => (selectedPath = p)}
      />
    </div>
    {#if selectedPath !== null}
      <div class="mobile-detail-overlay" role="dialog" aria-modal="true">
        <div class="overlay-head">
          <button
            class="overlay-close"
            type="button"
            onclick={dismissDetail}
            aria-label={m.common_close()}
          >
            ‹ {m.common_close()}
          </button>
          <div class="overlay-tabs">
            <button
              class="tab-btn"
              class:active={activeTab === "issues"}
              type="button"
              onclick={() => (activeTab = "issues")}
            >
              {selected && selected.openIssues !== null
                ? m.backlog_tab_issues_count({ count: selected.openIssues })
                : m.backlog_tab_issues()}
            </button>
            <button
              class="tab-btn"
              class:active={activeTab === "prs"}
              type="button"
              onclick={() => (activeTab = "prs")}
            >
              {selected && selected.openPRs !== null
                ? m.backlog_tab_prs_count({ count: selected.openPRs })
                : m.backlog_tab_prs()}
            </button>
            <button
              class="tab-btn"
              class:active={activeTab === "actions"}
              class:failing={actionsState.kind === "failing"}
              type="button"
              onclick={() => (activeTab = "actions")}
            >
              {#if actionsState.kind === "failing"}
                {m.backlog_tab_actions_failing()}
              {:else if actionsState.kind === "count"}
                {m.backlog_tab_actions_count({ count: actionsState.count })}
              {:else}
                {m.backlog_tab_actions()}
              {/if}
            </button>
            <button
              class="tab-btn"
              class:active={activeTab === "readiness"}
              type="button"
              onclick={() => (activeTab = "readiness")}
            >
              {m.backlog_tab_readiness()}
            </button>
            <button
              class="tab-btn"
              class:active={activeTab === "automation"}
              type="button"
              onclick={() => (activeTab = "automation")}
            >
              {m.backlog_tab_automation()}
            </button>
            <button
              class="gbtn ff-btn"
              type="button"
              disabled={ffInFlight || selectedPath === null}
              onclick={handleFf}
              title={m.backlog_ff_main_title()}
              aria-label={m.backlog_ff_main_title()}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M1 2.5L5.5 6 1 9.5V2.5Z" fill="currentColor" />
                <path d="M6.5 2.5L11 6 6.5 9.5V2.5Z" fill="currentColor" />
              </svg>
              {m.backlog_ff_main()}
            </button>
          </div>
        </div>
        <div class="overlay-body">
          {#if activeTab === "issues"}
            <IssuesPanel
              repoPath={selectedPath}
              onnewtask={(issue) => {
                onissue(selectedPath!, issue);
              }}
              onquick={onquick
                ? (issue, action) => onquick(selectedPath!, issue, action)
                : undefined}
              bodyPreview
              age
              {epics}
              expandEpic={target && target.repoPath === selectedPath ? target.issueNumber : null}
            />
          {:else if activeTab === "prs"}
            <PrsPanel
              repoPath={selectedPath}
              onreview={(pr) => onpr(selectedPath!, pr)}
              {onlaunchtrain}
              {inTrainPrs}
              age
            />
          {:else if activeTab === "actions"}
            <ActionsPanel repoPath={selectedPath} />
          {:else if activeTab === "automation"}
            <div class="automation-scroll">
              {#if selectedPath !== null}
                <AutomationSettings
                  repoPath={selectedPath}
                  drain={drain?.[selectedPath] ?? null}
                  showHeader={false}
                />
              {/if}
            </div>
          {:else}
            <ReadinessPanel repoPath={selectedPath} onadopt={(rp, p) => onadopt(rp, p)} />
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <!-- desktop: side-by-side master / detail, with the tab bar sitting ABOVE the
         detail pane (not the whole view) — the project list on the left is shared
         across tabs, so the tabs only switch the selected repo's detail content;
         keeping them inside the detail column makes that hierarchy legible. -->
    <div class="desktop-split">
      <div class="master-pane">
        <ProjectBacklogList
          projects={visibleProjects}
          pinnedPath={payload.pinnedPath}
          {selectedPath}
          {hasIssues}
          {hasPRs}
          {query}
          ontoggleissues={() => (hasIssues = !hasIssues)}
          ontoggleprs={() => (hasPRs = !hasPRs)}
          onsearch={(q) => (query = q)}
          onselect={(p) => (selectedPath = p)}
        />
      </div>
      <div class="detail-column">
        <div class="tab-bar">
          <button
            class="tab-btn"
            class:active={activeTab === "issues"}
            type="button"
            onclick={() => (activeTab = "issues")}
          >
            {selected && selected.openIssues !== null
              ? m.backlog_tab_issues_count({ count: selected.openIssues })
              : m.backlog_tab_issues()}
          </button>
          <button
            class="tab-btn"
            class:active={activeTab === "prs"}
            type="button"
            onclick={() => (activeTab = "prs")}
          >
            {selected && selected.openPRs !== null
              ? m.backlog_tab_prs_count({ count: selected.openPRs })
              : m.backlog_tab_prs()}
          </button>
          <button
            class="tab-btn"
            class:active={activeTab === "actions"}
            class:failing={actionsState.kind === "failing"}
            type="button"
            onclick={() => (activeTab = "actions")}
          >
            {#if actionsState.kind === "failing"}
              {m.backlog_tab_actions_failing()}
            {:else if actionsState.kind === "count"}
              {m.backlog_tab_actions_count({ count: actionsState.count })}
            {:else}
              {m.backlog_tab_actions()}
            {/if}
          </button>
          <button
            class="tab-btn"
            class:active={activeTab === "readiness"}
            type="button"
            onclick={() => (activeTab = "readiness")}
          >
            {m.backlog_tab_readiness()}
          </button>
          <button
            class="tab-btn"
            class:active={activeTab === "automation"}
            type="button"
            onclick={() => (activeTab = "automation")}
            use:coachTarget={"backlog-automation"}
          >
            {m.backlog_tab_automation()}
          </button>
          <button
            class="gbtn ff-btn"
            type="button"
            disabled={ffInFlight || selectedPath === null}
            onclick={handleFf}
            title={m.backlog_ff_main_title()}
            aria-label={m.backlog_ff_main_title()}
            use:coachTarget={"backlog-ff-main"}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1 2.5L5.5 6 1 9.5V2.5Z" fill="currentColor" />
              <path d="M6.5 2.5L11 6 6.5 9.5V2.5Z" fill="currentColor" />
            </svg>
            {m.backlog_ff_main()}
          </button>
        </div>
        <div class="detail-pane">
          {#if selectedPath !== null}
            {#if activeTab === "issues"}
              <IssuesPanel
                repoPath={selectedPath}
                onnewtask={(issue) => {
                  onissue(selectedPath!, issue);
                }}
                onquick={onquick
                  ? (issue, action) => onquick(selectedPath!, issue, action)
                  : undefined}
                bodyPreview
                age
                {epics}
                expandEpic={target && target.repoPath === selectedPath ? target.issueNumber : null}
              />
            {:else if activeTab === "prs"}
              <PrsPanel
                repoPath={selectedPath}
                onreview={(pr) => onpr(selectedPath!, pr)}
                {onlaunchtrain}
                {inTrainPrs}
                age
              />
            {:else if activeTab === "actions"}
              <ActionsPanel repoPath={selectedPath} />
            {:else if activeTab === "automation"}
              <div class="automation-scroll">
                <AutomationSettings
                  repoPath={selectedPath}
                  drain={drain?.[selectedPath] ?? null}
                  showHeader={false}
                />
              </div>
            {:else}
              <ReadinessPanel repoPath={selectedPath} onadopt={(rp, p) => onadopt(rp, p)} />
            {/if}
          {:else}
            <div class="detail-empty">
              <span class="detail-empty-label">{m.backlog_select_a_project()}</span>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .backlog-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  /* ── loading / empty full-area states ── */
  .state-full {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .skeleton-pulse {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }

  .empty-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }

  /* ── tab bar ── */
  .tab-bar {
    display: flex;
    gap: 2px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-head);
    flex-shrink: 0;
  }

  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      color 0.12s,
      border-color 0.12s;
  }

  .tab-btn:hover {
    color: var(--color-ink);
  }

  .tab-btn.active {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-inset);
  }

  .tab-btn.failing {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }

  .tab-btn.failing.active {
    color: var(--color-red);
    border-color: var(--color-red);
    background: var(--color-inset);
  }

  /* ── fast-forward button ── */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* keyboard focus — flat inset amber ring (never an outer glow), per design-system */
  .gbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ff-btn {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    white-space: nowrap;
  }

  /* ── desktop split layout ── */
  .desktop-split {
    display: grid;
    grid-template-columns: minmax(220px, 300px) 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .master-pane {
    border-right: 1px solid var(--color-line);
    overflow-y: auto;
    padding: 0 4px 6px;
  }

  .master-pane::-webkit-scrollbar {
    width: 4px;
  }
  .master-pane::-webkit-scrollbar-track {
    background: transparent;
  }
  .master-pane::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  /* Right column: tab bar stacked above the detail content, so the tabs read as
     controlling this pane rather than the whole view. */
  .detail-column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .detail-pane {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .detail-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .detail-empty-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  /* Both tabs share the split / master / detail / overlay chrome above. */

  /* ── mobile layout ── */
  .mobile-master {
    flex: 1;
    overflow-y: auto;
    padding: 0 4px 6px;
    -webkit-overflow-scrolling: touch;
  }

  .mobile-master::-webkit-scrollbar {
    width: 4px;
  }
  .mobile-master::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  /* full-area overlay (stacks above the list) */
  .mobile-detail-overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    background: var(--color-inset);
  }

  /* BacklogView must be position:relative so the overlay is contained */
  .backlog-view.mobile {
    position: relative;
  }

  /* flow mode: render at natural height for parent-page scrolling (mobile list) */
  .backlog-view.flow {
    height: auto;
    overflow: visible;
  }

  .overlay-head {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
    min-height: 44px;
    gap: 8px;
  }

  .overlay-close {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
    min-height: 40px;
    touch-action: manipulation;
    flex-shrink: 0;
  }

  .overlay-close:hover {
    background: var(--color-hover);
  }

  /* Tab strip sits after the fixed close button and scrolls horizontally when
     tabs exceed the available width. Scrollbar is hidden (matches ControlBar
     convention). */
  .overlay-tabs {
    display: flex;
    gap: 2px;
    flex: 1 1 0;
    min-width: 0;
    overflow-x: auto;
    white-space: nowrap;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .overlay-tabs::-webkit-scrollbar {
    display: none;
  }

  .overlay-tabs .tab-btn {
    min-height: 40px;
    padding: 0 12px;
    touch-action: manipulation;
    flex-shrink: 0;
  }

  .overlay-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Automation tab owns its scroll: AutomationSettings is height-neutral and
     non-scrolling (so the in-task popover's own clamp stays the only scroller
     there), and both .detail-pane / .overlay-body are overflow:hidden — so this
     wrapper is the scroll region that keeps the full rows + roles section
     reachable. Mirrors ReadinessPanel's .scroll. */
  .automation-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
</style>
