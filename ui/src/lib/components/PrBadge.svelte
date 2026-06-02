<script lang="ts">
  import type { GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { prBadgeLabel } from "./pr-badge";

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
    {/if}{label}
  </span>
{/if}

<style>
  .pr-badge {
    font-size: 10px;
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
    background: var(--color-green, #5ad19a);
  }
  .dot-failure {
    background: var(--color-red, #d9534f);
  }

  .rdot {
    width: 6px;
    height: 6px;
    border-radius: 1px;
    display: inline-block;
    background: var(--color-faint);
  }
  .rdot-approved {
    background: var(--color-green, #5ad19a);
  }
  .rdot-changes_requested {
    background: var(--color-amber);
  }
  .rdot-commented {
    background: var(--color-blue, #4a90d9);
  }
</style>
