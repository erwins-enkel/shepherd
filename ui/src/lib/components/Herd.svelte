<script lang="ts">
  import type { Session } from "$lib/types";
  import UnitRow from "./UnitRow.svelte";

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

<div class="panel bracket">
  <div class="phead">
    <span class="micro">The&nbsp;Herd</span>
    <span class="right micro">▦ All</span>
  </div>
  <div class="units">
    {#if sessions.length === 0}
      <div class="empty micro">No units — + New Task</div>
    {:else}
      {#each sessions as session (session.id)}
        <UnitRow {session} selected={session.id === selectedId} {nowMs} {onselect} />
      {/each}
    {/if}
  </div>
</div>

<style>
  .panel {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }

  .phead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-muted);
  }
  .phead .right {
    margin-left: auto;
  }

  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .units {
    overflow: auto;
    padding: 6px;
    flex: 1;
    min-height: 0;
  }

  .empty {
    padding: 24px 14px;
    text-align: center;
    color: var(--color-faint);
  }
</style>
