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
    getBacklog,
  } from "$lib/api";
  import type { DeployState, BacklogPayload, Issue, IssueRef } from "$lib/types";
  import { sortBlocked } from "$lib/triage";
  import { steers } from "$lib/steers.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { reviews } from "$lib/reviews.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import TriageDrawer from "$lib/components/TriageDrawer.svelte";
  import Herd from "$lib/components/Herd.svelte";
  import Viewport from "$lib/components/Viewport.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import BroadcastDialog from "$lib/components/BroadcastDialog.svelte";
  import ActionBar from "$lib/components/ActionBar.svelte";
  import HerdGrid from "$lib/components/HerdGrid.svelte";
  import BacklogView from "$lib/components/BacklogView.svelte";
  import UpdateModal from "$lib/components/UpdateModal.svelte";
  import HerdrUpdateModal from "$lib/components/HerdrUpdateModal.svelte";
  import { registerSW, onSelectSession } from "$lib/push";
  import { m } from "$lib/paraglide/messages";

  const store = new HerdStore();
  let selectedId = $state<string | null>(null);
  let showNew = $state(false);
  let showSettings = $state(false);
  let showBroadcast = $state(false);
  let showTriage = $state(false);
  let showUpdate = $state(false);
  // live state of a launched deploy → modal tails its log + surfaces failures
  let deploy = $state<DeployState | null>(null);
  let deployPollTimer: ReturnType<typeof setTimeout> | null = null;
  let showHerdrUpdate = $state(false);
  // set once the operator confirms the herdr update; herdr+shepherd restart drops
  // the WS and the store auto-reconnects, refreshing state once the new build is live.
  let herdrUpdating = $state(false);
  const blockedEntries = $derived(sortBlocked(store.sessions, store.blocks));
  let viewMode = $state<"focus" | "all">("focus");
  let nowMs = $state(Date.now());
  let composeRepoPath = $state<string | null>(null);
  let composeIssue = $state<Issue | null>(null);
  let backlog = $state<BacklogPayload | null>(null);

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);

  // Fetch backlog only when the overview is empty. Reading store.sessions.length
  // inside the effect body makes Svelte track it; backlog is written but never
  // read here, so it cannot re-trigger the effect → no loop.
  $effect(() => {
    if (store.sessions.length === 0) {
      getBacklog()
        .then((p) => (backlog = p))
        .catch(() => {
          backlog = { pinnedPath: null, projects: [], totals: { openIssues: 0, openPRs: 0 } };
        });
    }
  });

  function onissue(repoPath: string, issue: Issue) {
    composeRepoPath = repoPath;
    composeIssue = issue;
    showNew = true;
  }

  const mobile = new MediaQuery("max-width: 768px");
  // touch-primary device (e.g. unfolded foldable wider than the mobile breakpoint):
  // gets the control-key bar even in desktop layout, since there's no hardware keyboard
  const touch = new MediaQuery("(pointer: coarse)");
  let mobileScreen = $state<"list" | "detail">("list");

  function selectUnit(id: string) {
    selectedId = id;
    if (mobile.current) mobileScreen = "detail";
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
    steers.load();
    projectIcons.load();
    reviews.load();
    const dispose = store.connect();
    const t = setInterval(() => (nowMs = Date.now()), 1000);
    return () => {
      dispose();
      disposeSelect();
      clearInterval(t);
    };
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
  }

  async function onarchive(id: string) {
    // server stops the agent, removes the worktree, emits session:archived (store drops the row)
    await archiveSession(id);
    selectedId = store.sessions.find((s) => s.id !== id)?.id ?? null;
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
      needsYou={blockedEntries.length}
      ontriage={() => (showTriage = true)}
      update={store.update}
      onupdate={() => (showUpdate = true)}
      herdrUpdate={store.herdrUpdate}
      onherdrupdate={() => (showHerdrUpdate = true)}
    />
  {/if}

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
          ondecommission={onarchive}
        />
        {#if store.sessions.length === 0}
          <BacklogView payload={backlog} mobile={true} {onissue} />
        {/if}
      </div>
      <ActionBar onnew={() => (showNew = true)} mobile={mobile.current} />
    {:else if selected}
      <div class="col">
        <Viewport
          session={selected}
          mobile={mobile.current}
          connected={store.connected}
          limits={store.usageLimits}
          queue={blockedEntries.map((e) => e.session.id)}
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
      />
      {#if store.sessions.length === 0}
        <BacklogView payload={backlog} mobile={false} {onissue} />
      {:else if selected}
        <Viewport
          session={selected}
          touch={touch.current}
          queue={blockedEntries.map((e) => e.session.id)}
          onnavigate={(id) => selectUnit(id)}
          {onarchive}
          onbroadcast={() => (showBroadcast = true)}
          onnewtask={(repoPath, issue) => {
            composeRepoPath = repoPath;
            composeIssue = issue;
            showNew = true;
          }}
        />
      {:else}
        <div class="empty">{m.main_no_unit_selected()}</div>
      {/if}
    </div>
  {/if}

  <ActionBar
    onnew={() => (showNew = true)}
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
    onconfirm={() => (herdrUpdating = true)}
    onclose={() => {
      showHerdrUpdate = false;
      herdrUpdating = false;
    }}
  />
{/if}

{#if showNew}
  <NewTask
    {onsubmit}
    initialRepoPath={composeRepoPath ?? undefined}
    initialIssue={composeIssue ?? undefined}
    onclose={() => {
      showNew = false;
      composeRepoPath = null;
      composeIssue = null;
    }}
  />
{/if}

{#if showSettings}
  <Settings
    onclose={() => (showSettings = false)}
    herdrUpdate={store.herdrUpdate}
    onherdrupdate={() => {
      showSettings = false;
      showHerdrUpdate = true;
    }}
  />
{/if}

{#if showBroadcast}
  <BroadcastDialog sessions={store.sessions} onclose={() => (showBroadcast = false)} />
{/if}

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
    grid-template-columns: minmax(220px, 260px) 1fr;
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
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .col {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .shell.mobile {
    max-width: none;
    padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right))
      max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
    gap: 10px;
  }
</style>
