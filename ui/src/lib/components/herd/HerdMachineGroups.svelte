<script lang="ts">
  import type { Session } from "#lib/types.js";
  import type { HerdFilter } from "../herd-partition";
  import { m } from "#lib/paraglide/messages.js";
  import UnitRow from "../UnitRow.svelte";
  import { machineGroups, platformName } from "#lib/remote-sessions.js";

  // Sessions mirrored from connected machines (#2762): one read-only group per machine, after
  // the local lifecycle groups. Only in the "all" lens — the others are about what to act on
  // here, and these sessions cannot be acted on from this machine. The rows get no action
  // callbacks; UnitRow's remote mode shows the machine and why its actions are not offered.
  let {
    sessions,
    filter,
    selectedId,
    nowMs,
    onselect,
  }: {
    sessions: Session[];
    filter: HerdFilter;
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
  } = $props();

  const groups = $derived(filter === "all" ? machineGroups(sessions) : []);
</script>

{#each groups as group (group.host.instanceId)}
  <section class="machine-group" aria-label={m.remote_group_aria({ machine: group.host.name })}>
    <div class="machine-head micro">
      <span class="machine-name">{group.host.name}</span>
      <span class="machine-platform">{platformName(group.host.platform)}</span>
      <span class="machine-state" class:offline={group.connection.state === "disconnected"}
        >{group.connection.state === "connected"
          ? m.remote_state_connected()
          : m.remote_state_disconnected()}</span
      >
    </div>
    {#each group.sessions as session (session.id)}
      <UnitRow {session} selected={session.id === selectedId} {nowMs} {onselect} />
    {/each}
  </section>
{/each}

<style>
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* Slate like the other "noted, not yours to act on" headers; a lost link turns only its
     state word amber. */
  .machine-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-slate);
    border-top: 1px solid color-mix(in srgb, var(--color-slate) 30%, var(--color-line));
  }
  .machine-name {
    color: var(--color-ink);
    letter-spacing: 0.08em;
    text-transform: none;
  }
  .machine-state {
    margin-left: auto;
  }
  .machine-state.offline {
    color: var(--color-amber);
  }
</style>
