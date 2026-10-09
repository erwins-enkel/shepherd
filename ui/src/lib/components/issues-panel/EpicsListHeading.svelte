<script lang="ts">
  import type { DrainRunSummary } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { epicLeadExplanation } from "#lib/tooltips/explanations.js";
  import GlossaryText from "../GlossaryText.svelte";
  import SlotStepper, { slotCap } from "./SlotStepper.svelte";

  // Heading over the backlog list's epics (#2620): names the one-epic-leads rule and the repo's
  // agent-slot use, with −/+ for the cap (maxAuto) and a link to it in the Automation tab.
  let {
    repoPath,
    runSummary = null,
    onopenautomation = undefined,
  }: {
    repoPath: string;
    runSummary?: DrainRunSummary | null;
    onopenautomation?: () => void;
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
      <GlossaryText
        text={m.issuespanel_slots({
          used: runSummary.slots.used,
          max: slotCap(repoPath, runSummary.slots.max),
        })}
      />
      <SlotStepper {repoPath} max={runSummary.slots.max} />
      {#if onopenautomation}
        ·
        <button class="change" type="button" onclick={onopenautomation}
          >{m.issuespanel_slots_change()}</button
        >
      {/if}
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
    color: var(--color-faint);
  }

  /* Text-link recipe (as IssuesPanel's .retry-link). */
  .change {
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .change:hover,
  .change:focus-visible {
    color: var(--color-amber);
    outline: none;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .change {
      min-height: 32px;
    }
  }
</style>
