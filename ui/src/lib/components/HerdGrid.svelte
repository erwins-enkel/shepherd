<script lang="ts">
  import type { Session } from "$lib/types";
  import UnitTile from "./UnitTile.svelte";

  let {
    sessions,
    selectedId,
    nowMs,
    onselect,
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
  } = $props();
</script>

{#if sessions.length === 0}
  <div class="empty">No units — + New Task</div>
{:else}
  <div class="herd-grid">
    {#each sessions as session (session.id)}
      <UnitTile {session} selected={session.id === selectedId} {nowMs} {onselect} />
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
  .empty {
    flex: 1;
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
