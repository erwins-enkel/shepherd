<script lang="ts">
  import type { GitState, Session } from "$lib/types";
  import { reviews } from "$lib/reviews.svelte";
  import { deriveStage, STAGE_ORDER, PR_INDEX, REVIEW_INDEX, type Stage } from "./stage";
  import type { ChecksState } from "$lib/types";
  import { anchorPopover } from "$lib/floating-anchor";
  import { m } from "$lib/paraglide/messages";

  let {
    sessionId,
    git,
    readyToMerge,
    planPhase = null,
    onactivate,
  }: {
    sessionId: string;
    git?: GitState;
    readyToMerge: boolean;
    planPhase?: Session["planPhase"];
    // Activating the bar (click / Enter / Space) selects the row — same action as
    // the card's primary .unit-hit button. Optional so the component stays usable
    // standalone (e.g. tests / stories).
    onactivate?: () => void;
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

  // Plain-language explanation of what each stage means, shown per legend row.
  const STAGE_DESC: Record<Stage, () => string> = {
    planning: m.stepper_desc_planning,
    implementing: m.stepper_desc_implementing,
    pr: m.stepper_desc_pr,
    review: m.stepper_desc_review,
    ready: m.stepper_desc_ready,
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

  // Progress summary: stage + CI verdict (once PR reached) + review verdict (once
  // review reached), so pass/fail is conveyed by text, not segment color alone
  // (WCAG 1.4.1). States without a *_STATE_LABEL entry (`none`, review `error`)
  // omit their clause.
  const progressLabel = $derived.by(() => {
    const parts: string[] = [m.activity_progress({ stage: STAGE_LABEL[info.reached]() })];
    const ciWord = CI_STATE_LABEL[info.ci]?.();
    if (prReached && ciWord) parts.push(m.activity_ci_status({ state: ciWord }));
    const reviewWord = REVIEW_STATE_LABEL[info.review]?.();
    if (reviewReached && reviewWord) parts.push(m.activity_review_status({ state: reviewWord }));
    return parts.join(" · ");
  });

  // Accessible name discloses the activation target (activating opens the session,
  // same as the primary .unit-hit button) — not only the progress status.
  const openLabel = $derived(`${m.stepper_open_hint()} · ${progressLabel}`);

  // --- Legend tooltip (native top-layer popover; desktop hover/focus only) ---
  // Reuses the InfoTip / anchorPopover recipe so the popover escapes the card's
  // overflow clipping and is placed with Floating UI flip/shift.
  const legendId = $props.id();
  let open = $state(false);
  let stepperEl = $state<HTMLButtonElement | null>(null);
  let legendEl = $state<HTMLElement | null>(null);

  const isCoarse = () =>
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

  // Fine pointer: hover opens. Touch pointerenter is skipped so a tap just selects
  // the row (no tap-toggle) rather than popping a desktop tooltip.
  function onEnter(e: PointerEvent) {
    if (e.pointerType !== "touch") open = true;
  }
  // Focus opens on fine pointers only. A touch tap also focuses the button, so
  // gating on coarse keeps a tap from opening the tooltip (point: desktop affordance).
  function onOpen() {
    if (!isCoarse()) open = true;
  }
  function onClose() {
    open = false;
  }

  // Position the popover above the bar whenever open + both elements exist.
  // anchorPopover's teardown hides the popover, so flipping `open` false closes it.
  $effect(() => {
    if (!open || !stepperEl || !legendEl) return;
    try {
      legendEl.showPopover();
    } catch {
      return; // not connected this tick — effect re-runs once legendEl mounts
    }
    return anchorPopover(stepperEl, legendEl, 6, "top");
  });

  // Dismiss on Esc, outside pointerdown, and scroll/resize (mirrors InfoTip).
  $effect(() => {
    if (!open) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") open = false;
    }
    function onPointerdown(e: PointerEvent) {
      if (
        legendEl &&
        !legendEl.contains(e.target as Node) &&
        stepperEl &&
        !stepperEl.contains(e.target as Node)
      ) {
        open = false;
      }
    }
    function onScrollOrResize() {
      open = false;
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("pointerdown", onPointerdown);
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
      window.removeEventListener("scroll", onScrollOrResize, { capture: true });
      window.removeEventListener("resize", onScrollOrResize);
    };
  });
</script>

{#if info.terminal}
  <span class="chip {info.terminal}">
    {info.terminal === "merged" ? m.activity_merged() : m.activity_closed()}
  </span>
{:else}
  <!-- Activatable, focusable control (a real <button>, not a clickable role=img):
       hover/focus reveals the legend, click/Enter/Space selects the row. Raised
       above the .unit-hit overlay so it actually receives the pointer/focus. -->
  <button
    type="button"
    class="stepper"
    aria-label={openLabel}
    aria-describedby={legendId}
    bind:this={stepperEl}
    onpointerenter={onEnter}
    onpointerleave={onClose}
    onfocus={onOpen}
    onblur={onClose}
    onclick={() => onactivate?.()}
  >
    {#each STAGE_ORDER as stage, i (stage)}
      <span
        class="seg {segTint(i) ?? ''}"
        class:done={i < info.index}
        class:active={i === info.index}
        class:pending={i > info.index}
        class:skipped={stage === "planning" && info.planningSkipped}
        aria-hidden="true"
      ></span>
    {/each}
  </button>
  <!-- role=tooltip so aria-describedby surfaces the stage legend to screen readers.
       popover=manual: native top-layer, escapes the card's overflow:hidden. A
       <span> (phrasing) — not a <div> — so it stays valid inside the phrasing-only
       .meta-stepper / .meta wrapper at the call site; every child here is a span. -->
  <span id={legendId} bind:this={legendEl} class="legend" role="tooltip" popover="manual">
    {#each STAGE_ORDER as stage, i (stage)}
      {@const verdictWord = legendVerdict(i)}
      <span class="lg-row" class:cur={i === info.index}>
        <span
          class="seg sw {segTint(i) ?? ''}"
          class:done={i < info.index}
          class:active={i === info.index}
          class:pending={i > info.index}
          class:skipped={stage === "planning" && info.planningSkipped}
          aria-hidden="true"
        ></span>
        <span class="lg-text">
          <span class="lg-label">
            {STAGE_LABEL[stage]()}{verdictWord ? ` — ${verdictWord}` : ""}
          </span>
          <span class="lg-desc">{STAGE_DESC[stage]()}</span>
        </span>
        <span class="lg-state">{legendState(i)}</span>
      </span>
    {/each}
  </span>
{/if}

<style>
  /* Button reset (mirrors InfoTip's .info) so the bar looks unchanged, plus the
     control-only raise above .unit-hit (the bug fix). The terminal .chip branch is
     deliberately left unraised so clicking it still falls through to row-select. */
  .stepper {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: help;
  }
  /* Enlarge the pointer/focus target well beyond the 3px-tall lamps, with no
     reflow (the halo is an absolutely-positioned pseudo, not layout box). */
  .stepper::before {
    content: "";
    position: absolute;
    inset: -8px -6px;
  }
  .stepper:focus-visible {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 3px;
    border-radius: 2px;
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
  /* Skipped planning stage: hollow so it's visually distinct from a completed segment. */
  .seg.done.skipped {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--color-muted);
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
  /* Failure/changes also carry a non-color cue (a ring + extra height) so red
     differs from green by shape/weight, not hue alone (WCAG 1.4.1). No animation. */
  .seg.ci-failure,
  .seg.rv-changes {
    background: var(--color-red);
    height: 5px;
    outline: 1px solid var(--color-red);
    outline-offset: 1px;
  }
  /* Top-layer popover positioning: fixed + inset:auto + margin:0 lets Floating UI
     drive left/top without fighting browser default centering. */
  [popover].legend {
    position: fixed;
    inset: auto;
    margin: 0;
    z-index: 30;
    width: min(300px, 92vw);
    gap: 4px;
    padding: 6px 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    font-size: var(--fs-meta);
    line-height: 1.4;
    text-align: left;
  }
  /* Flex layout applies only when shown — the closed popover keeps the UA
     `display:none` so it never intercepts pointer events or reserves space. */
  [popover].legend:popover-open {
    display: flex;
    flex-direction: column;
  }
  .lg-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: start;
    gap: 6px;
    color: var(--color-muted);
  }
  .lg-row.cur {
    color: var(--color-ink);
  }
  .lg-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .lg-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lg-desc {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    white-space: normal;
    line-height: 1.35;
  }
  .lg-state {
    flex: none;
    white-space: nowrap;
  }
  /* legend swatch reuses .seg state classes (tint + done/active/pending); a wider
     bar, nudged down to align with the label's first line. */
  .seg.sw {
    width: 12px;
    margin-top: 5px;
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
