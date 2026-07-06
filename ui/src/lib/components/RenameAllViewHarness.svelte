<script lang="ts">
  import type { GitState, Session } from "$lib/types";
  import HerdGrid from "./HerdGrid.svelte";
  import Viewport from "./Viewport.svelte";

  let {
    sessions,
    nowMs = Date.now(),
    git = {},
  }: {
    sessions: Session[];
    nowMs?: number;
    git?: Record<string, GitState>;
  } = $props();

  let viewMode = $state<"all" | "focus">("all");
  let selectedId = $state<string | null>(null);
  let renameRequest = $state<{ id: string; tick: number } | null>(null);
  let renameSeq = 0;
  const selected = $derived(sessions.find((s) => s.id === selectedId) ?? null);

  function openRename(id: string) {
    selectedId = id;
    viewMode = "focus";
    renameRequest = { id, tick: ++renameSeq };
  }
</script>

{#if viewMode === "all"}
  <HerdGrid
    {sessions}
    {selectedId}
    {nowMs}
    {git}
    onselect={(id) => {
      selectedId = id;
      viewMode = "focus";
    }}
    onrename={openRename}
    onnew={() => {}}
  />
{:else if selected}
  <Viewport
    session={selected}
    git={git[selected.id] ?? null}
    {renameRequest}
    openPreviewTick={0}
    consumeAutoFocusTerm={() => false}
  />
{/if}
