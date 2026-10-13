<script lang="ts">
  import type { SessionConnection, SessionHost } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { machines } from "#lib/machines.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { remoteSessionExplanation } from "#lib/tooltips/explanations.js";

  // The machine a mirrored session (#2762) or an unconfirmed task (#2774) runs on: its name in the
  // machine's own color (#3055), so its cards read as one among the local ones. With a link state
  // (a session) the tooltip explains where it runs, the state of the link and why its actions are
  // not offered here; a task's row explains itself.
  let {
    host,
    connection = null,
    nowMs = 0,
  }: {
    host: SessionHost;
    connection?: SessionConnection | null;
    /** Only the link's tooltip reads the clock; a task's badge has none. */
    nowMs?: number;
  } = $props();

  const color = $derived(machines.colorOf(host.instanceId));
</script>

<span
  class="machine-badge"
  class:offline={connection?.state === "disconnected"}
  style:--machine-color={color}
  role="img"
  aria-label={m.remote_runs_on({ machine: host.name })}
  use:statusTip={connection ? { text: remoteSessionExplanation(host, connection, nowMs) } : null}
  >{host.name}</span
>

<style>
  /* Identity, not state: the machine's data hue on the dot and the outline, never a status color;
     the name keeps the readable slate of the other informational segments. A machine not yet
     known keeps the neutral line color. A lost link adds the amber ⚠ the degraded-sandbox segment
     uses — a standing condition, not a call to act. */
  .machine-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    border: 1px solid var(--machine-color, var(--color-line-bright));
    border-radius: 6px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    color: var(--color-slate);
    font-weight: 600;
    white-space: nowrap;
  }
  .machine-badge::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--machine-color, var(--color-line-bright));
  }
  .machine-badge.offline::before {
    content: "⚠";
    width: auto;
    height: auto;
    border-radius: 0;
    background: none;
    color: var(--color-amber);
    letter-spacing: 0;
  }
</style>
