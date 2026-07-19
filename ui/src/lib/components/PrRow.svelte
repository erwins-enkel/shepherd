<script lang="ts">
  import { onDestroy } from "svelte";
  import type { PullRequest } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { mergeBacklogPr, requestDependabotRebase } from "$lib/api";
  import { showRebaseOffer } from "./pr-row";
  import { isConflicting } from "$lib/pr-conflict";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";

  let {
    repoPath,
    pr,
    age = false,
    onreview,
    onmerged,
    selectable = false,
    selected = false,
    ontoggle,
    inTrain = false,
  }: {
    repoPath: string;
    pr: PullRequest;
    age?: boolean;
    onreview: (pr: PullRequest) => void;
    /** Called after a successful merge so the parent can drop/refetch the row. */
    onmerged: (number: number) => void;
    /** Render a leading multi-select checkbox (merge-train picking). */
    selectable?: boolean;
    selected?: boolean;
    ontoggle?: () => void;
    /** This PR is owned by a running merge train — show the MERGING badge and
     *  lock the manual merge button so the train (not the operator) lands it. */
    inTrain?: boolean;
  } = $props();

  // Merge is outward-facing and hard to reverse, so it arms on first click and
  // fires on the second. The armed state self-disarms after a few seconds so a
  // stray click never leaves a hot button waiting.
  let armed = $state(false);
  let mergeBusy = $state(false);
  let failed = $state(false);
  // Stuck Dependabot PRs get a one-click "@dependabot rebase" opt-in. `requested`
  // is sticky for the row's lifetime so Dependabot is never asked twice.
  let requesting = $state(false);
  let requested = $state(false);
  let rebaseFailed = $state(false);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  // The worst-of rollup dot expands into the head commit's individual CI jobs.
  // Default collapsed so a long PR list stays scannable.
  let expanded = $state(false);
  const hasJobs = $derived(pr.jobs.length > 0);

  // A PR with conflicts can't merge. The !isDraft guard rides the mergeable term only: some
  // hosts (Gitea) report mergeable:false for every draft, which would chip them all — but GitHub
  // reports DIRTY for genuinely conflicting drafts (DRAFT masks BEHIND, not DIRTY), so those
  // still chip. Mirrors src/pr-conflict.ts's isConflicting; see ui/src/lib/pr-conflict.ts.
  const blocked = $derived(isConflicting(pr));

  const offerRebase = $derived(showRebaseOffer({ kind: pr.kind, blocked, failed, requested }));

  const ciStatus = $derived(m.gitrail_ci_status({ status: pr.checks }));
  const ciToggleTitle = $derived(expanded ? m.prspanel_jobs_hide() : m.prspanel_jobs_show());
  // The toggle replaces the plain dot, so its label must still announce the
  // aggregate CI state ("CI: failure") alongside the show/hide action.
  const ciToggleLabel = $derived(`${ciStatus} · ${ciToggleTitle}`);
  // Ties the toggle to the region it reveals (aria-controls ↔ id) for the
  // standard disclosure pattern.
  const jobsId = $derived(`pr-jobs-${pr.number}`);
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
    if (mergeBusy || blocked) return;
    failed = false;
    rebaseFailed = false; // a fresh merge attempt clears any stale rebase-error text
    if (!armed) {
      armed = true;
      disarmTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    mergeBusy = true;
    try {
      await mergeBacklogPr(repoPath, pr.number);
      onmerged(pr.number);
    } catch {
      failed = true;
      mergeBusy = false;
    }
  }

  async function onrebase() {
    if (requesting || requested) return;
    rebaseFailed = false;
    failed = false; // requesting a rebase supersedes a prior merge-failure message
    requesting = true;
    try {
      await requestDependabotRebase(repoPath, pr.number);
      requested = true;
    } catch {
      rebaseFailed = true;
    } finally {
      requesting = false;
    }
  }
</script>

<div class="pr-row" class:selectable>
  {#if selectable}
    <input
      type="checkbox"
      class="pr-pick"
      checked={selected}
      onchange={ontoggle}
      aria-label={m.prspanel_select_pr({ number: pr.number })}
    />
  {/if}
  <div class="pr-body">
    <div class="pr-top">
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
      <a class="pr-num" href={pr.url} target="_blank" rel="noopener" title={m.prspanel_open_link()}
        >#{pr.number}</a
      >
      <a
        class="pr-title"
        href={pr.url}
        target="_blank"
        rel="noopener"
        title={m.prspanel_open_link()}>{pr.title}</a
      >
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
      {#if pr.kind === "dependabot"}
        <span class="kind-tag dep" title={m.prkind_dependabot_tag()}
          >{m.prkind_dependabot_tag()}</span
        >
      {:else if pr.kind === "release"}
        <span class="kind-tag rel" title={m.prkind_release_tag()}>{m.prkind_release_tag()}</span>
      {/if}
      {#if pr.isDraft}<span class="draft-chip">{m.prspanel_draft()}</span>{/if}
    </div>

    <div class="pr-meta">
      {#if inTrain}
        <span class="badge merging" title={m.prrow_in_train_title()}>{m.status_merging()}</span>
      {/if}
      {#if pr.awaitingWorkflowApproval}
        <span
          class="needs-approval"
          title={m.prrow_awaiting_approval_title()}
          aria-label={m.prrow_awaiting_approval_title()}>{m.prrow_awaiting_approval()}</span
        >
      {/if}
      {#if pr.checks !== "none"}
        {#if hasJobs}
          <button
            type="button"
            class="ci-toggle"
            class:expanded
            onclick={() => (expanded = !expanded)}
            aria-expanded={expanded}
            aria-controls={jobsId}
            title={ciToggleLabel}
            aria-label={ciToggleLabel}
          >
            <span class="dot dot-{pr.checks}"></span>
            <span class="caret" aria-hidden="true">▸</span>
          </button>
        {:else}
          <span class="dot dot-{pr.checks}" title={ciStatus} aria-label={ciStatus}></span>
        {/if}
      {/if}
      {#if pr.latestReview}
        <span class="rdot rdot-{pr.latestReview.state}" title={reviewTitle} aria-label={reviewTitle}
        ></span>
      {/if}
      {#if blocked}
        <span class="conflict">{m.prspanel_conflicts()}</span>
      {/if}
      {#if pr.nonDefaultBase}
        <span
          class="target-branch"
          title={m.prspanel_targets({ branch: pr.nonDefaultBase })}
          aria-label={m.prspanel_targets({ branch: pr.nonDefaultBase })}
        >
          <span class="arrow" aria-hidden="true">→</span>{pr.nonDefaultBase}
        </span>
      {/if}
      {#if pr.author}<span class="author">@{pr.author}</span>{/if}
      {#if age}
        <span class="age-chip">{relativeAge(pr.createdAt, clock.current)}</span>
      {/if}
    </div>

    {#if expanded && hasJobs}
      <div class="pr-jobs" id={jobsId}>
        <!-- key includes the index: a matrix build can repeat a check name on one
           head commit, which would otherwise collide in the keyed each. -->
        {#each pr.jobs as job, i (job.name + " " + i)}
          <div class="job">
            <span
              class="dot dot-{job.state}"
              title={m.gitrail_ci_status({ status: job.state })}
              aria-label={m.gitrail_ci_status({ status: job.state })}
            ></span>
            {#if job.url}
              <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
              <a
                class="job-name"
                href={job.url}
                target="_blank"
                rel="noopener"
                title={m.actionspanel_job_link()}>{job.name}</a
              >
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {:else}
              <span class="job-name">{job.name}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <div class="pr-actions">
      <!-- Left-aligned status text. One container carries the margin-right:auto push
         so co-occurring messages (e.g. a failed merge *and* a later rebase request)
         stay flush-left as a group instead of fighting over the free space. -->
      {#if failed || rebaseFailed || requested}
        <div class="pr-status">
          {#if failed}<span class="merge-err">{m.prspanel_merge_failed()}</span>{/if}
          {#if rebaseFailed}<span class="merge-err">{m.prspanel_rebase_failed()}</span>{/if}
          {#if requested}
            <span class="rebase-note" role="status">{m.prspanel_rebase_requested()}</span>
          {/if}
        </div>
      {/if}
      {#if offerRebase}
        <button
          class="rebase-btn"
          disabled={requesting}
          onclick={onrebase}
          title={m.prspanel_rebase_button_title()}
        >
          {requesting ? m.prspanel_requesting() : m.prspanel_rebase_button()}
        </button>
      {/if}
      <button
        class="review-btn"
        onclick={() => onreview(pr)}
        title={m.prspanel_review_button_title()}>{m.prspanel_review_button()}</button
      >
      {#if !pr.isDraft}
        <button
          class="merge-btn"
          class:armed
          disabled={mergeBusy || blocked || inTrain}
          onclick={onmerge}
          title={inTrain
            ? m.prrow_in_train_title()
            : blocked
              ? m.prspanel_merge_blocked_title()
              : undefined}
        >
          {mergeBusy
            ? m.prspanel_merging()
            : armed
              ? m.prspanel_merge_confirm()
              : m.prspanel_merge_button()}
        </button>
      {/if}
    </div>
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

  /* Selectable rows put the pick checkbox at the leading edge, alongside the
     row body, without disturbing the body's own vertical stack. */
  .pr-row.selectable {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;
  }

  .pr-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }

  /* A real, distinct hit target ahead of the row's links/buttons — its own
     accent on check so a picked row reads at a glance. */
  .pr-pick {
    flex-shrink: 0;
    margin: 0;
    width: 14px;
    height: 14px;
    accent-color: var(--color-amber);
    cursor: pointer;
  }

  .pr-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .pr-num {
    font-size: var(--fs-meta);
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
    font-size: var(--fs-base);
    color: var(--color-ink);
    line-height: 1.4;
    word-break: break-word;
    text-decoration: none;
    transition: color 0.12s;
  }
  .pr-title:hover {
    color: var(--color-ink-bright);
  }

  /* PR-kind tag — a hairline badge (outlined chip) marking a non-regular PR;
     regular PRs render no tag. Semantic hues: dependabot = blue, release = amber;
     never a status green. */
  .kind-tag {
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 5px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .kind-tag.dep {
    color: var(--color-blue);
    border-color: var(--color-blue);
  }
  .kind-tag.rel {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }

  /* DRAFT is metadata, not state — a neutral hairline chip, never a status hue. */
  .draft-chip {
    flex-shrink: 0;
    font-size: var(--fs-micro);
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

  /* The rollup dot doubles as the expand control when the head commit has jobs:
     a bare button so the dot keeps its exact size/hue, plus a hairline caret. */
  .ci-toggle {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: transparent;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    color: var(--color-faint);
  }
  .ci-toggle:hover .caret {
    color: var(--color-ink-bright);
  }

  .caret {
    font-size: var(--fs-micro);
    line-height: 1;
    color: var(--color-faint);
    transition:
      transform 0.12s,
      color 0.12s;
  }
  .ci-toggle.expanded .caret {
    transform: rotate(90deg);
  }

  .pr-jobs {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-left: 13px;
  }

  .job {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 12px;
  }

  .job-name {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    text-decoration: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    transition: color 0.12s;
  }
  a.job-name:hover {
    color: var(--color-ink-bright);
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
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-red);
  }

  /* A workflow run on this PR's head is awaiting manual approval to run — an
     operator must approve it on GitHub. Amber: the action/attention accent, since
     it's an actionable-but-not-broken state (never a status green/red). */
  .needs-approval {
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 5px;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
  }

  /* In-train badge — mirrors the session-list MERGING badge (UnitRow): the one
     colored, moving status badge, amber + pulse, marking the running merge train
     that owns this PR. Surfaces the same state the session row already shows. */
  .badge {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .badge.merging {
    color: var(--color-amber);
    animation: merge-pulse 1.5s ease-in-out infinite;
  }

  /* Non-default target branch — a hairline neutral chip (mirrors .kind-tag),
     shown ONLY when the PR targets something other than the repo default (a
     stacked/epic branch). Neutral hue: never a status green/amber. A long
     branch name truncates rather than stretching the row. */
  .target-branch {
    flex-shrink: 0;
    max-width: 12em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-micro);
    padding: 1px 5px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .target-branch .arrow {
    margin-right: 2px;
  }

  .author {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .age-chip {
    margin-left: auto;
    font-size: var(--fs-micro);
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

  /* Left-aligned status group: a single auto margin pushes the action buttons to
     the right, so multiple status messages never fight over the free space. */
  .pr-status {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-right: auto;
    min-width: 0;
  }

  .merge-err {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-red);
  }

  .review-btn,
  .merge-btn,
  .rebase-btn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }

  .review-btn:hover,
  .rebase-btn:hover:not(:disabled),
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

  .rebase-btn:disabled {
    color: var(--color-faint);
    border-color: var(--color-line);
    cursor: not-allowed;
  }

  /* "rebase requested" — a settled, non-alarming confirmation (muted, not red). */
  .rebase-note {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  @media (max-width: 768px) {
    .review-btn,
    .merge-btn,
    .rebase-btn {
      min-height: 40px;
      padding: 2px 14px;
    }
    /* Enlarge the dot's hit area to a real tap target without growing the dot. */
    .ci-toggle {
      min-height: 32px;
      min-width: 32px;
      justify-content: center;
    }
    .pr-pick {
      width: 20px;
      height: 20px;
    }
  }
</style>
