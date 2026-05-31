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
  } from "$lib/api";
  import type { DeployState } from "$lib/types";
  import { sortBlocked } from "$lib/triage";
  import { steers } from "$lib/steers.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import TopBar from "$lib/components/TopBar.svelte";
  import TriageDrawer from "$lib/components/TriageDrawer.svelte";
  import Herd from "$lib/components/Herd.svelte";
  import Viewport from "$lib/components/Viewport.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import BroadcastDialog from "$lib/components/BroadcastDialog.svelte";
  import ActionBar from "$lib/components/ActionBar.svelte";
  import HerdGrid from "$lib/components/HerdGrid.svelte";
  import UpdateModal from "$lib/components/UpdateModal.svelte";
  import HerdrUpdateModal from "$lib/components/HerdrUpdateModal.svelte";
  import { registerSW, setActiveSession, onSelectSession } from "$lib/push";
  import { m } from "$lib/paraglide/messages";

  const store = new HerdStore();
  let selectedId = $state<string | null>(null);
  let showNew = $state(false);
  let showSettings = $state(false);
  let showBroadcast = $state(false);
  let showTriage = $state(false);
  let showUpdate = $state(false);
  // set when a launched deploy reports failure → modal shows the captured reason
  let deployFailure = $state<DeployState | null>(null);
  let deployPollTimer: ReturnType<typeof setTimeout> | null = null;
  let showHerdrUpdate = $state(false);
  // set once the operator confirms the herdr update; herdr+shepherd restart drops
  // the WS and the store auto-reconnects, refreshing state once the new build is live.
  let herdrUpdating = $state(false);
  const blockedEntries = $derived(sortBlocked(store.sessions, store.blocks));
  let viewMode = $state<"focus" | "all">("focus");
  let nowMs = $state(Date.now());
  let composeRepoPath = $state<string | null>(null);
  let composePrompt = $state("");

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);

  $effect(() => {
    setActiveSession(selectedId);
  });

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
  }) {
    const s = await createSession(input);
    selectedId = s.id;
    showNew = false;
    composeRepoPath = null;
    composePrompt = "";
  }

  async function onarchive(id: string) {
    // server stops the agent, removes the worktree, emits session:archived (store drops the row)
    await archiveSession(id);
    selectedId = store.sessions.find((s) => s.id !== id)?.id ?? null;
  }

  // The deploy runs detached and only restarts the server on success — on a
  // success the store reloads (new SHA); on a failure nothing else fires, so we
  // poll the captured deploy log and surface the reason in the modal.
  function watchDeploy() {
    if (deployPollTimer) clearTimeout(deployPollTimer);
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const st = await getUpdateLog();
        if (st.phase === "failed") {
          deployFailure = st;
          store.updating = false; // unstick the spinner so the user can read + retry
          return;
        }
        if (st.phase === "done") return; // success → SHA change reloads the page
      } catch {
        /* transient (e.g. server mid-restart) — keep polling */
      }
      if (Date.now() - startedAt > 5 * 60_000) return; // give up after 5 min
      deployPollTimer = setTimeout(tick, 2000);
    };
    deployPollTimer = setTimeout(tick, 2000);
  }

  function onUpdateConfirm() {
    deployFailure = null;
    store.beginUpdate();
    watchDeploy();
  }

  function closeUpdate() {
    showUpdate = false;
    deployFailure = null;
    if (deployPollTimer) clearTimeout(deployPollTimer);
  }
</script>

<div class="shell" class:mobile={mobile.current}>
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
    screen={mobileScreen}
    detailSession={selected}
  />

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
        />
      </div>
      <ActionBar onnew={() => (showNew = true)} mobile={mobile.current} />
    {:else if selected}
      <div class="col">
        <Viewport
          session={selected}
          mobile={mobile.current}
          queue={blockedEntries.map((e) => e.session.id)}
          onnavigate={(id) => selectUnit(id)}
          {onarchive}
          onback={() => (mobileScreen = "list")}
          nextNeedsYou={otherNeedsYou.length}
          onnextneedsyou={jumpNextNeedsYou}
          onbroadcast={() => (showBroadcast = true)}
          onnewtask={(repoPath, prompt) => {
            composeRepoPath = repoPath;
            composePrompt = prompt;
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
      {#if selected}
        <Viewport
          session={selected}
          touch={touch.current}
          queue={blockedEntries.map((e) => e.session.id)}
          onnavigate={(id) => selectUnit(id)}
          {onarchive}
          onbroadcast={() => (showBroadcast = true)}
          onnewtask={(repoPath, prompt) => {
            composeRepoPath = repoPath;
            composePrompt = prompt;
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
    deploy={deployFailure}
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
    initialPrompt={composePrompt}
    onclose={() => {
      showNew = false;
      composeRepoPath = null;
      composePrompt = "";
    }}
  />
{/if}

{#if showSettings}
  <Settings onclose={() => (showSettings = false)} />
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
