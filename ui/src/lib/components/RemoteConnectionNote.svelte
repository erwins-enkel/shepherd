<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { lastKnownLabel } from "#lib/remote-sessions.js";

  // "Disconnected – last known 14:32" under a mirrored session whose machine is unreachable
  // (#2762): the status beside it is the last one known, not an end. Nothing otherwise.
  let { session, nowMs }: { session: Session; nowMs: number } = $props();
</script>

{#if session.connection?.state === "disconnected"}
  <div class="remote-offline">
    {m.remote_disconnected_line({ time: lastKnownLabel(session.connection.since, nowMs) })}
  </div>
{/if}

<style>
  .remote-offline {
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    color: var(--color-amber);
  }
</style>
