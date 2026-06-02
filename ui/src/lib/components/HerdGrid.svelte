<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import UnitTile from "./UnitTile.svelte";
  import EmptyHerd from "./EmptyHerd.svelte";

  let {
    sessions,
    selectedId,
    nowMs,
    onselect,
    onnew,
    git,
    standardCommandUnset = false,
    onsettings = undefined,
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    onnew: () => void;
    git: Record<string, GitState>;
    standardCommandUnset?: boolean;
    onsettings?: () => void;
  } = $props();
</script>

{#if sessions.length === 0}
  <EmptyHerd {onnew} {standardCommandUnset} {onsettings} />
{:else}
  <div class="herd-grid">
    {#each sessions as session (session.id)}
      <UnitTile
        {session}
        selected={session.id === selectedId}
        {nowMs}
        {onselect}
        git={git[session.id]}
      />
    {/each}
  </div>
{/if}

<style>
  .herd-grid {
    display: grid;
    min-height: 0;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    grid-auto-rows: 240px;
    gap: 12px;
    overflow: auto;
    padding: 2px;
    align-content: start;
  }
</style>
