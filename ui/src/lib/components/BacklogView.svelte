<script lang="ts">
  import { untrack } from "svelte";
  import type {
    BacklogPayload,
    DocAgentOutcome,
    DocAgentRun,
    DrainStatus,
    Epic,
    Issue,
    PullRequest,
    Steer,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { toasts } from "$lib/toasts.svelte";
  import { triggerDocAgent, getDocAgentRuns } from "$lib/api";
  import ProjectBacklogList from "./ProjectBacklogList.svelte";
  import AddRepoButton from "./AddRepoButton.svelte";
  import BacklogTabBar from "./backlog-view/BacklogTabBar.svelte";
  import BacklogTabContent from "./backlog-view/BacklogTabContent.svelte";
  import { actionsTabState, filterProjects, splitHidden } from "./backlog-view";
  import { repoConfig } from "$lib/reviews.svelte";
  import { pullMainAndToast } from "$lib/pull-offer";

  let {
    payload,
    mobile,
    onissue,
    onquick = undefined,
    oninject = undefined,
    onpr,
    onadopt,
    onlaunchtrain,
    // `flow` is consumed by the `class:flow` directive on the root element below; fallow's
    // prop-usage analyzer doesn't see Svelte `class:` shorthand, so it false-positives here
    // (pre-existing main-wide finding surfaced by this branch's pre-push audit).
    // fallow-ignore-next-line unused-component-props
    flow = false,
    epics = undefined,
    inTrainPrs = new Set(),
    target = null,
    drain = undefined,
    docAgentEnabled = false,
    docAgentAct = false,
    docAgentDone = null,
    onaddclone,
    onaddfork,
    onaddnewproject,
    selectPath = null,
  }: {
    payload: BacklogPayload | null;
    mobile: boolean;
    onissue: (repoPath: string, issue: Issue) => void;
    /** Quick-launch an issue with the configured standard command, skipping the
     *  New Task dialog. Omitted → no quick button is shown on the issues. */
    onquick?: (repoPath: string, issue: Issue, action: Steer) => void;
    /** Inject an issue steer: open the New Task dialog pre-seeded with the steer's
     *  prompt + the issue attached (does NOT spawn). Omitted → no steer items. */
    oninject?: (repoPath: string, issue: Issue, steer: Steer) => void;
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
    /** Whether the doc-agent feature is enabled for this repo. */
    docAgentEnabled?: boolean;
    /** True = act/PR phase; false = observe-only phase. */
    docAgentAct?: boolean;
    /** Reactive signal from store: a run just finished for a repo. */
    docAgentDone?: { repoPath: string; url: string | null; outcome: DocAgentOutcome } | null;
    /** "+ Add repo" menu actions — open the already-mounted Clone/Fork/New-project
     *  modals. Bubbled up to +page via BacklogOverlay → AppOverlays. */
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
    /** When set (a repo was just added from this panel), select that repo + switch
     *  to the Issues tab once per distinct value. Filters are cleared first so a
     *  brand-new (zero issues/PRs) repo isn't excluded from the visible list. */
    selectPath?: string | null;
  } = $props();

  type Tab = "issues" | "prs" | "actions" | "readiness" | "automation";
  let activeTab = $state<Tab>("issues");
  let ffInFlight = $state(false);

  // ── doc-agent state ──────────────────────────────────────────────────────────
  let docAgentRunning = $state(false);
  let docAgentRuns = $state<DocAgentRun[]>([]);

  async function refreshDocAgentRuns() {
    if (!docAgentEnabled || !selectedPath) return;
    const path = selectedPath;
    try {
      const r = await getDocAgentRuns(path);
      if (selectedPath === path) {
        docAgentRunning = r.running;
        docAgentRuns = r.runs;
      }
    } catch {
      // best-effort display — swallow errors
    }
  }

  // Re-fetch when repo selection or feature flag changes.
  $effect(() => {
    if (!docAgentEnabled || !selectedPath) {
      docAgentRunning = false;
      docAgentRuns = [];
      return;
    }
    void refreshDocAgentRuns();
  });

  // When a run finishes for the shown repo, refresh to pick up the result.
  $effect(() => {
    const done = docAgentDone;
    if (done && done.repoPath === untrack(() => selectedPath)) {
      void refreshDocAgentRuns();
    }
  });

  async function handleDocAgent() {
    if (!selectedPath || docAgentRunning) return;
    docAgentRunning = true; // optimistic
    try {
      const res = await triggerDocAgent(selectedPath);
      if (!res.started) toasts.info(m.docagent_trigger_skipped());
    } catch {
      toasts.info(m.docagent_trigger_failed());
    } finally {
      await refreshDocAgentRuns();
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

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
  // Ephemeral per-session UI state (not persisted): reveal the Hidden group in-place.
  let showHidden = $state(false);
  const searching = $derived(query.trim() !== "");

  // Filter first (unchanged predicate), then partition by hidden using repoConfig.hidden
  // as the optimistic overlay over each project's server `hidden` baseline.
  const filtered = $derived(
    payload ? filterProjects(payload.projects, { hasIssues, hasPRs, query }) : [],
  );
  const split = $derived(splitHidden(filtered, repoConfig.hidden));
  let visibleProjects = $derived(split.visible);
  // The Hidden group is revealed when the chip is on OR a search is active (so a
  // name search can surface a matching hidden repo even with Show-hidden off).
  const shownHidden = $derived(showHidden || searching ? split.hidden : []);
  // Chip badge counts ALL hidden repos, independent of the active search/scope.
  const hiddenCount = $derived(
    payload ? splitHidden(payload.projects, repoConfig.hidden).hidden.length : 0,
  );
  // Repos actually on screen = visible list ∪ any revealed hidden rows. The drop
  // effect uses this so hiding the selected repo with Show-hidden ON keeps its
  // (now dimmed) row + detail, while OFF removes the row and drops the selection.
  const onScreenPaths = $derived(new Set([...visibleProjects, ...shownHidden].map((p) => p.path)));

  function handleHide(path: string) {
    const p = payload?.projects.find((q) => q.path === path);
    if (!p) return;
    void repoConfig.toggleHidden(path, repoConfig.isHidden(path, p.hidden));
  }

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

  // Desktop: if the currently selected repo is no longer on screen (an active
  // filter narrowed it out, or it was hidden while Show-hidden is off), drop the
  // selection so the detail pane can't keep showing an off-list repo. A repo
  // hidden while Show-hidden is ON stays on screen (dimmed) → keeps its detail.
  // Mobile selects from the visible list and can't toggle filters while the detail
  // overlay covers the list, so it never needs this.
  $effect(() => {
    if (!mobile && selectedPath !== null && !onScreenPaths.has(selectedPath)) {
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

  // Auto-select a just-added repo (Clone/Fork/New-project succeeded from this
  // panel). Applied once per distinct value (appliedSelectPath read untracked so
  // the effect depends only on `selectPath`). A brand-new repo has zero issues/PRs
  // and won't match an active search, so the filter chips + query are cleared first
  // — otherwise filterProjects would drop it from visibleProjects and the desktop
  // drop-effect above would immediately clear this selection. Switch to Issues so
  // its detail pane opens (on mobile this opens the full-screen detail overlay,
  // which is the desired outcome of an explicit add action).
  let appliedSelectPath = $state<string | null>(null);
  $effect(() => {
    const path = selectPath;
    if (!path) {
      appliedSelectPath = null; // reset so re-adding the SAME path re-applies
      return;
    }
    if (path === untrack(() => appliedSelectPath)) return; // already applied
    appliedSelectPath = path;
    hasIssues = false;
    hasPRs = false;
    query = "";
    selectedPath = path;
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
    <!-- intentional empty state — also the primary place to surface "+ Add repo":
         a zero-repos user has no list header, so without this the acquisition
         affordance (the whole point of #1171) would be unreachable here. -->
    <div class="state-full">
      <span class="empty-label">{m.backlog_no_forge_repos()}</span>
      <AddRepoButton onclone={onaddclone} onfork={onaddfork} onnewproject={onaddnewproject} />
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
        hiddenProjects={shownHidden}
        {hiddenCount}
        {showHidden}
        pinnedPath={payload.pinnedPath}
        {selectedPath}
        {hasIssues}
        {hasPRs}
        {query}
        ontoggleissues={() => (hasIssues = !hasIssues)}
        ontoggleprs={() => (hasPRs = !hasPRs)}
        ontogglehidden={() => (showHidden = !showHidden)}
        onsearch={(q) => (query = q)}
        onselect={(p) => (selectedPath = p)}
        onhide={handleHide}
        {onaddclone}
        {onaddfork}
        {onaddnewproject}
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
          <BacklogTabBar
            variant="mobile"
            {activeTab}
            {selected}
            {actionsState}
            {ffInFlight}
            {selectedPath}
            {docAgentEnabled}
            {docAgentAct}
            {docAgentRunning}
            {docAgentRuns}
            onselecttab={(t) => (activeTab = t)}
            onff={handleFf}
            ondocagent={handleDocAgent}
          />
        </div>
        <div class="overlay-body">
          <BacklogTabContent
            {activeTab}
            {selectedPath}
            {onissue}
            {onquick}
            {oninject}
            {onpr}
            {onlaunchtrain}
            {onadopt}
            {epics}
            {inTrainPrs}
            {target}
            {drain}
          />
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
          hiddenProjects={shownHidden}
          {hiddenCount}
          {showHidden}
          pinnedPath={payload.pinnedPath}
          {selectedPath}
          {hasIssues}
          {hasPRs}
          {query}
          ontoggleissues={() => (hasIssues = !hasIssues)}
          ontoggleprs={() => (hasPRs = !hasPRs)}
          ontogglehidden={() => (showHidden = !showHidden)}
          onsearch={(q) => (query = q)}
          onselect={(p) => (selectedPath = p)}
          onhide={handleHide}
          {onaddclone}
          {onaddfork}
          {onaddnewproject}
        />
      </div>
      <div class="detail-column">
        <BacklogTabBar
          variant="desktop"
          {activeTab}
          {selected}
          {actionsState}
          {ffInFlight}
          {selectedPath}
          {docAgentEnabled}
          {docAgentAct}
          {docAgentRunning}
          {docAgentRuns}
          onselecttab={(t) => (activeTab = t)}
          onff={handleFf}
          ondocagent={handleDocAgent}
        />
        <div class="detail-pane">
          {#if selectedPath !== null}
            <BacklogTabContent
              {activeTab}
              {selectedPath}
              {onissue}
              {onquick}
              {onpr}
              {onlaunchtrain}
              {onadopt}
              {epics}
              {inTrainPrs}
              {target}
              {drain}
            />
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
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
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

  .overlay-body {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
