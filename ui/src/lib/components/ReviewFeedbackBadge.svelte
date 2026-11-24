<script lang="ts">
  import type { GitState } from "#lib/types.js";
  import { reviewFeedback } from "#lib/review-feedback.svelte.js";
  import { statusTip } from "#lib/tooltips/statusTip.svelte.js";
  import { reviewFeedbackBadgeExplanation } from "#lib/tooltips/explanations.js";
  import { feedbackCountLabel } from "./review-feedback-view";
  import ReviewFeedbackDialog from "./ReviewFeedbackDialog.svelte";

  // PR review feedback waiting for this session's agent (#4126): an amber "N review comments"
  // segment on the Herd card (`card`) or a chip in the git rail (`rail`). Hover/focus explains it;
  // a click opens ReviewFeedbackDialog. Renders nothing while nothing is pending. Additive: it
  // never replaces the card's status badge.
  let {
    sessionId,
    git,
    variant = "card",
    interactive = true,
  }: {
    sessionId: string;
    git?: GitState | null;
    variant?: "card" | "rail";
    /** D4: on a coarse-pointer card this is a read-only readout (the detail screen's rail acts). */
    interactive?: boolean;
  } = $props();

  const count = $derived(reviewFeedback.items(sessionId).length);
  const tip = $derived(reviewFeedbackBadgeExplanation(count, reviewFeedback.autoPaused(sessionId)));
  const label = $derived(feedbackCountLabel(count));
  let open = $state(false);

  function onOpen(e: MouseEvent) {
    e.stopPropagation(); // never also select the row
    // use:dialog restores focus to what held it at open; a tap doesn't focus on every browser.
    (e.currentTarget as HTMLElement).focus();
    open = true;
  }
</script>

{#if count > 0}
  {#if interactive}
    <button
      class={variant === "card" ? "badge rf-badge" : "rf-chip"}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onclick={onOpen}
      use:statusTip={{ text: tip, navigates: true }}
    >
      {label}
    </button>
  {:else}
    <span
      class={variant === "card" ? "badge rf-badge" : "rf-chip"}
      role="img"
      aria-label={label}
      use:statusTip={{ text: tip }}
    >
      {label}
    </span>
  {/if}
{/if}
{#if open}
  <ReviewFeedbackDialog
    {sessionId}
    prNumber={git?.number ?? null}
    prUrl={git?.url ?? null}
    onclose={() => (open = false)}
  />
{/if}

<style>
  /* Card segment: the strip's quiet uppercase text, in the attention hue. */
  .rf-badge {
    margin: 0;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--color-amber);
    background: transparent;
    border: 0;
  }
  button.rf-badge {
    cursor: pointer;
  }
  /* Rail chip: the verdict chip's geometry, amber. */
  .rf-chip {
    margin: 0;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    padding: 3px 9px;
    border: 1px solid currentColor;
    border-radius: var(--radius-chip);
    background: transparent;
    color: var(--color-amber);
  }
  button.rf-chip {
    cursor: pointer;
    transition: background 0.12s;
  }
  button.rf-chip:hover,
  button.rf-chip[aria-expanded="true"] {
    background: var(--color-hover);
  }
  button.rf-chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
