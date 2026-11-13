<script lang="ts">
  // #3016: an integrated epic child whose session on another machine is still to settle there, but
  // which no row in this herd carries — its session is not in this Shepherd's mirror (not loaded
  // yet, or gone there). The repo's drain status reports it, so it outlives the epic's record.
  import { m } from "#lib/paraglide/messages.js";
  import type { PendingSettle } from "#lib/integrated-child-note.js";
  import MachineBadge from "../MachineBadge.svelte";
  import IntegratedChildNote from "./IntegratedChildNote.svelte";

  let { settle }: { settle: PendingSettle } = $props();
</script>

<div
  class="settle-row"
  role="group"
  aria-label={m.integrated_pending_row_aria({
    machine: settle.host.name,
    issue: String(settle.issueNumber),
  })}
>
  <MachineBadge host={settle.host} />
  <span class="settle-issue">#{settle.issueNumber}</span>
  <IntegratedChildNote
    note={{
      parentIssueNumber: settle.parentIssueNumber,
      host: settle.host,
      settle: settle.reason,
    }}
  />
</div>

<style>
  /* Not a session here: a quiet row like an unconfirmed dispatch, under the lifecycle groups. */
  .settle-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    min-width: 0;
    padding: 6px 8px;
    border-bottom: 1px dashed var(--color-line);
  }
  .settle-issue {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
</style>
