<script lang="ts">
  import {
    gitState,
    setPrDraftState,
    openPr,
    redeploy,
    reviewPlan,
    isPlanReviewError,
    planReviewStarted,
  } from "#lib/api.js";
  import type { DrainStatus, GitState, Session } from "#lib/types.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { reviews, repoConfig, planGates } from "#lib/reviews.svelte.js";
  import { criticChip } from "./critic-badge";
  import { canOfferPlanReview, canTriggerPlanReview } from "./plan-gate-badge";
  import RailStatusActions from "./git-rail/RailStatusActions.svelte";
  import PrFindingsDialog from "./PrFindingsDialog.svelte";
  import AutomationPanel from "./AutomationPanel.svelte";
  import { automationCount, AUTOMATION_TOTAL } from "./git-rail-automation";
  import { coachTarget, coachTargets } from "#lib/actions/coachTarget.svelte.js";
  import { featureDiscovery } from "#lib/featureDiscovery.svelte.js";
  import { featureAnnouncements } from "#lib/feature-announcements.js";
  import LazyMount from "#lib/components/page/LazyMount.svelte";
  import { loadCoachmark } from "#lib/components/page/overlay-loaders.js";
  import { pollWhileVisible } from "#lib/visibility.js";
  import { railEpicChild, railEpicStopped } from "./git-rail/epic-rail";

  let {
    sessionId,
    repoPath = "",
    name = "",
    prompt = "",
    mobile = false,
    phone = false,
    planPhase = null,
    drain = null,
    autopilotOn = false,
    issueNumber = null,
    baseBranch = "",
    epicParent = null,
    rowOwnsPr = false,
  }: {
    sessionId: string;
    repoPath?: string;
    name?: string;
    prompt?: string;
    mobile?: boolean;
    /** Phone width: the ⚙ pill drops its word label to `⚙ n/N` (aria-label keeps it). */
    phone?: boolean;
    planPhase?: Session["planPhase"];
    /** Live drain status for this session's repo; passed through to AutomationPanel. */
    drain?: DrainStatus | null;
    /** Effective autopilot state. When on, the agent opens the PR itself, so the manual
        Open-PR button is redundant noise and is hidden. */
    autopilotOn?: boolean;
    /** Backlog issue this session was spawned for; drives the leftmost open-issue link.
        null = no linked issue. */
    issueNumber?: number | null;
    /** The session's base branch (e.g. "main"); an `epic/<n>-…` base marks an epic child. */
    baseBranch?: string;
    /** The epic this session is a child of (`Session.epicParent`); null for a non-epic session. */
    epicParent?: number | null;
    /** The merge row is on screen: it owns the PR's state and links, the rail keeps the rest. */
    rowOwnsPr?: boolean;
  } = $props();

  let git = $state<GitState | null>(null);
  let busy = $state(false);
  let err = $state<string | null>(null);
  // which handler last failed, so the inline Retry re-invokes the same action
  let retry = $state<(() => void) | null>(null);
  // the initial PR-status fetch threw (forge error, e.g. 502 when GitHub is
  // rate-limited) — distinct from a legit 404 (gitState returns null silently for
  // "no forge / no PR"). Drives the error+Retry fallback so the rail never renders
  // silently empty, and keeps the poll retrying until the forge recovers.
  let loadFailed = $state(false);

  // Open-PR popover
  let showPr = $state(false);
  let prTitle = $state("");
  let prBody = $state("");

  // Critic-findings dialog (PrFindingsDialog); the outside-click dismiss below is the
  // automation popover's.
  let showReview = $state(false);
  let wrapEl = $state<HTMLElement | null>(null);

  // Repo-automation panel (pill-anchored popover; replaces the icon-toggle horde)
  let showAutomation = $state(false);

  // two-step confirm for destructive actions (mirrors decommission UX). Merge is NOT among them:
  // it lives in the merge row above the steer bar (#3540), behind MergeConfirmDialog (#2299).
  let armed = $state<"redeploy" | "review-plan" | null>(null);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  function arm(which: "redeploy" | "review-plan"): boolean {
    if (armed === which) {
      clearTimeout(armTimer);
      armed = null;
      return true; // confirmed
    }
    armed = which;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => (armed = null), 3000);
    return false;
  }

  async function load(id: string) {
    try {
      const g = await gitState(id);
      if (id === sessionId) {
        git = g;
        loadFailed = false;
      }
    } catch {
      // The forge call failed (non-404 — gitState already maps 404 to a silent null
      // for "no forge / no PR"). Flag it so the rail shows a Retry affordance instead
      // of rendering empty, and so the poll below keeps retrying until it recovers.
      if (id === sessionId) {
        git = null;
        loadFailed = true;
      }
    }
  }

  // Bridge the gap between the review-plan HTTP reply and the WS plangate-reviewing
  // flag so the button's reviewing state doesn't blink back to idle. Held until the
  // reviewing flag is observed, with a backstop timeout so a lost event can't wedge it.
  let awaitingPlanReview = $state(false);
  // A real WS reviewing run supersedes the bridge.
  $effect(() => {
    if (planGates.isReviewing(sessionId)) awaitingPlanReview = false;
  });
  // Backstop: never wedge the indicator if the reviewing event never arrives.
  $effect(() => {
    if (!awaitingPlanReview) return;
    const t = setTimeout(() => (awaitingPlanReview = false), 4000);
    return () => clearTimeout(t);
  });

  // Close the Open-PR compose popover if autopilot flips on while it's open (toggle, or a
  // WS session:autopilot event): the trigger button is gated on !autopilotOn, but the
  // popover renders on its own showPr flag — without this it could dangle and still submit.
  $effect(() => {
    if (autopilotOn) showPr = false;
  });

  $effect(() => {
    const id = sessionId;
    git = null;
    err = null;
    retry = null;
    armed = null;
    showPr = false;
    showReview = false;
    showAutomation = false;
    awaitingPlanReview = false;
    loadFailed = false;
    load(id);
    // light poll while a PR is open (CI/merge state can change) OR while the last load
    // failed — a transient forge error (e.g. GitHub rate-limited) then clears on its own
    // instead of leaving the rail permanently blank. Hidden-tab ticks are skipped, with
    // a refresh on tab return.
    return pollWhileVisible(() => {
      if (loadFailed || git?.state === "open") load(id);
    }, 15000);
  });

  function startPr() {
    prTitle = name;
    prBody = prompt;
    showPr = true;
    showReview = false; // one popover at a time
    showAutomation = false; // one popover at a time
    err = null;
    retry = null;
  }

  function toggleReview(e?: Event) {
    showReview = !showReview;
    if (showReview) {
      // use:dialog restores focus to what held it at open; a tap doesn't focus the chip on every
      // browser, so focus it explicitly.
      (e?.currentTarget as HTMLElement | null)?.focus();
      showPr = false; // one popover at a time
      showAutomation = false;
    }
  }

  function toggleAutomation() {
    showAutomation = !showAutomation;
    if (showAutomation) {
      showPr = false;
      showReview = false; // one popover at a time
      // The critic/auto-address toggles now live behind this pill, so their
      // discovery coachmarks re-home onto it: arm the first still-unseen one on open.
      armFirstUnseenAutomation();
    }
  }

  // Escape / click-outside dismiss the automation popover (PrFindingsDialog dismisses itself)
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (showAutomation) showAutomation = false;
    }
  }
  function onWindowPointerdown(e: PointerEvent) {
    if (wrapEl && !wrapEl.contains(e.target as Node)) {
      if (showAutomation) showAutomation = false;
    }
  }

  // server message, when meaningful, becomes the {reason} clause; otherwise a generic fallback
  function reason(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message.trim() : "";
    return msg || fallback;
  }

  async function submitPr() {
    busy = true;
    err = null;
    retry = null;
    try {
      git = {
        kind: git?.kind ?? "github",
        ...(await openPr(sessionId, { title: prTitle, body: prBody })),
      };
      showPr = false;
    } catch (e) {
      err = m.gitrail_open_pr_failed({ reason: reason(e, m.gitrail_open_pr()) });
      retry = submitPr;
    } finally {
      busy = false;
    }
  }

  async function doRedeploy(skipArm = false) {
    if (!skipArm && !arm("redeploy")) return;
    busy = true;
    err = null;
    retry = null;
    try {
      await redeploy(sessionId);
    } catch (e) {
      err = m.gitrail_redeploy_failed({ reason: reason(e, m.gitrail_redeploy()) });
      retry = () => doRedeploy(true);
    } finally {
      busy = false;
    }
  }

  async function doTogglePrDraft(draft: boolean): Promise<boolean> {
    busy = true;
    err = null;
    retry = null;
    try {
      git = await setPrDraftState(sessionId, draft);
      toasts.info(draft ? m.prbadge_marked_draft() : m.prbadge_marked_ready(), {
        key: `pr-draft:${sessionId}`,
      });
      return true;
    } catch (e) {
      toasts.info(
        m.prbadge_draft_toggle_failed({
          reason: e instanceof Error ? e.message : m.prbadge_unknown_error(),
        }),
        { alert: true, key: `pr-draft:${sessionId}` },
      );
      return false;
    } finally {
      busy = false;
    }
  }

  // #2735: the rail marks an epic run that won't integrate this child.
  const epicChild = $derived(railEpicChild(epicParent, baseBranch));
  const epicStopped = $derived(railEpicStopped(epicChild, drain));

  const local = $derived(git?.kind === "local");

  const verdict = $derived(reviews.map[sessionId]);
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const pillReviewing = $derived(reviewing || planGates.isReviewing(sessionId));
  const chip = $derived(criticChip(verdict, reviewing));
  // Manual plan-review trigger: visible while the plan gate is active (planPhase === "planning"),
  // and — since #2224 — during execution when the approved plan has been edited since sign-off.
  // Matches PlanPanel's canReviewNow. The arm/confirm latch below matters more in that second case:
  // a re-review whose verdict requests changes returns the session to planning and stops the agent.
  const canReviewPlan = $derived(canOfferPlanReview({ planPhase }, planGates.map[sessionId]));
  const planReviewing = $derived(planGates.isReviewing(sessionId) || awaitingPlanReview);
  // Only an UNEDITED `approved` gate is a genuine block: `force` re-reviews an unchanged/at-cap
  // plan, and since #2224 an edited approved one too, so that is the sole state a click dead
  // no-ops. Pass GitRail's own `planReviewing` (store flag ∪ the 3 s optimistic bridge) so the
  // block can't re-enable mid-bridge.
  // (The "reviewing" case is already covered by the button's `disabled={planReviewing}` busy state.)
  const planReviewBlock = $derived(
    canTriggerPlanReview({ planPhase }, planGates.map[sessionId], planReviewing),
  );
  const planReviewBlockedReason = $derived(
    planReviewBlock === "approved" ? m.gitrail_review_plan_approved() : null,
  );
  // If the control becomes blocked while its 3 s confirm latch is armed, drop the latch so it
  // can't linger on an inert button.
  $effect(() => {
    if (planReviewBlockedReason && armed === "review-plan") armed = null;
  });
  const planReviewLabel = $derived(
    armed === "review-plan"
      ? m.gitrail_confirm_review()
      : planReviewing
        ? m.gitrail_reviewing_plan()
        : planGates.map[sessionId]
          ? m.gitrail_rereview_plan()
          : m.gitrail_review_plan(),
  );
  const autoCount = $derived(automationCount(repoConfig.flags(repoPath)));

  // Coachmark: which feature is currently "armed" (popover open on first reveal).
  // armedId is set when the automation pill is first opened while a feature is unseen;
  // cleared on onseen (markSeen) or onclose (dismiss without marking seen).
  let armedId = $state<string | null>(null);

  // Feature ids whose controls moved behind the automation pill; their discovery
  // coachmarks now anchor on the pill instead of their (deleted) individual toggles.
  const PILL_FEATURE_IDS = ["critic", "auto-address"] as const;

  // A passive "new" dot rides the pill while any relocated feature is still unseen.
  const automationHasUnseen = $derived(PILL_FEATURE_IDS.some((id) => !featureDiscovery.isSeen(id)));

  // Arm the first relocated feature that is unseen AND has a pill target registered.
  function armFirstUnseenAutomation() {
    const next = PILL_FEATURE_IDS.find(
      (id) => !featureDiscovery.isSeen(id) && coachTargets.has(id),
    );
    if (next) armedId = next;
  }

  // The first catalog entry whose targetId is registered in coachTargets AND not yet seen
  // AND is currently armed. Reading coachTargets (SvelteMap) here makes this reactive to
  // session-switch registry changes (action destroy deletes, remount re-registers).
  const armedEntry = $derived(
    armedId && !featureDiscovery.isSeen(armedId) && coachTargets.has(armedId)
      ? (featureAnnouncements.find((e) => e.targetId === armedId) ?? null)
      : null,
  );

  $effect(() => {
    if (repoPath) repoConfig.ensure(repoPath);
  });

  async function doReviewPlan() {
    if (!arm("review-plan")) return; // first click arms, second confirms
    if (planReviewing) return; // already in flight — consider() would skip
    try {
      const status = await reviewPlan(sessionId);
      // started (either flavour) → bridge to the WS reviewing flag (the indicator is the feedback).
      // "started-at-cap" additionally warns that findings won't be re-sent — the run is real, but the
      // rework budget is spent, so Resume is the affordance that delivers (#1759).
      // "skipped" while NOT already reviewing → transient note. Any error-* → 12s failure toast.
      if (planReviewStarted(status)) {
        awaitingPlanReview = true;
        if (status === "started-at-cap")
          // 12s + hover-pause (alert), not the 4s notice tier: this warns that the run the
          // operator just paid for will not deliver its findings. Keyed so repeat clicks replace.
          toasts.info(m.plangate_review_at_cap(), {
            alert: true,
            key: `review-plan-at-cap:${sessionId}`,
          });
      } else if (status === "plan-unavailable" && !planGates.isReviewing(sessionId))
        toasts.info(m.gitrail_review_plan_unavailable());
      else if (status === "skipped" && !planGates.isReviewing(sessionId))
        toasts.info(m.gitrail_review_plan_skipped());
      else if (isPlanReviewError(status))
        toasts.info(m.gitrail_review_plan_failed(), {
          alert: true,
          key: `review-plan:${sessionId}`,
        });
    } catch {
      toasts.info(m.gitrail_review_plan_failed(), {
        alert: true,
        key: `review-plan:${sessionId}`,
      });
    }
  }

  // The mobile rail is a hidden-scrollbar horizontal scroller; without a visible
  // bar nothing hints that trailing controls (verdict chip, PR menu) scroll off
  // the right edge. Fade whichever edge still has content beyond it, driven into
  // the .rail.mobile mask via --fade-l/--fade-r (0 = no fade, 1 = fade). A row
  // that fully fits shows no fade; an overflowing one cues the scroll. No-op (and
  // self-cleans) on desktop, where the rail isn't a scroller.
  function edgeFades(node: HTMLElement, enabled: boolean) {
    let ro: ResizeObserver | undefined;
    let mo: MutationObserver | undefined;
    const update = () => {
      const max = node.scrollWidth - node.clientWidth;
      node.style.setProperty("--fade-l", node.scrollLeft > 1 ? "1" : "0");
      node.style.setProperty("--fade-r", node.scrollLeft < max - 1 ? "1" : "0");
    };
    const start = () => {
      update();
      node.addEventListener("scroll", update, { passive: true });
      ro = new ResizeObserver(update);
      ro.observe(node);
      // The rail's box is width:100% of its wrapper, so a content change that
      // shifts scrollWidth without resizing that box (Redeploy arming to 'confirm ⟳',
      // the verdict chip appearing) won't trip ResizeObserver — watch the subtree
      // too so the fade can't go stale. NOT attributes: our own --fade-* writes are
      // style-attribute mutations and would loop.
      mo = new MutationObserver(update);
      mo.observe(node, { childList: true, subtree: true, characterData: true });
    };
    const stop = () => {
      node.removeEventListener("scroll", update);
      ro?.disconnect();
      mo?.disconnect();
      ro = mo = undefined;
      node.style.removeProperty("--fade-l");
      node.style.removeProperty("--fade-r");
    };
    if (enabled) start();
    return {
      update(next: boolean) {
        stop();
        if (next) start();
      },
      destroy: stop,
    };
  }
</script>

<!-- ⚙ automation pill. Sits OUTSIDE the (mobile: scrolling) .rail so on the strip it pins
     beside the autopilot toggle as one control cluster. -->
{#snippet autoPill()}
  <button
    class={["gbtn", "auto-pill", { reviewing: pillReviewing, armed: showAutomation }]}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={showAutomation}
    aria-busy={pillReviewing}
    aria-label={pillReviewing
      ? m.automation_pill_reviewing_aria()
      : m.automation_pill_aria({ count: autoCount, total: AUTOMATION_TOTAL })}
    use:coachTarget={"critic"}
    use:coachTarget={"auto-address"}
    onclick={toggleAutomation}
  >
    ⚙{phone ? "" : ` ${m.automation_pill_label()}`}
    <span class="auto-count" class:on={autoCount > 0}>{autoCount}/{AUTOMATION_TOTAL}</span>
    {#if automationHasUnseen}<span class="new-dot" aria-hidden="true"></span><span class="sr-only"
        >{m.newdot_aria()}</span
      >{/if}
  </button>
{/snippet}

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

{#if git}
  <!-- touch-only dim+blur behind the automation sheet. It sits
       OUTSIDE wrapEl so a backdrop tap trips the existing click-outside dismiss.
       Desktop keeps the lightweight anchored popover (non-modal, no scrim); only the
       coarse-pointer layout — where the panel becomes a centered fixed sheet — shows
       it (CSS-gated). Reuses the canonical .scrim primitive. Purely visual → aria-hidden. -->
  {#if showAutomation}
    <div class="auto-scrim scrim" aria-hidden="true"></div>
  {/if}
  <span class="git-rail-wrap" class:mobile bind:this={wrapEl}>
    <span class="rail" class:mobile use:edgeFades={mobile}>
      <RailStatusActions
        {git}
        {issueNumber}
        {local}
        {autopilotOn}
        {busy}
        {armed}
        {sessionId}
        {mobile}
        {chip}
        {showReview}
        {canReviewPlan}
        {planReviewing}
        {planReviewLabel}
        {planReviewBlockedReason}
        {startPr}
        togglePrDraft={doTogglePrDraft}
        {doRedeploy}
        {toggleReview}
        {doReviewPlan}
        {epicStopped}
        {rowOwnsPr}
      />

      {#if err}
        <span class="err" role="alert" title={err}>{err}</span>
        {#if retry}
          <button class="gbtn" type="button" disabled={busy} onclick={() => retry?.()}
            >{m.common_retry()}</button
          >
        {/if}
      {/if}
    </span>
    {#if repoPath}
      <!-- the single divider: git status │ control cluster. On mobile it hides with the rail
           when no status renders, so it can never orphan at the strip's leading edge. -->
      <span class="rail-sep cluster-sep" aria-hidden="true"></span>
      {@render autoPill()}
    {/if}

    {#if showPr}
      <div class="pr-pop">
        <input
          class="pr-title"
          bind:value={prTitle}
          placeholder={m.gitrail_pr_title_placeholder()}
          aria-label={m.gitrail_pr_title_aria()}
        />
        <textarea
          class="pr-body"
          data-1p-ignore
          bind:value={prBody}
          placeholder={m.gitrail_pr_description_placeholder()}
          aria-label={m.gitrail_pr_body_aria()}
          rows="4"></textarea>
        <div class="pr-actions">
          <button class="gbtn" type="button" onclick={() => (showPr = false)}
            >{m.gitrail_cancel()}</button
          >
          <button
            class="gbtn primary"
            type="button"
            disabled={busy || !prTitle.trim()}
            onclick={submitPr}
          >
            {m.gitrail_create_pr()}
          </button>
        </div>
      </div>
    {/if}

    {#if showAutomation}
      <AutomationPanel
        {repoPath}
        {sessionId}
        {planPhase}
        {drain}
        onClose={() => (showAutomation = false)}
      />
    {/if}

    {#if armedEntry}
      <!-- Lazy: the feature-catalog copy rides with Coachmark, off the boot bundle (#3242). -->
      <LazyMount load={loadCoachmark} onerror={() => (armedId = null)}>
        {#snippet children(Coachmark)}
          <Coachmark
            targetId={armedEntry.targetId ?? null}
            titleKey={armedEntry.titleKey}
            bodyKey={armedEntry.bodyKey}
            onseen={() => {
              if (armedId) featureDiscovery.markSeen(armedId);
              armedId = null;
            }}
            onclose={() => {
              armedId = null;
            }}
          />
        {/snippet}
      </LazyMount>
    {/if}

    {#if showReview && verdict}
      <PrFindingsDialog
        {sessionId}
        {verdict}
        {chip}
        {git}
        {busy}
        onclose={() => (showReview = false)}
      />
    {/if}
  </span>
{:else if loadFailed}
  <!-- the forge call failed (e.g. 502 — GitHub rate-limited). Without this branch the
       rail rendered nothing: no PR link, no error, no way to retry — the operator just
       saw missing buttons and couldn't open the PR. Surface the failure + a manual
       retry; the 15s poll also keeps retrying so a transient rate-limit clears itself. -->
  <span class="git-rail-wrap" class:mobile>
    <span class="rail" class:mobile use:edgeFades={mobile}>
      <span class="err" role="alert" title={m.gitrail_status_failed()}
        >{m.gitrail_status_failed()}</span
      >
      <button class="gbtn" type="button" disabled={busy} onclick={() => load(sessionId)}
        >{m.common_retry()}</button
      >
    </span>
  </span>
{/if}

<style>
  /* own positioning context so .pr-pop/.auto-pop anchor here in the
     desktop (non-mobile) mount, not to some far ancestor. On mobile the wrapper
     is narrower than the strip, so it goes position:static and the popovers
     anchor to the wider .vp-git-strip instead — see .git-rail-wrap.mobile. */
  .git-rail-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .rail {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .rail-sep {
    width: 1px;
    background: var(--color-line);
    flex-shrink: 0;
    align-self: stretch;
  }

  .gbtn {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
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
  /* Rail buttons (⚙ automation pill, err/Retry) take the 6px chip radius for
     chip-row cohesion (DESIGN.md #1541). Scoped to .rail so the PR-compose /
     findings-popover dialog buttons keep the standalone 2px. */
  .rail .gbtn,
  .auto-pill {
    border-radius: var(--radius-chip);
    padding: 3px 9px;
  }
  /* critic actively reviewing: amber outline (reused by automation pill) */
  .gbtn.reviewing {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* automation summary pill: worded label + active-count, replaces the toggle horde */
  .auto-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  /* active-count is informational telemetry, not a status light: it steps from
     faint (nothing on) to plain ink, never green (Four-Light Rule, DESIGN.md) */
  .auto-count {
    color: var(--color-faint);
  }
  .auto-count.on {
    color: var(--color-ink);
  }

  /* "new" discovery pip — separate element, distinct hue (accent blue ring).
     Sits next to .crit-dot inside the flex row; does NOT overload .crit-dot's
     grey/green/amber vocabulary.
     Visual priority: lower than .reviewing (reviewing uses !important pulse + amber,
     new-dot is a soft accent and loses visually by design).
     Reduced-motion: animation intentionally lacks !important so the global blanket
     in app.css (@media prefers-reduced-motion: reduce { animation: none !important })
     suppresses it — unlike .reviewing which is exempt. */
  .new-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--color-blue);
    flex-shrink: 0;
    animation: new-pip-pulse 2s ease-in-out infinite;
  }
  @keyframes new-pip-pulse {
    0%,
    100% {
      opacity: 0.4;
    }
    50% {
      opacity: 1;
    }
  }

  /* Visually hidden but available to screen readers */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }

  /* touch layouts: bigger tap targets + a single horizontally-scrollable row.
     Whole badges never wrap to a second line (that read as a vertical stack on
     phones); the rail (.rail.mobile below) scrolls instead. Because the strip
     keeps .strip-controls on this same row, the wrapper is narrower than the
     viewport — so go position:static here and let the popovers
     (.pr-pop/.auto-pop) anchor to the full-width .vp-git-strip
     (itself position:relative). Anchored to this narrow wrapper, a right:8px
     popover would shoot off the left screen edge. The ⚙ pill sits after the
     rail (not in it), so it pins right beside the strip's autopilot toggle. */
  .git-rail-wrap.mobile {
    position: static;
    flex: 1 1 auto;
    min-width: 0;
    justify-content: flex-end;
  }
  .rail.mobile {
    flex: 1 1 auto;
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    min-width: 0;
    gap: 6px;
    /* scroll affordance: with the scrollbar hidden, fade whichever edge has more
       content beyond it so an overflowing row visibly cues the scroll (the edgeFades
       action sets --fade-l/--fade-r to 0|1). The #000/transparent stops are mask
       alpha, not a theme color — the faded edge just reveals the strip's own
       --color-head behind the rail. Both vars 0 (fits / no action) → fully opaque. */
    --rail-fade: 22px;
    --fade-l: 0;
    --fade-r: 0;
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 calc(var(--fade-l) * var(--rail-fade)),
      #000 calc(100% - var(--fade-r) * var(--rail-fade)),
      transparent 100%
    );
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 calc(var(--fade-l) * var(--rail-fade)),
      #000 calc(100% - var(--fade-r) * var(--rail-fade)),
      transparent 100%
    );
  }
  .rail.mobile::-webkit-scrollbar {
    display: none;
  }
  /* horizontal-scroll row: items keep natural width and overflow → scroll,
     never shrink-wrap (the PR link wrapped to 3 lines and the CI dot squished
     to 0px otherwise). Mirrors the .tab-scroll recipe. */
  .rail.mobile > :global(*) {
    flex-shrink: 0;
  }
  /* right-pin the badge group when it fits; under overflow the auto margin
     collapses to 0 so the row scrolls cleanly from the first badge (avoids the
     flex justify-content:flex-end + overflow-x start-clip bug) */
  .rail.mobile > :global(:first-child) {
    margin-left: auto;
  }
  .rail.mobile :global(.gbtn),
  .git-rail-wrap.mobile > .auto-pill {
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 9px;
    font-size: var(--fs-base);
  }
  .git-rail-wrap.mobile > .auto-pill {
    flex-shrink: 0;
  }
  /* The critic chip is the gateway to the findings popover, but it's a
     .verdict-chip — not a .gbtn — so it missed the touch enlargement above and
     rendered at ~half height (23px) in muted text, indistinguishable from the
     passive list badge. On touch (no hover affordance) the happy "✓ REVIEWED"
     chip then read as a status label, not a button, so findings were effectively
     unreachable on mobile/fold. Match it to the sibling controls: a full-height
     tap target that obviously invites a tap. Scoped to button.verdict-chip so the
     non-interactive reviewing <span> (no prior findings) isn't blown up into a
     full-height button-looking element that does nothing on tap. */
  .rail.mobile :global(button.verdict-chip) {
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 9px;
    font-size: var(--fs-base);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  /* status-chips keep their touch legibility at --fs-base. Height/box treatment then
     splits by affordance (element type), NOT by a blanket rule: */
  .rail.mobile :global(.status-chip) {
    font-size: var(--fs-base);
  }
  /* Tappable status-chips — the Issue link (<a>) and the PR-menu trigger (<button>) — ARE
     tap targets, so promote them to the 44px touch floor like their .gbtn / button.verdict-chip
     siblings. Fixes the sub-44px a11y violation; the span. readouts below stay short. */
  .rail.mobile :global(a.status-chip),
  .rail.mobile :global(button.status-chip) {
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 9px;
  }
  /* Passive readouts (CI, merged, closed, plain/ready PR) and the reviewing-no-findings chip
     de-box on mobile: drop the fill + border so they read as inline dot+text labels rather
     than short boxes clashing against the 44px controls. Hue stays on the dot + text. The
     `span.` prefix keeps specificity above the .status-chip.info/.pend/… hue variants so the
     transparent border wins. No min-height → they stay short (not fake tap targets). */
  .rail.mobile :global(span.status-chip),
  .rail.mobile :global(span.verdict-chip) {
    background: transparent;
    border-color: transparent;
    padding: 0;
    font-size: var(--fs-base);
  }
  /* git status │ control-cluster divider breathes 14px each side (8px margin + the wrap's
     6px gap), matching the status-sep. No status chips → the rail has no element children:
     hide it and its divider so the cluster stands alone with no orphan hairline. */
  .git-rail-wrap.mobile > .cluster-sep {
    margin: 0 8px;
  }
  .rail.mobile:not(:has(> *)),
  .rail.mobile:not(:has(> *)) + .cluster-sep {
    display: none;
  }
  .rail.mobile :global(.dot) {
    width: 9px;
    height: 9px;
  }

  .err {
    font-size: var(--fs-micro);
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-red);
  }

  .pr-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 20;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: 320px;
    max-width: 90vw;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }

  .pr-title,
  .pr-body {
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    padding: 4px 6px;
    resize: vertical;
  }

  .pr-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  /* backdrop behind the automation sheet — only on touch, where the panel becomes a
     centered fixed sheet (see AutomationPanel's pointer:coarse block). The canonical
     .scrim class supplies fixed/inset/dim/blur (and the reduced-transparency drop);
     this rule only contributes the z-index and the coarse-pointer gate. Desktop keeps
     the anchored non-modal popover, so it stays display:none there. */
  .auto-scrim {
    display: none;
    z-index: 50;
  }
  @media (pointer: coarse) {
    .auto-scrim {
      display: block;
    }
  }
</style>
