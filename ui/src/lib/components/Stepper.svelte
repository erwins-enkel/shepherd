<script lang="ts">
  import type { GitState, Session } from "$lib/types";
  import { reviews } from "$lib/reviews.svelte";
  import { deriveStage, STAGE_ORDER, PR_INDEX, REVIEW_INDEX, type Stage } from "./stage";
  import type { ChecksState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  let {
    sessionId,
    git,
    readyToMerge,
    planPhase = null,
  }: {
    sessionId: string;
    git?: GitState;
    readyToMerge: boolean;
    planPhase?: Session["planPhase"];
  } = $props();

  const verdict = $derived(reviews.map[sessionId]);
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const info = $derived(deriveStage({ git, verdict, reviewing, readyToMerge, planPhase }));

  const STAGE_LABEL: Record<Stage, () => string> = {
    planning: m.activity_stage_planning,
    implementing: m.activity_stage_implementing,
    pr: m.activity_stage_pr,
    review: m.activity_stage_review,
    ready: m.activity_stage_ready,
  };

  // Localized CI verdict word, keyed by the checks rollup.
  const CI_STATE_LABEL: Partial<Record<ChecksState, () => string>> = {
    success: m.activity_ci_success,
    pending: m.activity_ci_pending,
    failure: m.activity_ci_failure,
  };

  // Localized review verdict word. `none` and `error` carry no word — there is
  // no verdict to announce, so the review clause/tint is omitted for both.
  const REVIEW_STATE_LABEL: Partial<Record<(typeof info)["review"], () => string>> = {
    reviewing: m.activity_review_reviewing,
    changes: m.activity_review_changes,
    approved: m.activity_review_approved,
  };

  const prReached = $derived(info.index >= PR_INDEX);
  const reviewReached = $derived(info.index >= REVIEW_INDEX);

  // Tint class for segment `i` (and the matching legend swatch): the PR segment
  // carries the checks rollup, the review segment the critic/GH-review verdict.
  function segTint(i: number): string | null {
    if (i === PR_INDEX && prReached && info.ci !== "none") return `ci-${info.ci}`;
    if (i === REVIEW_INDEX && reviewReached && REVIEW_STATE_LABEL[info.review])
      return `rv-${info.review}`;
    return null;
  }

  // Verdict word appended to a tinted PR/review row in the legend ("PR — failing").
  function legendVerdict(i: number): string | undefined {
    const tint = segTint(i);
    if (tint?.startsWith("ci-")) return CI_STATE_LABEL[info.ci]?.();
    if (tint?.startsWith("rv-")) return REVIEW_STATE_LABEL[info.review]?.();
    return undefined;
  }

  function legendState(i: number): string {
    if (i < info.index)
      return i === 0 && info.planningSkipped ? m.stepper_legend_skipped() : m.stepper_legend_done();
    if (i === info.index) return m.stepper_legend_now();
    return m.stepper_legend_pending();
  }

  // Accessible name: progress + CI verdict (once the PR stage is reached) + review
  // verdict (once the review stage is reached), so pass/fail is conveyed by text —
  // not by segment color alone (WCAG 1.4.1). States without a *_STATE_LABEL entry
  // (`none`, review `error`) have no verdict to announce and omit their clause.
  const ariaLabel = $derived.by(() => {
    const parts: string[] = [m.activity_progress({ stage: STAGE_LABEL[info.reached]() })];
    const ciWord = CI_STATE_LABEL[info.ci]?.();
    if (prReached && ciWord) parts.push(m.activity_ci_status({ state: ciWord }));
    const reviewWord = REVIEW_STATE_LABEL[info.review]?.();
    if (reviewReached && reviewWord) parts.push(m.activity_review_status({ state: reviewWord }));
    return parts.join(" · ");
  });

  // --- Hover legend (desktop only; pure visual duplicate of ariaLabel) ---
  const LEGEND_W = 220;
  // Flip the popover below the stepper when there isn't room above it.
  // ~110px legend height + ~50px margin headroom = 160px safe zone from top.
  const FLIP_BELOW_PX = 160;
  let stepperEl: HTMLSpanElement | undefined = $state();
  // null = closed; `top` xor `bottom` set depending on flip.
  let legendPos = $state<{ top?: number; bottom?: number; left: number } | null>(null);

  function openLegend() {
    // Touch devices fire synthetic mouseenter on tap — guard with hover-capable check
    // so the legend only opens for real pointer devices (CSS hover media query).
    if (!window.matchMedia("(hover: hover)").matches) return;
    const r = stepperEl?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - LEGEND_W - 8));
    // position: fixed because the card clips (overflow: hidden); above by
    // default, flipped below when too close to the viewport top.
    legendPos =
      r.top < FLIP_BELOW_PX
        ? { top: r.bottom + 6, left }
        : { bottom: window.innerHeight - r.top + 6, left };
  }

  // A fixed-position popover detaches from its row on scroll — dismiss immediately.
  $effect(() => {
    if (!legendPos) return;
    const close = () => (legendPos = null);
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  });
</script>

{#if info.terminal}
  <span class="chip {info.terminal}">
    {info.terminal === "merged" ? m.activity_merged() : m.activity_closed()}
  </span>
{:else}
  <span
    class="stepper"
    role="img"
    aria-label={ariaLabel}
    bind:this={stepperEl}
    onmouseenter={openLegend}
    onmouseleave={() => (legendPos = null)}
  >
    {#each STAGE_ORDER as stage, i (stage)}
      <span
        class="seg {segTint(i) ?? ''}"
        class:done={i < info.index}
        class:active={i === info.index}
        class:pending={i > info.index}
        aria-hidden="true"
      ></span>
    {/each}
    {#if legendPos}
      <!-- visual-only duplicate of ariaLabel (no role, inert to pointer/AT) -->
      <span
        class="legend"
        aria-hidden="true"
        style:width="{LEGEND_W}px"
        style:left="{legendPos.left}px"
        style:top={legendPos.top != null ? `${legendPos.top}px` : undefined}
        style:bottom={legendPos.bottom != null ? `${legendPos.bottom}px` : undefined}
      >
        {#each STAGE_ORDER as stage, i (stage)}
          {@const verdictWord = legendVerdict(i)}
          <span class="lg-row" class:cur={i === info.index}>
            <span
              class="seg sw {segTint(i) ?? ''}"
              class:done={i < info.index}
              class:active={i === info.index}
              class:pending={i > info.index}
            ></span>
            <span class="lg-label">
              {STAGE_LABEL[stage]()}{verdictWord ? ` — ${verdictWord}` : ""}
            </span>
            <span class="lg-state">{legendState(i)}</span>
          </span>
        {/each}
      </span>
    {/if}
  </span>
{/if}

<style>
  .stepper {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  /* Small quiet segments for a dense list row. */
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
  /* PR segment tints by the checks rollup, review segment by the review verdict,
     once each stage is reached (overrides done/active). */
  .seg.ci-success,
  .seg.rv-approved {
    background: var(--color-green);
  }
  .seg.ci-pending,
  .seg.rv-reviewing {
    background: var(--status-running);
  }
  @media (prefers-reduced-motion: no-preference) {
    .seg.ci-pending,
    .seg.rv-reviewing {
      animation: seg-pulse 1.8s ease-in-out infinite;
    }
  }
  @keyframes seg-pulse {
    50% {
      opacity: 0.45;
    }
  }
  /* Failure/changes also carry a non-color cue (a ring + extra height) so red
     differs from green by shape/weight, not hue alone (WCAG 1.4.1). No animation. */
  .seg.ci-failure,
  .seg.rv-changes {
    background: var(--color-red);
    height: 5px;
    outline: 1px solid var(--color-red);
    outline-offset: 1px;
  }
  /* Hover legend — fixed so the card's overflow:hidden can't clip it.
     Width is set via style:width="{LEGEND_W}px" to keep the single source of truth. */
  .legend {
    position: fixed;
    z-index: 30;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    font-size: var(--fs-micro);
    line-height: 1.5;
    text-align: left;
  }
  .lg-row {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-muted);
  }
  .lg-row.cur {
    color: var(--color-ink);
  }
  .lg-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lg-state {
    flex: none;
  }
  /* legend swatch reuses .seg state classes; pulse animation inherited. */
  .seg.sw {
    width: 12px;
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
