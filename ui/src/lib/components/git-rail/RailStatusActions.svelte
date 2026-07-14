<script lang="ts">
  import type { GitState, SessionStatus } from "$lib/types";
  import type { CriticChip } from "../critic-badge";
  import ReadyToggle from "../ReadyToggle.svelte";
  import PrBadgeMenu from "../PrBadgeMenu.svelte";
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
    planReviewBlockedReason,
    startPr,
    togglePrDraft,
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
    planReviewBlockedReason: string | null;
    startPr: () => void;
    togglePrDraft: (draft: boolean) => Promise<boolean>;
    doMerge: (skipArm?: boolean) => Promise<void>;
    doRedeploy: (skipArm?: boolean) => Promise<void>;
    toggleReview: (e?: Event) => void;
    doReview: () => Promise<void>;
    doReviewPlan: () => Promise<void>;
  } = $props();

  // CI status → short chip label (issue sketch: "CI passing"). Full status stays in title/aria.
  function ciLabel(c: GitState["checks"]): string {
    return c === "success"
      ? m.gitrail_ci_passing()
      : c === "pending"
        ? m.gitrail_ci_pending()
        : c === "failure"
          ? m.gitrail_ci_failing()
          : m.gitrail_ci_none();
  }
  // CI status → .status-chip accent modifier ("" = neutral for the "none" state).
  function ciMod(c: GitState["checks"]): string {
    return c === "success" ? "pass" : c === "pending" ? "pend" : c === "failure" ? "fail" : "";
  }

  const canToggleDraft = $derived(git.kind === "github" || git.kind === "gitea");
  let prButton = $state<HTMLButtonElement>();
  let prMenuAnchor = $state<DOMRect | null>(null);

  function closePrMenu() {
    prMenuAnchor = null;
  }

  function togglePrMenu(e: MouseEvent) {
    e.stopPropagation();
    if (prMenuAnchor) closePrMenu();
    else if (prButton) prMenuAnchor = prButton.getBoundingClientRect();
  }

  function openPr() {
    closePrMenu();
    if (!git.url) return;
    window.open(git.url, "_blank", "noopener,noreferrer");
  }

  async function toggleDraftState() {
    if (await togglePrDraft(git.isDraft !== true)) closePrMenu();
  }
</script>

{#if git.issueUrl && issueNumber != null}
  <!-- eslint-disable svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
  <a
    class="status-chip"
    href={git.issueUrl}
    target="_blank"
    rel="noopener"
    title={m.gitrail_issue_label({ number: issueNumber })}
    aria-label={m.gitrail_issue_label({ number: issueNumber })}
    ><span class="dot" aria-hidden="true"></span>{m.gitrail_open_issue()}</a
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
    <span class="status-chip info"
      ><span class="dot" aria-hidden="true"></span>{m.gitrail_ready_to_merge()} #{git.number}</span
    >
  {:else if git.url}
    <button
      bind:this={prButton}
      type="button"
      class="status-chip info"
      class:open={!!prMenuAnchor}
      title={m.prbadge_open({ number: git.number ?? 0 })}
      aria-label={m.prbadge_button_title({
        label: m.prbadge_open({ number: git.number ?? 0 }),
      })}
      aria-haspopup="menu"
      aria-expanded={!!prMenuAnchor}
      onclick={togglePrMenu}
      ><span class="dot" aria-hidden="true"></span>{m.gitrail_pr_link()}</button
    >
  {:else}
    <span class="status-chip info" title={m.prbadge_open({ number: git.number ?? 0 })}
      ><span class="dot" aria-hidden="true"></span>{m.gitrail_pr_plain()}</span
    >
  {/if}
  {#if !local}
    <span
      class={["status-chip", ciMod(git.checks)]}
      title={m.gitrail_ci_status({ status: git.checks })}
      aria-label={m.gitrail_ci_status({ status: git.checks })}
    >
      <span class="dot" aria-hidden="true"></span>{ciLabel(git.checks)}
    </span>
  {/if}
  <button
    class={["gbtn", "merge", { armed: armed === "merge" }]}
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
  <span class="status-chip parked"
    ><span class="dot" aria-hidden="true"></span>{local
      ? m.gitrail_merged_locally()
      : m.gitrail_merged()}</span
  >
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
  <span class="status-chip parked"
    ><span class="dot" aria-hidden="true"></span>{m.gitrail_closed()}</span
  >
{/if}

{#if prMenuAnchor}
  <PrBadgeMenu
    anchor={prMenuAnchor}
    opener={prButton}
    isDraft={git.isDraft === true}
    canOpen={!!git.url}
    {canToggleDraft}
    {busy}
    onopen={openPr}
    ontoggledraft={toggleDraftState}
    onclose={closePrMenu}
  />
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
    class:armed={armed === "review-plan" && !planReviewBlockedReason}
    type="button"
    disabled={planReviewing}
    aria-disabled={planReviewBlockedReason ? "true" : undefined}
    title={planReviewBlockedReason ?? undefined}
    aria-label={planReviewBlockedReason
      ? `${planReviewLabel} — ${planReviewBlockedReason}`
      : undefined}
    onclick={() => {
      if (planReviewBlockedReason) return;
      doReviewPlan();
    }}
  >
    {planReviewLabel}
  </button>
{/if}

<style>
  /* Interactive controls take the 6px chip radius inside the chip row (chip-row
     cohesion, DESIGN.md #1541); a standalone button would stay 2px. */
  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    padding: 3px 9px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .gbtn:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: var(--color-hover);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* Inert (not busy) — kept focusable so the reason in `title`/aria-label is reachable
     by keyboard, unlike bare `disabled`. */
  .gbtn[aria-disabled="true"] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .gbtn[aria-disabled="true"]:hover {
    border-color: var(--color-line);
    color: var(--color-muted);
    background: transparent;
  }
  .gbtn.armed {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* MERGE is the single amber primary action in the row (Quiet Ground: the one
     amber action). Secondary actions stay ghost-muted until hover. */
  .gbtn.merge:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* Status Chip — component-scoped copy of the canonical recipe (DESIGN.json;
     there is no shared class). Functional-status readouts plus the PR menu
     trigger. Semantic hue on border + text + leading dot. */
  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--color-panel-2);
    color: var(--color-muted);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-chip);
    padding: 3px 9px;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    text-decoration: none;
  }
  button.status-chip {
    appearance: none;
    margin: 0;
    line-height: inherit;
  }
  a.status-chip,
  button.status-chip {
    cursor: pointer;
    transition: background 0.12s;
  }
  a.status-chip:hover,
  button.status-chip:hover,
  button.status-chip.open {
    background: var(--color-hover);
  }
  button.status-chip:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .status-chip .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-muted);
    flex: none;
  }
  .status-chip.info {
    color: var(--color-blue);
    border-color: var(--color-blue);
  }
  .status-chip.info .dot {
    background: var(--color-blue);
  }
  .status-chip.pass {
    color: var(--color-green);
    border-color: var(--color-green);
  }
  .status-chip.pass .dot {
    background: var(--color-green);
  }
  .status-chip.pend {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .status-chip.pend .dot {
    background: var(--color-amber);
    /* CI running — functional status motion, exempt from the reduced-motion
       blanket (app.css): the pulse encodes "work happening", not decoration. */
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .status-chip.fail {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  .status-chip.fail .dot {
    background: var(--color-red);
  }
  .status-chip.parked {
    color: var(--color-slate);
    border-color: color-mix(in srgb, var(--color-slate) 60%, var(--color-line));
  }
  .status-chip.parked .dot {
    background: var(--color-slate);
  }

  /* verdict chip: 6px chip-row cohesion, colored by decision */
  .verdict-chip {
    background: transparent;
    border: 1px solid currentColor;
    border-radius: var(--radius-chip);
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 3px 9px;
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
