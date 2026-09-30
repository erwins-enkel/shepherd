<script lang="ts">
  import type { DrainRunSummary } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { statusTip } from "$lib/tooltips/statusTip.svelte";
  import { epicLeadExplanation } from "$lib/tooltips/explanations";
  import GlossaryText from "../GlossaryText.svelte";

  // Heading over the backlog list's epics (#2620): names the one-epic-leads rule and the repo's
  // agent-slot use, with a link to the cap (maxAuto) in the Automation tab.
  let {
    runSummary = null,
    onopenautomation = undefined,
  }: {
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
        text={m.issuespanel_slots({ used: runSummary.slots.used, max: runSummary.slots.max })}
      />
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
