<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import { placementReason, placementRefusalText } from "#lib/placement.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { placementExplanation } from "#lib/tooltips/explanations.js";
  import type { PlacementPreview } from "#lib/types.js";

  // Where the task will run and why (#2772), before it is submitted: the server's preview of the
  // very choice the create makes. A refusal reads as a warning — submitting would start nothing.
  let {
    preview,
    failed = false,
    selfId = null,
  }: { preview: PlacementPreview | null; failed?: boolean; selfId?: string | null } = $props();

  const placement = $derived(preview?.placement ?? null);
  const machine = $derived(
    placement && placement.target.instanceId === selfId
      ? m.placement_this_machine({ machine: placement.target.name })
      : (placement?.target.name ?? ""),
  );
</script>

{#if placement}
  <button
    type="button"
    class="nt-placement"
    use:statusTip={{ text: placementExplanation(placement), wide: true }}
  >
    {m.placement_runs_on({ machine, reason: placementReason(placement) })}
  </button>
{:else if preview?.refusal}
  <span class="nt-placement warn" role="status">{placementRefusalText(preview.refusal)}</span>
{:else if failed}
  <span class="nt-placement" role="status">{m.placement_preview_failed()}</span>
{:else if !preview}
  <span class="nt-placement" role="status">{m.placement_choosing()}</span>
{/if}

<style>
  .nt-placement {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  button.nt-placement {
    background: transparent;
    border: none;
    padding: 0;
    font-family: inherit;
    text-align: left;
    cursor: help;
  }
  .nt-placement.warn {
    color: var(--status-warn);
  }
</style>
