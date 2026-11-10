<script lang="ts">
  import type { CompletedEpic } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { formatAgo } from "#lib/format.js";
  import { successTime } from "#lib/succeeded-epics.js";

  // #3838: a succeeded epic's fully ticked path to main — through its landing PR, or, for an
  // incremental epic, child by child with no landing PR at all.
  let { epic, nowMs }: { epic: CompletedEpic; nowMs: number } = $props();

  const number = $derived(epic.parentIssueNumber);
  const total = $derived(epic.children.length);
  const included = $derived(epic.children.filter((c) => c.integrated).length);
  const landingLabel = $derived(
    epic.landingPrNumber != null
      ? m.integrated_epics_path_landing({ number: epic.landingPrNumber })
      : m.integrated_epics_path_landing_nonum(),
  );
  type Step = { label: string; value: string; detail?: string | null; final?: boolean };
  const steps = $derived<Step[]>(
    epic.outcome === "incremental"
      ? [
          { label: m.succeeded_epics_path_tasks_incremental(), value: `${total}` },
          {
            label: m.succeeded_epics_path_closed({ number }),
            value: m.succeeded_epics_path_no_landing(),
            final: true,
          },
        ]
      : [
          { label: m.integrated_epics_path_tasks(), value: `${included}/${total}` },
          {
            label: m.integrated_epics_path_collected(),
            value: m.integrated_epics_path_pr_count({ count: included }),
            detail: epic.integrationBranch,
          },
          {
            label: landingLabel,
            value: m.integrated_epics_child_merged_ago({
              ago: formatAgo(nowMs - successTime(epic)),
            }),
          },
          {
            label: m.integrated_epics_path_landed(),
            value: m.succeeded_epics_path_closed({ number }),
            final: true,
          },
        ],
  );
</script>

<section aria-label={m.integrated_epics_path_heading()}>
  <h4>{m.integrated_epics_path_heading()}</h4>
  <ol class="path">
    {#each steps as step, i (i)}
      <li class:final={step.final}>
        <span class="marker"
          ><svg viewBox="0 0 12 12" aria-hidden="true"
            ><path
              d="M2.5 6.4l2.3 2.3 4.7-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            /></svg
          ></span
        ><span class="step"><span>{step.label}</span><span class="value">{step.value}</span></span>
        {#if step.detail}<span class="branch">{step.detail}</span>{/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  h4 {
    margin: 0 0 8px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .path {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .path li {
    display: grid;
    grid-template-columns: 15px minmax(0, 1fr);
    gap: 3px 8px;
  }
  .marker {
    display: grid;
    place-items: center;
    width: 15px;
    height: 15px;
    box-sizing: border-box;
    border: 1px solid var(--status-done);
    border-radius: 50%;
    color: var(--color-muted);
  }
  .marker svg {
    width: 8px;
    height: 8px;
  }
  .final .marker {
    border-color: var(--color-ink-bright);
    background: var(--color-ink-bright);
    color: var(--color-panel);
  }
  .step {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
    color: var(--color-ink);
  }
  .final .step {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .value {
    font-size: var(--fs-micro);
    font-weight: 400;
    color: var(--color-muted);
    text-align: right;
  }
  .final .value {
    color: var(--color-ink);
  }
  .branch {
    grid-column: 2;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }
</style>
