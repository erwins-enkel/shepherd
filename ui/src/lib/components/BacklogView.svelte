<script lang="ts">
  import { untrack } from "svelte";
  import type {
    BacklogPayload,
    DocAgentOutcome,
    DocAgentRun,
    DrainStatus,
    Epic,
    GitState,
    Issue,
    PullRequest,
    Session,
    Steer,
    TaskRunDefaults,
    TaskRunSeed,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { triggerDocAgent, getDocAgentRuns } from "#lib/api.js";
  import ProjectBacklogList from "./ProjectBacklogList.svelte";
  import ReposHead from "./ReposHead.svelte";
  import ReposSwitcher from "./ReposSwitcher.svelte";
  import AddRepoButton from "./AddRepoButton.svelte";
  import BacklogTabBar from "./backlog-view/BacklogTabBar.svelte";
  import BacklogTabContent from "./backlog-view/BacklogTabContent.svelte";
  import {
    actionsTabState,
    filterProjects,
    partitionRecents,
    splitHidden,
    tabForFilters,
  } from "./backlog-view";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { pullMainAndToast } from "#lib/pull-offer.js";

  let {
    payload,
    mobile,
    onclose = () => {},
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
    taskDefaults = undefined,
    onopensession = undefined,
    sessionInfo = undefined,
    issueSession = undefined,
    ondraftepic = undefined,
  }: {
    payload: BacklogPayload | null;
    mobile: boolean;
    /** Closes the Repos dialog — the ✕ in the desktop header. (Mobile's ✕ is the
     *  title bar BacklogOverlay still owns.) */
    onclose?: () => void;
    onissue: (repoPath: string, issue: Issue, run?: TaskRunSeed) => void;
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
    /** Open a session from the epic run area's slot holders (#2620). Omitted → no link. */
    onopensession?: (sessionId: string) => void;
    /** A session and its PR state from the store, by id — an epic child's session view. */
    sessionInfo?: (id: string) => { session: Session; git?: GitState } | null;
    /** The live session working an issue of a repo — the Issues overview's "Running now". */
    issueSession?: (repoPath: string, issue: number) => Session | null;
    /** Open the New Task composer set to draft an epic for a repo (Issues overview). */
    ondraftepic?: (repoPath: string) => void;
    /** Global run defaults for the Issues tab's task box (CLI / model / effort pre-fill). */
    taskDefaults?: TaskRunDefaults;
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

  // Repo-list scope (chips + search live in the list — ProjectBacklogList on mobile,
  // the ReposSwitcher popover on desktop). State is owned here so both lists and the
  // selection effects share it. On desktop the scope only narrows the popover's list;
  // it never deselects the open repo (see the drop effect below).
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
  // Hidden/visible partition of ALL repos, independent of the scope above — what the
  // header's "Zuletzt" chips and the pinned auto-seed draw from, so typing in the
  // switcher's search can't change them.
  const allSplit = $derived(
    payload ? splitHidden(payload.projects, repoConfig.hidden) : { visible: [], hidden: [] },
  );
  // Other recently-worked-on repos for the header chips (same ranking as the picker).
  const headerRecents = $derived(
    partitionRecents(allSplit.visible.filter((p) => p.path !== selectedPath)).recents,
  );

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
  // Skip the seed when the pinned repo is hidden — otherwise it would open a repo
  // the user parked. allSplit is read untracked so a hide toggle alone never
  // auto-seeds; seeding stays tied to payload/pinned changes.
  //
  // A seed honours the active filter chip too (same rule as a repo pick, via
  // tabForFilters), e.g. a payload that arrives while "has PRs" is on opens the
  // pinned repo on the PRs tab. The chips are read untracked so this effect's
  // dependencies stay payload/pinned only; the selectedPath === null guard above
  // means a poll can never re-tab a selection the user is already reading.
  $effect(() => {
    const pinned = payload?.pinnedPath;
    if (
      pinned &&
      !mobile &&
      untrack(() => selectedPath === null && allSplit.visible.some((p) => p.path === pinned))
    ) {
      selectedPath = pinned;
      const tab = untrack(() => tabForFilters({ hasIssues, hasPRs }));
      if (tab) activeTab = tab;
    }
  });

  // Desktop: if the selected repo is gone from the payload (removed), drop the
  // selection so the detail pane can't keep showing it. Chips/search/hide are NOT
  // grounds for dropping: the repo list is a transient popover now, so narrowing it
  // (or parking the open repo) must not blank the detail the user is reading.
  // Mobile selects from the visible list and can't touch it while the detail overlay
  // covers the list, so it never needs this.
  $effect(() => {
    if (
      !mobile &&
      payload &&
      selectedPath !== null &&
      !payload.projects.some((p) => p.path === selectedPath)
    ) {
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
  // — otherwise filterProjects would drop it from visibleProjects and the new repo
  // would be missing from the list the user just added it to. Switch to Issues so
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

  // Repo row click (shared by the mobile list and the desktop list, so the two
  // can't drift). An active filter chip picks the tab: filtering by "has PRs" is
  // an explicit statement of what the user is hunting for, so the click opens the
  // PRs tab instead of always landing on Issues. No chip → tabForFilters returns
  // null and the current tab is left exactly as it was.
  //
  // Re-applied on EVERY click while a chip is on — switching to Actions manually
  // and then picking another repo lands on that chip's tab again.
  function handleSelect(path: string) {
    selectedPath = path;
    const tab = tabForFilters({ hasIssues, hasPRs });
    if (tab) activeTab = tab;
  }

  let switcher = $state<ReturnType<typeof ReposSwitcher>>();

  /** Open the desktop repo switcher (the dialog's `R` shortcut). No-op on mobile or
   *  when there are no repos to switch between. */
  export function openSwitcher() {
    if (mobile || !payload || payload.projects.length === 0) return;
    switcher?.openPanel();
  }

  // On mobile, a set selectedPath means the detail overlay is open.
  // Clearing it goes back to the project list.
  function dismissDetail() {
    selectedPath = null;
  }
</script>

<div class="backlog-view" class:mobile class:flow>
  {#if !mobile}
    <!-- desktop header: the repo switcher + recents + Fast-forward + close, replacing
         the dialog's old "REPOS" title bar and the repo sidebar (mobile keeps both). -->
    {#if payload && payload.projects.length > 0}
      <ReposHead
        recents={headerRecents}
        onselect={handleSelect}
        onff={handleFf}
        ffDisabled={ffInFlight || selectedPath === null}
        {onclose}
      >
        <ReposSwitcher
          bind:this={switcher}
          {selected}
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
          onselect={handleSelect}
          onhide={handleHide}
          {onaddclone}
          {onaddfork}
          {onaddnewproject}
        />
      </ReposHead>
    {:else}
      <ReposHead {onclose} />
    {/if}
  {/if}
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
        onselect={handleSelect}
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
            mobile
            {taskDefaults}
            {onopensession}
            {sessionInfo}
            {issueSession}
            {ondraftepic}
            onopenautomation={() => (activeTab = "automation")}
          />
        </div>
      </div>
    {/if}
  {:else}
    <!-- desktop: the tab bar sits ABOVE the detail pane — the repo choice lives in the
         header's switcher, the tabs only switch the selected repo's detail content. -->
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
        showFf={false}
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
            {oninject}
            {onpr}
            {onlaunchtrain}
            {onadopt}
            {epics}
            {inTrainPrs}
            {target}
            {drain}
            {taskDefaults}
            {onopensession}
            {sessionInfo}
            {issueSession}
            {ondraftepic}
            onopenautomation={() => (activeTab = "automation")}
          />
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

  /* Desktop detail: tab bar stacked above the detail content, filling the dialog
     below the header (the repo list is the header popover, not a column). */
  .detail-column {
    flex: 1;
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

  /* ── mobile layout ── */
  .mobile-master {
    flex: 1;
    overflow-y: auto;
    padding: 0 4px;
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

  /* The start-page repo list grows with content; its detail must fit the screen,
     independently of that list's height or the document's scroll position. */
  .backlog-view.mobile.flow .mobile-detail-overlay {
    position: fixed;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
      env(safe-area-inset-left);
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
