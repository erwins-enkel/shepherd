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
    getUpdate,
  } from "$lib/api";
  import { sortBlocked } from "$lib/triage";
  import { steers } from "$lib/steers.svelte";
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
  import { m } from "$lib/paraglide/messages";

  const store = new HerdStore();
  let selectedId = $state<string | null>(null);
  let showNew = $state(false);
  let showSettings = $state(false);
  let showBroadcast = $state(false);
  let showTriage = $state(false);
  let showUpdate = $state(false);
  const blockedEntries = $derived(sortBlocked(store.sessions, store.blocks));
  let viewMode = $state<"focus" | "all">("focus");
  let nowMs = $state(Date.now());
  let composeRepoPath = $state<string | null>(null);
  let composePrompt = $state("");

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);

  const mobile = new MediaQuery("max-width: 768px");
  // touch-primary device (e.g. unfolded foldable wider than the mobile breakpoint):
  // gets the control-key bar even in desktop layout, since there's no hardware keyboard
  const touch = new MediaQuery("(pointer: coarse)");
  let mobileScreen = $state<"list" | "detail">("list");

  function selectUnit(id: string) {
    selectedId = id;
    if (mobile.current) mobileScreen = "detail";
  }

  // if the selected unit disappears while in mobile detail, fall back to the list
  $effect(() => {
    if (mobile.current && mobileScreen === "detail" && !selected) {
      mobileScreen = "list";
    }
  });

  onMount(() => {
    listSessions()
      .then((list) => {
        store.setAll(list);
        if (!selectedId && list[0]) selectedId = list[0].id;
      })
      .catch(() => {});
    getUsageLimits()
      .then((l) => store.setUsageLimits(l))
      .catch(() => {});
    getUpdate()
      .then((u) => store.setUpdate(u))
      .catch(() => {});
    steers.load();
    const dispose = store.connect();
    const t = setInterval(() => (nowMs = Date.now()), 1000);
    return () => {
      dispose();
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
</script>

<div class="shell" class:mobile={mobile.current}>
  <TopBar
    sessions={store.sessions}
    {nowMs}
    connected={store.connected}
    mobile={mobile.current}
    limits={store.usageLimits}
    onsettings={() => (showSettings = true)}
    needsYou={blockedEntries.length}
    ontriage={() => (showTriage = true)}
    update={store.update}
    onupdate={() => (showUpdate = true)}
  />

  {#if mobile.current}
    {#if mobileScreen === "list"}
      <div class="col">
        <Herd sessions={store.sessions} {selectedId} {nowMs} onselect={(id) => selectUnit(id)} />
      </div>
      <ActionBar onnew={() => (showNew = true)} mobile={mobile.current} />
    {:else if selected}
      <div class="col">
        <Viewport
          session={selected}
          mobile={mobile.current}
          {onarchive}
          onback={() => (mobileScreen = "list")}
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
        onselect={(id) => {
          selectedId = id;
          viewMode = "focus";
        }}
      />
    </div>
  {:else}
    <div class="grid" class:compact={touch.current}>
      <Herd sessions={store.sessions} {selectedId} {nowMs} onselect={(id) => selectUnit(id)} />
      {#if selected}
        <Viewport
          session={selected}
          touch={touch.current}
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
      onclose={() => (showTriage = false)}
    />
  {/if}
</div>

{#if showUpdate && store.update && store.update.behind > 0}
  <UpdateModal
    update={store.update}
    updating={store.updating}
    onconfirm={() => store.beginUpdate()}
    onclose={() => (showUpdate = false)}
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
    padding: 22px;
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
    padding: 10px;
    gap: 10px;
  }
</style>
