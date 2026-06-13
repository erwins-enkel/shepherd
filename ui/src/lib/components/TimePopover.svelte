<script lang="ts">
  import type { Session, GitState, SessionActivity } from "$lib/types";
  import { elapsed, formatAgo, waitTier } from "$lib/format";
  import { m } from "$lib/paraglide/messages";

  let {
    session,
    git,
    activity,
    nowMs,
    anchorRect,
    onclose,
  }: {
    session: Session;
    git?: GitState;
    activity?: SessionActivity;
    nowMs: number;
    /** The wall-clock element's getBoundingClientRect() at show time — the popover is
     *  position:fixed (the cards clip: .tile / .swipe-wrap are overflow:hidden). */
    anchorRect: DOMRect;
    onclose: () => void;
  } = $props();

  // Fixed positioning with a simple flip: below the anchor unless that would
  // leave less room than above. Rather than measure the popover, compare the
  // free space on each side — the content is a handful of one-liners, so the
  // roomier side always fits it.
  const placeAbove = $derived(
    window.innerHeight - anchorRect.bottom < anchorRect.top &&
      window.innerHeight - anchorRect.bottom < 220,
  );
  const left = $derived(Math.max(8, Math.min(anchorRect.left, window.innerWidth - 328)));

  // The popover is hover-ephemeral; on any scroll/resize its fixed coordinates
  // go stale, so close instead of repositioning. Capture-phase catches the
  // rail's inner scroller, not just window scroll.
  $effect(() => {
    const close = () => onclose();
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close, { passive: true });
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  });

  const startLabel = $derived(
    new Date(session.createdAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  const lastActivityTs = $derived(activity?.lastActivityTs || 0);

  const prOpen = $derived(git?.state === "open" && git.number != null);

  // "Waiting on {who}" — only when the server computed a handoff, which it does
  // ONLY for an open PR with green CI (annotateHandoff, repo-roles.ts): with
  // pending/failing checks nobody else is up yet, so the line is intentionally
  // absent there (the "open for X" line still carries the total wait).
  // The escalation clock measures what is actually being waited on:
  //   reviewer → since the PR opened; merger → since the approval (an
  //   un-approved latest review must not date the merge wait — merger handoffs
  //   can exist without any approval), falling back to the PR open time.
  const approvedReview = $derived(
    git?.latestReview?.state === "approved" ? git.latestReview : undefined,
  );
  const waitSince = $derived(
    git?.handoff === "merger" ? (approvedReview?.submittedAt ?? git.createdAt) : git?.createdAt,
  );
  // The "who's up next" lines (waiting-on-reviewer/merger and the neutral
  // ready-to-merge fallback) only apply once the PR is actually handed off. Mirror
  // herd-partition.ts's `greenIdle` gate exactly: open + green + non-draft AND the
  // session no longer in the agent's court (raw "running" OR "blocked" both keep it
  // in the herd's `active` group). So an ACTIVE/blocked session never claims a
  // reviewer/merger/operator is up — matching the card badge and the herd grouping.
  const handedOff = $derived(
    git?.state === "open" &&
      git.checks === "success" &&
      !git.isDraft &&
      session.status !== "running" &&
      session.status !== "blocked",
  );
  const waiting = $derived(
    handedOff && git?.handoff && git.handoffWho && waitSince
      ? {
          role: git.handoff,
          who: git.handoffWho,
          tier: waitTier(nowMs - waitSince),
          ago: formatAgo(nowMs - waitSince),
        }
      : null,
  );
  // Handed off but with no foreign reviewer/merger named: neutrally flag it as ready
  // to merge (we can't pin the merge on the operator).
  const awaitingMerge = $derived(handedOff && !git?.handoff);

  const REVIEW_MSG = {
    fresh: m.timetip_waiting_review_fresh,
    dozing: m.timetip_waiting_review_dozing,
    burning: m.timetip_waiting_review_burning,
    skeleton: m.timetip_waiting_review_skeleton,
  } as const;
  const MERGE_MSG = {
    fresh: m.timetip_waiting_merge_fresh,
    dozing: m.timetip_waiting_merge_dozing,
    burning: m.timetip_waiting_merge_burning,
    skeleton: m.timetip_waiting_merge_skeleton,
  } as const;
</script>

<div
  class="time-pop"
  role="tooltip"
  style:left="{left}px"
  style:top={placeAbove ? "auto" : `${anchorRect.bottom + 4}px`}
  style:bottom={placeAbove ? `${window.innerHeight - anchorRect.top + 4}px` : "auto"}
>
  <div class="tp-repo">{session.repoPath}</div>
  <div class="tp-line">
    {m.timetip_clock({ elapsed: elapsed(session.createdAt, nowMs), start: startLabel })}
  </div>
  {#if lastActivityTs > 0}
    <div class="tp-line">
      {m.timetip_last_activity({ ago: formatAgo(nowMs - lastActivityTs) })}
    </div>
  {/if}
  {#if prOpen}
    {#if git?.createdAt}
      <div class="tp-line">
        {m.timetip_pr_open_since({ number: git.number!, ago: formatAgo(nowMs - git.createdAt) })}
      </div>
    {/if}
    {#if approvedReview}
      <div class="tp-line">
        {m.timetip_approved_ago({
          who: approvedReview.author,
          ago: formatAgo(nowMs - approvedReview.submittedAt),
        })}
      </div>
    {/if}
    {#if waiting}
      <div class="tp-line tp-wait tp-wait--{waiting.tier}">
        {(waiting.role === "reviewer" ? REVIEW_MSG : MERGE_MSG)[waiting.tier]({
          who: waiting.who,
          ago: waiting.ago,
        })}
      </div>
    {:else if awaitingMerge}
      <div class="tp-line tp-wait">{m.timetip_ready_to_merge()}</div>
    {/if}
  {/if}
</div>

<style>
  /* Anchored, non-blocking hover popover (role=tooltip, no scrim — per the
     design-system exemption for small anchored popovers, same family as
     AutomationPanel's .auto-pop). pointer-events:none so it can never swallow
     the click that selects the card underneath. */
  .time-pop {
    position: fixed;
    z-index: 60;
    width: max-content;
    max-width: 320px;
    pointer-events: none;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tp-repo {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    letter-spacing: 0.06em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tp-line {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    font-variant-numeric: tabular-nums;
  }
  .tp-wait {
    color: var(--color-ink-bright);
  }
  .tp-wait--burning,
  .tp-wait--skeleton {
    color: var(--color-amber);
  }
</style>
