<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { MediaQuery, SvelteSet } from "svelte/reactivity";
  import { HerdStore } from "$lib/store.svelte";
  import { createTabSignal, deriveTabState } from "$lib/tab-signal.svelte";
  import { tabTicker } from "$lib/tab-ticker.svelte";
  import {
    listSessions,
    createSession,
    archiveSession,
    relaunchSession,
    restoreSession,
    stageRelaunchImages,
    ApiError,
    getUsageLimits,
    getUpdate,
    getUpdateLog,
    getHerdrUpdate,
    getCodexUpdate,
    getPluginUpdates,
    getStarPrompt,
    gitStates,
    activityStates,
    claudeAliveStates,
    workingBlockedStates,
    blockStates,
    holdStates,
    subagentStates,
    previewStates,
    getBacklog,
    getSettings,
    listBranches,
    pickBaseBranch,
    getMergedClearable,
    clearMerged,
    getDrain,
    getAutoMerge,
    getCompletedEpics,
    dismissCompletedEpic,
    ackEpicMigrations,
    ackManualSteps,
    landEpic,
    getEpic,
    getDiagnostics,
    getPlugins,
    halt as apiHalt,
    getBuildQueues,
    listHeld,
    updateHeld,
    invokePluginRoute,
  } from "$lib/api";
  import type {
    AgentProvider,
    CompletedEpic,
    DeployState,
    BacklogPayload,
    HeldTask,
    Issue,
    IssueRef,
    OwedFocusSnapshot,
    PluginUpdatesStatus,
    PullRequest,
    SandboxProfile,
    Session,
    Settings as Settings_,
    Steer,
  } from "$lib/types";
  import { sortBlocked } from "$lib/triage";
  import { displayStatus } from "$lib/display-status";
  import { steers } from "$lib/steers.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { repos } from "$lib/repos.svelte";
  import { reviews, planGates, repoConfig } from "$lib/reviews.svelte";
  import { openPreviewInNewTab } from "$lib/previewOpen";
  import { recaps } from "$lib/recaps.svelte";
  import { herdDigest } from "$lib/herd-digest.svelte";
  import { upNext } from "$lib/up-next.svelte";
  import { claudeUsageHoldLikely } from "$lib/provider-capacity";
  import { doneSessions } from "$lib/done.svelte";
  import { postMergeSteps as postMergeStepsStore } from "$lib/post-merge-steps.svelte";
  import { learnings } from "$lib/learnings.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import { basename, shouldCloseLearningsDrawer } from "$lib/components/learnings-drawer";
  import Herd from "$lib/components/Herd.svelte";
  import {
    railOrder,
    isCommandBarChord,
    cycleId,
    nthId,
    nextNeedsYouTarget,
    altComboKey,
  } from "$lib/components/herd-keynav";
  import { groupSessionsByEpic } from "$lib/components/epic-grouping";
  import { normalizeEpicCollapse } from "$lib/components/herd-epic-collapse";
  import { isReworkRunning as isReworkRunningSession } from "$lib/components/rework-running";
  import { buildCommands } from "$lib/command-registry";
  import type { HerdFilter } from "$lib/components/herd-partition";
  import {
    collectReadyPrs,
    isMerging,
    mergeTrainCreateInput,
    pickTrainRepo,
  } from "$lib/components/merge-train";
  import Viewport from "$lib/components/Viewport.svelte";
  import DoneRecapPanel from "$lib/components/DoneRecapPanel.svelte";
  import type { KickoffChoice } from "$lib/components/NewProject.svelte";
  import ActionBar from "$lib/components/ActionBar.svelte";
  import QueueStrip from "$lib/components/QueueStrip.svelte";
  import RepoSwitcher from "$lib/components/RepoSwitcher.svelte";
  import {
    firstCurateRepo,
    globalLearningsCounts,
    nextRepoFilter,
    pickRepoSwitchTarget,
    repoChipRows,
    staleFilterRepos,
    followRepoFilter,
  } from "$lib/components/queue-strip";
  import BacklogView from "$lib/components/BacklogView.svelte";
  import AppOverlays from "$lib/components/page/AppOverlays.svelte";
  import ExperimentPicker from "$lib/components/ExperimentPicker.svelte";
  import type { ExperimentPickerState } from "$lib/components/ExperimentPicker.svelte";
  import FeedbackDialog from "$lib/components/FeedbackDialog.svelte";
  import TelemetryConsent from "$lib/components/TelemetryConsent.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import { registerSW, onSelectSession, onOpenLearnings } from "$lib/push";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import type { FeatureAnnouncement } from "$lib/feature-announcements";
  import { featureAnnouncements, FABLE_FEATURE_ID } from "$lib/feature-announcements";
  import { resolveFableArrival } from "$lib/fable-arrival";
  import { featureDiscovery } from "$lib/featureDiscovery.svelte";
  import { computeNewEntries } from "$lib/feature-gate";
  import { version } from "$lib/build-info";
  import { sidebarCollapse, sidebarShouldCollapse } from "$lib/sidebar-collapse.svelte";
  import { herdWidth } from "$lib/herd-width.svelte";
  import { backlogRefresh } from "$lib/backlog-refresh.svelte";
  // Side-effect-free (no top-level DOM/timer work) — tree-shakes out of non-demo
  // builds along with every other __DEMO__-guarded reference below.
  import { commandBarShowcase } from "$lib/demo/showcase";

  const store = new HerdStore();

  // Ambient tab-state signaling (#1327): when THIS tab is backgrounded, mirror the
  // count of sessions needing the operator (blocked · ci-red · ready-to-merge) into
  // the tab title + a severity-dot favicon + the App Badge. Driven by one $effect off
  // the store here (where the HerdStore instance lives, not +layout); the aria-live
  // region below mirrors changes for screen readers. Disposed on unmount.
  const tabSignal = createTabSignal();
  $effect(() => {
    const st = deriveTabState(store.sessions, store.git, store.workingBlocked, planGates.map);
    // Progress ring: selected session's build-queue completion, but ONLY when it is
    // running and nothing needs the operator (the severity dot always wins).
    const sel = selected;
    const q = sel ? store.buildQueues[sel.id] : undefined;
    let ringFraction: number | null = null;
    if (
      sel &&
      st.count === 0 &&
      displayStatus(sel, store.workingBlocked) === "running" &&
      q &&
      q.steps.length > 0
    ) {
      const done = q.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
      ringFraction = done / q.steps.length;
    }
    tabSignal.update({ ...st, attended: store.attended, ticker: tabTicker.enabled, ringFraction });
  });
  $effect(() => () => tabSignal.dispose());

  // PR identity keys (`${repoPath}#${number}`) currently owned by a running merge
  // train — a session that's flagged merging and has an open PR number. Threaded
  // down to the backlog PRs panel so each in-train row shows a badge + its manual
  // merge button is disabled (the train owns the merge).
  // NB: isMerging is called WITHOUT nowMs on purpose. Marks appear/disappear on
  // `session:merging` store events (not the clock), so this re-derives only when
  // the store changes — passing nowMs would rebuild the Set every 1s tick and
  // re-render every backlog PR row for a 24h-backstop boundary that never bites
  // in practice (cf. the partition's same nowMs-avoidance choice).
  const inTrainPrs = $derived(
    new Set(
      store.sessions
        .filter((s) => isMerging(s))
        .map((s) => {
          const n = store.git[s.id]?.number;
          return n != null ? `${s.repoPath}#${n}` : null;
        })
        .filter((k): k is string => k !== null),
    ),
  );
  let selectedId = $state<string | null>(null);
  // Monotonic tick bumped when a row's Preview badge is clicked; passed to the
  // Viewport so it switches to its Preview tab. A counter (not a boolean) so a
  // repeat click on the already-selected session still re-triggers the open.
  let openPreviewTick = $state(0);
  let renameRequest = $state<{ id: string; tick: number } | null>(null);
  let renameRequestSeq = 0;
  // Flatten the /api/preview snapshot ({ id: { previewPort, serve? } }) into the
  // store's flat sessionId → port|null map (unchanged shape; serve is separate).
  function flattenPreview(
    map: Record<string, { previewPort: number | null; serve?: "ok" | "failed" }>,
  ): Record<string, number | null> {
    return Object.fromEntries(Object.entries(map).map(([id, v]) => [id, v.previewPort]));
  }
  // Extract the tailscale-serve registration status from the /api/preview snapshot
  // into the store's sessionId → "ok"|"failed" map (absent = not managed / no mapping).
  function extractServe(
    map: Record<string, { previewPort: number | null; serve?: "ok" | "failed" }>,
  ): Record<string, "ok" | "failed"> {
    return Object.fromEntries(
      Object.entries(map).flatMap(([id, v]) => (v.serve ? [[id, v.serve]] : [])),
    );
  }
  // Keep Preview-chip behavior deterministic: rows only resolve their mode after
  // the repo config fetch has settled. Successful loads use the persisted repo
  // mode; failed loads fall back to ask so the chip never stays inert.
  $effect(() => {
    const reposWithPreview = new Set(
      store.sessions.filter((s) => store.preview[s.id] != null).map((s) => s.repoPath),
    );
    for (const repo of reposWithPreview) void repoConfig.ensure(repo);
  });
  // A row asked to open its live preview. Inline preserves the existing select +
  // Preview-tab tick path; tab uses the same URL helper as Viewport's iframe.
  function openPreview(id: string, target: "inline" | "tab" = "inline") {
    if (target === "tab") {
      const port = store.preview[id];
      if (port == null || typeof location === "undefined") return;
      openPreviewInNewTab(settings?.previewHost ?? null, location, port);
      return;
    }
    selectUnit(id);
    openPreviewTick++;
  }
  function openRename(id: string) {
    selectUnit(id, false, true);
    if (mobile.current) mobileScreen = "detail";
    renameRequest = { id, tick: ++renameRequestSeq };
  }
  let showNew = $state(false);
  let showSettings = $state(false);
  let showUsage = $state(false);
  let settingsTab = $state<"workspace" | "session" | "device" | "diagnose" | "plugins">(
    "workspace",
  );
  let focusPluginId = $state<string | null>(null);
  // Steer id to expand + focus in the steers editor when Settings opens (set from the
  // steer chip's right-click → "Edit" action; null when the editor is opened plainly).
  let focusSteerId = $state<string | null>(null);
  let showClone = $state(false);
  let showFork = $state(false);
  let showNewProject = $state(false);
  // Where a Clone/Fork/New-project modal was opened from. The three modals are
  // shared (mounted once), so their done/close handlers branch on this: "backlog"
  // keeps the user in the Backlog panel (refetch + auto-select), "newtask" reopens
  // New Task preselected. Set on EVERY open path, reset on every close/done so a
  // cancelled backlog open can't misroute a later New-Task completion.
  let repoAddOrigin = $state<"backlog" | "newtask" | null>(null);
  // Path of a repo just added from the Backlog panel, forwarded to BacklogView to
  // auto-select it. Sticky until the next backlog close (the view applies it once).
  let backlogSelectPath = $state<string | null>(null);
  let showBroadcast = $state(false);
  // Cmd/Ctrl+K quick-switcher over sessions/repos/lenses (#1334). Opened from
  // onShortcut before the modifier/typing bails so it fires even over the terminal.
  let showCommandBar = $state(false);
  // Demo-only scripted-showcase seed (see $lib/demo/showcase.ts) — forwarded to
  // CommandBar's `initialFilter`. Stays "" on the real ⌘K path.
  let demoCommandFilter = $state("");
  // Mirror the one-shot showcase store into local state — guarded so the whole
  // subscription dead-code-eliminates out of non-demo builds. The real ⌘K path
  // (onShortcut / oncommandbar* handlers below) never touches this store, so
  // demoCommandFilter stays "" and showCommandBar is unaffected outside the demo.
  $effect(() => {
    if (!__DEMO__) return;
    const unsub = commandBarShowcase.subscribe((s) => {
      showCommandBar = s.open;
      demoCommandFilter = s.filter;
    });
    return unsub;
  });
  let showRetry = $state(false);
  // Epic-diagnosis entry (command bar → arbitrary parent #, #1657). Defaults its repo
  // picker to the in-focus repo when the herd is filtered to exactly one.
  let showEpicDiagnose = $state(false);
  // "clear all merged" confirm modal: the merged sessions to clear + their total
  // leftover subprocess count (both fetched server-side when the modal opens).
  let clearMergedSessions = $state<Session[] | null>(null);
  let clearMergedLeftovers = $state(0);
  // Pending merge-train awaiting operator confirmation. Setting it opens the
  // confirm modal; confirming runs `run` (the original launch); closing discards
  // with zero side effects. `run` carries the full launch closure for whichever
  // trigger armed it, so the modal stays uniform across both paths.
  let pendingTrain = $state<{
    repoLabel: string;
    items: { number: number; title: string }[];
    handpicked: boolean;
    otherRepoCount: number;
    run: () => Promise<void>;
  } | null>(null);
  let showLearnings = $state(false);
  // True once the first learnings.load() has resolved. Gates the auto-close effect so a
  // deep-link (issue #852: ?learnings=1 / "open-learnings") that opens the drawer before
  // the async load populates items/injectable isn't reversed by the still-empty lists.
  let learningsLoaded = $state(false);
  // When the learnings drawer is opened from the gear menu and there's nothing to
  // approve, this carries the first over-budget ("curate") repoPath so the drawer scrolls
  // to the matching section; null = opened globally with proposals to review.
  let learningsRepo = $state<string | null>(null);
  // Herd repo filter: set of full repo paths, toggled from RepoSwitcher chips (Shift+click
  // combines several) or a card's inline repo emoji; empty = all repos. Only narrows the herd
  // list views — selection and global counts stay whole. A SvelteSet is already reactive, so it
  // is a `const` mutated in place (never reassigned) via the helpers below.
  const repoFilter = new SvelteSet<string>();
  // The single active repo when exactly one is selected, else null. Drives the single-repo
  // behaviors (selection re-target, new-task follow, composer prefill) so a multi-selection
  // never yanks selection or prefills a repo.
  const activeRepo = $derived(repoFilter.size === 1 ? [...repoFilter][0]! : null);
  // Reconcile the filter set in place (mutation, not reassignment — SvelteSet is reactive).
  function replaceRepoFilter(paths: Iterable<string>) {
    const next = new Set(paths);
    for (const p of [...repoFilter]) if (!next.has(p)) repoFilter.delete(p);
    for (const p of next) repoFilter.add(p);
  }
  // Chip / inline-emoji click: additively toggle (Shift) or reset-to-single (plain click).
  function applyRepoFilter(repoPath: string, additive: boolean) {
    replaceRepoFilter(nextRepoFilter(repoFilter, repoPath, additive));
  }
  const PINNED_REPO_KEY = "shepherd:repo-switcher-pinned";
  // Local display preference for the herd repo switcher. A pinned repo keeps its
  // normal filter behavior but sorts to the first chip slot whenever it is live.
  let pinnedRepo = $state<string | null>(null);
  onMount(() => {
    try {
      pinnedRepo = localStorage.getItem(PINNED_REPO_KEY) || null;
    } catch {
      // private mode / blocked storage: pinning stays in-memory for this page
    }
  });
  function setPinnedRepo(repoPath: string | null) {
    pinnedRepo = repoPath;
    try {
      if (repoPath) localStorage.setItem(PINNED_REPO_KEY, repoPath);
      else localStorage.removeItem(PINNED_REPO_KEY);
    } catch {
      // ignore: best-effort local preference
    }
  }
  // Latches set by selectNewSession when the herd filter follows a just-started task
  // onto its repo. That session isn't in the store yet (it arrives via WS), so two
  // effects below need coordinating until it does. Both are plain `let` (NON-reactive):
  // reading/clearing them inside an effect must not feed back into reactivity.
  //   • followingRepo — the followed repo path; holds the prune effect off that
  //     repo until its chip appears (else staleFilterRepos, seeing no chip yet,
  //     would immediately drop the repo we just set). Released once the chip lands.
  //   • followingNewSession — one-shot; suppresses the repo-switch re-target for the
  //     single filter change selectNewSession makes (selection is already on the new task).
  let followingRepo: string | null = null;
  let followingNewSession = false;
  // Chips for the repo switcher: one per repo with a live session, computed from the
  // unfiltered herd (selection/global counts stay whole). Single source — passed to the switcher.
  const repoChips = $derived(
    repoChipRows(store.sessions, store.drain, learnings.items, learnings.injectable),
  );
  const learningsCounts = $derived(globalLearningsCounts(learnings.items, learnings.injectable));
  // Prune only the selected repos whose last live session has ended (no chip) — a filter on a
  // vanished repo would strand it in the set. Removes exactly the stale members, keeping the rest.
  $effect(() => {
    // Release the follow latch once the just-started task's session has arrived (its
    // chip now exists). repoChips is reactive, so its WS-driven change re-runs this.
    if (followingRepo !== null && repoChips.some((c) => c.repoPath === followingRepo)) {
      followingRepo = null;
    }
    // A just-followed repo has no chip until its session arrives — that gap is expected, not a
    // vanished repo, so don't prune the repo we just followed onto. Any OTHER stale member is
    // still pruned normally.
    for (const stale of staleFilterRepos(repoFilter, repoChips)) {
      if (stale !== followingRepo) repoFilter.delete(stale);
    }
  });
  // Picking a repo chip narrows the herd list to that repo — but the terminal would
  // otherwise keep showing whatever session was selected before, which now lives in a
  // different repo than the visible list. Re-target selection onto the chosen repo
  // (waiting-on-you session first, then first active, then any). Tracks ONLY activeRepo
  // (everything else is untracked) so it fires on a single-repo chip switch, never on a
  // later session/block update. Keyed on activeRepo (null unless exactly one repo is
  // selected) so shift-adding a 2nd repo to a multi-selection keeps the current selection.
  $effect(() => {
    const rf = activeRepo;
    // Consume the one-shot suppression FIRST — before any early return — so it can't
    // leak (if the prune effect emptied the filter this same flush, an early
    // `rf == null` return would otherwise strand the flag true and suppress the next
    // legitimate repo-chip re-target). selectNewSession already pointed selection at a
    // just-started session in `rf` (not in the store yet — it arrives via WS), so when
    // set this skips the one re-target that would grab a *different* existing session.
    const skipFollow = followingNewSession;
    followingNewSession = false;
    if (rf == null) return; // "all repos" or a multi-selection keeps selection whole
    if (skipFollow) return;
    untrack(() => {
      const target = pickRepoSwitchTarget(
        rf,
        store.sessions,
        store.blocks,
        store.workingBlocked,
        selected,
      );
      // toDetail=false: filtering the list must not fling a phone user into a terminal.
      if (target) selectUnit(target, false, false);
    });
  });
  // Session-status filter toggled from the TopBar tallies; null = all statuses.
  // Independent of the repo filter — both compose into herdSessions below. Sticky
  // by design: statuses fluctuate (running ↔ idle), so an auto-clear on count-zero
  // would pop the filter off mid-observation; the filtered empty state + chip in
  // the herd head are the way out instead.
  let statusFilter = $state<"running" | "idle" | "blocked" | null>(null);
  const herdSessions = $derived.by(() => {
    const byRepo = repoFilter.size
      ? store.sessions.filter((s) => repoFilter.has(s.repoPath))
      : store.sessions;
    // displayStatus, not raw status: a working-while-blocked session belongs under
    // the "running" filter (the tallies count it there), never under "blocked".
    return statusFilter
      ? byRepo.filter((s) => displayStatus(s, store.workingBlocked) === statusFilter)
      : byRepo;
  });
  // Display name of the active filter for the herd's empty-state copy: null when unfiltered,
  // the basename for a single repo, "N repos" for a multi-selection.
  const repoFilterName = $derived(
    repoFilter.size === 0
      ? null
      : repoFilter.size === 1
        ? basename([...repoFilter][0]!)
        : m.repo_filter_multi_name({ count: repoFilter.size }),
  );
  // completed epics scoped to the active repo filter (mirrors herdSessions' repo scope)
  const completedEpicsShown = $derived(
    repoFilter.size
      ? store.completedEpics.filter((e) => repoFilter.has(e.repoPath))
      : store.completedEpics,
  );

  // ── Epic grouping (page-owned, shared by the Herd render AND the keynav rail) ──
  // The live ACTIVE epics: one per repo whose drain carries an `epicParent`. Keyed
  // `${repoPath}#${parentIssueNumber}` (same shape as store.epics / activeEpicKeys
  // in groupSessionsByEpic). Derived from store.drain so it updates on the bootstrap
  // GET /api/drain AND on every `drain:status` WS push — an epic starting mid-session
  // enters this set at once, without waiting for a chance `epic:update`.
  const activeEpicKeys = $derived(
    new Set(
      Object.values(store.drain)
        .filter((d) => d.epicParent != null)
        .map((d) => `${d.repoPath}#${d.epicParent}`),
    ),
  );
  // Page-owned collapse state (group key → collapsed). SvelteSet so .has/.add/.delete
  // are reactive (a plain Set is not in Svelte 5); passed to both <Herd> (render) and
  // railOrder (nav) so the two read ONE source and can't drift.
  const collapsedEpics = new SvelteSet<string>();
  const touchedEpicCollapseKeys = new SvelteSet<string>();
  function replaceSet(target: SvelteSet<string>, next: ReadonlySet<string>) {
    for (const key of [...target]) {
      if (!next.has(key)) target.delete(key);
    }
    for (const key of next) {
      if (!target.has(key)) target.add(key);
    }
  }
  function normalizeRenderedEpicCollapse(keys: string[]) {
    const next = normalizeEpicCollapse(keys, collapsedEpics, touchedEpicCollapseKeys);
    replaceSet(collapsedEpics, next.collapsed);
    replaceSet(touchedEpicCollapseKeys, next.touched);
  }
  function markEpicCollapseTouched(key: string) {
    touchedEpicCollapseKeys.add(key);
  }
  function expandEpicGroup(key: string) {
    markEpicCollapseTouched(key);
    collapsedEpics.delete(key);
  }
  function collapseEpicGroup(key: string) {
    markEpicCollapseTouched(key);
    collapsedEpics.add(key);
  }
  function toggleEpicCollapse(key: string) {
    if (collapsedEpics.has(key)) expandEpicGroup(key);
    else collapseEpicGroup(key);
  }
  // Seed store.epics for any active epic we don't have the full Epic for yet (header
  // needs title + X/Y + backlog link). Reactive on activeEpicKeys, deduped per key.
  // Fires on load (drain bootstrapped) and when an epic starts mid-session. The effect
  // re-runs when activeEpicKeys (drain:status) or store.epics (epic:update) change — not on
  // a timer — so on a transient getEpic failure we drop the guard and the next such update
  // re-runs this and retries. A persistently failing fetch leaves those children ungrouped
  // (they still render in the lifecycle sections) — acceptable fail-open degradation.
  // Deliberately a plain (non-reactive) Set: it's a fetch-dedup guard, NOT UI state —
  // a SvelteSet would make the seed $effect re-run on its own .add/.delete and churn.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const seededEpics = new Set<string>();
  $effect(() => {
    for (const k of activeEpicKeys) {
      if (store.epics[k] || seededEpics.has(k)) continue;
      seededEpics.add(k);
      const i = k.lastIndexOf("#"); // repoPath may contain no '#'; parent is after the last '#'
      const repoPath = k.slice(0, i);
      const parent = Number(k.slice(i + 1));
      getEpic(repoPath, parent)
        .then((e) => store.setEpic(e))
        .catch(() => seededEpics.delete(k));
    }
  });
  // sessionId → epic group key, from the SAME pure grouping the Herd render + rail use.
  // Drives NEEDS-YOU auto-expand: a jump target sitting in a collapsed group is found
  // here so the handler can expand that group before selecting. Built off raw
  // herdSessions (no rail ready/status filter): it only resolves the group of a blocked
  // jump target (which always passes the filter) to remove a collapsed key — never used
  // for ordering — so the filter asymmetry with render/rail is intentional and harmless.
  const epicGroupOf = $derived.by(() => {
    const isReviewing = (id: string) => reviews.isReviewing(id) || planGates.isReviewing(id);
    const isReworkRunning = (session: Session) =>
      isReworkRunningSession(
        session,
        { planGate: planGates.map[session.id], review: reviews.map[session.id] },
        store.workingBlocked,
        nowMs,
      );
    const { groups } = groupSessionsByEpic(
      herdSessions,
      store.epics,
      activeEpicKeys,
      store.git,
      isReviewing,
      isReworkRunning,
      nowMs,
    );
    // Build from an entries array (not .set in a loop) so it's a plain non-reactive
    // lookup, matching Herd's groupParts pattern.
    return new Map<string, string>(
      groups.flatMap((g) => g.sessions.map((s): [string, string] => [s.id, g.key])),
    );
  });

  let showUpdate = $state(false);
  // live state of a launched deploy → modal tails its log + surfaces failures
  let deploy = $state<DeployState | null>(null);
  let deployPollTimer: ReturnType<typeof setTimeout> | null = null;
  let showHerdrUpdate = $state(false);
  // set once the operator confirms the herdr update; herdr+shepherd restart drops
  // the WS and the store auto-reconnects, refreshing state once the new build is live.
  let herdrUpdating = $state(false);
  let showCodexUpdate = $state(false);
  // set once the operator confirms the codex update; the install runs server-side
  // and the modal resolves itself via the codex-update:done event.
  let codexUpdating = $state(false);
  // Open the codex modal fresh: drop any prior terminal result + log so a *failed*
  // apply's "you can retry" state doesn't linger and hide the Update button (the
  // done event can land after the modal was closed, re-arming the stale result).
  function openCodexUpdate() {
    store.codexUpdateDone = null;
    store.codexUpdateLog = [];
    codexUpdating = false;
    showCodexUpdate = true;
  }
  // Installed-plugin update status + in-place apply.
  let showPluginUpdates = $state(false);
  function openPluginUpdates() {
    showPluginUpdates = true;
  }
  function closePluginUpdates() {
    showPluginUpdates = false;
  }
  /** After an in-place plugin update: adopt the recomputed snapshot (refreshes the badge)
   *  and reload the loaded-plugin list so a freshly-activated/newly-versioned plugin shows. */
  function onPluginUpdated(status: PluginUpdatesStatus) {
    store.pluginUpdates = status;
    loadPlugins();
  }
  let showWhatsNew = $state(false);
  let whatsNewEntries = $state<FeatureAnnouncement[]>([]);
  let whatsNewDotOn = $state(false);
  // One-time Fable 5 launch celebration (gated separately from the What's-New
  // drawer via the persisted seen-set, so it fires exactly once per upgrade).
  // fableArrivalEligible is set synchronously in onMount if the feature entry is
  // unseen; the actual showFableArrival flip is deferred to loadSettings().then()
  // so we can gate on s.fableAvailable — fails closed: no settings ⇒ no hero.
  let showFableArrival = $state(false);
  let fableArrivalEligible = false;
  // First-run onboarding: a one-screen environment checklist shown only on a
  // genuinely fresh install. The fresh-install branch seeds lastSeenVersion
  // immediately (so update-diffs work), which would flip the null gate false on
  // this same load — so we latch "was fresh" before seeding and gate on that +
  // the persisted seen-set (markSeen("onboarding") keeps it from reappearing).
  let showOnboarding = $state(false);
  // First-run telemetry consent prompt — shown once, after onboarding resolves, when the
  // server reports telemetry is available but the operator hasn't answered yet. See
  // loadSettings() for the gating and the render site near AppOverlays for the
  // onboardingBlocking guard (never stack over the blocking repo-pick modal).
  let showTelemetryConsent = $state(false);
  // True only when the diagnostics seed fetch failed and no snapshot has arrived
  // yet (HTTP or the WS push) — lets the onboarding checklist show a retry instead
  // of a permanent "Loading…".
  let diagnosticsLoadFailed = $state(false);
  function loadDiagnostics() {
    getDiagnostics()
      .then((d) => {
        store.diagnostics = d;
        diagnosticsLoadFailed = false;
      })
      .catch(() => {
        if (!store.diagnostics) diagnosticsLoadFailed = true;
      });
  }
  // Bootstrap the loaded-plugins list (issue #1124). Best-effort: a missing registry
  // returns an empty list, keeping the Settings → Plugins tab hidden. Live `plugin:status`
  // pushes update it thereafter via the store.
  function loadPlugins() {
    getPlugins()
      .then((list) => store.setPlugins(list))
      .catch(() => {});
  }
  const blockedEntries = $derived(sortBlocked(store.sessions, store.blocks, store.holds));
  $effect(() => {
    // Close only when both the proposed list and the injected view are empty —
    // a repo can have injected rules to curate with zero outstanding proposals.
    // Gated on learningsLoaded so a deep-link that opens the drawer before the async
    // load resolves (empty lists) isn't immediately closed (issue #852).
    if (
      shouldCloseLearningsDrawer(
        showLearnings,
        learningsLoaded,
        learnings.items.length,
        learnings.injectable.length,
      )
    )
      showLearnings = false;
  });
  let nowMs = $state(Date.now());
  let composeRepoPath = $state<string | null>(null);
  let composeIssue = $state<Issue | null>(null);
  // Seed prompt for the New Task dialog (PR review path); null = no seed.
  let composePrompt = $state<string | null>(null);
  // Seed model for the New Task dialog (Fable celebration "Try it" path); null = picker default.
  let composeModel = $state<string | null>(null);
  // Seed effort for the composer, mirroring composeModel. On relaunch/edit-held it carries the
  // original's effort so the picker shows it (and the submit forwards it); null = provider default.
  let composeEffort = $state<string | null>(null);
  // Relaunch-elsewhere: when set, the New Task dialog runs in relaunch mode and its
  // submit routes to relaunchSession(originalId, …) instead of createSession.
  let relaunchOriginalId = $state<string | null>(null);
  // Seed base branch for the New Task dialog (preserved across a relaunch); null = repo default.
  let composeBaseBranch = $state<string | null>(null);
  // Relaunch source issue number (null = none); drives the relaunch note's cross-repo issue-drop line.
  let relaunchIssueNumber = $state<number | null>(null);
  // Carried images from the original session, staged on relaunch-elsewhere so the composer
  // seeds them as removable chips (its image list is the single source of truth on submit).
  let composeImages = $state<{ path: string; name: string }[]>([]);
  // Edit-held: when set, the New Task dialog runs in edit mode and its submit routes to
  // updateHeld(id, …) instead of createSession, keeping the task held with the new input.
  let editHeldId = $state<string | null>(null);
  // Run-config seeds carried into the composer when editing a held task, so a prompt-only
  // tweak round-trips the original agent/plan-gate/autopilot/sandbox/research choices.
  let composeAgentProvider = $state<AgentProvider | null>(null);
  let composePlanGate = $state<boolean | null>(null);
  let composeAutopilot = $state<boolean | null>(null);
  let composeSandbox = $state<SandboxProfile | null>(null);
  let composeResearch = $state(false);
  let composeEpicAuthoring = $state(false);
  // Re-entrancy guard so a double-invoke while staging is in flight doesn't double-seed.
  let relaunchStaging = $state(false);
  let backlog = $state<BacklogPayload | null>(null);
  // loaded once on mount (previewHost etc.); re-read on settings close.
  let settings = $state<Settings_ | null>(null);
  // Drives Onboarding's required-pick, non-dismissible mode: true exactly while the server still
  // reports first-run-pending (see loadSettings()). Once the pick persists, handleOnboardingPicked
  // re-loads settings and this flips false on its own.
  const onboardingBlocking = $derived(settings?.firstRunPending ?? false);
  const showTelemetryConsentModal = $derived(showTelemetryConsent && !onboardingBlocking);
  // The blocking picker resolved server-side (putSettings persisted a root): close the gate and
  // re-pull settings so repoRoot/repoRootDisplay/firstRunPending are all fresh.
  function handleOnboardingPicked() {
    showOnboarding = false;
    featureDiscovery.markSeen("onboarding");
    loadSettings();
  }
  // Usage hold settings — extracted from the settings object for the holdLikely derived.
  let usageHoldEnabled = $state(false);
  let usageHoldPct = $state(80);
  // First-run nudge: backlog quick-launch buttons are invisible until at least one
  // issue-scoped steer exists. The steers store updates live on editor save, so a
  // just-added action dismisses the hint without a reload.
  const issueActionsUnset = $derived(steers.loaded && !steers.list.some((s) => s.onIssues));

  // Mirror of the server's shouldHold gate — predicts whether submitting a new task
  // will result in it being held, so NewTask can offer the dual "Hold for reset" /
  // "Submit anyway" buttons before the round-trip. usageLimits is null until the first
  // snapshot lands, so the prediction is conservatively false until data is available.
  // Gates on usage alone (no running-session term) — see src/usage-hold.ts.
  const holdLikely = $derived(
    claudeUsageHoldLikely(store.usageLimits, usageHoldEnabled, usageHoldPct),
  );
  // Held only when creating fresh (not a relaunch, not editing an already-held task).
  // Pre-computed here so the ternary lives in <script>, keeping it out of the
  // AppOverlays mount markup.
  const composeHoldLikely = $derived(
    relaunchOriginalId === null && editHeldId === null ? holdLikely : false,
  );
  const upNextLaunch = $derived({
    store,
    defaultAgentProvider: settings?.defaultAgentProvider ?? "claude",
    fableAvailable: settings?.fableAvailable ?? true,
    upnextSkipCliPicker: settings?.upnextSkipCliPicker ?? false,
    usageHoldEnabled,
    usageHoldPct,
    nowMs,
  });

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);
  // Pending MCP OAuth authorize URL for the selected session's awaiting-input block, if any.
  const selectedAuthUrl = $derived(
    selected ? (store.blocks[selected.id]?.reason.authUrl ?? null) : null,
  );

  // Select a freshly-started session and follow the herd's repo filter onto its repo.
  // A new task lands in `repoPath`; if the active filter does NOT include that repo the
  // task would be hidden behind the stale filter (the user just launched it but can't see
  // it). An empty filter = "all repos" already shows it, so leave that view whole. When a
  // multi-selection would hide the new task, collapse the filter to just its repo so the
  // task is visible and selection lands on it (matches the single-repo follow behavior).
  // Shared by every create/relaunch path so the behaviour can't drift between them.
  // Arms both follow latches (declared near repoFilter) so the prune and re-target
  // effects coordinate until the new session arrives via WS.
  // Follow the herd's repo filter onto `repoPath` when an active filter would otherwise hide a
  // session there, arming both follow latches so the prune + re-target effects don't fight it.
  // The single shared follow step behind selectNewSession (new task) AND the command-bar session
  // select, so the behaviour can't drift. followRepoFilter mutates repoFilter in place (collapse
  // to the single repo) and reports whether it changed; the latches arm only on a real change.
  function followFilterToRepo(repoPath: string) {
    if (followRepoFilter(repoFilter, repoPath)) {
      followingRepo = repoPath;
      followingNewSession = true;
    }
  }
  function selectNewSession(id: string, repoPath: string) {
    followFilterToRepo(repoPath);
    selectedId = id;
  }

  // Retry-halted gate: how many sessions are usage-halted, and is usage back below the threshold?
  const haltedCount = $derived(store.sessions.filter((s) => s.haltReason === "usage_limit").length);
  const usageBelow = $derived(
    Math.max(store.usageLimits?.session5h?.pct ?? 0, store.usageLimits?.week?.pct ?? 0) <
      usageHoldPct,
  );
  const retryReady = $derived(haltedCount > 0 && usageBelow);

  // Open Settings on the steers editor. An optional steer id (from a steer chip's
  // right-click → "Edit") expands + focuses that row; omitted for the plain pencil.
  // Defined here, not inline, so the nullish branch stays out of the route template.
  function openSteersEditor(id?: string) {
    settingsTab = "session";
    focusSteerId = id ?? null;
    showSettings = true;
  }

  function loadSettings() {
    getSettings()
      .then((s) => {
        settings = s;
        usageHoldEnabled = s.usageHoldEnabled;
        usageHoldPct = s.usageHoldPct;
        store.docAgentEnabled = s.docAgentEnabled;
        // Server-reported first run (settings.firstRunPending) is the source of truth for the
        // required-pick onboarding gate — force it open even if the localStorage feature-discovery
        // "seen" latch would otherwise keep the (non-blocking) checklist from reappearing.
        if (s.firstRunPending) showOnboarding = true;
        // Ask for telemetry consent once the operator has onboarded and telemetry can run.
        // Skip in the hosted demo: its PUT /api/settings is a no-op stub, so a shown modal
        // could never be dismissed (same __DEMO__ guard as the onboarding-checklist gate).
        if (
          !__DEMO__ &&
          s.telemetryAvailable &&
          s.telemetryConsent === "unset" &&
          !s.firstRunPending
        ) {
          showTelemetryConsent = true;
        }
        // One-shot: loadSettings() also re-fires on tab return, so the eligibility
        // flag is consumed and `seen` re-checked here — a dismissed (or already-seen)
        // arrival must never reappear. See resolveFableArrival.
        const arrival = resolveFableArrival(
          fableArrivalEligible,
          featureDiscovery.isSeen(FABLE_FEATURE_ID),
          s.fableAvailable,
        );
        fableArrivalEligible = arrival.eligible;
        if (arrival.show) showFableArrival = true;
      })
      .catch(() => {});
  }

  // Re-pull the REST-loaded state on tab return. The live /events stream is
  // delta-only: while a mobile tab is frozen (locked phone / backgrounded app)
  // the socket drops and every missed event is gone for good, so sessions, git,
  // usage, backlog — and the critic/plan-gate verdicts plus their in-flight
  // `reviewing` latches — sit stale until a manual refresh. The reviewing latch
  // is the costly one: it only clears on a live `reviewing=false`/verdict event,
  // so a server restart mid-review (which boots with an empty in-flight map and
  // never re-emits the `false`) strands it `true`, pinning the card in the
  // reviewing group until a full reload. Resync the high-signal data when the tab
  // comes back so launching from a notification or unlocking shows current state
  // without one. Always fires — a half-open socket can read as connected, so we
  // can't gate on store.connected.
  //
  // The held-tasks badge counts off `store.heldCount`, seeded once in onMount and
  // otherwise kept live by `held:changed` events (each carries an absolute count).
  // Those events are push-on-change only — there's no snapshot on reconnect — so a
  // restart/deploy that auto-releases held tasks (usage reset) emits them while the
  // socket is down, leaving the badge stale until reload unless resync() re-pulls it.
  function refreshHeldCount() {
    listHeld()
      .then((arr) => (store.heldCount = arr.length))
      .catch(() => {});
  }

  // Wake + socket-reopen typically coincide (a frozen tab kills the socket), which
  // would fire resync() twice back-to-back. The guard swallows the duplicate on the
  // visibility/pageshow path only; the socket-open caller passes force:true and must
  // NEVER be suppressed — it is the only fetch that closes the loss window for
  // sig-deduped epic:update events emitted after a guarded wake-fetch but before the
  // replacement socket was open (the server never re-sends those deltas).
  let lastResyncAt = 0;

  function resync(opts?: { force?: boolean }) {
    const now = Date.now();
    if (!opts?.force && now - lastResyncAt < 2_000) return;
    lastResyncAt = now;
    refreshHeldCount();
    listSessions()
      .then((list) => store.setAll(list))
      .catch(() => {});
    getUsageLimits()
      .then((r) => store.setUsageLimits(r.limits))
      .catch(() => {});
    gitStates()
      .then((m) => store.setGit(m))
      .catch(() => {});
    activityStates()
      .then((m) => store.setActivity(m))
      .catch(() => {});
    claudeAliveStates()
      .then((m) => store.setClaudeAlive(m))
      .catch(() => {});
    workingBlockedStates()
      .then((m) => store.setWorkingBlocked(m))
      .catch(() => {});
    blockStates()
      .then((m) => store.setBlocks(m))
      .catch(() => {});
    holdStates()
      .then((m) => store.setHolds(m))
      .catch(() => {});
    subagentStates()
      .then((m) => store.setSubagents(m))
      .catch(() => {});
    previewStates()
      .then((m) => {
        store.setPreview(flattenPreview(m));
        store.setPreviewServe(extractServe(m));
      })
      .catch(() => {});
    getBacklog()
      .then((p) => (backlog = p))
      .catch(() => {});
    getBuildQueues()
      .then((m) => store.setBuildQueues(m))
      .catch(() => {});
    // Re-seed completed epics: the epic:completed WS payload carries the bare row WITHOUT the
    // GET-only live landing-gate fields (landingReady/landingChecks/landingMergeable/landingStranded),
    // so only a fetch repopulates them — without this, the "Land epic" CTA reads disabled on wake.
    getCompletedEpics()
      .then((l) => store.seedCompletedEpics(l))
      .catch(() => {});
    // Re-pull drain + live epics: both are delta-streams (drain:status / epic:update)
    // whose missed events are gone for good — the server dedupes epic emissions by
    // signature and only re-emits on the NEXT real change, so a badge that missed a
    // child-merge while the tab was frozen would otherwise sit stale indefinitely.
    // Refreshing store.drain also refreshes activeEpicKeys; an epic that STARTED
    // while away is then fetched by the seed $effect above, so here we only need to
    // re-pull epics the page already knows.
    getDrain()
      .then((l) => store.setDrain(l))
      .catch(() => {});
    for (const k of Object.keys(store.epics)) {
      const i = k.lastIndexOf("#"); // repoPath may contain no '#'; parent is after the last '#'
      getEpic(k.slice(0, i), Number(k.slice(i + 1)))
        .then((e) => store.setEpic(e))
        .catch(() => {});
    }
    // Nudge the backlog drawer's one-shot caches (issues, epic summaries, expanded
    // epic panels) — an open IssuesPanel has no other refresh path.
    backlogRefresh.bump();
    // Reconcile critic + plan-gate verdicts and their reviewing latches from the
    // server snapshot (both self-handle errors). load() re-fetches the /inflight
    // ids, so a `reviewing=false` missed across a disconnect/restart is corrected.
    reviews.load();
    planGates.load();
    recaps.load();
  }

  // Forced resync whenever a REPLACEMENT socket opens (epoch 1 is the initial
  // page-load connect — onMount's bootstrap already covers it). Anchored to
  // ws.onopen via connectionEpoch, not a `connected` false→true edge: a mobile
  // freeze kills the socket without ever firing onclose, so `connected` never goes
  // false there. force:true bypasses the 2s guard — deltas emitted between a
  // guarded wake-fetch and this socket opening are sig-deduped server-side and will
  // never be re-sent, so only this post-open pull can recover them. untrack keeps
  // the effect keyed on the epoch alone: resync() reads reactive state (e.g.
  // store.epics) and writes it back via setEpic, which would otherwise loop.
  $effect(() => {
    const epoch = store.connectionEpoch;
    if (epoch > 1) untrack(() => resync({ force: true }));
  });

  // Fetch backlog when the overview is empty, or when the operator opens the
  // backlog overlay while agents are running. Reading store.sessions.length and
  // showBacklog inside the effect body makes Svelte track them; backlog is
  // written but never read here, so it cannot re-trigger the effect → no loop.
  $effect(() => {
    if (store.sessions.length === 0 || showBacklog) {
      getBacklog()
        .then((p) => (backlog = p))
        .catch(() => {
          backlog = { pinnedPath: null, projects: [], totals: { openIssues: 0, openPRs: 0 } };
        });
    }
  });
  // The fetch above is a one-shot for fast first paint; the server's warm poller
  // then pushes a backlog:update over the WS every ~45s. Mirror each push so a
  // long-open dashboard's counts stay live instead of frozen at load time.
  $effect(() => {
    if (store.backlog) backlog = store.backlog;
  });

  function onissue(repoPath: string, issue: Issue) {
    composeRepoPath = repoPath;
    composeIssue = issue;
    showNew = true;
    // composing from the backlog overlay → close it so the herd is behind the modal
    showBacklog = false;
  }

  // PRs tab → open a review task seeded with the PR reference. The PR rides in
  // the prompt (a tiny reference line), not the issue-attachment path, since
  // that path is issue-worded server-side.
  function onpr(repoPath: string, pr: PullRequest) {
    composeRepoPath = repoPath;
    composeIssue = null;
    composePrompt = m.newtask_pr_review_template({ number: pr.number, url: pr.url });
    showNew = true;
    showBacklog = false;
  }

  // Readiness tab → seed a New Task with the AI-readiness install prescription
  // (the generated CLAUDE.md rides along in the prompt). Mirrors onpr's seeding.
  function onadopt(repoPath: string, prompt: string) {
    composeRepoPath = repoPath;
    composeIssue = null;
    composePrompt = prompt;
    showNew = true;
    showBacklog = false;
  }

  // Build the prompt seed for a new project's first agent run.
  // For a slash-command kickoff, prepend the command; for the default PRD path,
  // use the verbatim i18n seed template (authored as app chrome, EN+DE).
  function buildKickoffSeed(kickoff: KickoffChoice, idea: string): string {
    if (kickoff.kind === "command") {
      return `/${kickoff.name} ${idea}`.trim();
    }
    return m.newproject_prd_seed({ idea: idea || m.newproject_prd_seed_noidea() });
  }

  // Quick-launch: spawn a session straight from a backlog issue with the picked
  // issue action's prompt, skipping the New Task dialog. Resolve the repo's current
  // branch the same way NewTask does; on any spawn failure fall back to the normal
  // dialog so the click is never lost.
  async function onquickissue(repoPath: string, issue: Issue, action: Steer) {
    const cmd = action.text.trim();
    if (!cmd) {
      onissue(repoPath, issue);
      return;
    }
    const br = await listBranches(repoPath).catch(() => null);
    const baseBranch = pickBaseBranch(br);
    try {
      const r = await createSession({
        repoPath,
        baseBranch,
        prompt: cmd,
        agentProvider: action.agentProviders?.length === 1 ? action.agentProviders[0] : undefined,
        model: null,
        force: true,
        issueRef: {
          number: issue.number,
          url: issue.url,
          title: issue.title,
          body: issue.body,
        },
      });
      if ("held" in r) return;
      selectNewSession(r.id, repoPath);
      showBacklog = false;
      if (mobile.current) mobileScreen = "detail";
    } catch {
      // spawn failed → hand off to the dialog so the operator can retry manually
      onissue(repoPath, issue);
    }
  }

  // Inject an issue steer from a backlog row's right-click / long-press menu: open the
  // New Task dialog pre-seeded with the steer's prompt + the issue attached. Unlike
  // onquickissue this does NOT spawn — the operator reviews and hits Run. Mirrors the
  // PR-review seed path (composePrompt + open the dialog).
  function oninjectissue(repoPath: string, issue: Issue, steer: Steer) {
    composeRepoPath = repoPath;
    composeIssue = issue;
    composePrompt = steer.text;
    showBacklog = false;
    showNew = true;
  }

  // Merge-train shortcut (Ready-to-merge group header): spawn a new session that
  // works through the PRs of every ready-to-merge session, suggesting a merge
  // order. A merge train is per-repo, so when ready PRs span repos we scope to
  // the repo with the most and surface a fail-loud notice for the rest rather
  // than silently folding them in. Mirrors onquickissue for branch + create.
  function onmergetrain() {
    const ready = collectReadyPrs(
      store.sessions,
      store.git,
      (id) => reviews.isReviewing(id) || planGates.isReviewing(id),
    );
    const { repoPath, prs, otherRepoCount } = pickTrainRepo(ready);
    if (!repoPath || prs.length === 0) {
      toasts.info(m.toast_merge_train_no_prs());
      return;
    }
    // Don't launch yet — open the confirm modal. The excluded-repo count is
    // surfaced as the modal's warn line, NOT a post-launch toast (no double-surfacing).
    pendingTrain = {
      repoLabel: basename(repoPath),
      items: prs.map((p) => ({ number: p.number, title: p.title })),
      handpicked: false,
      otherRepoCount,
      run: async () => {
        const br = await listBranches(repoPath).catch(() => null);
        const baseBranch = pickBaseBranch(br);
        try {
          const r = await createSession({
            ...mergeTrainCreateInput(repoPath, baseBranch, prs),
            force: true,
          });
          if ("held" in r) return;
          selectNewSession(r.id, repoPath);
          showBacklog = false;
          if (mobile.current) mobileScreen = "detail";
        } catch {
          toasts.info(m.toast_merge_train_failed());
        }
      },
    };
  }

  /** Launch a merge train scoped to a hand-picked set of PRs from the backlog
   *  PRs panel. Unlike onmergetrain (which auto-collects ready sessions), the
   *  operator chose these PRs directly, so the kickoff prompt uses the
   *  hand-picked framing. The server marks participant PRs "merging" from the
   *  passed mergeTrainPrs; backlog-only PRs still ride along in the prompt. */
  function onlaunchtrain(repoPath: string, prs: PullRequest[]) {
    if (prs.length < 2) return; // UI gates at >=2; defensive guard
    // Don't launch yet — open the confirm modal (renders above the still-mounted
    // backlog overlay). The launch body runs on confirm; backlog stays open until then.
    pendingTrain = {
      repoLabel: basename(repoPath),
      items: prs.map((p) => ({ number: p.number, title: p.title })),
      handpicked: true,
      otherRepoCount: 0,
      run: async () => {
        const br = await listBranches(repoPath).catch(() => null);
        const baseBranch = pickBaseBranch(br);
        try {
          const r = await createSession({
            ...mergeTrainCreateInput(repoPath, baseBranch, prs, true),
            force: true,
          });
          if ("held" in r) return;
          selectNewSession(r.id, repoPath);
          showBacklog = false;
          if (mobile.current) mobileScreen = "detail";
        } catch {
          toasts.info(m.toast_merge_train_failed());
        }
      },
    };
  }

  // Mobile layout fires when the viewport is narrow OR short: width ≤768px is the
  // phone breakpoint; height ≤600px catches wide-but-short viewports (an unfolded
  // foldable in split-screen landscape, ordinary phone landscape, a short desktop
  // window) that would otherwise land in the desktop branch and get crushed — its
  // fixed-height chrome assumes a tall viewport. Both terms are parenthesised so
  // Svelte's MediaQuery passes the comma to matchMedia verbatim as a top-level OR.
  const mobile = new MediaQuery("(max-width: 768px), (max-height: 600px)");
  // touch-primary device (e.g. unfolded foldable wider than the mobile breakpoint):
  // gets the control-key bar even in desktop layout, since there's no hardware keyboard
  const touch = new MediaQuery("(pointer: coarse)");
  // Collapse the herd sidebar only on touch-primary wide devices (e.g. unfolded
  // foldable) that opted in — gives the terminal full width. Mouse desktops and
  // phones (handled by the mobile branch) never collapse.
  const canCollapse = $derived(touch.current && !mobile.current);
  const sidebarCollapsed = $derived(
    sidebarShouldCollapse(touch.current, mobile.current, sidebarCollapse.collapsed),
  );

  // Toggling unmounts whichever control was clicked (Herd's collapse tab on collapse,
  // the reopen tab on expand), which would drop focus to <body>. After the DOM
  // settles, move focus to the counterpart control so keyboard/SR users keep place.
  async function toggleSidebar() {
    const wasCollapsed = sidebarCollapsed;
    sidebarCollapse.toggle();
    await tick();
    document.getElementById(wasCollapsed ? "herd-collapse-btn" : "herd-reopen-tab")?.focus();
  }

  // ── Herd sidebar resize (issue #1588, mouse-desktop only) ─────────────────
  // The splitter drives herdWidth; the .grid below applies it as `--herd-w`. A
  // ~3px threshold gates live resizing so a jittery click never moves the width,
  // and commit() only persists after an actual drag. Reset is a manual
  // double-click detector (two clicks <400ms apart) rather than native dblclick,
  // which setPointerCapture + preventDefault can suppress. Gated on
  // `!touch.current` (see herdResizable) so touch-wide + mobile are untouched.
  const herdResizable = $derived(!touch.current);
  // Derived (not inline in the template) to keep the .grid markup free of extra
  // branches — +page's synthetic <template> complexity sits just under the fallow
  // Tier-1 bar (see .fallowrc.jsonc), so conditionals live in <script>.
  const herdResized = $derived(herdResizable && herdWidth.width !== null);
  const herdWidthStyle = $derived(herdResized ? `--herd-w:${herdWidth.width}px` : undefined);
  let herdColEl = $state<HTMLElement>();
  let herdResizing = $state(false);
  const HERD_DRAG_THRESHOLD = 3;
  const HERD_DBLCLICK_MS = 400;
  let herdLastClickTs = 0;

  function startHerdResize(e: PointerEvent) {
    // The splitter stays in the DOM but is display:none on touch (see .inert);
    // guard anyway so a stray event can't resize when not resizable.
    if (!herdResizable || e.button !== 0 || !herdColEl) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startW = herdColEl.getBoundingClientRect().width;
    let moved = false;
    handle.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < HERD_DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        herdResizing = true;
      }
      herdWidth.set(startW + (ev.clientX - startX));
    };
    const onUp = (ev: PointerEvent) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      if (moved) {
        herdResizing = false;
        herdWidth.commit();
        herdLastClickTs = 0; // a drag isn't a click
        return;
      }
      // No drag → treat as a click; two within the window reset to default.
      if (herdLastClickTs && ev.timeStamp - herdLastClickTs < HERD_DBLCLICK_MS) {
        herdWidth.reset();
        herdLastClickTs = 0;
      } else {
        herdLastClickTs = ev.timeStamp;
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  let mobileScreen = $state<"list" | "detail">("list");
  let chromeHidden = $state(false);

  // The fixed mobile ActionBar (+ New Task) is rendered iff this is true (see its
  // render guard in the mobile list branch below). Single source for "is the action
  // bar present?", consumed by <Toasts aboveActionBar> so the toast banner insets
  // above the bar instead of covering it (issue #810).
  const mobileActionBarPresent = $derived(mobile.current && mobileScreen === "list");

  // Scroll-compress the chrome header on mobile list: hide on scroll-down, restore
  // on scroll-up or at/near top. Window (document) scroll only — the mobile list
  // screen is a document-scroll app-shell; inner regions don't scroll.
  $effect(() => {
    const active = mobile.current && mobileScreen === "list";
    if (!active) {
      chromeHidden = false;
      return;
    }

    // Delta threshold to avoid jitter from sub-pixel bounces.
    const THRESHOLD = 7;
    // Always restore when within this many px of the top.
    const TOP_SNAP = 60;

    let lastY = window.scrollY;
    let rafId: ReturnType<typeof requestAnimationFrame> | null = null;

    function onScroll() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const y = window.scrollY;
        if (y < TOP_SNAP) {
          chromeHidden = false;
        } else {
          const delta = y - lastY;
          if (delta > THRESHOLD) {
            chromeHidden = true;
          } else if (delta < -THRESHOLD) {
            chromeHidden = false;
          }
        }
        lastY = y;
      });
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      chromeHidden = false;
    };
  });

  let showBacklog = $state(false);

  // EPIC badge → open the backlog targeted at that session's repo + epic issue
  // (Issues tab, row expanded + scrolled). Cleared on every backlog close so a
  // normal reopen never re-applies a stale target.
  let epicTarget = $state<{ repoPath: string; issueNumber: number } | null>(null);
  function openEpicInBacklog(repoPath: string, issueNumber: number) {
    epicTarget = { repoPath, issueNumber };
    showBacklog = true;
  }
  $effect(() => {
    if (!showBacklog) epicTarget = null;
  });

  // Whether the *next* terminal remount should grab the keyboard. Deliberately a
  // plain (non-reactive) let, NOT $state: nothing renders it and the consumer
  // (Viewport's mount rAF) reads it imperatively, so reactivity buys nothing —
  // and keeping it out of $state guards against any future tracked read in
  // Viewport's terminal-rebuild $effect re-creating the terminal (and dropping
  // scrollback) whenever this flips. One-shot: Viewport's consume resets it to
  // true, so resumeEpoch-driven rebuilds (resume / re-attach, no selection
  // change) keep auto-focusing.
  let keynavFocusIntent = true;

  // One-shot consume of keynavFocusIntent — read it, reset it to true, return
  // it. Passed to both Viewport instances (focus + compact layouts) as their
  // consumeAutoFocusTerm prop.
  function consumeAutoFocusTerm(): boolean {
    const v = keynavFocusIntent;
    keynavFocusIntent = true;
    return v;
  }

  // bind:this on the desktop Viewport, so the Enter shortcut can hand the
  // keyboard back to the terminal that plain-key navigation kept it out of.
  let viewportRef: Viewport | undefined = $state();

  // toDetail=false re-targets the selection WITHOUT opening the mobile detail screen —
  // used when the switch is a side effect of another action (e.g. a repo-filter change)
  // rather than the user tapping a session row, so a list-level action doesn't fling a
  // phone user into a terminal.
  function selectUnit(id: string, focusTerm = true, toDetail = true) {
    // only a *real* switch remounts the terminal and consumes the intent; a
    // self-selection (e.g. plain j wrapping back to the only visible session)
    // must not park a stale `false` that would suppress a later
    // resumeEpoch-driven auto-focus.
    if (id !== selectedId) keynavFocusIntent = focusTerm;
    selectedId = id;
    if (toDetail && mobile.current) mobileScreen = "detail";
  }

  // A global session jump must leave the target visible in the herd, even when a lens or
  // repo/status filter currently hides it. Shared by the command bar and auto-merge strip.
  function jumpToSession(id: string) {
    showBacklog = false;
    herdFilter = "all";
    statusFilter = null;
    const repoPath = store.sessions.find((s) => s.id === id)?.repoPath;
    if (repoPath) followFilterToRepo(repoPath);
    selectUnit(id);
  }

  // Deep-link a Rundown item to its live session: leave the panel-only Rundown lens
  // (back to the full list so the session row is visible) and select it via the same
  // selectUnit a rail click uses.
  function selectRundownItem(id: string) {
    herdFilter = "all";
    selectUnit(id);
  }

  // Deep-link a Rundown epics-to-land item (#1045) to its row in the IntegratedEpicsBand: leave the
  // panel-only Rundown lens (the band is hidden there) and hand the band a focus target so it
  // expands + scrolls/opens that epic's row with its Land CTA. Cleared first so re-clicking the same
  // epic re-triggers the scroll/highlight (the focus effect keys on the value changing).
  let focusEpic = $state<{ repo: string; parent: number } | null>(null);
  let focusEpicToken = 0;
  function selectRundownEpic(repo: string, parent: number) {
    herdFilter = "all";
    focusEpic = null;
    const token = ++focusEpicToken;
    queueMicrotask(() => (focusEpic = { repo, parent }));
    // Clear once the row's highlight (~1.6s) has settled so a later band remount doesn't re-expand
    // and re-flash a stale target. Token-guarded so a rapid re-click to another epic isn't cleared.
    setTimeout(() => {
      if (focusEpicToken === token) focusEpic = null;
    }, 2000);
  }

  // true when focus sits in something that consumes typing — a form field or the
  // PTY terminal (xterm holds focus in a hidden <textarea>, so the TEXTAREA check
  // covers it). Single-key shortcuts must stay silent there so they never eat a
  // keystroke the user meant for the terminal or an input.
  function isTyping(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  // The rail's all/ready list filter, bound into <Herd> so keynav sees exactly
  // what the rail shows — with "ready" active, j/k/1-9 only walk visible rows.
  let herdFilter = $state<HerdFilter>("all");
  // Owed-lens focus (#1275): set when a manual-steps chip is clicked, so the Owed panel can
  // scroll-to + highlight the target session's card (or render a frozen fallback). The nonce
  // pair lets the panel (which unmounts on lens switch) tell an unhandled click from one it
  // already resolved, surviving its own remounts.
  let owedFocusId = $state<string | null>(null);
  let owedFocusSnapshot = $state<OwedFocusSnapshot | null>(null);
  let owedFocusNonce = $state(0);
  let owedFocusHandledNonce = $state(0);
  // Panel-only lenses (rundown + owed, #1061): the rail swaps in a dedicated panel and the main
  // area shows a neutral pointer. One derived keeps the template's branch count flat as lenses grow.
  const panelOnlyLens = $derived(
    herdFilter === "rundown" || herdFilter === "owed" || herdFilter === "next",
  );
  const panelMainHint = $derived(
    herdFilter === "next"
      ? m.upnext_main_hint()
      : herdFilter === "owed"
        ? m.owed_main_hint()
        : m.rundown_main_hint(),
  );

  // Done lens: separate selection state. selectedId resolves against store.sessions
  // (the live list), which has EVICTED archived sessions — so reusing it for a done
  // (archived) id would break. doneSelectedId tracks the picked done row instead.
  let doneSelectedId = $state<string | null>(null);
  // The currently-selected done session (resolved against the lazy doneSessions list).
  const doneSelected = $derived(doneSessions.sessions.find((s) => s.id === doneSelectedId) ?? null);
  // Entering the Done lens lazy-loads the archived session list + repopulates the
  // shared recaps store (archived recaps persist server-side; live events dropped the
  // session's recap, /api/recaps returns it). Both are best-effort / self-handling.
  // Re-selects the first done row whenever the current pick isn't in the (re)loaded list.
  $effect(() => {
    if (herdFilter !== "done") return;
    void doneSessions.load();
    void recaps.load();
  });
  // Owed lens count badge (#1257): eagerly load the durable post-merge steps on the DESKTOP layout
  // so the OWED lens badge reflects the outstanding count before the lens is ever opened. Gated on
  // `!mobile.current` because the mobile branch renders HerdSegRow, whose OWED segment (#1198)
  // carries no count badge to feed — and re-fires if the viewport later widens to desktop. Once-only via the
  // store's `loaded` guard; the store's in-flight guard stops a viewport toggle mid-load from
  // duplicating the GET. Live updates thereafter arrive via the `post-merge-steps:changed` WS event
  // (handled in store.svelte.ts), whose `refreshIfLoaded()` is a no-op until `loaded` is true.
  $effect(() => {
    if (mobile.current || postMergeStepsStore.loaded) return;
    void postMergeStepsStore.load();
  });
  // Failure-recovery fallback (#1257): if the eager load above failed (`loaded` still false), opening
  // the OWED lens retries — the operator's natural action when they suspect owed work. The `!loaded`
  // guard makes this a no-op on the happy path (eager load already populated it), so there is no
  // double-fetch when the lens opens normally.
  $effect(() => {
    if (herdFilter !== "owed" || postMergeStepsStore.loaded) return;
    void postMergeStepsStore.load();
  });
  $effect(() => {
    if (herdFilter !== "done") return;
    const list = doneSessions.sessions;
    if (list.length === 0) {
      doneSelectedId = null;
    } else if (!list.some((s) => s.id === doneSelectedId)) {
      doneSelectedId = list[0].id;
    }
  });

  // The herd rail's visible session order (same shown set + partition + group
  // order Herd.svelte renders) — the j/k/1-9 navigation space. Computed on demand
  // at keypress time, not $derived: re-partitioning on every nowMs tick would be
  // wasted work for a value only keystrokes read.
  function railIds(): string[] {
    // The Done lens is its own navigation space (archived rows, not live `sessions`),
    // so j/k/1-9 walk the done list and select via doneSelectedId — never the hidden
    // live partition.
    if (herdFilter === "done") return doneSessions.sessions.map((s) => s.id);
    return railOrder(
      herdSessions,
      store.git,
      (id) => reviews.isReviewing(id) || planGates.isReviewing(id),
      (session) =>
        isReworkRunningSession(
          session,
          { planGate: planGates.map[session.id], review: reviews.map[session.id] },
          store.workingBlocked,
          nowMs,
        ),
      nowMs,
      // a page-level status filter short-circuits the rail's all/ready filter in
      // Herd's shown set (one filter at a time) — mirror that here so keynav walks
      // exactly the visible rows, never a "ready" subset of the status-filtered list
      statusFilter != null ? "all" : herdFilter,
      store.workingBlocked,
      store.epics,
      activeEpicKeys,
      collapsedEpics,
    );
  }

  // Keyboard-driven selection: route through the same selectUnit a rail click
  // uses, then keep the now-selected row visible in the rail's scroll area.
  // focusTerm = whether the remounted terminal should grab the keyboard.
  function keyNavSelect(id: string | null, focusTerm = true) {
    if (!id) return;
    // Done lens: pick the archived row (its own selection state, no terminal to focus).
    if (herdFilter === "done") {
      doneSelectedId = id;
      if (mobile.current) mobileScreen = "detail";
    } else {
      selectUnit(id, focusTerm);
    }
    document
      .querySelector(`[data-unit-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  // Herd keyboard navigation (the rail-selection half of onShortcut):
  // j/k (vim) + arrows cycle selection through the rail's visible order
  // (wrapping at the ends; preventDefault keeps arrows from also scrolling),
  // 1-9 select the Nth visible session in rail order. (Jump-to-next-needs-you
  // lives only in the command bar's `next-needs-you` verb now.) Returns true
  // when the key belonged to keynav.
  // focusTerm follows the keystroke's origin: plain keys pass false so focus
  // stays out of the terminal and the next plain key still chains; Alt combos
  // pass true only when fired from inside the terminal (focus follows origin).
  // The keynav cursor: the Done lens cycles from doneSelectedId, every other mode from
  // the live selectedId (the two selection spaces never mix).
  function navCursor(): string | null {
    return herdFilter === "done" ? doneSelectedId : selectedId;
  }

  function handleHerdKeyNav(key: string, e: KeyboardEvent, focusTerm: boolean): boolean {
    switch (key) {
      case "j":
      case "arrowdown":
        e.preventDefault();
        keyNavSelect(cycleId(railIds(), navCursor(), 1), focusTerm);
        return true;
      case "k":
      case "arrowup":
        e.preventDefault();
        keyNavSelect(cycleId(railIds(), navCursor(), -1), focusTerm);
        return true;
      default:
        if (key >= "1" && key <= "9") {
          const id = nthId(railIds(), Number(key));
          if (id) {
            e.preventDefault();
            keyNavSelect(id, focusTerm);
          }
          return true;
        }
        return false;
    }
  }

  // Every shortcut tier stands down while a modal/overlay is open, so a stray
  // key can't stack dialogs or switch sessions under one.
  //
  // The flag list covers the dialogs THIS route owns; the DOM probe covers the ones it doesn't —
  // a modal owned by a child (Viewport's EpicDraftModal, LeftoverDialog) is invisible to these
  // flags, so without it j/k/n/r keep firing behind an open dialog. It mirrors the probe
  // shouldForwardEscape already trusts (see Viewport.svelte), and rides behind the flag
  // short-circuit so the common path stays a plain boolean OR and never touches the DOM.
  // Non-blocking anchored popovers (.auto-pop, .ep) don't carry these classes, so they're
  // unaffected — .overlay/.drawer are reserved for surfaces that seize the app.
  function anyOverlayOpen(): boolean {
    return (
      showNew ||
      showSettings ||
      showUsage ||
      showBacklog ||
      showBroadcast ||
      showRetry ||
      showUpdate ||
      showHerdrUpdate ||
      showCodexUpdate ||
      showPluginUpdates ||
      showWhatsNew ||
      showCommandBar ||
      !!document.querySelector(".overlay, .drawer")
    );
  }

  // The Alt tier of onShortcut: Alt+J/K/arrows/1-9 are the work-everywhere
  // session switchers — they deliberately SKIP the typing guard so they fire
  // even while xterm holds focus (Viewport's attachCustomKeyEventHandler
  // suppresses the same combos — via the shared altComboKey map — from reaching
  // the PTY). Returns true when the key was consumed; false (Alt held but not a
  // combo key, or other modifier mixes) falls through to onShortcut's modifier
  // bail, untouched.
  function handleAltCombo(e: KeyboardEvent): boolean {
    if (!e.altKey || e.ctrlKey || e.metaKey) return false;
    // physical e.code, not e.key: macOS Option+J types "∆" (see altComboKey)
    const mapped = altComboKey(e.code);
    if (mapped === null) return false;
    // focus follows origin: Alt from inside the terminal keeps the operator
    // in terminal flow (focus the new session's terminal); Alt from anywhere
    // else leaves focus out so plain-key navigation still chains after.
    const fromTerminal = e.target instanceof HTMLElement && e.target.closest(".xterm") !== null;
    // Session-cycle aliases, resolved to the shared next/prev (j/k) handlers:
    //   Alt+] / Alt+Tab        → next (j)
    //   Alt+[ / Alt+Shift+Tab  → prev (k)
    // Resolved HERE (not as handleHerdKeyNav cases) so the plain-key path never
    // navigates on a bare [, ] or Tab — plain Tab keeps native focus traversal.
    // Tab is the only combo whose direction depends on Shift; the rest is shift-
    // agnostic (Alt+Shift+J == Alt+J), and both Alt+Tab and Alt+Shift+Tab are kept
    // out of the PTY by Viewport (altComboKey returns "tab" for both).
    let navKey = mapped;
    if (mapped === "]") navKey = "j";
    else if (mapped === "[") navKey = "k";
    else if (mapped === "tab") navKey = e.shiftKey ? "k" : "j";
    handleHerdKeyNav(navKey, e, fromTerminal);
    return true;
  }

  // Global shortcuts, two tiers: the Alt combos (handleAltCombo) and plain
  // single keys (n/b + keynav), which are suppressed while typing — they must
  // never eat a keystroke meant for an input or the terminal. Desktop only,
  // and suppressed under any open modal/overlay (anyOverlayOpen).
  function onShortcut(e: KeyboardEvent) {
    if (mobile.current) return;
    // no auto-repeat anywhere (plain or Alt) — held j must not machine-gun
    // through sessions; and stand down during IME composition.
    if (e.repeat || e.isComposing) return;
    if (anyOverlayOpen()) return;
    // Cmd/Ctrl+K → command bar. Handled BEFORE the modifier + isTyping bails so it
    // fires even while an input or the terminal owns the keyboard (Viewport's custom
    // key handler suppresses the same combo from reaching the PTY). Plain K falls
    // through to keynav untouched.
    if (isCommandBarChord(e)) {
      e.preventDefault();
      showCommandBar = true;
      return;
    }
    if (handleAltCombo(e)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    const key = e.key.toLowerCase();
    switch (key) {
      case "n":
        e.preventDefault();
        showNew = true;
        break;
      case "r":
        // mirror the ActionBar gate: Repos only exists once there are sessions
        if (store.sessions.length > 0) {
          e.preventDefault();
          showBacklog = true;
        }
        break;
      case "enter":
        // hand the keyboard back to the terminal after chained plain-key
        // navigation. Deliberately narrow — body-focused only: a focused
        // rail-card button keeps native Enter→click activation.
        if (e.target === document.body) {
          e.preventDefault();
          viewportRef?.focusTerminal();
        }
        break;
      default:
        // plain keynav keeps focus OUT of the new terminal so the next plain
        // key chains (j j j…) instead of vanishing into the PTY; Enter opts in.
        handleHerdKeyNav(key, e, false);
    }
  }

  // sessions waiting on the operator other than the one on screen — gates the
  // command bar's `next-needs-you` verb and tells the operator how many remain.
  const otherNeedsYou = $derived(blockedEntries.filter((e) => e.session.id !== selectedId));

  // Jump to the next waiting session: walk blockedEntries (oldest-first, same set
  // as the NEEDS YOU badge) starting after the current one, wrapping around. Keep
  // blockedEntries UNFILTERED (count + jump stay on the same full set); if the target
  // sits in a collapsed epic group, expand it first so the row is visible. Backs the
  // command bar's `next-needs-you` verb.
  async function selectNextNeedsYou(focusTerm = true) {
    const { id, expand } = nextNeedsYouTarget(
      blockedEntries.map((entry) => entry.session.id),
      selectedId,
      epicGroupOf,
      collapsedEpics,
    );
    if (expand) {
      expandEpicGroup(expand);
      await tick(); // let the now-expanded group's rows mount so keyNavSelect can scroll to the target
    }
    keyNavSelect(id, focusTerm);
  }

  // if the selected unit disappears while in mobile detail, fall back to the list
  $effect(() => {
    if (mobile.current && mobileScreen === "detail" && !selected) {
      mobileScreen = "list";
    }
  });

  onMount(() => {
    registerSW();
    const params = new URLSearchParams(location.search);
    const deepLink = params.get("session");
    // Learnings-retire push deep-link (issue #852): ?learnings=1 (cold open) or an
    // "open-learnings" message from the SW (open/backgrounded window) opens the drawer.
    if (params.get("learnings") === "1") showLearnings = true;
    const disposeSelect = onSelectSession((id) => selectUnit(id));
    const disposeLearnings = onOpenLearnings(() => (showLearnings = true));
    listSessions()
      .then((list) => {
        store.setAll(list);
        if (deepLink && list.some((s) => s.id === deepLink)) selectedId = deepLink;
        else if (!selectedId && list[0]) selectedId = list[0].id;
      })
      .catch(() => {});
    getUsageLimits()
      .then((r) => store.setUsageLimits(r.limits))
      .catch(() => {});
    getUpdate()
      .then((u) => store.setUpdate(u))
      .catch(() => {});
    getHerdrUpdate()
      .then((u) => (store.herdrUpdate = u))
      .catch(() => {});
    getCodexUpdate()
      .then((u) => (store.codexUpdate = u))
      .catch(() => {});
    getPluginUpdates()
      .then((u) => (store.pluginUpdates = u))
      .catch(() => {});
    loadDiagnostics();
    loadPlugins();
    getStarPrompt()
      .then((s) => (store.starPrompt = s))
      .catch(() => {});
    gitStates()
      .then((m) => store.setGit(m))
      .catch(() => {});
    activityStates()
      .then((m) => store.setActivity(m))
      .catch(() => {});
    claudeAliveStates()
      .then((m) => store.setClaudeAlive(m))
      .catch(() => {});
    workingBlockedStates()
      .then((m) => store.setWorkingBlocked(m))
      .catch(() => {});
    blockStates()
      .then((m) => store.setBlocks(m))
      .catch(() => {});
    holdStates()
      .then((m) => store.setHolds(m))
      .catch(() => {});
    subagentStates()
      .then((m) => store.setSubagents(m))
      .catch(() => {});
    previewStates()
      .then((m) => {
        store.setPreview(flattenPreview(m));
        store.setPreviewServe(extractServe(m));
      })
      .catch(() => {});
    getDrain()
      .then((l) => store.setDrain(l))
      .catch(() => {});
    getAutoMerge()
      .then((l) => store.setAutoMerge(l))
      .catch(() => {});
    getCompletedEpics()
      .then((l) => store.seedCompletedEpics(l))
      .catch(() => {});
    steers.load();
    projectIcons.load();
    repos.load();
    reviews.load();
    planGates.load();
    recaps.load();
    herdDigest.load();
    // App-load paints the CACHED Up Next snapshot only (peek) — no cross-repo gh recompute for a
    // session that never opens the lens. Lens-open + the 15-min loop keep it fresh.
    upNext.load({ peek: true });
    learnings.load().then(() => (learningsLoaded = true));
    refreshHeldCount();
    loadSettings();
    // Feature-discovery gate — synchronous, independent of loadSettings().
    // hydrate() reads localStorage; version + featureAnnouncements are compile-time constants.
    featureDiscovery.hydrate();
    {
      const lastSeen = featureDiscovery.lastSeenVersion;
      if (lastSeen === null) {
        // Fresh install: show the one-time onboarding checklist. Latch "was
        // fresh" (gated on the seen-set, not the version) BEFORE seeding, since
        // seeding lastSeenVersion below would otherwise make this gate false on
        // the same load. markSeen("onboarding") on dismiss keeps it from
        // reappearing on later loads (lastSeenVersion is no longer null then).
        // The demo is a hosted marketing build with no local environment, so the
        // "we checked your environment" onboarding checklist is meaningless there —
        // skip it so visitors land straight in the seeded herd.
        if (!__DEMO__ && !featureDiscovery.isSeen("onboarding")) showOnboarding = true;
        // Fresh install: seed baseline so future updates can diff against it.
        featureDiscovery.lastSeenVersion = version;
      } else {
        try {
          const entries = computeNewEntries(lastSeen, version, featureAnnouncements);
          if (entries.length > 0) {
            whatsNewEntries = entries;
            whatsNewDotOn = true;
            // Fable 5 gets a one-time hero celebration on top of the drawer line.
            // Fires only for upgraders (computeNewEntries returns [] on a fresh
            // install) and only once (seen-set keyed by the catalog id).
            if (
              entries.some((e) => e.id === FABLE_FEATURE_ID) &&
              !featureDiscovery.isSeen(FABLE_FEATURE_ID)
            ) {
              fableArrivalEligible = true;
            }
          }
        } catch {
          // should never throw, but guard defensively
        }
      }
    }
    const dispose = store.connect();
    // visibilitychange only fires on a real hidden→visible flip (tab switch,
    // app switch, unlock), so this isn't chatty on plain window focus.
    const onWake = () => {
      if (document.visibilityState === "visible") resync();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) resync();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      dispose();
      disposeSelect();
      disposeLearnings();
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("pageshow", onPageShow);
    };
  });

  // elapsed-time tick: only run while there's at least one session — an empty
  // herd has no elapsed clocks to drive, so don't write nowMs every second.
  // Gate on a $derived boolean, not store.sessions.length directly: session:new
  // and session:archived reassign store.sessions, which would re-run an effect
  // that read it and recreate the interval mid-add/remove — under churn the 1s
  // tick could stutter, freezing every elapsed clock. A $derived only propagates
  // on the empty↔non-empty flip, so the interval is made once.
  const hasSessions = $derived(store.sessions.length > 0);

  // Open the global learnings drawer: with proposals pending, show them all (repo = null);
  // otherwise focus the first over-budget ("curate") repo. Shared by the top-bar entry
  // point and the command-bar Learnings verb so both behave identically.
  function openLearnings() {
    learningsRepo = learningsCounts.proposed > 0 ? null : firstCurateRepo(learnings.injectable);
    showLearnings = true;
  }

  // Command bar v2 verbs. Availability flags mirror the same gates the on-screen
  // affordances use (Broadcast needs sessions; Retry mirrors SteerBar's retryReady chip;
  // the needs-you jump needs another waiting session), so the bar never offers a verb the
  // UI itself would hide. buildCommands filters out the unavailable ones.
  const commandBarCommands = $derived(
    buildCommands({
      onNewTask: () => (showNew = true),
      onBroadcast: () => (showBroadcast = true),
      onSettings: () => (showSettings = true),
      onUsage: () => (showUsage = true),
      onRetry: () => (showRetry = true),
      onNextNeedsYou: () => selectNextNeedsYou(),
      onLearnings: openLearnings,
      onDiagnoseEpic: () => (showEpicDiagnose = true),
      hasSessions,
      retryReady,
      otherNeedsYouCount: otherNeedsYou.length,
      hasLearnings: learningsCounts.proposed > 0 || learningsCounts.curate > 0,
    }),
  );

  $effect(() => {
    if (!hasSessions) return;
    nowMs = Date.now(); // refresh on the empty→non-empty flip so the first frame isn't up to 1s stale
    const t = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(t);
  });

  // Keep the "Land epic" CTA + stranded badge live. The landing-gate fields are computed only in the
  // GET /api/epics/completed enrichment; the epic:completed WS payload omits them, and the two signals
  // that flip them — the landing PR's CI going green and the time-based `stranded` crossing — fire no
  // WS event. So while an open-landing epic exists, re-seed from the GET on a slow timer (and once
  // immediately on the none→open flip, so a freshly-opened landing isn't disabled for a full interval).
  // Gated on a $derived boolean (same reasoning as hasSessions above): it only flips on none↔open, so
  // the interval is created once — completedEpics reassignment from WS events won't recreate it.
  const hasOpenLandingEpic = $derived(store.completedEpics.some((e) => e.landingState === "open"));
  $effect(() => {
    if (!hasOpenLandingEpic) return;
    const refresh = () =>
      getCompletedEpics()
        .then((l) => store.seedCompletedEpics(l))
        .catch(() => {});
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  });

  // Clear ALL compose + relaunch seed state. Called on every dialog dismissal and
  // after a successful submit so no seed (repo / issue / prompt / model / base branch /
  // relaunch origin + issue) leaks into the next New Task open.
  function resetCompose() {
    composeRepoPath = null;
    composeIssue = null;
    composePrompt = null;
    composeModel = null;
    composeEffort = null;
    composeBaseBranch = null;
    relaunchOriginalId = null;
    relaunchIssueNumber = null;
    composeImages = [];
    editHeldId = null;
    composeAgentProvider = null;
    composePlanGate = null;
    composeAutopilot = null;
    composeSandbox = null;
    composeResearch = false;
    composeEpicAuthoring = false;
  }

  // NewProject partial-success warning code → message map. A lookup (not a ternary
  // ladder) keeps onNewProjectDone under the function complexity bar; unknown codes
  // fall back to the generic GitHub warning.
  const NEW_PROJECT_WARNINGS: Record<string, () => string> = {
    newproject_failed_gh_missing: m.newproject_failed_gh_missing,
    newproject_failed_gh_auth: m.newproject_failed_gh_auth,
    newproject_failed_gh_exists: m.newproject_failed_gh_exists,
    newproject_failed_remote: m.newproject_failed_remote,
    newproject_failed_timeout: m.newproject_failed_timeout,
  };

  // A repo was just added from the Backlog panel: stay in the browse surface.
  // Refetch the backlog so the new repo appears, then hand BacklogView the path to
  // auto-select. The Backlog overlay stays mounted underneath the (now-closing)
  // modal — the three modals sit at z-index:30, above the overlay's 20 — so there
  // is no remount and the user's place is preserved. Origin is reset so a later
  // New-Task-origin completion isn't misrouted here.
  //
  // Order matters: set backlogSelectPath ONLY AFTER the refreshed payload is
  // assigned. The new repo (zero issues/PRs) isn't in the old payload, so selecting
  // against the stale list would let BacklogView's desktop "drop off-screen
  // selection" effect ($effect at BacklogView.svelte ~223) clear the selection
  // before the fresh payload lands — and the once-per-value select effect wouldn't
  // re-fire. Assigning payload first guarantees the repo is in `visibleProjects`
  // when the select effect runs. On refetch failure we skip selection (no phantom).
  function finishBacklogAdd(path: string) {
    getBacklog()
      .then((p) => {
        backlog = p;
        backlogSelectPath = path;
      })
      .catch(() => {});
    repoAddOrigin = null;
  }

  // "+ Add repo" menu actions from any Backlog repos panel (the overlay AND the
  // inline empty-herd panels). Mark the origin so the shared modal's done handler
  // stays in the browse surface, then open the already-mounted modal.
  function addRepoClone() {
    repoAddOrigin = "backlog";
    showClone = true;
  }
  function addRepoFork() {
    repoAddOrigin = "backlog";
    showFork = true;
  }
  function addRepoNewProject() {
    repoAddOrigin = "backlog";
    showNewProject = true;
  }

  // NewProject.ondone. From the Backlog panel: refetch + auto-select (no yank into
  // New Task). Otherwise (New-Task origin): auto-select the new repo in NewTask +
  // prefill the kickoff seed. A warning (partial success: local ok, GitHub failed)
  // surfaces as a non-blocking info toast in either case. Named here (not inline in
  // the AppOverlays mount) so its branching stays out of the route template.
  function onNewProjectDone(
    entry: { path: string; warning?: string },
    kickoff: KickoffChoice,
    idea: string,
  ) {
    showNewProject = false;
    if (entry.warning) {
      toasts.info((NEW_PROJECT_WARNINGS[entry.warning] ?? m.newproject_warning_github)());
    }
    if (repoAddOrigin === "backlog") {
      finishBacklogAdd(entry.path);
      return;
    }
    composeRepoPath = entry.path;
    composePrompt = buildKickoffSeed(kickoff, idea);
    repoAddOrigin = null;
    showNew = true;
  }

  // Relaunch-elsewhere submit: route to relaunchSession(originalId, overrides) instead of
  // createSession. The server owns issue handling (cross-repo drops it + releases its claim),
  // so we never pass issueRef. Errors THROW so NewTask renders them inline (keeps the dialog
  // open with a Retry); success mirrors onrelaunch's toast semantics.
  async function submitRelaunch(
    id: string,
    input: {
      repoPath: string;
      baseBranch: string;
      prompt: string;
      model: string | null;
      effort: string | null;
      images: string[];
      attachmentNames?: string[];
      launchUiState?: {
        researchChecked: boolean;
        planGateChecked: boolean;
        autopilotChecked: boolean;
      };
      planGateEnabled: boolean | null;
    },
  ) {
    let result: { session: Session; archived: boolean };
    try {
      result = await relaunchSession(id, {
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
        planGateEnabled: input.planGateEnabled,
        images: input.images,
        attachmentNames: input.attachmentNames,
        launchUiState: input.launchUiState,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "in_progress")
        throw new Error(m.relaunch_in_progress(), { cause: e });
      if (e instanceof ApiError && e.code === "issue_unresolved")
        throw new Error(m.relaunch_issue_unresolved(), { cause: e });
      throw e instanceof Error ? e : new Error(m.relaunch_failed(), { cause: e });
    }
    selectNewSession(result.session.id, input.repoPath);
    showNew = false;
    resetCompose();
    if (result.archived) toasts.info(m.relaunch_done({ desig: result.session.desig }));
    else
      // Same assertive 12s failure toast onrelaunch uses (deduped per id).
      toasts.info(m.relaunch_archive_failed(), {
        alert: true,
        key: `relaunch-fail:${id}`,
      });
  }

  // Persist an edited held task: replace its stored input via PATCH, keeping it held.
  // Errors THROW so NewTask renders them inline (dialog stays open with a Retry).
  async function submitEditHeld(
    id: string,
    input: {
      repoPath: string;
      baseBranch: string;
      prompt: string;
      agentProvider?: AgentProvider;
      model: string | null;
      effort: string | null;
      images: string[];
      attachmentNames?: string[];
      issueRef?: IssueRef;
      launchUiState?: {
        researchChecked: boolean;
        planGateChecked: boolean;
        autopilotChecked: boolean;
      };
      planGateEnabled: boolean | null;
      autopilotEnabled: boolean | null;
      sandboxProfile?: SandboxProfile;
      research: boolean;
    },
  ) {
    await updateHeld(id, input);
    showNew = false;
    resetCompose();
    toasts.info(m.toast_held_edit_saved());
  }

  async function onsubmit(input: {
    repoPath: string;
    baseBranch: string;
    prompt: string;
    agentProvider?: AgentProvider;
    model: string | null;
    effort: string | null;
    images: string[];
    attachmentNames?: string[];
    issueRef?: IssueRef;
    launchUiState?: {
      researchChecked: boolean;
      planGateChecked: boolean;
      autopilotChecked: boolean;
      epicAuthoringChecked?: boolean;
    };
    planGateEnabled: boolean | null;
    autopilotEnabled: boolean | null;
    sandboxProfile?: SandboxProfile;
    research: boolean;
    epicAuthoring: boolean;
    force?: boolean;
  }) {
    // Edit-held path persists the new input back onto the still-held task; relaunch-elsewhere
    // branches to submitRelaunch; otherwise the normal New Task create.
    if (editHeldId !== null) return submitEditHeld(editHeldId, input);
    if (relaunchOriginalId !== null) return submitRelaunch(relaunchOriginalId, input);
    const r = await createSession(input);
    if ("held" in r) {
      // Held tasks are queued (visible via the TopBar badge); close the composer like a
      // normal submit so the populated prompt can't be re-clicked into a duplicate hold.
      toasts.info(m.toast_task_held());
      showNew = false;
      resetCompose();
      return;
    }
    selectNewSession(r.id, input.repoPath);
    showNew = false;
    resetCompose();
  }

  // Relaunch elsewhere: open the New Task composer pre-filled from this session so the
  // operator can pick a different repo / base branch / prompt before submitting. The
  // submit routes through onsubmit's relaunch branch (relaunchOriginalId set).
  async function onrelaunchElsewhere(id: string) {
    const s = store.sessions.find((x) => x.id === id);
    if (!s) return;
    // Guard a double-invoke while a slow upload-stage is in flight (don't double-seed).
    if (relaunchStaging) return;
    relaunchStaging = true;
    // Stage the original's uploads FIRST and assign the relaunch/compose seed state only
    // AFTER it resolves: a bare New-Task opener (onnew) can fire during this await, and if
    // relaunchOriginalId were already set the composer would mount in a half-set relaunch
    // state (and submit would wrongly archive the original). On failure, seed empty + warn
    // so the operator knows to re-attach (never double-attach).
    let staged: { path: string; name: string }[] = [];
    try {
      staged = (await stageRelaunchImages(id)).map((img) => ({
        path: img.path,
        name: img.nameRecorded && img.name ? img.name : m.tasktip_not_recorded(),
      }));
    } catch {
      toasts.info(m.relaunch_images_carry_failed(), { alert: true });
    } finally {
      relaunchStaging = false;
    }
    // No await past this point: assign all seeds + open synchronously so nothing can
    // interleave a half-set state. NewTask's one-time initialImages seed reads composeImages
    // at mount, so it must be set before showNew flips true.
    composePrompt = s.prompt;
    composeRepoPath = s.repoPath;
    composeBaseBranch = s.baseBranch;
    // null model = "claude default": map to the literal "default" so the composer's
    // model select shows Default and submits null back (preserving the original's model
    // exactly). `?? undefined` would wrongly fall back to the operator default.
    composeModel = s.model ?? "default";
    // Mirror the null-model handling: null effort → literal "default" so the picker shows Default
    // and submits it, preserving the original's effort exactly (server keeps it via pickOverride).
    composeEffort = s.effort ?? "default";
    composeIssue = null;
    relaunchIssueNumber = s.issueNumber;
    relaunchOriginalId = id;
    composeImages = staged;
    showNew = true;
  }

  // Edit a still-held task: open the New Task composer pre-filled from the task's stored
  // input so the operator can change the prompt / repo / settings before it spawns. Submit
  // routes through onsubmit's edit-held branch (editHeldId set). All seeds are assigned
  // synchronously (no await) so a bare onnew can't interleave a half-set edit state. The
  // held task's uploads are already staged paths, so we seed them directly as chips.
  function onEditHeld(task: HeldTask) {
    const input = task.input;
    composePrompt = input.prompt;
    composeRepoPath = input.repoPath;
    composeBaseBranch = input.baseBranch;
    // Mirror relaunch's null-model handling: null = "claude default" → literal "default".
    composeModel = input.model ?? "default";
    composeEffort = input.effort ?? "default";
    composeImages = (input.images ?? []).map((p, i) => ({
      path: p,
      name: input.attachmentNames?.[i] ?? p.split("/").at(-1) ?? p,
    }));
    // The held input carries an IssueRef (no labels/assignees); pad it to the Issue shape
    // the composer chip expects. The body rides out-of-band, same as a fresh attach.
    composeIssue = input.issueRef
      ? { ...input.issueRef, labels: [], createdAt: 0, assignees: [] }
      : null;
    composeAgentProvider = input.agentProvider ?? null;
    composePlanGate = input.planGateEnabled ?? null;
    composeAutopilot = input.autopilotEnabled ?? null;
    composeSandbox = input.sandboxProfile ?? null;
    composeResearch = input.research ?? false;
    composeEpicAuthoring = input.epicAuthoring ?? false;
    editHeldId = task.id;
    showNew = true;
  }

  function onarchive(id: string, reap?: string[]) {
    // Removing the worktree is irreversible, so we DEFER it: focus leaves the
    // doomed session immediately, but archiveSession only fires when the undo
    // window expires. UNDO restores focus and the server is never called.
    const name = store.sessions.find((s) => s.id === id)?.name ?? id;
    if (selectedId === id) selectedId = store.sessions.find((s) => s.id !== id)?.id ?? null;
    toasts.undo(m.toast_decommissioned({ name }), {
      undoLabel: m.common_undo(),
      key: id,
      onUndo: () => {
        // restore focus only if the row is still around (it never left the store)
        if (store.sessions.some((s) => s.id === id)) selectedId = id;
      },
      onCommit: async () => {
        // server stops the agent, removes the worktree, emits session:archived
        // (store drops the row); a failure surfaces with a Retry that re-defers
        // the same decommission, so the row never dead-ends.
        try {
          await archiveSession(id, reap);
        } catch {
          toasts.info(m.toast_decommission_failed({ name }), {
            sticky: true,
            alert: true,
            key: `decommission-fail:${id}`,
            action: { label: m.common_retry(), run: () => onarchive(id, reap) },
          });
        }
      },
    });
  }

  // Relaunch a task: spawn a fresh replacement carrying the original's prompt +
  // current settings, then decommission the original. No manual list mutation — the
  // store adds the new card on session:new and drops the old one on session:archived;
  // the handler only awaits the API and toasts. The two-step arm lives in CardMenu, so
  // by the time this fires the operator has already confirmed (no undo window — relaunch
  // is irreversible and an undo would have to also kill the fresh replacement).
  async function onrelaunch(id: string) {
    const fail = (text: string) =>
      // Assertive + deduped per id under a relaunch-fail namespace: the failure lingers
      // 12s (longer than the transient 4s success info), and repeated failures to one
      // card collapse into a single toast rather than stacking.
      toasts.info(text, { alert: true, key: `relaunch-fail:${id}` });
    try {
      const { session, archived } = await relaunchSession(id);
      if (archived) toasts.info(m.relaunch_done({ desig: session.desig }));
      else fail(m.relaunch_archive_failed());
    } catch (e) {
      if (e instanceof ApiError && e.code === "in_progress") fail(m.relaunch_in_progress());
      else if (e instanceof ApiError && e.code === "issue_unresolved")
        fail(m.relaunch_issue_unresolved());
      else fail(m.relaunch_failed());
    }
  }

  // ── Comparison experiments ───────────────────────────────────────────────────
  // A card's "Start as variant…" / "Continue with…" menu item and an experiment group's
  // "Compare" button all open the SAME anchored provider/model picker; the chosen pair drives
  // the matching API call. Variants/comparison spawns appear live via session:new; the original
  // joins the group live via session:experiment.
  let picker = $state<ExperimentPickerState | null>(null);
  const pickerFableAvailable = $derived(settings?.fableAvailable ?? true);
  const pickerProvider = $derived<AgentProvider>(settings?.defaultAgentProvider ?? "claude");
  function onvariant(id: string, anchor: { x: number; y: number }) {
    picker = { mode: "variant", id, x: anchor.x, y: anchor.y };
  }
  function onreplace(id: string, anchor: { x: number; y: number }) {
    picker = { mode: "replace", id, x: anchor.x, y: anchor.y };
  }
  function oncompare(experimentId: string, anchor: { x: number; y: number }) {
    picker = { mode: "compare", experimentId, x: anchor.x, y: anchor.y };
  }
  // Restore an archived session from the Done lens: re-creates the worktree on its
  // surviving branch and resumes the conversation (recovers committed work only).
  // The two-step arm lives in DoneRecapPanel, so by the time this fires the operator
  // has already confirmed. The live Herd row arrives via session:new — no manual
  // store mutation needed beyond dropping the row from the Done list on success.
  async function onBringBack(id: string) {
    const fail = (text: string) => toasts.info(text, { alert: true, key: `restore-fail:${id}` });
    try {
      const s = await restoreSession(id);
      doneSessions.remove(id);
      toasts.info(m.restore_done({ desig: s.desig }));
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "cannot_restore") fail(m.restore_cannot());
        else if (e.code === "branch_gone") fail(m.restore_branch_gone());
        else if (e.code === "branch_in_use") fail(m.restore_branch_in_use());
        else if (e.code === "not_archived") fail(m.restore_not_archived());
        else if (e.code === "in_progress") fail(m.restore_in_progress());
        else fail(m.restore_failed());
      } else {
        fail(m.restore_failed());
      }
    }
  }

  // Fleet-wide emergency stop. Interrupting every working agent is consequential, so
  // the guard against an accidental tap is the TopBar's two-step arm→confirm gesture
  // (first activation arms the red "Halt N?" pill, a second commits) — by the time
  // onhalt fires here the operator has already confirmed, so we POST straight away.
  // An interim "Halting N…" toast gives immediate feedback; the "Halted N" confirm
  // rides in on the `halt:done` WS event (all connected clients). All three toasts
  // share the 'halt-done' key so each supersedes the last in place (interim →
  // Halted N on success, or interim → Retry on failure) rather than stacking.
  function haltHerd() {
    // Raw status by design (NOT displayStatus): the server's haltAll only reaches
    // agents herdr itself reports working — a working-while-blocked session is
    // latched "blocked" there, so counting it would overstate the e-stop's reach.
    const count = store.sessions.filter((s) => s.status === "running").length;
    if (count === 0) return; // nothing to halt; the control is hidden in this state anyway
    toasts.info(m.halt_confirm({ count }), { key: "halt-done" });
    apiHalt().catch(() => {
      toasts.info(m.halt_failed(), {
        alert: true,
        sticky: true, // stay until the operator retries/closes — a failed fleet-halt must not vanish
        key: "halt-done",
        action: { label: m.common_retry(), run: () => haltHerd() },
      });
    });
  }

  // Plugin gear items: one entry per plugin that published a gearItem.
  // Verbatim plugin-authored data — never run through i18n.
  const pluginGearItems = $derived(
    store.plugins
      .filter((p) => p.gearItem)
      .map((p) => ({ id: p.id, label: p.gearItem!.label, icon: p.gearItem!.icon })),
  );

  async function handlePluginGearItem(id: string) {
    const item = store.plugins.find((p) => p.id === id)?.gearItem;
    if (!item) return;
    const a = item.action;
    if (a.kind === "url") {
      window.open(a.href, "_blank", "noopener,noreferrer");
    } else if (a.kind === "panel") {
      focusPluginId = id;
      settingsTab = "plugins";
      showSettings = true;
    } else {
      // route
      try {
        const text = await invokePluginRoute(id, a.method, a.path);
        toasts.info(text.length > 0 ? text : m.plugin_gear_action_done());
      } catch {
        toasts.info(m.plugin_gear_action_failed(), {
          alert: true,
          key: `plugin-gear:${id}`,
        });
      }
    }
  }

  // Open the "clear all merged" confirm modal. The server is the source of truth
  // for which sessions are merged (same prCache the list partitions on) and for the
  // leftover count, so we ask it rather than trust the local snapshot.
  async function onclearmerged() {
    try {
      const { ids, leftovers } = await getMergedClearable();
      // store.sessions mirrors every active session, so each merged id resolves to a
      // row here — `targets` matches the server's `ids` and `leftovers` lines up with
      // the listed sessions. (Were a merged id somehow absent, we'd list and clear only
      // the rows we can show; the leftover figure would slightly overstate. Cosmetic.)
      const targets = ids
        .map((id) => store.sessions.find((s) => s.id === id))
        .filter((s): s is Session => s != null);
      if (targets.length === 0) return; // nothing merged (or already cleared) → no modal
      clearMergedLeftovers = leftovers;
      clearMergedSessions = targets;
    } catch {
      toasts.info(m.toast_clear_merged_failed());
    }
  }

  // Archive the given merged sessions. The server stops each agent, removes its
  // worktree, deletes the merged branch, and emits session:archived so the rows drop
  // from the store. Shared by the confirm and its Retry so a successful retry shows
  // the same success toast and focus-move as the first attempt. Focus only moves
  // off the cleared rows on success — a transient failure leaves selection put,
  // since nothing was actually cleared.
  async function runClearMerged(ids: string[]) {
    try {
      const { cleared } = await clearMerged(ids);
      const gone = new Set(cleared);
      if (selectedId && gone.has(selectedId)) {
        selectedId = store.sessions.find((s) => !gone.has(s.id))?.id ?? null;
      }
      toasts.info(m.toast_cleared_merged({ count: cleared.length }));
    } catch {
      toasts.info(m.toast_clear_merged_failed(), {
        sticky: true,
        alert: true,
        key: "clear-merged-fail",
        action: { label: m.common_retry(), run: () => void runClearMerged(ids) },
      });
    }
  }

  // Dismiss a completed epic from the integrated-epics band. Optimistic remove, then
  // reconcile against the CURRENT state on API error — re-insert only the removed
  // entry if it isn't already present, never clobber the whole array. Restoring a
  // captured snapshot wholesale would drop a completed epic that arrived via an
  // `epic:completed` WS event during the in-flight request. A successful dismiss
  // also fires an `epic:completed-cleared` WS event that removes it again —
  // idempotent, harmless.
  async function onDismissEpic(repoPath: string, parent: number) {
    const match = (e: CompletedEpic) => e.repoPath === repoPath && e.parentIssueNumber === parent;
    const removed = store.completedEpics.find(match);
    store.completedEpics = store.completedEpics.filter((e) => !match(e)); // optimistic
    try {
      await dismissCompletedEpic(repoPath, parent);
    } catch {
      if (removed && !store.completedEpics.some(match)) {
        // reconcile vs CURRENT state — don't clobber WS arrivals
        store.completedEpics = [removed, ...store.completedEpics];
      }
      toasts.info(m.integrated_epics_dismiss_failed(), {
        alert: true,
        key: `epic-dismiss-fail:${repoPath}#${parent}`,
      });
    }
  }

  // Acknowledge a completed epic's landing-PR migrations (#645). Like onDismissEpic, the server
  // ack also dismisses the row, so optimistically remove it; on failure, restore + toast.
  async function onAckEpicMigrations(repoPath: string, parent: number) {
    const match = (e: CompletedEpic) => e.repoPath === repoPath && e.parentIssueNumber === parent;
    const removed = store.completedEpics.find(match);
    store.completedEpics = store.completedEpics.filter((e) => !match(e)); // optimistic
    try {
      await ackEpicMigrations(repoPath, parent);
    } catch {
      if (removed && !store.completedEpics.some(match)) {
        store.completedEpics = [removed, ...store.completedEpics];
      }
      toasts.info(m.integrated_epics_ack_migrations_failed(), {
        alert: true,
        key: `epic-ack-migrations-fail:${repoPath}#${parent}`,
      });
    }
  }

  // Acknowledge a session's manual operator steps (#1060), clearing its auto-merge gate. The
  // server emits session:manual-steps with the fresh ackedAt on success, so the chip/CTA clear
  // live via the WS handler — no optimistic mutation needed. On failure, a 12s, tone-
  // namespaced keyed alert so a flapping failure can't stack.
  async function onAckManualSteps(id: string) {
    try {
      await ackManualSteps(id);
    } catch {
      toasts.info(m.unitrow_ack_manual_steps_failed(), {
        alert: true,
        key: `ack-manual-steps-fail:${id}`,
      });
    }
  }

  // Manual-steps chip -> Owed lens (#1275): switch lenses and snapshot the session's steps so the
  // panel can scroll-to + highlight the live card, or fall back to a read-only frozen card when no
  // live outstanding record exists (pre-merge, cleared, dismissed, or load-failed).
  function onShowOwed(id: string) {
    const s = store.sessions.find((x) => x.id === id);
    if (s) {
      owedFocusSnapshot = {
        sessionId: id,
        desig: s.desig,
        prNumber: store.git[id]?.number ?? null,
        steps: s.manualSteps,
        merged: store.git[id]?.state === "merged",
      };
      owedFocusId = id;
      owedFocusNonce += 1; // bump so re-clicking the same session re-fires
    }
    herdFilter = "owed";
    // Force an on-demand refresh so a click on the chip never shows a client-stale
    // frozen set (#1478) — the loaded-guarded loads above only fire once.
    void postMergeStepsStore.load();
  }

  // Reports the panel's resolution of a focus click (live scroll+flash, frozen fallback, or a
  // still-loading wait that later resolved) so a later remount of the panel (lens toggled away and
  // back) can tell an already-handled click from a fresh one.
  function onOwedFocusResolved(nonce: number) {
    owedFocusHandledNonce = nonce;
  }

  // Clear focus on leaving the Owed lens so a later return via the lens strip doesn't resurrect a
  // stale frozen/highlight target. Nonces are left alone — a future click bumps owedFocusNonce past
  // owedFocusHandledNonce regardless.
  $effect(() => {
    if (herdFilter !== "owed") {
      owedFocusId = null;
      owedFocusSnapshot = null;
    }
  });

  // Merge the landing PR for a completed epic (#1039). Server emits epic:completed on success
  // (landingState:"merged") so the band updates live — no optimistic mutation needed here.
  async function onLandEpic(repoPath: string, parent: number) {
    try {
      await landEpic(repoPath, parent);
    } catch (err) {
      const msg =
        err instanceof Error && err.message ? err.message : m.integrated_epics_land_failed();
      toasts.info(msg, {
        alert: true,
        key: `epic-land-fail:${repoPath}#${parent}`,
      });
    }
  }

  // Confirmed: clear the dialog state (before the await, so it can't double-submit),
  // then run the bulk archive.
  function confirmClearMerged() {
    const targets = clearMergedSessions ?? [];
    clearMergedSessions = null;
    void runClearMerged(targets.map((s) => s.id));
  }

  // Confirmed: capture the launch closure, clear the dialog state BEFORE awaiting
  // (so it can't double-fire), then run the original launch.
  function confirmTrain() {
    const run = pendingTrain?.run;
    pendingTrain = null;
    if (run) void run();
  }

  // The deploy runs detached: it builds, restarts the server, and only then —
  // after the new process answers a health check — writes its success marker.
  // So a readable `done` GUARANTEES the new build is already live. We poll the
  // captured log to drive the modal (live progress + failures) and, on `done`,
  // reload immediately rather than waiting for the update:status broadcast,
  // which the server only re-emits every 5 min (and a phone's WS often misses
  // on reconnect) — that lag is why the modal used to sit frozen until a manual
  // app restart.
  function watchDeploy() {
    if (deployPollTimer) clearTimeout(deployPollTimer);
    let lastReachable = Date.now(); // last time the server answered the log poll
    const tick = async () => {
      try {
        const st = await getUpdateLog();
        lastReachable = Date.now();
        deploy = st; // feed the modal the live, tailing log
        if (st.phase === "done") {
          // new server is up and healthy → pull the freshly built UI assets
          location.reload();
          return;
        }
        if (st.phase === "failed") {
          store.updating = false; // unstick the spinner so the user can read + retry
          return;
        }
      } catch {
        // server is briefly unreachable mid-restart — expected, keep polling.
        // But if it stays unreachable far longer than a restart should take,
        // stop guessing and tell the user, so the modal can't wedge forever.
        if (Date.now() - lastReachable > 3 * 60_000) {
          deploy = { phase: "failed", exitCode: null, log: m.updatemodal_unreachable() };
          store.updating = false;
          return;
        }
      }
      deployPollTimer = setTimeout(tick, 1500);
    };
    deployPollTimer = setTimeout(tick, 1500);
  }

  function onUpdateConfirm() {
    deploy = null;
    store.beginUpdate();
    watchDeploy();
  }

  function closeUpdate() {
    showUpdate = false;
    deploy = null;
    if (deployPollTimer) clearTimeout(deployPollTimer);
  }
</script>

<svelte:window onkeydown={onShortcut} />

<div
  class="shell"
  class:mobile={mobile.current}
  class:list={mobile.current && mobileScreen === "list"}
>
  <!-- a11y: a single top-level heading for the app shell, visually hidden via the
       scoped .sr-only rule below (no layout change), gives screen-reader users an
       h1 to orient by. Always present, even on the phone terminal screen where the
       chrome is hidden. -->
  <h1 class="sr-only">{m.app_shell_heading()}</h1>
  <!-- a11y: the ambient tab signal (title/favicon/App Badge) is invisible to screen
       readers and title changes aren't reliably announced, so mirror every count
       change into a polite live region (#1327). -->
  <div class="sr-only" role="status" aria-live="polite">{tabSignal.announcement}</div>
  <!-- On a phone in the terminal-focus screen the top bar is subsumed by the
       viewport's merged header (repo · session + back + status tint), so it's
       hidden there; settings + global chrome stay on the herd overview. -->
  {#if !(mobile.current && mobileScreen === "detail")}
    <header class="chrome" class:chrome-hidden={chromeHidden}>
      <TopBar
        sessions={store.sessions}
        {nowMs}
        connected={store.connected}
        mobile={mobile.current}
        touch={touch.current}
        limits={store.usageLimits}
        onsettings={() => {
          settingsTab = "workspace";
          showSettings = true;
        }}
        onusage={() => (showUsage = true)}
        onhalt={haltHerd}
        update={store.update}
        onupdate={() => (showUpdate = true)}
        herdrUpdate={store.herdrUpdate}
        onherdrupdate={() => (showHerdrUpdate = true)}
        codexUpdate={store.codexUpdate}
        oncodexupdate={openCodexUpdate}
        whatsNew={whatsNewDotOn}
        onwhatsnew={() => (showWhatsNew = true)}
        learnings={learningsCounts.proposed}
        learningsCurate={learningsCounts.curate}
        onlearnings={openLearnings}
        {statusFilter}
        onstatusfilter={(s) => (statusFilter = s)}
        workingBlocked={store.workingBlocked}
        diagnosticsOverall={store.diagnosticsOverall}
        ondiagnose={() => {
          settingsTab = "diagnose";
          showSettings = true;
        }}
        heldCount={store.heldCount}
        onedithheld={onEditHeld}
        pluginItems={pluginGearItems}
        onpluginitem={handlePluginGearItem}
        oncommandbar={() => (showCommandBar = true)}
      />
      <RepoSwitcher
        chips={repoChips}
        {repoFilter}
        {pinnedRepo}
        mobile={mobile.current}
        onrepofilter={applyRepoFilter}
        onpinrepo={setPinnedRepo}
      />
      <QueueStrip autoMerge={store.autoMerge} onselect={jumpToSession} />
    </header>
  {/if}

  <main id="main-content" class="main-region">
    {#if mobile.current}
      <!-- This list branch is the sole place the mobile ActionBar renders; its
           presence is mirrored by `mobileActionBarPresent` above (feeds Toasts).
           Keep the two in sync. -->
      {#if mobileScreen === "list"}
        <div class="col">
          <Herd
            sessions={herdSessions}
            filteredRepo={repoFilterName}
            {repoFilter}
            onrepofilter={applyRepoFilter}
            {statusFilter}
            onstatusfilter={(s) => (statusFilter = s)}
            {selectedId}
            {nowMs}
            onselect={(id) => selectUnit(id)}
            onnew={() => (showNew = true)}
            git={store.git}
            activity={store.activity}
            preview={store.preview}
            previewServe={store.previewServe}
            onpreview={openPreview}
            onrename={openRename}
            epics={store.epics}
            onepic={openEpicInBacklog}
            {activeEpicKeys}
            collapsedKeys={collapsedEpics}
            oncollapsetoggle={toggleEpicCollapse}
            onrenderedepicgroups={normalizeRenderedEpicCollapse}
            ondecommission={onarchive}
            {onrelaunch}
            {onrelaunchElsewhere}
            {onvariant}
            {onreplace}
            {oncompare}
            {onclearmerged}
            {onmergetrain}
            {issueActionsUnset}
            onsettings={() => {
              settingsTab = "workspace";
              showSettings = true;
            }}
            flow={true}
            bind:filter={herdFilter}
            workingBlocked={store.workingBlocked}
            blocks={store.blocks}
            holds={store.holds}
            completedEpics={completedEpicsShown}
            ondismissepic={onDismissEpic}
            onlandepic={onLandEpic}
            doneList={doneSessions.sessions}
            {doneSelectedId}
            ondoneselect={(id) => {
              doneSelectedId = id;
              mobileScreen = "detail";
            }}
            onrundownitem={selectRundownItem}
            onrundownepic={selectRundownEpic}
            {focusEpic}
            onackmigrationsepic={onAckEpicMigrations}
            onackmanualsteps={onAckManualSteps}
            onshowowed={onShowOwed}
            {owedFocusId}
            {owedFocusSnapshot}
            {owedFocusNonce}
            {owedFocusHandledNonce}
            onfocusresolved={onOwedFocusResolved}
            onbacklog={() => (showBacklog = true)}
            {upNextLaunch}
          />
          {#if store.sessions.length === 0 && herdFilter !== "done" && !panelOnlyLens}
            <BacklogView
              payload={backlog}
              mobile={true}
              {onissue}
              onquick={onquickissue}
              oninject={oninjectissue}
              {onpr}
              {onadopt}
              {onlaunchtrain}
              onaddclone={addRepoClone}
              onaddfork={addRepoFork}
              onaddnewproject={addRepoNewProject}
              selectPath={backlogSelectPath}
              flow={true}
              epics={store.epics}
              {inTrainPrs}
              drain={store.drain}
              docAgentEnabled={settings?.docAgentEnabled ?? false}
              docAgentAct={settings?.docAgentAct ?? false}
              docAgentDone={store.docAgentDone}
            />
          {/if}
        </div>
        <ActionBar
          onnew={() => (showNew = true)}
          onbacklog={store.sessions.length > 0 ? () => (showBacklog = true) : undefined}
          mobile={mobile.current}
        />
      {:else if herdFilter === "done"}
        <!-- Done lens detail (mobile): read-only recap; back returns to the done list -->
        <div class="col">
          <button type="button" class="done-back" onclick={() => (mobileScreen = "list")}
            >{m.done_back_to_list()}</button
          >
          {#if doneSelected}
            <DoneRecapPanel session={doneSelected} onbringback={(id) => onBringBack(id)} />
          {:else}
            <div class="empty">{m.herd_done_empty()}</div>
          {/if}
        </div>
      {:else if selected}
        <div class="col">
          <Viewport
            session={selected}
            mobile={mobile.current}
            connected={store.connected}
            limits={store.usageLimits}
            git={store.git[selected.id]}
            activity={store.activity[selected.id]}
            previewPort={store.preview[selected.id] ?? null}
            claudeAlive={store.claudeAlive[selected.id]}
            previewMap={store.preview}
            previewHost={settings?.previewHost ?? null}
            previewServeFailed={store.previewServe[selected.id] === "failed"}
            {openPreviewTick}
            {renameRequest}
            buildQueue={store.buildQueues[selected.id] ?? null}
            onSeedBuildQueue={(q) => store.setBuildQueue(q)}
            queue={blockedEntries.map((e) => e.session.id)}
            switchOrder={store.sessions.map((s) => s.id)}
            onnavigate={(id) => selectUnit(id)}
            {consumeAutoFocusTerm}
            {onarchive}
            workingBlocked={store.workingBlocked}
            authUrl={selectedAuthUrl}
            onback={() => (mobileScreen = "list")}
            onretry={() => (showRetry = true)}
            retryHaltedCount={haltedCount}
            {retryReady}
            onedit={openSteersEditor}
            drain={store.drain[selected.repoPath] ?? null}
            subagents={store.subagents}
          />
        </div>
      {/if}
    {:else}
      <div
        class="grid"
        class:compact={touch.current}
        class:collapsed={sidebarCollapsed}
        class:resized={herdResized}
        class:resizing={herdResizing}
        style={herdWidthStyle}
      >
        {#if sidebarCollapsed}
          <button
            id="herd-reopen-tab"
            type="button"
            class="reopen-tab"
            title={m.herd_expand()}
            aria-label={m.herd_expand()}
            onclick={toggleSidebar}>›</button
          >
        {:else}
          <div class="herd-col" bind:this={herdColEl}>
            <Herd
              sessions={herdSessions}
              filteredRepo={repoFilterName}
              {repoFilter}
              onrepofilter={applyRepoFilter}
              {statusFilter}
              onstatusfilter={(s) => (statusFilter = s)}
              {selectedId}
              {nowMs}
              onselect={(id) => selectUnit(id)}
              onnew={() => (showNew = true)}
              git={store.git}
              activity={store.activity}
              preview={store.preview}
              previewServe={store.previewServe}
              onpreview={openPreview}
              onrename={openRename}
              epics={store.epics}
              onepic={openEpicInBacklog}
              {activeEpicKeys}
              collapsedKeys={collapsedEpics}
              oncollapsetoggle={toggleEpicCollapse}
              onrenderedepicgroups={normalizeRenderedEpicCollapse}
              ondecommission={onarchive}
              {onrelaunch}
              {onrelaunchElsewhere}
              {onvariant}
              {onreplace}
              {oncompare}
              {onclearmerged}
              {onmergetrain}
              {issueActionsUnset}
              onsettings={() => {
                settingsTab = "workspace";
                showSettings = true;
              }}
              bind:filter={herdFilter}
              workingBlocked={store.workingBlocked}
              blocks={store.blocks}
              holds={store.holds}
              collapsible={canCollapse}
              oncollapse={toggleSidebar}
              completedEpics={completedEpicsShown}
              ondismissepic={onDismissEpic}
              onlandepic={onLandEpic}
              doneList={doneSessions.sessions}
              {doneSelectedId}
              ondoneselect={(id) => (doneSelectedId = id)}
              onrundownitem={selectRundownItem}
              onrundownepic={selectRundownEpic}
              {focusEpic}
              onackmigrationsepic={onAckEpicMigrations}
              onackmanualsteps={onAckManualSteps}
              onshowowed={onShowOwed}
              {owedFocusId}
              {owedFocusSnapshot}
              {owedFocusNonce}
              {owedFocusHandledNonce}
              onfocusresolved={onOwedFocusResolved}
              onbacklog={() => (showBacklog = true)}
              {upNextLaunch}
            />
            <!-- Drag-resize splitter (issue #1588): abs-positioned child of the
                 position:relative .herd-col so it anchors to the sidebar's right
                 edge (.grid is not positioned). Drag to resize, double-click to
                 reset — see startHerdResize. Always in the DOM but display:none
                 on touch (.inert) rather than {#if}-gated, to keep +page's
                 <template> complexity under the fallow Tier-1 bar. -->
            <div
              class="herd-splitter"
              class:inert={!herdResizable}
              class:dragging={herdResizing}
              role="separator"
              aria-orientation="vertical"
              aria-label={m.herd_resize_handle()}
              title={m.herd_resize_handle()}
              onpointerdown={startHerdResize}
            ></div>
          </div>
        {/if}
        {#if panelOnlyLens}
          <!-- Rundown + Owed lenses render their panel inside the rail (left); the main area
               shows a neutral pointer (panelMainHint) so the right pane never reads as empty. -->
          <div class="empty">{panelMainHint}</div>
        {:else if herdFilter === "done"}
          <!-- Done lens: read-only recap for the picked archived session -->
          {#if doneSelected}
            <DoneRecapPanel session={doneSelected} onbringback={(id) => onBringBack(id)} />
          {:else}
            <div class="empty">{m.herd_done_empty()}</div>
          {/if}
        {:else if store.sessions.length === 0}
          <BacklogView
            payload={backlog}
            mobile={false}
            {onissue}
            onquick={onquickissue}
            oninject={oninjectissue}
            {onpr}
            {onadopt}
            {onlaunchtrain}
            onaddclone={addRepoClone}
            onaddfork={addRepoFork}
            onaddnewproject={addRepoNewProject}
            selectPath={backlogSelectPath}
            epics={store.epics}
            {inTrainPrs}
            drain={store.drain}
            docAgentEnabled={settings?.docAgentEnabled ?? false}
            docAgentAct={settings?.docAgentAct ?? false}
            docAgentDone={store.docAgentDone}
          />
        {:else if selected}
          <Viewport
            bind:this={viewportRef}
            session={selected}
            touch={touch.current}
            git={store.git[selected.id]}
            activity={store.activity[selected.id]}
            previewPort={store.preview[selected.id] ?? null}
            claudeAlive={store.claudeAlive[selected.id]}
            previewMap={store.preview}
            previewHost={settings?.previewHost ?? null}
            previewServeFailed={store.previewServe[selected.id] === "failed"}
            {openPreviewTick}
            {renameRequest}
            buildQueue={store.buildQueues[selected.id] ?? null}
            onSeedBuildQueue={(q) => store.setBuildQueue(q)}
            queue={blockedEntries.map((e) => e.session.id)}
            switchOrder={store.sessions.map((s) => s.id)}
            onnavigate={(id) => selectUnit(id)}
            {consumeAutoFocusTerm}
            {onarchive}
            workingBlocked={store.workingBlocked}
            authUrl={selectedAuthUrl}
            onretry={() => (showRetry = true)}
            retryHaltedCount={haltedCount}
            {retryReady}
            onedit={openSteersEditor}
            drain={store.drain[selected.repoPath] ?? null}
            subagents={store.subagents}
          />
        {:else}
          <div class="empty">{m.main_no_unit_selected()}</div>
        {/if}
      </div>
    {/if}
  </main>

  <ActionBar
    onnew={() => (showNew = true)}
    onbacklog={store.sessions.length > 0 ? () => (showBacklog = true) : undefined}
    mobile={mobile.current}
    desktopOnly
  />
</div>

<AppOverlays
  {store}
  {settings}
  mobile={mobile.current}
  {showLearnings}
  {learningsRepo}
  onlearningsclose={() => {
    showLearnings = false;
    learningsRepo = null;
  }}
  {showUpdate}
  {deploy}
  onupdateconfirm={onUpdateConfirm}
  onupdateclose={closeUpdate}
  {showHerdrUpdate}
  {herdrUpdating}
  onherdrupdateconfirm={() => {
    herdrUpdating = true;
    store.herdrUpdateDone = null; // fresh run: clear any prior result
    store.herdrUpdateLog = [];
  }}
  onherdrupdateclose={() => {
    showHerdrUpdate = false;
    herdrUpdating = false;
    store.herdrUpdateDone = null;
  }}
  onherdrupdatejump={(id) => {
    showHerdrUpdate = false;
    herdrUpdating = false;
    store.herdrUpdateDone = null;
    selectUnit(id);
  }}
  {showCodexUpdate}
  {codexUpdating}
  oncodexupdateconfirm={() => {
    codexUpdating = true;
    store.codexUpdateDone = null; // fresh run: clear any prior result
    store.codexUpdateLog = [];
  }}
  oncodexupdateclose={() => {
    showCodexUpdate = false;
    codexUpdating = false;
    store.codexUpdateDone = null;
  }}
  {showPluginUpdates}
  onpluginupdatesclose={closePluginUpdates}
  onpluginupdated={onPluginUpdated}
  {showOnboarding}
  {onboardingBlocking}
  {diagnosticsLoadFailed}
  ononboardingretry={loadDiagnostics}
  ononboardingdismiss={() => {
    featureDiscovery.markSeen("onboarding");
    showOnboarding = false;
  }}
  ononboardingpicked={handleOnboardingPicked}
  {showWhatsNew}
  {whatsNewEntries}
  onwhatsnewdismiss={() => {
    featureDiscovery.lastSeenVersion = version;
    whatsNewDotOn = false;
  }}
  onwhatsnewclose={() => (showWhatsNew = false)}
  {showFableArrival}
  onfabletry={() => {
    featureDiscovery.markSeen(FABLE_FEATURE_ID);
    showFableArrival = false;
    composeModel = "fable";
    showNew = true;
  }}
  onfableclose={() => {
    featureDiscovery.markSeen(FABLE_FEATURE_ID);
    showFableArrival = false;
  }}
  {showNew}
  {onsubmit}
  relaunchOriginal={relaunchOriginalId !== null}
  editHeld={editHeldId !== null}
  {composeRepoPath}
  repoFilter={activeRepo}
  {composeBaseBranch}
  {composeIssue}
  {relaunchIssueNumber}
  {composeImages}
  {composePrompt}
  {composeModel}
  {composeEffort}
  {composeAgentProvider}
  {composePlanGate}
  {composeAutopilot}
  {composeSandbox}
  {composeResearch}
  {composeEpicAuthoring}
  usageLimits={store.usageLimits}
  holdLikely={composeHoldLikely}
  onnewclose={() => {
    showNew = false;
    resetCompose();
  }}
  onnewclone={() => {
    resetCompose();
    repoAddOrigin = "newtask";
    showNew = false;
    showClone = true;
  }}
  onnewfork={() => {
    resetCompose();
    repoAddOrigin = "newtask";
    showNew = false;
    showFork = true;
  }}
  onnewnewproject={() => {
    resetCompose();
    repoAddOrigin = "newtask";
    showNew = false;
    showNewProject = true;
  }}
  {showSettings}
  {settingsTab}
  {focusPluginId}
  {focusSteerId}
  onsettingsclose={() => {
    showSettings = false;
    focusPluginId = null;
    focusSteerId = null;
    loadSettings();
  }}
  onsettingsherdrupdate={() => {
    showSettings = false;
    showHerdrUpdate = true;
  }}
  onsettingscodexupdate={() => {
    showSettings = false;
    openCodexUpdate();
  }}
  onsettingspluginupdates={() => {
    showSettings = false;
    openPluginUpdates();
  }}
  onsettingswhatsnew={() => {
    showSettings = false;
    showWhatsNew = true;
  }}
  {showUsage}
  onusageclose={() => (showUsage = false)}
  {showClone}
  oncloneclose={() => {
    showClone = false;
    repoAddOrigin = null;
  }}
  onclonedone={(entry) => {
    showClone = false;
    if (repoAddOrigin === "backlog") {
      finishBacklogAdd(entry.path);
    } else {
      composeRepoPath = entry.path;
      repoAddOrigin = null;
      showNew = true;
    }
  }}
  {showFork}
  onforkclose={() => {
    showFork = false;
    repoAddOrigin = null;
  }}
  onforkdone={(entry) => {
    showFork = false;
    if (repoAddOrigin === "backlog") {
      finishBacklogAdd(entry.path);
    } else {
      composeRepoPath = entry.path;
      repoAddOrigin = null;
      showNew = true;
    }
  }}
  {showNewProject}
  onnewprojectclose={() => {
    showNewProject = false;
    repoAddOrigin = null;
  }}
  onnewprojectdone={onNewProjectDone}
  {showBroadcast}
  onbroadcastclose={() => (showBroadcast = false)}
  {showCommandBar}
  {commandBarCommands}
  commandBarInitialFilter={demoCommandFilter}
  oncommandbarclose={() => {
    showCommandBar = false;
    demoCommandFilter = "";
  }}
  oncommandbarsession={(id) => {
    showCommandBar = false;
    demoCommandFilter = "";
    jumpToSession(id);
  }}
  oncommandbarrepo={(path) => {
    showCommandBar = false;
    demoCommandFilter = "";
    showBacklog = true;
    // Payload-before-path ordering per finishBacklogAdd: BacklogView's select effect
    // fires once per value, so the repo must be in the payload when the path is set.
    getBacklog()
      .then((p) => {
        backlog = p;
        backlogSelectPath = path;
      })
      .catch(() => {});
  }}
  oncommandbarfilterrepo={(path) => {
    // Secondary repo action: scope the herd to this repo alone (same state the RepoSwitcher
    // chips drive). Set the single-repo set DIRECTLY (not via nextRepoFilter, whose
    // clear-when-sole branch would toggle it off if the bar re-scopes the already-selected
    // repo). Close the bar + backlog so the filtered session list is visible; the re-target
    // effect then jumps selection onto a session in the repo. Only fired for repos with a
    // live session, so the prune effect won't immediately drop it.
    showCommandBar = false;
    showBacklog = false;
    replaceRepoFilter([path]);
  }}
  oncommandbarlens={(lens) => {
    showCommandBar = false;
    demoCommandFilter = "";
    showBacklog = false;
    herdFilter = lens;
  }}
  {showRetry}
  onretryclose={() => (showRetry = false)}
  {showEpicDiagnose}
  epicDiagnoseInitialRepo={activeRepo ?? undefined}
  onepicdiagnoseclose={() => (showEpicDiagnose = false)}
  {clearMergedSessions}
  {clearMergedLeftovers}
  onclearmergedclose={() => (clearMergedSessions = null)}
  onclearmergedconfirm={confirmClearMerged}
  {showBacklog}
  {backlog}
  {epicTarget}
  {inTrainPrs}
  {onissue}
  onquick={onquickissue}
  oninject={oninjectissue}
  {onpr}
  {onadopt}
  {onlaunchtrain}
  onaddclone={addRepoClone}
  onaddfork={addRepoFork}
  onaddnewproject={addRepoNewProject}
  {backlogSelectPath}
  onbacklogclose={() => {
    showBacklog = false;
    backlogSelectPath = null;
  }}
  {pendingTrain}
  ontrainclose={() => (pendingTrain = null)}
  ontrainconfirm={confirmTrain}
  onstarresolve={(s) => (store.starPrompt = s)}
/>

<TelemetryConsent
  show={showTelemetryConsentModal}
  onresolved={() => {
    showTelemetryConsent = false;
    loadSettings();
  }}
/>

<FeedbackDialog />

<ExperimentPicker
  bind:picker
  fableAvailable={pickerFableAvailable}
  initialProvider={pickerProvider}
  onselect={selectUnit}
/>

<Toasts aboveActionBar={mobileActionBarPresent} />

<style>
  /* Visually-hidden utility, scoped here explicitly rather than leaning on
     Tailwind's content-scanned global `.sr-only` (which other components in this
     repo also hand-roll). Canonical clip recipe — see GitRail/UnitRow. */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .shell {
    /* No max-width cap: the desktop layout fills the viewport so widening the
       browser scales the terminal column (1fr) instead of leaving dead space at
       the sides. The session picker stays compact; the terminal absorbs the gain. */
    width: 100%;
    /* max(base, inset): on devices/browsers without safe areas env() is 0 so the
       base padding wins (no regression); in an iOS standalone PWA the Dynamic Island
       (top) and home indicator (bottom) insets win. Everything flows inside .shell,
       so insetting it alone clears both edges + the landscape sides. */
    padding: max(22px, env(safe-area-inset-top)) max(22px, env(safe-area-inset-right))
      max(22px, env(safe-area-inset-bottom)) max(22px, env(safe-area-inset-left));
    display: flex;
    flex-direction: column;
    gap: 14px;
    /* dvh, not vh: on mobile/foldable browsers vh includes the area behind the
       browser chrome, pushing the bottom ActionBar (+ New Task) off-screen */
    height: 100dvh;
    box-sizing: border-box;
  }
  /* Demo-only: the marketing ribbon (demo/DemoRibbon.svelte) is fixed to the
     viewport bottom and would overlay the desktop bottom bar (New Task etc.).
     Reserve its height so the shell ends above it. `--demo-ribbon-h` is set ONLY
     by the demo ribbon; outside the demo it is unset, so this resolves to a plain
     `calc(100dvh - 0px)` = 100dvh and the real Shepherd layout is unchanged. Scoped
     to `:not(.mobile)` (desktop only): in mobile mode the ActionBar is
     `position: fixed`, so reserving shell height can't clear it — the ribbon lifts
     itself above the fixed bar instead. Both use the SAME boundary as this `.mobile`
     class (`(max-width: 768px), (max-height: 600px)` — the ribbon's media query
     matches it verbatim), so they're exactly complementary with no uncovered band. */
  .shell:not(.mobile) {
    height: calc(100dvh - var(--demo-ribbon-h, 0px));
  }
  .grid {
    display: grid;
    /* session picker stays compact; terminal absorbs all extra width */
    grid-template-columns: minmax(300px, 360px) 1fr;
    gap: 14px;
    flex: 1;
    min-height: 0;
  }
  /* Operator-chosen sidebar width (issue #1588, mouse-desktop only). Set only
     when `!touch.current && herdWidth.width !== null`, so it never coexists with
     the touch-only .compact/.collapsed rules — specificity (0,2,0) beats base
     .grid. --herd-w is a clamped px value from the splitter drag. */
  .grid.resized {
    grid-template-columns: var(--herd-w) 1fr;
  }
  /* During an active drag: kill text selection + force the resize cursor so
     dragging over the terminal doesn't select its content. */
  .grid.resizing {
    user-select: none;
    cursor: col-resize;
  }
  /* Wrapper around <Herd> that hosts the absolutely-positioned splitter. Single
     implicit grid cell: the Herd .panel stretches to fill both axes exactly as
     it did as a direct grid item. */
  .herd-col {
    position: relative;
    display: grid;
    min-height: 0;
    min-width: 0;
  }
  /* Splitter: ~12px hit strip centred on the 14px grid gap at the sidebar's
     right edge (right:0 of .herd-col is the sidebar edge; gap midpoint is +7px).
     A 2px hairline (::after) is invisible at rest and brightens on hover/drag. */
  .herd-splitter {
    position: absolute;
    top: 0;
    bottom: 0;
    right: -13px;
    width: 12px;
    cursor: col-resize;
    z-index: 5;
    touch-action: none;
  }
  /* Touch-wide layouts: keep the splitter in the DOM (avoids an extra template
     branch) but fully inert — no hit area, no cursor, no visual. */
  .herd-splitter.inert {
    display: none;
  }
  .herd-splitter::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 2px;
    transform: translateX(-50%);
    background: transparent;
    transition: background 0.12s ease;
  }
  .herd-splitter:hover::after,
  .herd-splitter.dragging::after {
    background: var(--color-line-bright);
  }
  .herd-splitter:focus-visible {
    outline: none;
  }
  .herd-splitter:focus-visible::after {
    background: var(--color-line-bright);
  }
  /* touch devices on the desktop layout (e.g. unfolded foldables): the picker
     would otherwise eat too much of a narrow-ish wide screen */
  .grid.compact {
    grid-template-columns: minmax(244px, 288px) 1fr;
    gap: 10px;
  }
  /* Collapsed herd on touch-primary wide devices: the sidebar is replaced by a
     slim reopen tab and the terminal reclaims the width. Authored at
     .grid.compact.collapsed specificity (0,3,0) so it outranks .grid.compact by
     specificity, not source order — collapse on a touch device sets both classes. */
  .grid.compact.collapsed {
    grid-template-columns: 44px 1fr;
    gap: 0;
  }
  .reopen-tab {
    height: 100%;
    width: 100%;
    align-self: stretch;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    color: var(--color-faint);
    font-size: var(--fs-lg);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    box-sizing: border-box;
    transition: color 0.12s ease;
  }
  .reopen-tab:hover {
    color: var(--color-ink);
  }
  .reopen-tab:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .empty {
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .col {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* Done-lens mobile back affordance: a quiet text trigger above the recap panel. */
  .done-back {
    align-self: flex-start;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 4px 2px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    transition: color 0.12s ease;
  }
  .done-back:hover {
    color: var(--color-ink);
  }
  /* Primary landmark wrapping the herd/viewport content. Transparent to the
     flex layout: it fills the shell column and lets its own child (.col /
     .grid) keep flexing exactly as before the <main> wrapper.
     gap:inherit takes .shell's computed gap (14px desktop, 10px mobile) so the
     mobile list column + bottom ActionBar keep the spacing they had as direct
     shell children; no-op where the region holds a single child. */
  .main-region {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: inherit;
  }

  .shell.mobile {
    padding: max(var(--mobile-shell-pad), env(safe-area-inset-top))
      max(var(--mobile-shell-pad), env(safe-area-inset-right))
      max(var(--mobile-shell-pad), env(safe-area-inset-bottom))
      max(var(--mobile-shell-pad), env(safe-area-inset-left));
    gap: 10px;
  }

  /* Short viewports (foldable split-screen landscape, phone landscape): reclaim
     vertical room for the cramped pane — tighten the inter-section gap and the
     top/bottom breathing room (safe-area insets still win where present, e.g. a
     notch). Horizontal padding is unchanged. The detail screen (.shell.mobile
     without .list) is the main beneficiary; the .list rule below keeps its own
     padding-top:0 / ActionBar padding-bottom by higher specificity. */
  @media (max-height: 600px) {
    .shell.mobile {
      gap: 6px;
      padding-top: max(6px, env(safe-area-inset-top));
      padding-bottom: max(6px, env(safe-area-inset-bottom));
    }
  }

  .chrome {
    display: flex;
    flex-direction: column;
    gap: inherit;
  }

  /* Mobile list screen becomes a document-scroll app-shell: the shell grows with
     content (min-height floor = one viewport), the middle flows at natural height
     so the whole page scrolls, and the chrome/ActionBar are pinned. This keeps the
     ActionBar reachable even if 100dvh is mis-measured taller than the real window. */
  .shell.mobile.list {
    height: auto;
    min-height: 100dvh;
    /* the pinned chrome owns the top safe-area inset (see below), so drop the
       shell's own top padding — otherwise a stuck header would inset twice
       (notch + shell). The bottom reserves room for the fixed ActionBar
       (--mobile-actionbar-h + its own safe-area inset, both shared with the bar
       in app.css) so the last list row never hides behind it. */
    padding-top: 0;
    padding-bottom: calc(
      var(--mobile-actionbar-h) + max(var(--mobile-actionbar-pad), env(safe-area-inset-bottom))
    );
  }
  .shell.mobile.list .chrome {
    position: sticky;
    top: 0;
    z-index: 5;
    /* opaque base surface so list content scrolling underneath doesn't show
       through the gaps in the chrome stack (TopBar → RepoSwitcher → QueueStrip) */
    background: var(--color-bg);
    /* own the top safe-area inset (mirrors the ActionBar's padding-bottom): keeps
       the TopBar clear of the notch / Dynamic Island while the chrome is stuck at
       top:0, with the opaque background filling the inset area. max(…) keeps
       the prior --mobile-shell-pad breathing room on non-notched devices. */
    padding-top: max(var(--mobile-shell-pad), env(safe-area-inset-top));
    /* scroll-compression: slide the chrome out above the viewport on scroll-down,
       slide it back on scroll-up / at top. translateY(-100%) covers the full
       element box including safe-area padding — no second inset needed. */
    will-change: transform;
  }
  @media (prefers-reduced-motion: no-preference) {
    .shell.mobile.list .chrome {
      transition: transform 0.2s ease;
    }
  }
  .shell.mobile.list .chrome.chrome-hidden {
    transform: translateY(-100%);
  }
  .shell.mobile.list .main-region,
  .shell.mobile.list .col {
    /* min-height:auto (not 0): flex children still grow to fill the viewport when
       the list is short, but are no longer capped — tall content overflows and the
       document scrolls instead of trapping it in an inner scroller */
    min-height: auto;
  }
</style>
