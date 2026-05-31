<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import UnitTile from "./UnitTile.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    sessions,
    selectedId,
    nowMs,
    onselect,
    onnew,
    git,
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    onnew: () => void;
    git: Record<string, GitState>;
  } = $props();
</script>

{#if sessions.length === 0}
  <button type="button" class="empty" onclick={onnew}>{m.herd_empty()}</button>
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
  .empty {
    flex: 1;
    width: 100%;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-faint);
    font-family: inherit;
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .empty:hover {
    color: var(--color-ink);
    border-color: var(--color-line-bright);
  }
</style>
