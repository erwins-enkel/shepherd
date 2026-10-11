<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { remoteSessionExplanation } from "#lib/tooltips/explanations.js";

  // The machine a mirrored session runs on (#2762); nothing for a local session. The tooltip
  // explains where it runs, the state of the link and why its actions are not offered here.
  let { session, nowMs }: { session: Session; nowMs: number } = $props();
</script>

{#if session.host && session.connection}
  <span
    class="machine-badge"
    class:offline={session.connection.state === "disconnected"}
    role="img"
    aria-label={m.remote_runs_on({ machine: session.host.name })}
    use:statusTip={{ text: remoteSessionExplanation(session.host, session.connection, nowMs) }}
    >{session.host.name}</span
  >
{/if}

<style>
  /* Identity, not state: slate like the other informational segments. A lost link adds the
     amber ⚠ the degraded-sandbox segment uses — a standing condition, not a call to act. */
  .machine-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    color: var(--color-slate);
    font-weight: 600;
    white-space: nowrap;
  }
  .machine-badge.offline::before {
    content: "⚠";
    color: var(--color-amber);
    letter-spacing: 0;
  }
</style>
