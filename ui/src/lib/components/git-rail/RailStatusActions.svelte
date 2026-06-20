<script lang="ts">
  import type { GitState, SessionStatus } from "$lib/types";
  import type { CriticChip } from "../critic-badge";
  import ReadyToggle from "../ReadyToggle.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { m } from "$lib/paraglide/messages";

  let {
    git,
    issueNumber,
    local,
    autopilotOn,
    busy,
    armed,
    mergeBlocked,
    mergeBlockedReason,
    ready,
    showReady,
    status,
    sessionId,
    mobile,
    chip,
    showReview,
    canReview,
    reviewLabel,
    canReviewPlan,
    planReviewing,
    planReviewLabel,
    startPr,
    doMerge,
    doRedeploy,
    toggleReview,
    doReview,
    doReviewPlan,
  }: {
    git: GitState;
    issueNumber: number | null;
    local: boolean;
    autopilotOn: boolean;
    busy: boolean;
    armed: "merge" | "redeploy" | "review" | "review-plan" | null;
    mergeBlocked: boolean;
    mergeBlockedReason: string | undefined;
    ready: boolean;
    showReady: boolean;
    status: SessionStatus;
    sessionId: string;
    mobile: boolean;
    chip: CriticChip;
    showReview: boolean;
    canReview: boolean;
    reviewLabel: string;
    canReviewPlan: boolean;
    planReviewing: boolean;
    planReviewLabel: string;
    startPr: () => void;
    doMerge: (skipArm?: boolean) => Promise<void>;
    doRedeploy: (skipArm?: boolean) => Promise<void>;
    toggleReview: (e?: Event) => void;
    doReview: () => Promise<void>;
    doReviewPlan: () => Promise<void>;
  } = $props();
</script>

{#if git.issueUrl && issueNumber != null}
  <!-- eslint-disable svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
  <a
    class="prlink"
    href={git.issueUrl}
    target="_blank"
    rel="noopener"
    title={m.gitrail_issue_label({ number: issueNumber })}
    aria-label={m.gitrail_issue_label({ number: issueNumber })}>{m.gitrail_open_issue()}</a
  >
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
{/if}
{#if git.state === "none"}
  <!-- Hidden whenever autopilot is effectively on — the agent opens the PR itself,
       so the manual button is redundant. This stays hidden even while autopilot is
       PAUSED (autopilotPaused): a paused autopilot is still on and will resume and
       open the PR; the human escape hatch is the AP toggle in the same strip.
       autopilotPaused is surfaced separately via AutopilotBadge — not a signal to
       re-show this button. -->
  {#if !autopilotOn}
    <button class="gbtn" type="button" disabled={busy} onclick={startPr}
      >{local ? m.gitrail_open_for_merge() : m.gitrail_open_pr()}</button
    >
  {/if}
{:else if git.state === "open"}
  {#if local}
    <span class="prlink">{m.gitrail_ready_to_merge()} #{git.number}</span>
  {:else if git.url}
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
    <a
      class="prlink"
      href={git.url}
      target="_blank"
      rel="noopener"
      title={m.prbadge_open({ number: git.number ?? 0 })}
      aria-label={m.prbadge_open({ number: git.number ?? 0 })}>{m.gitrail_pr_link()}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  {:else}
    <span class="prlink" title={m.prbadge_open({ number: git.number ?? 0 })}
      >{m.gitrail_pr_plain()}</span
    >
  {/if}
  {#if !local}
    <span
      class="dot dot-{git.checks}"
      title={m.gitrail_ci_status({ status: git.checks })}
      aria-label={m.gitrail_ci_status({ status: git.checks })}
    ></span>
  {/if}
  <button
    class="gbtn"
    class:armed={armed === "merge"}
    type="button"
    disabled={mergeBlocked}
    title={mergeBlockedReason}
    onclick={() => doMerge()}
  >
    {#if local}
      {armed === "merge" ? m.gitrail_confirm_merge_locally() : m.gitrail_merge_locally()}
    {:else}
      {armed === "merge" ? m.gitrail_confirm_merge() : m.gitrail_merge()}
    {/if}
  </button>
{:else if git.state === "merged"}
  <span class="merged">{local ? m.gitrail_merged_locally() : m.gitrail_merged()}</span>
  {#if git.deployConfigured}
    <button
      class="gbtn"
      class:armed={armed === "redeploy"}
      type="button"
      disabled={busy}
      onclick={() => doRedeploy()}
    >
      {armed === "redeploy" ? m.gitrail_confirm_redeploy() : m.gitrail_redeploy()}
    </button>
  {/if}
{:else}
  <span class="merged">{m.gitrail_closed()}</span>
{/if}

{#if showReady && (git.state === "open" || ready) && status !== "running" && status !== "blocked"}
  <ReadyToggle {sessionId} {ready} {mobile} />
{/if}
<!-- while re-reviewing: keep the prior findings reachable (hasFindings ⇒ verdict body exists,
     so the showReview popover below still has content); otherwise a plain status chip. -->
{#if chip.kind === "reviewing"}
  {#if chip.hasFindings}
    <button
      class={["verdict-chip", "critic-reviewing", { armed: showReview }]}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={showReview}
      title={m.criticbadge_reviewing_title()}
      onclick={(e) => toggleReview(e)}
    >
      <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
    </button>
  {:else}
    <span class="verdict-chip critic-reviewing" title={m.criticbadge_reviewing_title()}>
      <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
    </span>
  {/if}
{:else if chip.kind === "verdict"}
  <button
    class={["verdict-chip", `critic-${chip.decision}`, { armed: showReview }]}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={showReview}
    title={m.gitrail_review_title()}
    onclick={(e) => toggleReview(e)}
  >
    {chip.label}
  </button>
{/if}

{#if canReview}
  <button
    class="gbtn"
    class:armed={armed === "review"}
    type="button"
    onclick={() => doReview()}
    use:coachTarget={"manual-critic-review"}
  >
    {reviewLabel}
  </button>
{/if}

{#if canReviewPlan}
  <button
    class="gbtn"
    class:armed={armed === "review-plan"}
    type="button"
    disabled={planReviewing}
    onclick={() => doReviewPlan()}
  >
    {planReviewLabel}
  </button>
{/if}

<style>
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 2px 8px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .gbtn.armed {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  .prlink {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    text-decoration: none;
  }
  .prlink:hover {
    color: var(--color-ink-bright);
  }

  .merged {
    font-size: var(--fs-meta);
    color: var(--color-slate);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    background: var(--color-faint);
  }
  .dot-pending {
    background: var(--color-amber);
    /* CI running — functional status motion, exempt from the reduced-motion
       blanket (app.css): the pulse encodes "work happening", not decoration. */
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .dot-success {
    background: var(--color-green);
  }
  .dot-failure {
    background: var(--color-red);
  }

  /* verdict chip: .gbtn sizing, colored by decision */
  .verdict-chip {
    background: transparent;
    border: 1px solid currentColor;
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 8px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      opacity 0.12s,
      box-shadow 0.12s;
  }
  .verdict-chip:hover {
    opacity: 0.8;
  }
  .verdict-chip.armed {
    box-shadow: 0 0 0 1px currentColor inset;
  }
  /* The reviewing-with-no-prior-findings variant renders as a <span>, not a
     <button> — nothing to open. Drop the base cursor:pointer so it doesn't
     advertise a tap that does nothing. */
  span.verdict-chip {
    cursor: default;
  }

  .verdict-chip.critic-reviewing {
    border-color: var(--color-amber);
    color: var(--color-amber);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  /* shared pulsing status dot for both the rail chip and the popover-head label */
  .verdict-chip.critic-reviewing .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: rev-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes rev-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  .verdict-chip.critic-changes_requested {
    color: var(--color-amber);
  }
  .verdict-chip.critic-commented {
    color: var(--color-blue);
  }
  .verdict-chip.critic-error {
    color: var(--color-faint);
  }
</style>
