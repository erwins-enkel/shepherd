<script lang="ts">
  import type { GitState } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { setPrDraftState, mergePr } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { prBadgeLabel, prBadgeIsDraft, prMergeAvailable } from "./pr-badge";
  import { prBadgeStaleMarker } from "$lib/pr-ready";
  import PrBadgeMenu from "./PrBadgeMenu.svelte";
  import PrReviewRequestPopover from "./PrReviewRequestPopover.svelte";

  // D4 (docs/design/mobile-herd): on a coarse pointer this badge is a READ-ONLY readout,
  // not a tap target. Its ~15px box cannot meet iOS HIG 44x44, and five of them stack in one
  // card — inflating them would push the card past 200px. The action moves to the detail
  // screen, which the card tap already opens. Default true leaves desktop untouched.
  let {
    git,
    sessionId,
    interactive = true,
  }: { git?: GitState; sessionId?: string; interactive?: boolean } = $props();
  const label = $derived(prBadgeLabel(git));
  const actionable = $derived(interactive && !!sessionId && git?.state === "open" && !!git.number);
  const canToggleDraft = $derived(git?.kind === "github" || git?.kind === "gitea");
  const canRequestReview = $derived(git?.kind === "github");
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
  // Merge-readiness marker (#1551): a PR whose checks all passed can still be unmergeable
  // because it fell behind its base or conflicts. The CI dot stays honest (CI really did
  // pass), so the reason rides its own amber marker instead. Scoped to the two blocks a
  // rebase fixes — branch protection has its own GitRail reason line and Herd group.
  const staleMarker = $derived(prBadgeStaleMarker(git));
  const staleText = $derived(
    staleMarker === "behind"
      ? m.prbadge_behind()
      : staleMarker === "conflict"
        ? m.prbadge_conflict()
        : "",
  );
  const staleTitle = $derived(
    staleMarker === "behind"
      ? m.prbadge_behind_title()
      : staleMarker === "conflict"
        ? m.prbadge_conflict_title()
        : "",
  );
  const canMerge = $derived(!!sessionId && prMergeAvailable(git));
  let btnEl = $state<HTMLButtonElement>();
  let menu = $state<{
    anchor: DOMRect;
    autoFocus: boolean;
  } | null>(null);
  let reviewPopover = $state<{
    anchor: DOMRect;
    sessionId: string;
    prNumber: number;
    prUrl?: string;
  } | null>(null);
  let busy = $state(false);
  let mergeArmed = $state(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  function disarmMerge() {
    clearTimeout(armTimer);
    mergeArmed = false;
  }

  function closeMenu() {
    disarmMerge();
    menu = null;
  }

  function closeReviewPopover() {
    reviewPopover = null;
  }

  function openMenu(autoFocus: boolean) {
    if (!actionable || !btnEl) return;
    menu = { anchor: btnEl.getBoundingClientRect(), autoFocus };
  }

  function toggleMenu(e: MouseEvent) {
    e.stopPropagation();
    if (!actionable) return;
    if (reviewPopover) closeReviewPopover();
    else if (menu) closeMenu();
    else openMenu(true);
  }

  function openReviewRequest() {
    if (!canRequestReview || !sessionId || !git?.number || !btnEl) return;
    const anchor = btnEl.getBoundingClientRect();
    closeMenu();
    reviewPopover = {
      anchor,
      sessionId,
      prNumber: git.number,
      prUrl: git.url,
    };
  }

  $effect(() => {
    if (
      reviewPopover &&
      (reviewPopover.sessionId !== sessionId || reviewPopover.prNumber !== git?.number)
    ) {
      reviewPopover = null;
    }
  });

  function openPr() {
    closeMenu();
    if (!git?.url) return;
    window.open(git.url, "_blank", "noopener,noreferrer");
  }

  // Two-tap arm (GitRail parity): the first click arms for 3s, the second merges.
  async function doMerge() {
    if (!sessionId || !canMerge) return;
    if (!mergeArmed) {
      mergeArmed = true;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => (mergeArmed = false), 3000);
      return;
    }
    disarmMerge();
    const number = git?.number ?? 0;
    busy = true;
    try {
      await mergePr(sessionId);
      closeMenu();
      toasts.info(m.prbadge_merged_toast({ number }), { key: `pr-merge:${sessionId}` });
    } catch (err) {
      toasts.info(
        m.prbadge_merge_failed({
          reason: err instanceof Error ? err.message : m.prbadge_unknown_error(),
        }),
        { alert: true, key: `pr-merge:${sessionId}` },
      );
    } finally {
      busy = false;
    }
  }

  async function toggleDraftState() {
    if (!sessionId || !canToggleDraft) return;
    const nextDraft = !showDraft;
    busy = true;
    try {
      await setPrDraftState(sessionId, nextDraft);
      closeMenu();
      toasts.info(nextDraft ? m.prbadge_marked_draft() : m.prbadge_marked_ready(), {
        key: `pr-draft:${sessionId}`,
      });
    } catch (err) {
      toasts.info(
        m.prbadge_draft_toggle_failed({
          reason: err instanceof Error ? err.message : m.prbadge_unknown_error(),
        }),
        { alert: true, key: `pr-draft:${sessionId}` },
      );
    } finally {
      busy = false;
    }
  }
</script>

{#if label}
  {#snippet content()}
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
    {/if}{#if staleMarker}<span class="stale-marker" title={staleTitle} aria-label={staleTitle}
        >{staleText}</span
      >{/if}{label}
  {/snippet}

  {#if actionable}
    <button
      bind:this={btnEl}
      type="button"
      class="pr-badge pr-{git!.state} as-button"
      class:open={!!menu || !!reviewPopover}
      title={m.prbadge_button_title({ label })}
      aria-label={m.prbadge_button_title({ label })}
      aria-haspopup={reviewPopover ? "dialog" : "menu"}
      aria-expanded={!!menu || !!reviewPopover}
      onclick={toggleMenu}
    >
      {@render content()}
    </button>
  {:else}
    <span class="pr-badge pr-{git!.state}">
      {@render content()}
    </span>
  {/if}
{/if}

{#if menu}
  <PrBadgeMenu
    anchor={menu.anchor}
    opener={btnEl}
    isDraft={showDraft}
    canOpen={!!git?.url}
    {canToggleDraft}
    showMerge={canMerge}
    showRequestReview={canRequestReview}
    {mergeArmed}
    autoFocus={menu.autoFocus}
    {busy}
    onopen={openPr}
    onrequestreview={openReviewRequest}
    onmerge={doMerge}
    ontoggledraft={toggleDraftState}
    onclose={closeMenu}
  />
{/if}

{#if reviewPopover}
  <PrReviewRequestPopover
    anchor={reviewPopover.anchor}
    opener={btnEl}
    sessionId={reviewPopover.sessionId}
    prNumber={reviewPopover.prNumber}
    prUrl={reviewPopover.prUrl}
    onclose={closeReviewPopover}
  />
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
  .as-button {
    position: relative;
    z-index: 1;
    appearance: none;
    margin: 0;
    font-family: inherit;
    line-height: inherit;
    background: transparent;
    cursor: pointer;
  }
  .as-button:hover,
  .as-button.open {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
    background: var(--color-hover);
  }
  .as-button:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
    color: var(--color-ink-bright);
  }
  /* `pr-open` is the brightest PR state via the default muted styling — no hue.
     Amber is reserved for the one actionable badge (critic CHANGES); PR
     existence is an identifier, and CI health is carried by the dot beside it. */
  .pr-merged {
    color: var(--color-slate);
  }
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
  /* Shared marker chrome; each marker only picks its hue, and the border tints itself from
     it via currentColor. */
  .draft-marker,
  .stale-marker {
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    padding: 0 2px;
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    border-radius: 2px;
    line-height: 1.2;
  }
  .draft-marker {
    color: var(--color-slate);
  }
  /* Amber, not slate: unlike DRAFT (parked, awaiting sign-off) a stale or conflicting PR
     needs someone to act before it can merge. */
  .stale-marker {
    color: var(--color-amber);
  }
</style>
