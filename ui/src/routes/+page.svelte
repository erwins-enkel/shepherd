<script lang="ts">
  import { onMount, tick } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { HerdStore } from "$lib/store.svelte";
  import {
    listSessions,
    createSession,
    startMergeTrain,
    archiveSession,
    relaunchSession,
    ApiError,
    getUsageLimits,
    replySession,
    dismissStall,
    getUpdate,
    getUpdateLog,
    getHerdrUpdate,
    getStarPrompt,
    gitStates,
    activityStates,
    claudeAliveStates,
    workingBlockedStates,
    previewStates,
    getBacklog,
    getSettings,
    listBranches,
    approveLearning,
    dismissLearning,
    distillRepo,
    promoteLearning,
    getMergedClearable,
    clearMerged,
    getDrain,
    getAutoMerge,
    halt as apiHalt,
  } from "$lib/api";
  import type {
    DeployState,
    BacklogPayload,
    Issue,
    IssueRef,
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
  import { reviews, planGates } from "$lib/reviews.svelte";
  import { learnings } from "$lib/learnings.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import TriageDrawer from "$lib/components/TriageDrawer.svelte";
  import LearningsDrawer from "$lib/components/LearningsDrawer.svelte";
  import { basename } from "$lib/components/learnings-drawer";
  import Herd from "$lib/components/Herd.svelte";
  import {
    railOrder,
    cycleId,
    nthId,
    nextNeedsYou,
    altComboKey,
  } from "$lib/components/herd-keynav";
  import type { HerdFilter } from "$lib/components/herd-partition";
  import {
    collectReadyPrs,
    mergeTrainCreateInput,
    pickTrainRepo,
    sessionsForPrNumbers,
  } from "$lib/components/merge-train";
  import Viewport from "$lib/components/Viewport.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import CloneRepo from "$lib/components/CloneRepo.svelte";
  import NewProject from "$lib/components/NewProject.svelte";
  import type { KickoffChoice } from "$lib/components/NewProject.svelte";
  import BroadcastDialog from "$lib/components/BroadcastDialog.svelte";
  import ClearMergedDialog from "$lib/components/ClearMergedDialog.svelte";
  import ActionBar from "$lib/components/ActionBar.svelte";
  import HerdGrid from "$lib/components/HerdGrid.svelte";
  import QueueStrip from "$lib/components/QueueStrip.svelte";
  import RepoSwitcher from "$lib/components/RepoSwitcher.svelte";
  import { repoChipRows, shouldClearRepoFilter } from "$lib/components/queue-strip";
  import BacklogView from "$lib/components/BacklogView.svelte";
  import BacklogOverlay from "$lib/components/BacklogOverlay.svelte";
  import UpdateModal from "$lib/components/UpdateModal.svelte";
  import HerdrUpdateModal from "$lib/components/HerdrUpdateModal.svelte";
  import StarPrompt from "$lib/components/StarPrompt.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import { registerSW, onSelectSession } from "$lib/push";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import type { FeatureAnnouncement } from "$lib/feature-announcements";
  import { featureAnnouncements, FABLE_FEATURE_ID } from "$lib/feature-announcements";
  import { featureDiscovery } from "$lib/featureDiscovery.svelte";
  import { computeNewEntries } from "$lib/feature-gate";
  import { version } from "$lib/build-info";
  import WhatsNew from "$lib/components/WhatsNew.svelte";
  import FableArrival from "$lib/components/FableArrival.svelte";
  import { sidebarCollapse, sidebarShouldCollapse } from "$lib/sidebar-collapse.svelte";

  const store = new HerdStore();
  let selectedId = $state<string | null>(null);
  // Monotonic tick bumped when a row's Preview badge is clicked; passed to the
  // Viewport so it switches to its Preview tab. A counter (not a boolean) so a
  // repeat click on the already-selected session still re-triggers the open.
  let openPreviewTick = $state(0);
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
  // A row asked to open its live preview: select the session, then bump the tick
  // so the Viewport flips to its Preview tab (after its own unit-switch reset).
  function openPreview(id: string) {
    selectUnit(id);
    openPreviewTick++;
  }
  let showNew = $state(false);
  let showSettings = $state(false);
  let settingsTab = $state<"workspace" | "session" | "device">("workspace");
  let showClone = $state(false);
  let showNewProject = $state(false);
  let showBroadcast = $state(false);
  // "clear all merged" confirm modal: the merged sessions to clear + their total
  // leftover subprocess count (both fetched server-side when the modal opens).
  let clearMergedSessions = $state<Session[] | null>(null);
  let clearMergedLeftovers = $state(0);
  let showTriage = $state(false);
  let showLearnings = $state(false);
  // When the learnings drawer is opened from a repo's chip (its ✦ in the RepoSwitcher
  // rail), this carries that repoPath so the drawer scrolls to the matching section;
  // null = opened globally.
  let learningsRepo = $state<string | null>(null);
  // Herd repo filter (full repo path), toggled from a RepoSwitcher chip or from a
  // card's inline repo emoji; null = all repos. Only narrows the herd list views —
  // selection and global counts stay whole.
  let repoFilter = $state<string | null>(null);
  // Chips for the repo switcher: one per repo with a live session, computed from the
  // unfiltered herd (selection/global counts stay whole). Single source — passed to the switcher.
  const repoChips = $derived(
    repoChipRows(store.sessions, store.drain, learnings.items, learnings.injectable),
  );
  // Clear the filter only when its repo has no live session left (no chip) —
  // a filter on a vanished repo would strand an empty view.
  $effect(() => {
    if (shouldClearRepoFilter(repoFilter, repoChips)) repoFilter = null;
  });
  // Session-status filter toggled from the TopBar tallies; null = all statuses.
  // Independent of the repo filter — both compose into herdSessions below. Sticky
  // by design: statuses fluctuate (running ↔ idle), so an auto-clear on count-zero
  // would pop the filter off mid-observation; the filtered empty state + chip in
  // the herd head are the way out instead.
  let statusFilter = $state<"running" | "idle" | "blocked" | null>(null);
  const herdSessions = $derived.by(() => {
    const byRepo = repoFilter
      ? store.sessions.filter((s) => s.repoPath === repoFilter)
      : store.sessions;
    // displayStatus, not raw status: a working-while-blocked session belongs under
    // the "running" filter (the tallies count it there), never under "blocked".
    return statusFilter
      ? byRepo.filter((s) => displayStatus(s, store.workingBlocked) === statusFilter)
      : byRepo;
  });
  // basename of the active filter for the herd's empty-state copy; null when unfiltered
  const repoFilterName = $derived(repoFilter ? basename(repoFilter) : null);
  let showUpdate = $state(false);
  // live state of a launched deploy → modal tails its log + surfaces failures
  let deploy = $state<DeployState | null>(null);
  let deployPollTimer: ReturnType<typeof setTimeout> | null = null;
  let showHerdrUpdate = $state(false);
  // set once the operator confirms the herdr update; herdr+shepherd restart drops
  // the WS and the store auto-reconnects, refreshing state once the new build is live.
  let herdrUpdating = $state(false);
  let showWhatsNew = $state(false);
  let whatsNewEntries = $state<FeatureAnnouncement[]>([]);
  let whatsNewDotOn = $state(false);
  // One-time Fable 5 launch celebration (gated separately from the What's-New
  // drawer via the persisted seen-set, so it fires exactly once per upgrade).
  let showFableArrival = $state(false);
  const blockedEntries = $derived(sortBlocked(store.sessions, store.blocks));
  // Once every "needs you" item is handled the drawer has nothing left to show —
  // close it so it slides out instead of lingering on an empty state.
  $effect(() => {
    if (showTriage && blockedEntries.length === 0) showTriage = false;
  });
  $effect(() => {
    // Close only when both the proposed list and the injected view are empty —
    // a repo can have injected rules to curate with zero outstanding proposals.
    if (showLearnings && learnings.items.length === 0 && learnings.injectable.length === 0)
      showLearnings = false;
  });
  let viewMode = $state<"focus" | "all">("focus");
  let nowMs = $state(Date.now());
  let composeRepoPath = $state<string | null>(null);
  let composeIssue = $state<Issue | null>(null);
  // Seed prompt for the New Task dialog (PR review path); null = no seed.
  let composePrompt = $state<string | null>(null);
  // Seed model for the New Task dialog (Fable celebration "Try it" path); null = picker default.
  let composeModel = $state<string | null>(null);
  // Relaunch-elsewhere: when set, the New Task dialog runs in relaunch mode and its
  // submit routes to relaunchSession(originalId, …) instead of createSession.
  let relaunchOriginalId = $state<string | null>(null);
  // Seed base branch for the New Task dialog (preserved across a relaunch); null = repo default.
  let composeBaseBranch = $state<string | null>(null);
  // Relaunch source issue number (null = none); drives the relaunch note's cross-repo issue-drop line.
  let relaunchIssueNumber = $state<number | null>(null);
  let backlog = $state<BacklogPayload | null>(null);
  // loaded once on mount (previewHost etc.); re-read on settings close.
  let settings = $state<Settings_ | null>(null);
  // First-run nudge: backlog quick-launch buttons are invisible until at least one
  // issue-scoped steer exists. The steers store updates live on editor save, so a
  // just-added action dismisses the hint without a reload.
  const issueActionsUnset = $derived(steers.loaded && !steers.list.some((s) => s.onIssues));

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);

  function loadSettings() {
    getSettings()
      .then((s) => (settings = s))
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
  function resync() {
    listSessions()
      .then((list) => store.setAll(list))
      .catch(() => {});
    getUsageLimits()
      .then((l) => store.setUsageLimits(l))
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
    previewStates()
      .then((m) => {
        store.setPreview(flattenPreview(m));
        store.setPreviewServe(extractServe(m));
      })
      .catch(() => {});
    getBacklog()
      .then((p) => (backlog = p))
      .catch(() => {});
    // Reconcile critic + plan-gate verdicts and their reviewing latches from the
    // server snapshot (both self-handle errors). load() re-fetches the /inflight
    // ids, so a `reviewing=false` missed across a disconnect/restart is corrected.
    reviews.load();
    planGates.load();
  }

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
    const baseBranch = br?.current ?? br?.branches[0] ?? "main";
    try {
      const s = await createSession({
        repoPath,
        baseBranch,
        prompt: cmd,
        model: null,
        issueRef: {
          number: issue.number,
          url: issue.url,
          title: issue.title,
          body: issue.body,
        },
      });
      selectedId = s.id;
      showBacklog = false;
      if (mobile.current) mobileScreen = "detail";
    } catch {
      // spawn failed → hand off to the dialog so the operator can retry manually
      onissue(repoPath, issue);
    }
  }

  // Merge-train shortcut (Ready-to-merge group header): spawn a new session that
  // works through the PRs of every ready-to-merge session, suggesting a merge
  // order. A merge train is per-repo, so when ready PRs span repos we scope to
  // the repo with the most and surface a fail-loud notice for the rest rather
  // than silently folding them in. Mirrors onquickissue for branch + create.
  async function onmergetrain() {
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
    const br = await listBranches(repoPath).catch(() => null);
    const baseBranch = br?.current ?? br?.branches[0] ?? "main";
    try {
      const s = await createSession(mergeTrainCreateInput(repoPath, baseBranch, prs));
      selectedId = s.id;
      // Mark this repo's ready PR-sessions as "merging" so the list shows them
      // in-flight. Derived from the same scoped `prs` array the train works
      // through — single source of truth, no separate filter needed.
      // Fire-and-forget + fail-soft: a marking error must not abort the launch —
      // the train (session s) is already running.
      startMergeTrain(
        prs.map((p) => p.sessionId),
        s.id,
      ).catch(() => toasts.info(m.toast_merge_train_mark_failed()));
      showBacklog = false;
      if (mobile.current) mobileScreen = "detail";
      if (otherRepoCount > 0)
        toasts.info(m.toast_merge_train_other_repos({ count: otherRepoCount }));
    } catch {
      toasts.info(m.toast_merge_train_failed());
    }
  }

  /** Launch a merge train scoped to a hand-picked set of PRs from the backlog
   *  PRs panel. Unlike onmergetrain (which auto-collects ready sessions), the
   *  operator chose these PRs directly, so the kickoff prompt uses the
   *  hand-picked framing. Matching ready-to-merge sessions are marked "merging";
   *  backlog-only PRs (no session) still ride along in the prompt. */
  async function onlaunchtrain(repoPath: string, prs: PullRequest[]) {
    if (prs.length < 2) return; // UI gates at >=2; defensive guard
    const br = await listBranches(repoPath).catch(() => null);
    const baseBranch = br?.current ?? br?.branches[0] ?? "main";
    try {
      const s = await createSession(mergeTrainCreateInput(repoPath, baseBranch, prs, true));
      selectedId = s.id;
      // Mark any ready-to-merge sessions whose open PR is in this selection as
      // "merging" (same coupling as onmergetrain). Composed review predicate
      // matches onmergetrain. Fire-and-forget + fail-soft; skip when none match.
      const ids = sessionsForPrNumbers(
        repoPath,
        prs.map((p) => p.number),
        store.sessions,
        store.git,
        (id) => reviews.isReviewing(id) || planGates.isReviewing(id),
      );
      if (ids.length > 0)
        startMergeTrain(ids, s.id).catch(() => toasts.info(m.toast_merge_train_mark_failed()));
      showBacklog = false;
      if (mobile.current) mobileScreen = "detail";
    } catch {
      toasts.info(m.toast_merge_train_failed());
    }
  }

  const mobile = new MediaQuery("max-width: 768px");
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

  let mobileScreen = $state<"list" | "detail">("list");
  let showBacklog = $state(false);

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

  function selectUnit(id: string, focusTerm = true) {
    // only a *real* switch remounts the terminal and consumes the intent; a
    // self-selection (e.g. plain j wrapping back to the only visible session)
    // must not park a stale `false` that would suppress a later
    // resumeEpoch-driven auto-focus.
    if (id !== selectedId) keynavFocusIntent = focusTerm;
    selectedId = id;
    if (mobile.current) mobileScreen = "detail";
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

  // The herd rail's visible session order (same shown set + partition + group
  // order Herd.svelte renders) — the j/k/1-9 navigation space. Computed on demand
  // at keypress time, not $derived: re-partitioning on every nowMs tick would be
  // wasted work for a value only keystrokes read.
  function railIds(): string[] {
    return railOrder(
      herdSessions,
      store.git,
      (id) => reviews.isReviewing(id) || planGates.isReviewing(id),
      nowMs,
      // a page-level status filter short-circuits the rail's all/ready filter in
      // Herd's shown set (one filter at a time) — mirror that here so keynav walks
      // exactly the visible rows, never a "ready" subset of the status-filtered list
      statusFilter != null ? "all" : herdFilter,
      store.workingBlocked,
    );
  }

  // Keyboard-driven selection: route through the same selectUnit a rail click
  // uses, then keep the now-selected row visible in the rail's scroll area.
  // focusTerm = whether the remounted terminal should grab the keyboard.
  function keyNavSelect(id: string | null, focusTerm = true) {
    if (!id) return;
    selectUnit(id, focusTerm);
    document
      .querySelector(`[data-unit-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  // Herd keyboard navigation (the rail-selection half of onShortcut):
  // j/k (vim) + arrows cycle selection through the rail's visible order
  // (wrapping at the ends; preventDefault keeps arrows from also scrolling),
  // g jumps to the next session that needs you (cycling among blocked ones,
  // silently a no-op when nothing is blocked), 1-9 select the Nth visible
  // session in rail order. Returns true when the key belonged to keynav.
  // focusTerm follows the keystroke's origin: plain keys pass false so focus
  // stays out of the terminal and the next plain key still chains; Alt combos
  // pass true only when fired from inside the terminal (focus follows origin).
  function handleHerdKeyNav(key: string, e: KeyboardEvent, focusTerm: boolean): boolean {
    switch (key) {
      case "j":
      case "arrowdown":
        e.preventDefault();
        keyNavSelect(cycleId(railIds(), selectedId, 1), focusTerm);
        return true;
      case "k":
      case "arrowup":
        e.preventDefault();
        keyNavSelect(cycleId(railIds(), selectedId, -1), focusTerm);
        return true;
      case "g":
        e.preventDefault();
        keyNavSelect(
          nextNeedsYou(
            blockedEntries.map((entry) => entry.session.id),
            selectedId,
          ),
          focusTerm,
        );
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
  function anyOverlayOpen(): boolean {
    return (
      showNew ||
      showSettings ||
      showBacklog ||
      showBroadcast ||
      showTriage ||
      showUpdate ||
      showHerdrUpdate ||
      showWhatsNew
    );
  }

  // The Alt tier of onShortcut: Alt+J/K/G/arrows/1-9 are the work-everywhere
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
    handleHerdKeyNav(mapped, e, fromTerminal);
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
    if (handleAltCombo(e)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) return;
    const key = e.key.toLowerCase();
    switch (key) {
      case "n":
        e.preventDefault();
        showNew = true;
        break;
      case "b":
        // mirror the ActionBar gate: backlog only exists once there are sessions
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
  // header "needs you" jump and tells the operator how many remain.
  const otherNeedsYou = $derived(blockedEntries.filter((e) => e.session.id !== selectedId));

  // Jump to the next waiting session: walk blockedEntries (oldest-first, same set
  // as the NEEDS YOU badge) starting after the current one, wrapping around.
  // Same pure helper the "g" shortcut uses, so button and key can't drift.
  function jumpNextNeedsYou() {
    keyNavSelect(
      nextNeedsYou(
        blockedEntries.map((entry) => entry.session.id),
        selectedId,
      ),
    );
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
    const disposeSelect = onSelectSession((id) => selectUnit(id));
    listSessions()
      .then((list) => {
        store.setAll(list);
        if (deepLink && list.some((s) => s.id === deepLink)) selectedId = deepLink;
        else if (!selectedId && list[0]) selectedId = list[0].id;
      })
      .catch(() => {});
    getUsageLimits()
      .then((l) => store.setUsageLimits(l))
      .catch(() => {});
    getUpdate()
      .then((u) => store.setUpdate(u))
      .catch(() => {});
    getHerdrUpdate()
      .then((u) => (store.herdrUpdate = u))
      .catch(() => {});
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
    steers.load();
    projectIcons.load();
    reviews.load();
    planGates.load();
    learnings.load();
    loadSettings();
    // Feature-discovery gate — synchronous, independent of loadSettings().
    // hydrate() reads localStorage; version + featureAnnouncements are compile-time constants.
    featureDiscovery.hydrate();
    {
      const lastSeen = featureDiscovery.lastSeenVersion;
      if (lastSeen === null) {
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
              showFableArrival = true;
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
  $effect(() => {
    if (!hasSessions) return;
    nowMs = Date.now(); // refresh on the empty→non-empty flip so the first frame isn't up to 1s stale
    const t = setInterval(() => (nowMs = Date.now()), 1000);
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
    composeBaseBranch = null;
    relaunchOriginalId = null;
    relaunchIssueNumber = null;
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
      images: string[];
      planGateEnabled: boolean;
    },
  ) {
    let result: { session: Session; archived: boolean };
    try {
      result = await relaunchSession(id, {
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        prompt: input.prompt,
        model: input.model,
        planGateEnabled: input.planGateEnabled,
        images: input.images,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "in_progress")
        throw new Error(m.relaunch_in_progress(), { cause: e });
      if (e instanceof ApiError && e.code === "issue_unresolved")
        throw new Error(m.relaunch_issue_unresolved(), { cause: e });
      throw e instanceof Error ? e : new Error(m.relaunch_failed(), { cause: e });
    }
    selectedId = result.session.id;
    showNew = false;
    resetCompose();
    if (result.archived) toasts.info(m.relaunch_done({ desig: result.session.desig }));
    else
      // Same persistent + assertive failure toast onrelaunch uses (deduped per id).
      toasts.info(m.relaunch_archive_failed(), {
        duration: null,
        alert: true,
        key: `relaunch-fail:${id}`,
      });
  }

  async function onsubmit(input: {
    repoPath: string;
    baseBranch: string;
    prompt: string;
    model: string | null;
    images: string[];
    issueRef?: IssueRef;
    planGateEnabled: boolean;
    sandboxProfile?: SandboxProfile;
  }) {
    // Relaunch-elsewhere path branches off to submitRelaunch; otherwise the New Task create.
    if (relaunchOriginalId !== null) return submitRelaunch(relaunchOriginalId, input);
    const s = await createSession(input);
    selectedId = s.id;
    showNew = false;
    resetCompose();
  }

  // Relaunch elsewhere: open the New Task composer pre-filled from this session so the
  // operator can pick a different repo / base branch / prompt before submitting. The
  // submit routes through onsubmit's relaunch branch (relaunchOriginalId set).
  function onrelaunchElsewhere(id: string) {
    const s = store.sessions.find((x) => x.id === id);
    if (!s) return;
    composePrompt = s.prompt;
    composeRepoPath = s.repoPath;
    composeBaseBranch = s.baseBranch;
    // null model = "claude default": map to the literal "default" so the composer's
    // model select shows Default and submits null back (preserving the original's model
    // exactly). `?? undefined` would wrongly fall back to the operator default.
    composeModel = s.model ?? "default";
    composeIssue = null;
    relaunchIssueNumber = s.issueNumber;
    relaunchOriginalId = id;
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
      // Persistent + assertive, deduped per id under a relaunch-fail namespace: a
      // failure toast must not vanish (unlike the transient success info), and repeated
      // failures to one card collapse into a single toast rather than stacking.
      toasts.info(text, { duration: null, alert: true, key: `relaunch-fail:${id}` });
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
        duration: null, // stay until the operator retries/closes — a failed fleet-halt must not vanish
        key: "halt-done",
        action: { label: m.common_retry(), run: () => haltHerd() },
      });
    });
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
        action: { label: m.common_retry(), run: () => void runClearMerged(ids) },
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
  <!-- On a phone in the terminal-focus screen the top bar is subsumed by the
       viewport's merged header (repo · session + back + status tint), so it's
       hidden there; settings + global chrome stay on the herd overview. -->
  {#if !(mobile.current && mobileScreen === "detail")}
    <header class="chrome">
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
        onhalt={haltHerd}
        needsYou={blockedEntries.length}
        ontriage={() => (showTriage = true)}
        update={store.update}
        onupdate={() => (showUpdate = true)}
        herdrUpdate={store.herdrUpdate}
        onherdrupdate={() => (showHerdrUpdate = true)}
        whatsNew={whatsNewDotOn}
        onwhatsnew={() => (showWhatsNew = true)}
        {statusFilter}
        onstatusfilter={(s) => (statusFilter = s)}
        workingBlocked={store.workingBlocked}
      />
      <RepoSwitcher
        chips={repoChips}
        {repoFilter}
        onrepofilter={(repoPath) => (repoFilter = repoPath)}
        onlearnings={(repoPath) => {
          learningsRepo = repoPath;
          showLearnings = true;
        }}
      />
      <QueueStrip autoMerge={store.autoMerge} />
    </header>
  {/if}

  <main id="main-content" class="main-region">
    {#if mobile.current}
      {#if mobileScreen === "list"}
        <div class="col">
          <Herd
            sessions={herdSessions}
            filteredRepo={repoFilterName}
            {repoFilter}
            onrepofilter={(repoPath) => (repoFilter = repoPath)}
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
            ondecommission={onarchive}
            {onrelaunch}
            {onrelaunchElsewhere}
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
          />
          {#if store.sessions.length === 0}
            <BacklogView
              payload={backlog}
              mobile={true}
              {onissue}
              onquick={onquickissue}
              {onpr}
              {onadopt}
              {onlaunchtrain}
              flow={true}
              epics={store.epics}
            />
          {/if}
        </div>
        <ActionBar
          onnew={() => (showNew = true)}
          onbacklog={store.sessions.length > 0 ? () => (showBacklog = true) : undefined}
          mobile={mobile.current}
        />
      {:else if selected}
        <div class="col">
          <Viewport
            session={selected}
            mobile={mobile.current}
            connected={store.connected}
            limits={store.usageLimits}
            git={store.git[selected.id]}
            previewPort={store.preview[selected.id] ?? null}
            claudeAlive={store.claudeAlive[selected.id]}
            previewMap={store.preview}
            previewHost={settings?.previewHost ?? null}
            previewServeFailed={store.previewServe[selected.id] === "failed"}
            {openPreviewTick}
            buildQueue={store.buildQueues[selected.id] ?? null}
            onSeedBuildQueue={(q) => store.setBuildQueue(q)}
            queue={blockedEntries.map((e) => e.session.id)}
            switchOrder={store.sessions.map((s) => s.id)}
            onnavigate={(id) => selectUnit(id)}
            {consumeAutoFocusTerm}
            {onarchive}
            workingBlocked={store.workingBlocked}
            onback={() => (mobileScreen = "list")}
            nextNeedsYou={otherNeedsYou.length}
            onnextneedsyou={jumpNextNeedsYou}
            onbroadcast={() => (showBroadcast = true)}
            onedit={() => {
              settingsTab = "session";
              showSettings = true;
            }}
            drain={store.drain[selected.repoPath] ?? null}
          />
        </div>
      {/if}
    {:else if viewMode === "all"}
      <div class="grid-all">
        <HerdGrid
          sessions={herdSessions}
          filteredRepo={repoFilterName}
          {statusFilter}
          {selectedId}
          {nowMs}
          git={store.git}
          activity={store.activity}
          {onrelaunch}
          {onrelaunchElsewhere}
          onselect={(id) => {
            selectedId = id;
            viewMode = "focus";
          }}
          onnew={() => (showNew = true)}
          {issueActionsUnset}
          onsettings={() => {
            settingsTab = "workspace";
            showSettings = true;
          }}
          workingBlocked={store.workingBlocked}
        />
      </div>
    {:else}
      <div class="grid" class:compact={touch.current} class:collapsed={sidebarCollapsed}>
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
          <Herd
            sessions={herdSessions}
            filteredRepo={repoFilterName}
            {repoFilter}
            onrepofilter={(repoPath) => (repoFilter = repoPath)}
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
            ondecommission={onarchive}
            {onrelaunch}
            {onrelaunchElsewhere}
            {onclearmerged}
            {onmergetrain}
            {issueActionsUnset}
            onsettings={() => {
              settingsTab = "workspace";
              showSettings = true;
            }}
            bind:filter={herdFilter}
            workingBlocked={store.workingBlocked}
            collapsible={canCollapse}
            oncollapse={toggleSidebar}
          />
        {/if}
        {#if store.sessions.length === 0}
          <BacklogView
            payload={backlog}
            mobile={false}
            {onissue}
            onquick={onquickissue}
            {onpr}
            {onadopt}
            {onlaunchtrain}
            epics={store.epics}
          />
        {:else if selected}
          <Viewport
            bind:this={viewportRef}
            session={selected}
            touch={touch.current}
            git={store.git[selected.id]}
            previewPort={store.preview[selected.id] ?? null}
            claudeAlive={store.claudeAlive[selected.id]}
            previewMap={store.preview}
            previewHost={settings?.previewHost ?? null}
            previewServeFailed={store.previewServe[selected.id] === "failed"}
            {openPreviewTick}
            buildQueue={store.buildQueues[selected.id] ?? null}
            onSeedBuildQueue={(q) => store.setBuildQueue(q)}
            queue={blockedEntries.map((e) => e.session.id)}
            switchOrder={store.sessions.map((s) => s.id)}
            onnavigate={(id) => selectUnit(id)}
            {consumeAutoFocusTerm}
            {onarchive}
            workingBlocked={store.workingBlocked}
            onbroadcast={() => (showBroadcast = true)}
            onedit={() => {
              settingsTab = "session";
              showSettings = true;
            }}
            drain={store.drain[selected.repoPath] ?? null}
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
    mode={viewMode}
    onmode={(m) => (viewMode = m)}
    mobile={mobile.current}
    desktopOnly
  />

  {#if showTriage}
    <TriageDrawer
      entries={blockedEntries}
      {nowMs}
      onreply={(id, text) => replySession(id, text).catch(() => {})}
      ondismiss={(id) => dismissStall(id).catch(() => {})}
      onopen={(id) => {
        selectUnit(id);
        showTriage = false;
      }}
      onclose={() => (showTriage = false)}
    />
  {/if}

  {#if showLearnings}
    <LearningsDrawer
      items={learnings.items}
      injectable={learnings.injectable}
      focusRepo={learningsRepo}
      onapprove={(id, rule) =>
        approveLearning(id, rule)
          .then(() => learnings.load())
          .catch(() => {})}
      ondismiss={(id) =>
        dismissLearning(id)
          .then(() => learnings.load())
          .catch(() => {})}
      ondistill={(repoPath) =>
        distillRepo(repoPath)
          .then(() => toasts.info(m.learnings_distill_started({ repo: basename(repoPath) })))
          .catch(() => {})}
      onpromote={(id) =>
        promoteLearning(id)
          .then(() => {
            toasts.info(m.learnings_promote_started());
            return learnings.load();
          })
          .catch(() => toasts.info(m.learnings_promote_failed()))}
      onclose={() => {
        showLearnings = false;
        learningsRepo = null;
      }}
    />
  {/if}
</div>

{#if showUpdate && store.update && store.update.behind > 0}
  <UpdateModal
    update={store.update}
    updating={store.updating}
    {deploy}
    onconfirm={onUpdateConfirm}
    onclose={closeUpdate}
  />
{/if}

{#if showHerdrUpdate && store.herdrUpdate && (store.herdrUpdate.updateAvailable || herdrUpdating)}
  <!-- displayStatus: the warning counts agents the herdr restart interrupts — a
       working-while-blocked agent is genuinely mid-turn, so it counts as working -->
  <HerdrUpdateModal
    update={store.herdrUpdate}
    sessions={store.sessions.filter((s) => displayStatus(s, store.workingBlocked) === "running")
      .length}
    log={store.herdrUpdateLog}
    done={store.herdrUpdateDone}
    onconfirm={() => {
      herdrUpdating = true;
      store.herdrUpdateDone = null; // fresh run: clear any prior result
      store.herdrUpdateLog = [];
    }}
    onclose={() => {
      showHerdrUpdate = false;
      herdrUpdating = false;
      store.herdrUpdateDone = null;
    }}
  />
{/if}

{#if showWhatsNew}
  <WhatsNew
    entries={whatsNewEntries}
    ondismiss={() => {
      featureDiscovery.lastSeenVersion = version;
      whatsNewDotOn = false;
    }}
    onclose={() => (showWhatsNew = false)}
  />
{/if}

{#if showFableArrival}
  <FableArrival
    ontry={() => {
      featureDiscovery.markSeen(FABLE_FEATURE_ID);
      showFableArrival = false;
      composeModel = "fable";
      showNew = true;
    }}
    onclose={() => {
      featureDiscovery.markSeen(FABLE_FEATURE_ID);
      showFableArrival = false;
    }}
  />
{/if}

{#if showNew}
  <!-- Preselect: explicit backlog/PR context first, else the repo the herd is
       currently filtered to, else NewTask falls back to the most-recently-used repo. -->
  <NewTask
    {onsubmit}
    relaunch={relaunchOriginalId !== null}
    initialRepoPath={composeRepoPath ?? repoFilter ?? undefined}
    initialBaseBranch={composeBaseBranch ?? undefined}
    initialIssue={composeIssue ?? undefined}
    {relaunchIssueNumber}
    initialPrompt={composePrompt ?? undefined}
    initialModel={composeModel ?? undefined}
    defaultModel={settings?.defaultModel}
    onclose={() => {
      showNew = false;
      resetCompose();
    }}
    onclone={() => {
      // Clear stale relaunch/compose state before handing off to Clone: its ondone
      // reopens NewTask, and a lingering relaunchOriginalId would wrongly put that
      // fresh-create into relaunch mode (archiving the original session).
      resetCompose();
      showNew = false;
      showClone = true;
    }}
    onnewproject={() => {
      // Same as onclone: NewProject.ondone reopens NewTask, so drop any stale
      // relaunch/compose seed first to avoid an unintended relaunch.
      resetCompose();
      showNew = false;
      showNewProject = true;
    }}
  />
{/if}

{#if showSettings}
  <Settings
    initialTab={settingsTab}
    onclose={() => {
      showSettings = false;
      loadSettings();
    }}
    herdrUpdate={store.herdrUpdate}
    onherdrupdate={() => {
      showSettings = false;
      showHerdrUpdate = true;
    }}
    onclone={() => {
      showSettings = false;
      showClone = true;
    }}
    onwhatsnew={() => {
      showSettings = false;
      showWhatsNew = true;
    }}
  />
{/if}

{#if showClone}
  <!-- Close whichever dialog launched Clone (NewTask or Settings) is already done
       before we get here; ondone reopens NewTask preselected on the fresh repo. -->
  <CloneRepo
    onclose={() => (showClone = false)}
    ondone={(entry) => {
      showClone = false;
      composeRepoPath = entry.path;
      showNew = true;
    }}
    repoRootDisplay={settings?.repoRootDisplay}
  />
{/if}

{#if showNewProject}
  <!-- ondone auto-selects the new repo in NewTask + prefills the kickoff seed.
       A warning (partial success: local ok, GitHub failed) surfaces as a non-blocking
       info toast — the flow still proceeds to NewTask with the repo preselected. -->
  <NewProject
    repoRootDisplay={settings?.repoRootDisplay}
    onclose={() => (showNewProject = false)}
    ondone={(entry, kickoff, idea) => {
      showNewProject = false;
      composeRepoPath = entry.path;
      composePrompt = buildKickoffSeed(kickoff, idea);
      if (entry.warning) {
        const warningMsg =
          entry.warning === "newproject_failed_gh_missing"
            ? m.newproject_failed_gh_missing()
            : entry.warning === "newproject_failed_gh_auth"
              ? m.newproject_failed_gh_auth()
              : entry.warning === "newproject_failed_gh_exists"
                ? m.newproject_failed_gh_exists()
                : entry.warning === "newproject_failed_remote"
                  ? m.newproject_failed_remote()
                  : entry.warning === "newproject_failed_timeout"
                    ? m.newproject_failed_timeout()
                    : m.newproject_warning_github();
        toasts.info(warningMsg);
      }
      showNew = true;
    }}
  />
{/if}

{#if showBroadcast}
  <BroadcastDialog sessions={store.sessions} onclose={() => (showBroadcast = false)} />
{/if}

{#if clearMergedSessions}
  <ClearMergedDialog
    sessions={clearMergedSessions}
    leftovers={clearMergedLeftovers}
    onclose={() => (clearMergedSessions = null)}
    onconfirm={confirmClearMerged}
  />
{/if}

{#if showBacklog}
  <BacklogOverlay
    payload={backlog}
    mobile={mobile.current}
    {onissue}
    onquick={onquickissue}
    {onpr}
    {onadopt}
    {onlaunchtrain}
    onclose={() => (showBacklog = false)}
    epics={store.epics}
  />
{/if}

{#if store.starPrompt?.shouldPrompt}
  <StarPrompt onresolve={(s) => (store.starPrompt = s)} />
{/if}

<Toasts />

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
  .grid {
    display: grid;
    /* session picker stays compact; terminal absorbs all extra width */
    grid-template-columns: minmax(300px, 360px) 1fr;
    gap: 14px;
    flex: 1;
    min-height: 0;
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
  .grid-all {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .grid-all :global(.herd-grid) {
    flex: 1;
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
  /* Primary landmark wrapping the herd/viewport content. Transparent to the
     flex layout: it fills the shell column and lets its own child (.col /
     .grid / .grid-all) keep flexing exactly as before the <main> wrapper.
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
  }
  .shell.mobile.list .main-region,
  .shell.mobile.list .col {
    /* min-height:auto (not 0): flex children still grow to fill the viewport when
       the list is short, but are no longer capped — tall content overflows and the
       document scrolls instead of trapping it in an inner scroller */
    min-height: auto;
  }
</style>
