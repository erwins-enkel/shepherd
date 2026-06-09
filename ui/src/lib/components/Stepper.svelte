<script lang="ts">
  import type { GitState } from "$lib/types";
  import { reviews } from "$lib/reviews.svelte";
  import { deriveStage, STAGE_ORDER, CI_INDEX, type Stage } from "./stage";
  import type { ChecksState } from "$lib/types";
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

  // Localized CI verdict word, keyed by the checks rollup.
  const CI_STATE_LABEL: Partial<Record<ChecksState, () => string>> = {
    success: m.activity_ci_success,
    pending: m.activity_ci_pending,
    failure: m.activity_ci_failure,
  };

  // CI segment is tinted by the checks rollup once that stage is reached.
  const ciReached = $derived(info.index >= CI_INDEX);

  // Accessible name: progress + (once CI reached) the CI verdict, so pass/fail
  // is conveyed by text — not by segment color alone (WCAG 1.4.1).
  // When the PR has no checks (`info.ci === "none"`) the CI clause is intentionally
  // omitted: there's no verdict to announce, and "CI: none" would be noise. `none`
  // therefore has no CI_STATE_LABEL entry, so `ciWord` is undefined and we fall through.
  const ariaLabel = $derived.by(() => {
    const progress = m.activity_progress({ stage: STAGE_LABEL[info.reached]() });
    const ciWord = CI_STATE_LABEL[info.ci]?.();
    if (ciReached && ciWord) return `${progress} · ${m.activity_ci_status({ state: ciWord })}`;
    return progress;
  });
</script>

{#if info.terminal}
  <span class="chip {info.terminal}">
    {info.terminal === "merged" ? m.activity_merged() : m.activity_closed()}
  </span>
{:else}
  <span class="stepper" role="img" aria-label={ariaLabel}>
    {#each STAGE_ORDER as stage, i (stage)}
      <span
        class="seg"
        class:done={i < info.index}
        class:active={i === info.index}
        class:pending={i > info.index}
        class:ci-success={i === CI_INDEX && ciReached && info.ci === "success"}
        class:ci-pending={i === CI_INDEX && ciReached && info.ci === "pending"}
        class:ci-failure={i === CI_INDEX && ciReached && info.ci === "failure"}
        aria-hidden="true"
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
  /* Failure also carries a non-color cue (a ring + extra height) so it differs
     from success by shape/weight, not hue alone (WCAG 1.4.1). No animation. */
  .seg.ci-failure {
    background: var(--color-red);
    height: 5px;
    outline: 1px solid var(--color-red);
    outline-offset: 1px;
  }
  .chip {
    font-size: var(--fs-micro);
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
