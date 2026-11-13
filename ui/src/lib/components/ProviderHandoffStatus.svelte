<script lang="ts">
  import { m } from "#lib/paraglide/messages.js";
  import type { Session } from "#lib/types.js";
  let { handoff }: { handoff: NonNullable<Session["providerHandoff"]> } = $props();
  const phaseText = $derived(
    handoff.phase === "observed"
      ? m.handoff_observed()
      : {
          preparing: m.handoff_phase_preparing,
          stopped: m.handoff_phase_stopped,
          bootstrap: m.handoff_phase_bootstrap,
          pending: m.handoff_phase_pending,
          sent: m.handoff_phase_sent,
          uncertain: m.handoff_phase_uncertain,
          failed: m.handoff_phase_failed,
        }[handoff.phase](),
  );
  const gapText = (gap: string) =>
    gap.startsWith("git")
      ? m.handoff_git_gap()
      : gap.startsWith("plan")
        ? m.handoff_plan_gap()
        : gap.startsWith("evidence")
          ? m.handoff_storage_gap()
          : m.handoff_transcript_gap();
  const gaps = $derived([...new Set(handoff.gaps.map(gapText))]);
</script>

<details class="handoff">
  <summary>{m.handoff_title()}: {phaseText}{gaps.length ? ` · ${m.handoff_partial()}` : ""}</summary
  >
  <p>{m.handoff_route({ source: handoff.sourceProvider, target: handoff.targetProvider })}</p>
  {#if handoff.phase === "failed" && handoff.sourceStopped === false}<p>
      {m.handoff_source_unchanged()}
    </p>
  {:else if handoff.phase !== "observed"}<p>{m.handoff_waiting()}</p>{/if}
  {#if handoff.waitingForOperator}<p>{m.handoff_summary_waiting()}</p>{/if}
  {#if gaps.length}
    <strong>{m.handoff_gaps()}</strong>
    <ul>
      {#each gaps as gap (gap)}<li>{gap}</li>{/each}
    </ul>
  {/if}
</details>

<style>
  .handoff {
    padding: 8px 12px;
    background: var(--color-head);
    color: var(--color-muted);
    font-size: var(--fs-meta);
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
  }
  p,
  ul {
    margin-block: 8px;
  }
</style>
