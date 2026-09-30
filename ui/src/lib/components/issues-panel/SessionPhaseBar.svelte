<script lang="ts">
  import type { GitState, Session } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { reviews } from "$lib/reviews.svelte";
  import { deriveStage, STAGE_ORDER, type Stage } from "../stage";

  // Labelled phase bar of an epic child's session (#2622): Planning → Implementing → PR →
  // Review → Ready. Same stage logic as the session card's Stepper (stage.ts → deriveStage),
  // spelled out for the reading detail instead of the card's compact lamps.
  let {
    session,
    git = undefined,
  }: {
    session: Pick<Session, "id" | "readyToMerge" | "planPhase">;
    git?: GitState;
  } = $props();

  const info = $derived(
    deriveStage({
      git,
      verdict: reviews.map[session.id],
      reviewing: reviews.isReviewing(session.id),
      readyToMerge: session.readyToMerge,
      planPhase: session.planPhase,
    }),
  );

  const STAGE_LABEL: Record<Stage, () => string> = {
    planning: m.activity_stage_planning,
    implementing: m.activity_stage_implementing,
    pr: m.activity_stage_pr,
    review: m.activity_stage_review,
    ready: m.activity_stage_ready,
  };
</script>

<ol class="phases" aria-label={m.childrun_phase_label()}>
  {#each STAGE_ORDER as stage, i (stage)}
    <li
      class="phase"
      class:done={i < info.index}
      class:current={i === info.index}
      class:skipped={stage === "planning" && info.planningSkipped}
      aria-current={i === info.index ? "step" : undefined}
    >
      <span class="bar" aria-hidden="true"></span>
      <span class="name">{STAGE_LABEL[stage]()}</span>
    </li>
  {/each}
</ol>

<style>
  .phases {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .phase {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .bar {
    height: 3px;
    border-radius: 2px;
    background: var(--color-line);
  }
  .done .bar {
    background: var(--color-muted);
  }
  /* Skipped planning: hollow, as on the session card. */
  .done.skipped .bar {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--color-muted);
  }
  .current .bar {
    background: var(--status-running);
  }

  .name {
    overflow: hidden;
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .done .name {
    color: var(--color-muted);
  }
  .current .name {
    color: var(--status-running);
  }
</style>
