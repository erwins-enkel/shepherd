<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import UnitTile from "./UnitTile.svelte";
  import EmptyHerd from "./EmptyHerd.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    sessions,
    selectedId,
    nowMs,
    onselect,
    onnew,
    git,
    standardCommandUnset = false,
    onsettings = undefined,
    filteredRepo = null,
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    onnew: () => void;
    git: Record<string, GitState>;
    standardCommandUnset?: boolean;
    onsettings?: () => void;
    // basename of an active repo filter; empty + filtered → neutral note, not EmptyHerd
    filteredRepo?: string | null;
  } = $props();
</script>

{#if sessions.length === 0}
  {#if filteredRepo}
    <div class="grid-empty">{m.herd_repo_filter_empty({ repo: filteredRepo })}</div>
  {:else}
    <EmptyHerd {onnew} {standardCommandUnset} {onsettings} />
  {/if}
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
  .grid-empty {
    padding: 24px 14px;
    text-align: center;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
</style>
