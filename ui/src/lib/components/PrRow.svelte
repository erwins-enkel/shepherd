<script lang="ts">
  import { onDestroy } from "svelte";
  import type { PullRequest } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { mergeBacklogPr } from "$lib/api";

  let {
    repoPath,
    pr,
    age = false,
    onreview,
    onmerged,
  }: {
    repoPath: string;
    pr: PullRequest;
    age?: boolean;
    onreview: (pr: PullRequest) => void;
    /** Called after a successful merge so the parent can drop/refetch the row. */
    onmerged: (number: number) => void;
  } = $props();

  // Merge is outward-facing and hard to reverse, so it arms on first click and
  // fires on the second. The armed state self-disarms after a few seconds so a
  // stray click never leaves a hot button waiting.
  let armed = $state(false);
  let merging = $state(false);
  let failed = $state(false);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  // A PR with conflicts can't merge. Drafts have no merge button, and some hosts
  // (Gitea) report mergeable:false for every draft — so don't read that as a real
  // conflict on a draft, or the row shows a bogus "conflicts" chip.
  const blocked = $derived(pr.mergeable === false && !pr.isDraft);

  const ciStatus = $derived(m.gitrail_ci_status({ status: pr.checks }));
  const reviewTitle = $derived(
    pr.latestReview?.state === "approved"
      ? m.prbadge_review_approved()
      : pr.latestReview?.state === "commented"
        ? m.prbadge_review_comment()
        : pr.latestReview
          ? m.prbadge_review_changes()
          : "",
  );

  function disarm() {
    armed = false;
    if (disarmTimer) {
      clearTimeout(disarmTimer);
      disarmTimer = null;
    }
  }

  // The row can unmount mid-arm (its PR leaves the list); drop any pending timer
  // so it never fires disarm() against a destroyed instance.
  onDestroy(() => {
    if (disarmTimer) clearTimeout(disarmTimer);
  });

  async function onmerge() {
    if (merging || blocked) return;
    failed = false;
    if (!armed) {
      armed = true;
      disarmTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    merging = true;
    try {
      await mergeBacklogPr(repoPath, pr.number);
      onmerged(pr.number);
    } catch {
      failed = true;
      merging = false;
    }
  }
</script>

<div class="pr-row">
  <div class="pr-top">
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
    <a class="pr-num" href={pr.url} target="_blank" rel="noopener" title={m.prspanel_open_link()}
      >#{pr.number}</a
    >
    <a class="pr-title" href={pr.url} target="_blank" rel="noopener" title={m.prspanel_open_link()}
      >{pr.title}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {#if pr.isDraft}<span class="draft-chip">{m.prspanel_draft()}</span>{/if}
  </div>

  <div class="pr-meta">
    {#if pr.checks !== "none"}
      <span class="dot dot-{pr.checks}" title={ciStatus} aria-label={ciStatus}></span>
    {/if}
    {#if pr.latestReview}
      <span class="rdot rdot-{pr.latestReview.state}" title={reviewTitle} aria-label={reviewTitle}
      ></span>
    {/if}
    {#if blocked}
      <span class="conflict">{m.prspanel_conflicts()}</span>
    {/if}
    {#if pr.author}<span class="author">@{pr.author}</span>{/if}
    {#if age}
      <span class="age-chip"
        >{m.backlog_open_since_days({
          days: Math.floor((Date.now() - pr.createdAt) / 86_400_000),
        })}</span
      >
    {/if}
  </div>

  <div class="pr-actions">
    {#if failed}<span class="merge-err">{m.prspanel_merge_failed()}</span>{/if}
    <button class="review-btn" onclick={() => onreview(pr)} title={m.prspanel_review_button_title()}
      >{m.prspanel_review_button()}</button
    >
    {#if !pr.isDraft}
      <button
        class="merge-btn"
        class:armed
        disabled={merging || blocked}
        onclick={onmerge}
        title={blocked ? m.prspanel_merge_blocked_title() : undefined}
      >
        {merging
          ? m.prspanel_merging()
          : armed
            ? m.prspanel_merge_confirm()
            : m.prspanel_merge_button()}
      </button>
    {/if}
  </div>
</div>

<style>
  .pr-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 7px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
  }

  .pr-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .pr-num {
    font-size: 10.5px;
    color: var(--color-faint);
    flex-shrink: 0;
    text-decoration: none;
    font-variant-numeric: tabular-nums;
    transition: color 0.12s;
  }
  .pr-num:hover {
    color: var(--color-ink-bright);
  }

  .pr-title {
    flex: 1;
    font-size: 12.5px;
    color: var(--color-ink);
    line-height: 1.4;
    word-break: break-word;
    text-decoration: none;
    transition: color 0.12s;
  }
  .pr-title:hover {
    color: var(--color-ink-bright);
  }

  /* DRAFT is metadata, not state — a neutral hairline chip, never a status hue. */
  .draft-chip {
    flex-shrink: 0;
    font-size: 9.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-faint);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 1px 5px;
  }

  .pr-meta {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 12px;
  }

  /* CI + review dots: the exact four-light vocabulary used by PrBadge/GitRail. */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    background: var(--color-faint);
    flex-shrink: 0;
  }
  .dot-pending {
    background: var(--color-amber);
    /* CI running pulses like every other in-progress signal; intentionally
       overrides the reduced-motion blanket since it encodes live work. */
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
    flex-shrink: 0;
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

  .conflict {
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-red);
  }

  .author {
    font-size: 10.5px;
    color: var(--color-muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .age-chip {
    margin-left: auto;
    font-size: 9.5px;
    letter-spacing: 0.1em;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .pr-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
  }

  .merge-err {
    margin-right: auto;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-red);
  }

  .review-btn,
  .merge-btn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }

  .review-btn:hover,
  .merge-btn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Armed merge: the one moment this control earns the amber action accent +
     the inset glow doctrine reserves for a primary/active button. */
  .merge-btn.armed {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }

  .merge-btn:disabled {
    color: var(--color-faint);
    border-color: var(--color-line);
    cursor: not-allowed;
  }

  @media (max-width: 768px) {
    .review-btn,
    .merge-btn {
      min-height: 40px;
      padding: 2px 14px;
    }
  }
</style>
