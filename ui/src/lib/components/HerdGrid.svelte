<script lang="ts">
  import type { Session, GitState, SessionActivity } from "$lib/types";
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
    activity = {},
    issueActionsUnset = false,
    onsettings = undefined,
    filteredRepo = null,
    statusFilter = null,
    onrelaunch = undefined,
    onrelaunchElsewhere = undefined,
    onvariant = undefined,
    onreplace = undefined,
    workingBlocked = {},
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    onnew: () => void;
    git: Record<string, GitState>;
    // per-session live activity (heartbeat) — threaded into the tiles' TimePopover
    activity?: Record<string, SessionActivity>;
    // when provided, each tile's CardMenu gains a two-step armed Relaunch action
    onrelaunch?: (id: string) => void;
    // when provided, each tile's CardMenu gains a one-click "Relaunch elsewhere" item
    onrelaunchElsewhere?: (id: string) => void;
    // when provided, each tile's CardMenu gains "Start as variant…" / "Replace with…" items
    onvariant?: (id: string, anchor: { x: number; y: number }) => void;
    onreplace?: (id: string, anchor: { x: number; y: number }) => void;
    issueActionsUnset?: boolean;
    onsettings?: () => void;
    // basename of an active repo filter; empty + filtered → neutral note, not EmptyHerd
    filteredRepo?: string | null;
    // page-level status filter (TopBar tallies); sessions arrive pre-filtered,
    // the prop only picks the right empty-state copy
    statusFilter?: "running" | "idle" | "blocked" | null;
    // working-while-blocked display flags (store map) — threaded into the tiles' displayStatus
    workingBlocked?: Record<string, boolean>;
  } = $props();

  const statusLabel = $derived(
    statusFilter === "running"
      ? m.topbar_working_label()
      : statusFilter === "idle"
        ? m.topbar_idle_label()
        : m.topbar_blocked_label(),
  );
</script>

{#if sessions.length === 0}
  <!-- status-filter emptiness happens at page level, so it lands in this branch
       and must outrank the repo note and the first-run EmptyHerd nudge -->
  {#if statusFilter != null && filteredRepo}
    <div class="grid-empty">
      {m.herd_status_repo_filter_empty({ status: statusLabel, repo: filteredRepo })}
    </div>
  {:else if statusFilter != null}
    <div class="grid-empty">{m.herd_status_filter_empty({ status: statusLabel })}</div>
  {:else if filteredRepo}
    <div class="grid-empty">{m.herd_repo_filter_empty({ repo: filteredRepo })}</div>
  {:else}
    <EmptyHerd {onnew} {issueActionsUnset} {onsettings} />
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
        activity={activity[session.id]}
        {onrelaunch}
        {onrelaunchElsewhere}
        {onvariant}
        {onreplace}
        {workingBlocked}
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
