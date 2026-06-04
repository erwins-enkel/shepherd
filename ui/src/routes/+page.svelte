<script lang="ts">
  import { onMount } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { HerdStore } from "$lib/store.svelte";
  import {
    listSessions,
    createSession,
    archiveSession,
    getUsageLimits,
    replySession,
    dismissStall,
    getUpdate,
    getUpdateLog,
    getHerdrUpdate,
    gitStates,
    activityStates,
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
    halt as apiHalt,
  } from "$lib/api";
  import type {
    DeployState,
    BacklogPayload,
    Issue,
    IssueRef,
    PullRequest,
    Session,
    Settings as Settings_,
  } from "$lib/types";
  import { sortBlocked } from "$lib/triage";
  import { steers } from "$lib/steers.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import { learnings } from "$lib/learnings.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import TriageDrawer from "$lib/components/TriageDrawer.svelte";
  import LearningsDrawer from "$lib/components/LearningsDrawer.svelte";
  import { basename } from "$lib/components/learnings-drawer";
  import Herd from "$lib/components/Herd.svelte";
  import Viewport from "$lib/components/Viewport.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import CloneRepo from "$lib/components/CloneRepo.svelte";
  import BroadcastDialog from "$lib/components/BroadcastDialog.svelte";
  import ClearMergedDialog from "$lib/components/ClearMergedDialog.svelte";
  import ActionBar from "$lib/components/ActionBar.svelte";
  import HerdGrid from "$lib/components/HerdGrid.svelte";
  import QueueStrip from "$lib/components/QueueStrip.svelte";
  import BacklogView from "$lib/components/BacklogView.svelte";
  import BacklogOverlay from "$lib/components/BacklogOverlay.svelte";
  import UpdateModal from "$lib/components/UpdateModal.svelte";
  import HerdrUpdateModal from "$lib/components/HerdrUpdateModal.svelte";
  import Toasts from "$lib/components/Toasts.svelte";
  import { registerSW, onSelectSession } from "$lib/push";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import type { FeatureAnnouncement } from "$lib/feature-announcements";
  import { featureAnnouncements } from "$lib/feature-announcements";
  import { featureDiscovery } from "$lib/featureDiscovery.svelte";
  import { computeNewEntries } from "$lib/feature-gate";
  import { version } from "$lib/build-info";
  import WhatsNew from "$lib/components/WhatsNew.svelte";

  const store = new HerdStore();
  let selectedId = $state<string | null>(null);
  let showNew = $state(false);
  let showSettings = $state(false);
  let showClone = $state(false);
  let showBroadcast = $state(false);
  // "clear all merged" confirm modal: the merged sessions to clear + their total
  // leftover subprocess count (both fetched server-side when the modal opens).
  let clearMergedSessions = $state<Session[] | null>(null);
  let clearMergedLeftovers = $state(0);
  let showTriage = $state(false);
  let showLearnings = $state(false);
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
  // Active/promoted rules that an enabled repo wants to inject but couldn't fit in
  // the budget — the #253 case. Drives a TopBar entry point even with zero proposals
  // (disabled repos are excluded: pruning won't help, re-enabling injection would).
  const overBudgetRules = $derived(
    learnings.injectable.reduce(
      (n, repo) => n + (repo.enabled ? repo.rules.filter((r) => !r.injected).length : 0),
      0,
    ),
  );
  let viewMode = $state<"focus" | "all">("focus");
  let nowMs = $state(Date.now());
  let composeRepoPath = $state<string | null>(null);
  let composeIssue = $state<Issue | null>(null);
  // Seed prompt for the New Task dialog (PR review path); null = no seed.
  let composePrompt = $state<string | null>(null);
  let backlog = $state<BacklogPayload | null>(null);
  // loaded once on mount; drives the first-run nudge (quick-launch is invisible
  // until a standard command is set). Re-read on settings close so a just-saved
  // command dismisses the hint.
  let settings = $state<Settings_ | null>(null);
  const standardCommandUnset = $derived((settings?.standardCommand ?? "").trim() === "");

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);

  function loadSettings() {
    getSettings()
      .then((s) => (settings = s))
      .catch(() => {});
  }

  // Re-pull the REST-loaded state on tab return. The live /events stream is
  // delta-only: while a mobile tab is frozen (locked phone / backgrounded app)
  // the socket drops and every missed event is gone for good, so sessions, git,
  // usage and backlog sit stale until a manual refresh. Resync the high-signal
  // data when the tab comes back so launching from a notification or unlocking
  // shows current state without one. Always fires — a half-open socket can read
  // as connected, so we can't gate on store.connected.
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
    getBacklog()
      .then((p) => (backlog = p))
      .catch(() => {});
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

  // Quick-launch: spawn a session straight from a backlog issue with the configured
  // standard command, skipping the New Task dialog. We re-read settings on click so a
  // just-saved command takes effect, and resolve the repo's current branch the same
  // way NewTask does. With no command configured (or any lookup failure) we fall back
  // to the normal dialog so the click is never lost.
  async function onquickissue(repoPath: string, issue: Issue) {
    const settings = await getSettings().catch(() => null);
    const cmd = (settings?.standardCommand ?? "").trim();
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

  const mobile = new MediaQuery("max-width: 768px");
  // touch-primary device (e.g. unfolded foldable wider than the mobile breakpoint):
  // gets the control-key bar even in desktop layout, since there's no hardware keyboard
  const touch = new MediaQuery("(pointer: coarse)");
  let mobileScreen = $state<"list" | "detail">("list");
  let showBacklog = $state(false);

  function selectUnit(id: string) {
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

  // Global single-key shortcuts (no modifier → zero browser/terminal conflict,
  // works on every platform). Desktop only, and suppressed while typing or while
  // any modal/overlay is open so a stray "n"/"b" can't stack dialogs.
  function onShortcut(e: KeyboardEvent) {
    if (mobile.current) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return;
    if (isTyping(e.target)) return;
    if (
      showNew ||
      showSettings ||
      showBacklog ||
      showBroadcast ||
      showTriage ||
      showUpdate ||
      showHerdrUpdate ||
      showWhatsNew
    )
      return;
    switch (e.key.toLowerCase()) {
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
    }
  }

  // sessions waiting on the operator other than the one on screen — gates the
  // header "needs you" jump and tells the operator how many remain.
  const otherNeedsYou = $derived(blockedEntries.filter((e) => e.session.id !== selectedId));

  // Jump to the next waiting session: walk blockedEntries (oldest-first, same set
  // as the NEEDS YOU badge) starting after the current one, wrapping around.
  function jumpNextNeedsYou() {
    const entries = blockedEntries;
    if (entries.length === 0) return;
    const idx = entries.findIndex((e) => e.session.id === selectedId);
    const start = idx === -1 ? 0 : idx + 1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[(start + i) % entries.length];
      if (e.session.id !== selectedId) {
        selectUnit(e.session.id);
        return;
      }
    }
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
    gitStates()
      .then((m) => store.setGit(m))
      .catch(() => {});
    activityStates()
      .then((m) => store.setActivity(m))
      .catch(() => {});
    getDrain()
      .then((l) => store.setDrain(l))
      .catch(() => {});
    steers.load();
    projectIcons.load();
    reviews.load();
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
  // Gate on a $derived boolean, not store.sessions.length directly: session:status
  // (and renamed/ready/new) reassign store.sessions, which would re-run an effect
  // that read it and recreate the interval mid-second — under heavy status traffic
  // the 1s tick could stutter or stall, freezing every elapsed clock. A $derived
  // only propagates on the empty↔non-empty flip, so the interval is made once.
  const hasSessions = $derived(store.sessions.length > 0);
  $effect(() => {
    if (!hasSessions) return;
    nowMs = Date.now(); // refresh on the empty→non-empty flip so the first frame isn't up to 1s stale
    const t = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(t);
  });

  async function onsubmit(input: {
    repoPath: string;
    baseBranch: string;
    prompt: string;
    model: string | null;
    images: string[];
    issueRef?: IssueRef;
  }) {
    const s = await createSession(input);
    selectedId = s.id;
    showNew = false;
    composeRepoPath = null;
    composeIssue = null;
    composePrompt = null;
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

  // Fleet-wide emergency stop. Interrupting every working agent is consequential and
  // not server-side reversible, so — like decommission — we DEFER it behind an undo
  // window rather than firing on the first tap: one tap arms a 5s undo toast, and the
  // POST only goes out when that window expires un-cancelled. The "Halted N" confirm
  // rides in solely on the `halt:done` WS event (its 'halt-done' key dedupes WS echoes /
  // back-to-back halts into one row). A failed POST re-toasts with a Retry that re-defers.
  function haltHerd() {
    const count = store.sessions.filter((s) => s.status === "running").length;
    if (count === 0) return; // nothing to halt; the control is hidden in this state anyway
    toasts.undo(m.halt_confirm({ count }), {
      undoLabel: m.common_undo(),
      key: "halt-herd",
      onCommit: async () => {
        try {
          await apiHalt();
          // success confirm arrives via the halt:done WS event (all connected clients)
        } catch {
          toasts.info(m.halt_failed(), {
            alert: true,
            action: { label: m.common_retry(), run: () => haltHerd() },
          });
        }
      },
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

<div class="shell" class:mobile={mobile.current}>
  <!-- On a phone in the terminal-focus screen the top bar is subsumed by the
       viewport's merged header (repo · session + back + status tint), so it's
       hidden there; settings + global chrome stay on the herd overview. -->
  {#if !(mobile.current && mobileScreen === "detail")}
    <TopBar
      sessions={store.sessions}
      {nowMs}
      connected={store.connected}
      mobile={mobile.current}
      touch={touch.current}
      limits={store.usageLimits}
      onsettings={() => (showSettings = true)}
      onhalt={haltHerd}
      needsYou={blockedEntries.length}
      ontriage={() => (showTriage = true)}
      learnings={learnings.items.length}
      overBudget={overBudgetRules}
      onlearnings={() => (showLearnings = true)}
      update={store.update}
      onupdate={() => (showUpdate = true)}
      herdrUpdate={store.herdrUpdate}
      onherdrupdate={() => (showHerdrUpdate = true)}
      whatsNew={whatsNewDotOn}
      onwhatsnew={() => (showWhatsNew = true)}
    />
    <QueueStrip drain={store.drain} />
  {/if}

  <main id="main-content" class="main-region">
    {#if mobile.current}
      {#if mobileScreen === "list"}
        <div class="col">
          <Herd
            sessions={store.sessions}
            {selectedId}
            {nowMs}
            onselect={(id) => selectUnit(id)}
            onnew={() => (showNew = true)}
            git={store.git}
            activity={store.activity}
            ondecommission={onarchive}
            {onclearmerged}
            {standardCommandUnset}
            onsettings={() => (showSettings = true)}
          />
          {#if store.sessions.length === 0}
            <BacklogView payload={backlog} mobile={true} {onissue} onquick={onquickissue} {onpr} />
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
            queue={blockedEntries.map((e) => e.session.id)}
            switchOrder={store.sessions.map((s) => s.id)}
            onnavigate={(id) => selectUnit(id)}
            {onarchive}
            onback={() => (mobileScreen = "list")}
            nextNeedsYou={otherNeedsYou.length}
            onnextneedsyou={jumpNextNeedsYou}
            onbroadcast={() => (showBroadcast = true)}
            onnewtask={(repoPath, issue) => {
              composeRepoPath = repoPath;
              composeIssue = issue;
              showNew = true;
            }}
            onquick={onquickissue}
          />
        </div>
      {/if}
    {:else if viewMode === "all"}
      <div class="grid-all">
        <HerdGrid
          sessions={store.sessions}
          {selectedId}
          {nowMs}
          git={store.git}
          onselect={(id) => {
            selectedId = id;
            viewMode = "focus";
          }}
          onnew={() => (showNew = true)}
          {standardCommandUnset}
          onsettings={() => (showSettings = true)}
        />
      </div>
    {:else}
      <div class="grid" class:compact={touch.current}>
        <Herd
          sessions={store.sessions}
          {selectedId}
          {nowMs}
          onselect={(id) => selectUnit(id)}
          onnew={() => (showNew = true)}
          git={store.git}
          activity={store.activity}
          {onclearmerged}
          {standardCommandUnset}
          onsettings={() => (showSettings = true)}
        />
        {#if store.sessions.length === 0}
          <BacklogView payload={backlog} mobile={false} {onissue} onquick={onquickissue} {onpr} />
        {:else if selected}
          <Viewport
            session={selected}
            touch={touch.current}
            git={store.git[selected.id]}
            queue={blockedEntries.map((e) => e.session.id)}
            switchOrder={store.sessions.map((s) => s.id)}
            onnavigate={(id) => selectUnit(id)}
            {onarchive}
            onbroadcast={() => (showBroadcast = true)}
            onnewtask={(repoPath, issue) => {
              composeRepoPath = repoPath;
              composeIssue = issue;
              showNew = true;
            }}
            onquick={onquickissue}
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
      onclose={() => (showLearnings = false)}
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
  <HerdrUpdateModal
    update={store.herdrUpdate}
    sessions={store.sessions.filter((s) => s.status === "running").length}
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

{#if showNew}
  <NewTask
    {onsubmit}
    initialRepoPath={composeRepoPath ?? undefined}
    initialIssue={composeIssue ?? undefined}
    initialPrompt={composePrompt ?? undefined}
    onclose={() => {
      showNew = false;
      composeRepoPath = null;
      composeIssue = null;
      composePrompt = null;
    }}
    onclone={() => {
      showNew = false;
      showClone = true;
    }}
  />
{/if}

{#if showSettings}
  <Settings
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
    onclose={() => (showBacklog = false)}
  />
{/if}

<Toasts />

<style>
  .shell {
    max-width: 1480px;
    margin: 0 auto;
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
    max-width: none;
    padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right))
      max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
    gap: 10px;
  }
</style>
