<script lang="ts">
  import { untrack } from "svelte";
  import type { BacklogPayload, Issue } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import ProjectBacklogList from "./ProjectBacklogList.svelte";
  import IssuesPanel from "./IssuesPanel.svelte";

  let {
    payload,
    mobile,
    onissue,
  }: {
    payload: BacklogPayload | null;
    mobile: boolean;
    onissue: (repoPath: string, issue: Issue) => void;
  } = $props();

  const BACKLOG_FILTER: string[] = ["bug", "enhancement"];

  type Tab = "issues" | "prs";
  let activeTab = $state<Tab>("issues");

  // selectedPath: initialized from pinnedPath once payload arrives;
  // user selection is not clobbered (only set when currently null).
  let selectedPath = $state<string | null>(null);

  // Use untrack to read selectedPath without subscribing to it, so that
  // dismissDetail() (which sets selectedPath = null) does not re-fire this
  // effect and immediately re-seed the overlay from pinnedPath.
  $effect(() => {
    const pinned = payload?.pinnedPath;
    if (pinned && untrack(() => selectedPath === null)) {
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
  {:else}
    <!-- tab bar -->
    <div class="tab-bar">
      <button
        class="tab-btn"
        class:active={activeTab === "issues"}
        type="button"
        onclick={() => (activeTab = "issues")}
      >
        {m.backlog_tab_issues_count({ count: payload.totals.openIssues })}
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === "prs"}
        type="button"
        onclick={() => (activeTab = "prs")}
      >
        {m.backlog_tab_prs_count({ count: payload.totals.openPRs })}
      </button>
    </div>

    <!-- tab content -->
    {#if activeTab === "issues"}
      {#if mobile}
        <!-- mobile: full-width list; selected project opens overlay -->
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
            </div>
            <div class="overlay-body">
              <IssuesPanel
                repoPath={selectedPath}
                onnewtask={(issue) => {
                  onissue(selectedPath!, issue);
                }}
                bodyPreview
                age
                filterLabels={BACKLOG_FILTER}
              />
            </div>
          </div>
        {/if}
      {:else}
        <!-- desktop: side-by-side master + detail -->
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
              <IssuesPanel
                repoPath={selectedPath}
                onnewtask={(issue) => {
                  onissue(selectedPath!, issue);
                }}
                bodyPreview
                age
                filterLabels={BACKLOG_FILTER}
              />
            {:else}
              <div class="detail-empty">
                <span class="detail-empty-label">{m.backlog_select_a_project()}</span>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {:else}
      <!-- PRs tab: placeholder, intentional empty state -->
      <div class="prs-tab">
        <div class="prs-count">{payload.totals.openPRs}</div>
        <div class="prs-soon">{m.backlog_prs_soon()}</div>
      </div>
    {/if}
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
    font-size: 11px;
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
    font-size: 11px;
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
    font-size: 10.5px;
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
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }

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
    font-size: 11px;
    letter-spacing: 0.08em;
    padding: 6px 12px;
    cursor: pointer;
    min-height: 40px;
    touch-action: manipulation;
  }

  .overlay-close:hover {
    background: var(--color-hover);
  }

  .overlay-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* ── PRs placeholder tab ── */
  .prs-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  .prs-count {
    font-size: 36px;
    font-variant-numeric: tabular-nums;
    color: var(--color-ink-bright);
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .prs-soon {
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 4px 10px;
  }
</style>
