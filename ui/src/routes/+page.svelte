<script lang="ts">
  import { onMount } from "svelte";
  import { HerdStore } from "$lib/store.svelte";
  import { listSessions, createSession, archiveSession } from "$lib/api";
  import TopBar from "$lib/components/TopBar.svelte";
  import Herd from "$lib/components/Herd.svelte";
  import Viewport from "$lib/components/Viewport.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import ActionBar from "$lib/components/ActionBar.svelte";

  const store = new HerdStore();
  let selectedId = $state<string | null>(null);
  let showNew = $state(false);
  let nowMs = $state(Date.now());
  let composeRepoPath = $state<string | null>(null);
  let composePrompt = $state("");

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);

  onMount(() => {
    listSessions()
      .then((list) => {
        store.setAll(list);
        if (!selectedId && list[0]) selectedId = list[0].id;
      })
      .catch(() => {});
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

<div class="shell">
  <TopBar sessions={store.sessions} {nowMs} connected={store.connected} />
  <div class="grid">
    <Herd sessions={store.sessions} {selectedId} {nowMs} onselect={(id) => (selectedId = id)} />
    {#if selected}
      <Viewport
        session={selected}
        {onarchive}
        onnewtask={(repoPath, prompt) => {
          composeRepoPath = repoPath;
          composePrompt = prompt;
          showNew = true;
        }}
      />
    {:else}
      <div class="empty">NO UNIT SELECTED</div>
    {/if}
  </div>
  <ActionBar onnew={() => (showNew = true)} />
</div>

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

<style>
  .shell {
    max-width: 1180px;
    margin: 0 auto;
    padding: 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    height: 100vh;
    box-sizing: border-box;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1.15fr;
    gap: 14px;
    flex: 1;
    min-height: 0;
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
</style>
