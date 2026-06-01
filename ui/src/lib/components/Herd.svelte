<script lang="ts">
  import type { Session, GitState } from "$lib/types";
  import UnitRow from "./UnitRow.svelte";
  import { partitionSessions } from "./herd-partition";
  import { m } from "$lib/paraglide/messages";

  let {
    sessions,
    selectedId,
    nowMs,
    onselect,
    onnew,
    git,
    ondecommission,
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    onnew: () => void;
    git: Record<string, GitState>;
    // when provided, rows gain left-swipe-to-decommission (mobile list)
    ondecommission?: (id: string) => void;
  } = $props();

  // sidebar list filter: "all" or "ready" (only sessions not actively working —
  // anything but a running agent: idle, blocked, done → awaiting the operator)
  let filter = $state<"all" | "ready">("all");
  const shown = $derived(
    filter === "ready" ? sessions.filter((s) => s.status !== "running") : sessions,
  );
  // within the shown set: active rows on top; ready-to-merge ones parked in a
  // green group at the bottom
  const partition = $derived(partitionSessions(shown));
</script>

<div class="panel bracket">
  <div class="phead">
    <span class="micro">{m.herd_title()}</span>
    <div class="right filters">
      <button
        type="button"
        class="micro fbtn"
        class:active={filter === "all"}
        aria-pressed={filter === "all"}
        onclick={() => (filter = "all")}>{m.herd_all_hint()}</button
      >
      <button
        type="button"
        class="micro fbtn"
        class:active={filter === "ready"}
        aria-pressed={filter === "ready"}
        onclick={() => (filter = "ready")}>{m.herd_ready_filter()}</button
      >
    </div>
  </div>
  <div class="units">
    {#if sessions.length === 0}
      <button type="button" class="empty micro" onclick={onnew}>{m.herd_empty()}</button>
    {:else if shown.length === 0}
      <div class="empty micro static">{m.herd_ready_empty()}</div>
    {:else}
      {#each partition.active as session (session.id)}
        <UnitRow
          {session}
          selected={session.id === selectedId}
          {nowMs}
          {onselect}
          git={git[session.id]}
          {ondecommission}
        />
      {/each}
      {#if partition.ready.length > 0}
        <div class="ready-head micro">{m.herd_ready_group({ count: partition.ready.length })}</div>
        {#each partition.ready as session (session.id)}
          <UnitRow
            {session}
            selected={session.id === selectedId}
            {nowMs}
            {onselect}
            git={git[session.id]}
            {ondecommission}
          />
        {/each}
      {/if}
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
  .filters {
    display: flex;
    gap: 4px;
  }
  .fbtn {
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 5px;
    color: var(--color-faint);
    transition: color 0.12s ease;
  }
  .fbtn:hover {
    color: var(--color-ink);
  }
  .fbtn.active {
    color: var(--color-amber);
  }

  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* green section header for the parked "ready to merge" group */
  .ready-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-green);
    border-top: 1px solid color-mix(in srgb, var(--color-green) 30%, var(--color-line));
  }

  .units {
    overflow: auto;
    padding: 6px;
    flex: 1;
    min-height: 0;
    /* size context for UnitRow's container queries — lets rows adapt the
       designator to the actual sidebar width (compact vs desktop) */
    container: herd / inline-size;
  }

  .empty {
    width: 100%;
    padding: 24px 14px;
    text-align: center;
    color: var(--color-faint);
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .empty:hover {
    color: var(--color-ink);
  }
  .empty.static {
    cursor: default;
  }
  .empty.static:hover {
    color: var(--color-faint);
  }
</style>
