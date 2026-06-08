<script lang="ts">
  import { untrack } from "svelte";
  import type { BacklogPayload, Issue, PullRequest } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import ProjectBacklogList from "./ProjectBacklogList.svelte";
  import IssuesPanel from "./IssuesPanel.svelte";
  import PrsPanel from "./PrsPanel.svelte";
  import ActionsPanel from "./ActionsPanel.svelte";
  import ReadinessPanel from "./ReadinessPanel.svelte";
  import { actionsTabState } from "./backlog-view";

  let {
    payload,
    mobile,
    onissue,
    onquick = undefined,
    onpr,
    onadopt,
  }: {
    payload: BacklogPayload | null;
    mobile: boolean;
    onissue: (repoPath: string, issue: Issue) => void;
    /** Quick-launch an issue with the configured standard command, skipping the
     *  New Task dialog. Omitted → no quick button is shown on the issues. */
    onquick?: (repoPath: string, issue: Issue) => void;
    /** Open a review task seeded with a PR (PRs tab → New Task). */
    onpr: (repoPath: string, pr: PullRequest) => void;
    /** Seed a New Task with the AI-readiness install prescription (Readiness tab). */
    onadopt: (repoPath: string, prompt: string) => void;
  } = $props();

  type Tab = "issues" | "prs" | "actions" | "readiness";
  let activeTab = $state<Tab>("issues");

  // selectedPath: initialized from pinnedPath once payload arrives;
  // user selection is not clobbered (only set when currently null).
  // Shared across tabs so switching Issues ↔ PRs keeps the chosen project.
  let selectedPath = $state<string | null>(null);

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
  $effect(() => {
    const pinned = payload?.pinnedPath;
    if (pinned && !mobile && untrack(() => selectedPath === null)) {
      selectedPath = pinned;
    }
  });

  // On mobile, a set selectedPath means the detail overlay is open.
  // Clearing it goes back to the project list.
  function dismissDetail() {
    selectedPath = null;
  }
</script>

<div class="backlog-view" class:mobile>
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
        projects={payload.projects}
        pinnedPath={payload.pinnedPath}
        {selectedPath}
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
          </div>
        </div>
        <div class="overlay-body">
          {#if activeTab === "issues"}
            <IssuesPanel
              repoPath={selectedPath}
              onnewtask={(issue) => {
                onissue(selectedPath!, issue);
              }}
              onquick={onquick ? (issue) => onquick(selectedPath!, issue) : undefined}
              bodyPreview
              age
            />
          {:else if activeTab === "prs"}
            <PrsPanel repoPath={selectedPath} onreview={(pr) => onpr(selectedPath!, pr)} age />
          {:else if activeTab === "actions"}
            <ActionsPanel repoPath={selectedPath} />
          {:else}
            <ReadinessPanel repoPath={selectedPath} onadopt={(rp, p) => onadopt(rp, p)} />
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <!-- desktop: persistent tab bar + side-by-side master / detail. Both panes
         are always visible, so flipping the tab visibly swaps the detail pane. -->
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
    </div>

    <div class="desktop-split">
      <div class="master-pane">
        <ProjectBacklogList
          projects={payload.projects}
          pinnedPath={payload.pinnedPath}
          {selectedPath}
          onselect={(p) => (selectedPath = p)}
        />
      </div>
      <div class="detail-pane">
        {#if selectedPath !== null}
          {#if activeTab === "issues"}
            <IssuesPanel
              repoPath={selectedPath}
              onnewtask={(issue) => {
                onissue(selectedPath!, issue);
              }}
              onquick={onquick ? (issue) => onquick(selectedPath!, issue) : undefined}
              bodyPreview
              age
            />
          {:else if activeTab === "prs"}
            <PrsPanel repoPath={selectedPath} onreview={(pr) => onpr(selectedPath!, pr)} age />
          {:else if activeTab === "actions"}
            <ActionsPanel repoPath={selectedPath} />
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
    padding: 6px 4px;
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

  .detail-pane {
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
    padding: 6px 4px;
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

  .overlay-head {
    display: flex;
    align-items: center;
    padding: 6px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
    min-height: 44px;
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
  }

  .overlay-close:hover {
    background: var(--color-hover);
  }

  /* Tab toggle relocated into the overlay header on mobile, pushed to the
     right of the back/close button. Touch-sized to match .overlay-close. */
  .overlay-tabs {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }

  .overlay-tabs .tab-btn {
    min-height: 40px;
    padding: 0 12px;
    touch-action: manipulation;
  }

  .overlay-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
