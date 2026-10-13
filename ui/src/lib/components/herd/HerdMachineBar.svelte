<script lang="ts">
  import type { Session } from "#lib/types.js";
  import type { MachineFilter } from "#lib/remote-sessions.js";
  import { machines } from "#lib/machines.svelte.js";
  import { m } from "#lib/paraglide/messages.js";

  // The herd's machine bar (#3055): "All machines", this Shepherd, and every configured machine —
  // from the machine list, not the sessions, so a machine with none still has its chip, with 0 —
  // each with how many sessions the current lens shows there. A chip narrows the herd to its
  // machine. A machine whose probe did not get through says so. The parent renders the bar only
  // while a machine is configured.
  let {
    filter = $bindable<MachineFilter>("all"),
    localCount,
    remote,
    touch = false,
  }: {
    filter?: MachineFilter;
    /** This Shepherd's sessions under the current lens. */
    localCount: number;
    /** The mirrored sessions under the current lens, of every machine. */
    remote: readonly Session[];
    /** Coarse pointer: 44px targets. */
    touch?: boolean;
  } = $props();

  type Chip = {
    id: MachineFilter;
    label: string;
    count: number;
    color: string | null;
    disconnected: boolean;
  };

  const chips = $derived<Chip[]>([
    {
      id: "all",
      label: m.herd_machine_all(),
      count: localCount + remote.length,
      color: null,
      disconnected: false,
    },
    {
      id: "local",
      label: machines.self?.name ?? m.herd_machine_this(),
      count: localCount,
      color: null,
      disconnected: false,
    },
    ...machines.list.map((x) => ({
      id: x.instanceId,
      label: machines.names.get(x.instanceId) ?? x.name,
      count: remote.filter((s) => s.host?.instanceId === x.instanceId).length,
      color: machines.colorOf(x.instanceId),
      disconnected: x.status !== "connected" && x.status !== "checking",
    })),
  ]);
</script>

<div class="machine-bar" class:touch role="group" aria-label={m.herd_machines_label()}>
  {#each chips as chip (chip.id)}
    <button
      type="button"
      class="chip"
      class:on={filter === chip.id}
      aria-pressed={filter === chip.id}
      style:--machine-color={chip.color}
      onclick={() => (filter = chip.id)}
    >
      {#if chip.color}<span class="dot" aria-hidden="true"></span>{/if}
      <span class="lb">{chip.label}</span>
      <span class="n">{chip.count}</span>
      {#if chip.disconnected}<span class="off">{m.remote_state_disconnected()}</span>{/if}
    </button>
  {/each}
</div>

<style>
  /* A thin row under the lens strip, wrapping on a narrow rail. The pressed chip takes the lens
     strip's active treatment (amber on the inset wash); a machine's dot wears its data hue —
     identity, never a status color. */
  .machine-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    padding: 3px 8px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: none;
    color: var(--color-muted);
    font: var(--fs-meta) var(--font-mono);
    letter-spacing: 0.02em;
    cursor: pointer;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .touch .chip {
    min-height: 44px;
  }
  .chip:hover {
    color: var(--color-ink);
  }
  .chip.on {
    color: var(--color-amber);
    border-color: var(--color-amber);
    background: var(--color-inset);
  }
  .chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--machine-color);
  }
  .lb {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n {
    flex: none;
    color: var(--color-muted);
  }
  .off {
    flex: none;
    color: var(--color-amber);
  }
</style>
