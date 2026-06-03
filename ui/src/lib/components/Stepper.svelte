<script lang="ts">
  import type { GitState } from "$lib/types";
  import { reviews } from "$lib/reviews.svelte";
  import { deriveStage, STAGE_ORDER, type Stage } from "./stage";
  import { m } from "$lib/paraglide/messages";

  let {
    sessionId,
    git,
    readyToMerge,
  }: { sessionId: string; git?: GitState; readyToMerge: boolean } = $props();

  const verdict = $derived(reviews.map[sessionId]);
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const info = $derived(deriveStage({ git, verdict, reviewing, readyToMerge }));

  const STAGE_LABEL: Record<Stage, () => string> = {
    coding: m.activity_stage_coding,
    pr: m.activity_stage_pr,
    ci: m.activity_stage_ci,
    review: m.activity_stage_review,
    ready: m.activity_stage_ready,
  };

  // CI segment (index 2) is tinted by the checks rollup once reached.
  const ciReached = $derived(info.index >= 2);
</script>

{#if info.terminal}
  <span class="chip {info.terminal}">
    {info.terminal === "merged" ? m.activity_merged() : m.activity_closed()}
  </span>
{:else}
  <span
    class="stepper"
    role="img"
    aria-label={m.activity_progress({ stage: STAGE_LABEL[info.reached]() })}
  >
    {#each STAGE_ORDER as stage, i (stage)}
      <span
        class="seg"
        class:done={i < info.index}
        class:active={i === info.index}
        class:pending={i > info.index}
        class:ci-success={i === 2 && ciReached && info.ci === "success"}
        class:ci-pending={i === 2 && ciReached && info.ci === "pending"}
        class:ci-failure={i === 2 && ciReached && info.ci === "failure"}
        title={STAGE_LABEL[stage]()}
      ></span>
    {/each}
  </span>
{/if}

<style>
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  /* Small quiet segments for a dense list row. Reduced-motion safe (no animation). */
  .seg {
    width: 10px;
    height: 3px;
    border-radius: 2px;
    background: var(--color-line);
    flex: none;
  }
  .seg.done {
    background: var(--color-muted);
  }
  .seg.active {
    background: var(--color-ink);
  }
  .seg.pending {
    background: var(--color-line);
  }
  /* CI segment tints by the checks rollup once reached (overrides done/active). */
  .seg.ci-success {
    background: var(--color-green);
  }
  .seg.ci-pending {
    background: var(--status-running);
  }
  .seg.ci-failure {
    background: var(--color-red);
  }
  .chip {
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
  }
  .chip.merged {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .chip.closed {
    color: var(--color-faint);
  }
</style>
