<script lang="ts">
  import type { DrainRunSummary } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { agentSlotExplanation, epicLeadExplanation } from "#lib/tooltips/explanations.js";
  import SlotStepper, { slotCap } from "./SlotStepper.svelte";

  // Heading over the backlog list's epics (#2620): names the one-epic-leads rule and, at the
  // right, the repo's agent-slot use as "used/max" with −/+ for the cap (maxAuto). Kept to the
  // bare count so it fits the narrow list column; the label lives in the aria-label and tooltip.
  let {
    repoPath,
    runSummary = null,
  }: {
    repoPath: string;
    runSummary?: DrainRunSummary | null;
  } = $props();
</script>

<div class="epics-heading">
  <span class="rule"
    >{m.issuespanel_epics_heading()} ·
    <span class="lead" use:statusTip={{ text: epicLeadExplanation(), placement: "right" }}
      >{m.issuespanel_epics_one_leads()}</span
    ></span
  >
  {#if runSummary}
    <span class="slots">
      <span
        class="count"
        role="img"
        aria-label={m.issuespanel_slots_aria({
          used: runSummary.slots.used,
          max: slotCap(repoPath, runSummary.slots.max),
        })}
        use:statusTip={{ text: agentSlotExplanation(), placement: "bottom" }}
        >{runSummary.slots.used}/{slotCap(repoPath, runSummary.slots.max)}</span
      >
      <SlotStepper {repoPath} max={runSummary.slots.max} />
    </span>
  {/if}
</div>

<style>
  .epics-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 4px 10px;
    padding: 8px 2px 2px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .lead {
    color: var(--color-faint);
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }

  .slots {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-faint);
  }
  .count {
    letter-spacing: 0.08em;
  }
</style>
