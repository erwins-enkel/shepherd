<script lang="ts">
  import type { GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { prBadgeLabel, prBadgeIsDraft } from "./pr-badge";

  let { git }: { git?: GitState } = $props();
  const label = $derived(prBadgeLabel(git));
  // CI only matters on an open PR; `none` means no checks reported.
  const showCi = $derived(git?.state === "open" && git.checks !== "none");
  const review = $derived(git?.latestReview);
  const reviewTitle = $derived(
    review?.state === "approved"
      ? m.prbadge_review_approved()
      : review?.state === "commented"
        ? m.prbadge_review_comment()
        : review
          ? m.prbadge_review_changes()
          : "",
  );
  // Draft marker: only on open PRs; never green — always slate.
  const showDraft = $derived(prBadgeIsDraft(git));
</script>

{#if label}
  <span class="pr-badge pr-{git!.state}">
    {#if showCi}
      <span
        class="dot dot-{git!.checks}"
        title={m.gitrail_ci_status({ status: git!.checks })}
        aria-label={m.gitrail_ci_status({ status: git!.checks })}
      ></span>
    {/if}
    {#if review}
      <span class="rdot rdot-{review.state}" title={reviewTitle} aria-label={reviewTitle}></span>
    {/if}
    {#if showDraft}
      <span class="draft-marker" aria-label={m.prbadge_draft()}>{m.prbadge_draft()}</span>
    {/if}{label}
  </span>
{/if}

<style>
  .pr-badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: nowrap;
    color: var(--color-muted);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  /* `pr-open` is the brightest PR state via the default muted styling — no hue.
     Amber is reserved for the one actionable badge (critic CHANGES); PR
     existence is an identifier, and CI health is carried by the dot beside it. */
  .pr-merged {
    color: var(--color-slate);
  }
  .pr-none,
  .pr-closed {
    color: var(--color-faint);
  }

  /* same CI colors as GitRail's detail dot; sized to match the reviewing dot in-list */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    background: var(--color-faint);
  }
  .dot-pending {
    background: var(--color-amber);
    /* CI running — pulse like every other in-progress indicator.
       Functional status motion: intentionally overrides the reduced-motion
       blanket (app.css) — the pulse encodes "work happening", not decoration. */
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .dot-success {
    background: var(--color-green);
  }
  .dot-failure {
    background: var(--color-red);
  }

  .rdot {
    width: 6px;
    height: 6px;
    border-radius: 1px;
    display: inline-block;
    background: var(--color-faint);
  }
  .rdot-approved {
    background: var(--color-green);
  }
  .rdot-changes_requested {
    background: var(--color-amber);
  }
  .rdot-commented {
    background: var(--color-blue);
  }

  /* Slate DRAFT marker — parked/not-ready, must NEVER render green */
  .draft-marker {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    color: var(--color-slate);
    padding: 0 2px;
    border: 1px solid color-mix(in srgb, var(--color-slate) 40%, transparent);
    border-radius: 2px;
    line-height: 1.2;
  }
</style>
