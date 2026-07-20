<script lang="ts">
  import {
    gitState,
    setPrDraftState,
    openPr,
    mergePr,
    redeploy,
    replySession,
    reviewPr,
    reviewPlan,
    isPlanReviewError,
    planReviewStarted,
  } from "$lib/api";
  import type { DrainStatus, GitState, Session, SessionStatus } from "$lib/types";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import { reviews, repoConfig, planGates } from "$lib/reviews.svelte";
  import { checksCleared } from "$lib/checks-cleared";
  import { isConflicting } from "$lib/pr-conflict";
  import { criticChip, criticBadgeLabel } from "./critic-badge";
  import { canTriggerPlanReview } from "./plan-gate-badge";
  import RailStatusActions from "./git-rail/RailStatusActions.svelte";
  import AutomationPanel from "./AutomationPanel.svelte";
  import { automationCount, AUTOMATION_TOTAL } from "./git-rail-automation";
  import { coachTarget, coachTargets } from "$lib/actions/coachTarget.svelte";
  import { featureDiscovery } from "$lib/featureDiscovery.svelte";
  import { featureAnnouncements } from "$lib/feature-announcements";
  import Coachmark from "$lib/components/Coachmark.svelte";
  import { pollWhileVisible } from "$lib/visibility";
  import { pullMainAndToast } from "$lib/pull-offer";

  let {
    sessionId,
    repoPath = "",
    name = "",
    prompt = "",
    mobile = false,
    ready = false,
    status = "idle",
    showReady = true,
    planPhase = null,
    drain = null,
    autopilotOn = false,
    issueNumber = null,
    isolated = false,
    baseBranch = "",
    ondecommission = undefined,
  }: {
    sessionId: string;
    repoPath?: string;
    name?: string;
    prompt?: string;
    mobile?: boolean;
    ready?: boolean;
    status?: SessionStatus;
    showReady?: boolean;
    planPhase?: Session["planPhase"];
    /** Live drain status for this session's repo; passed through to AutomationPanel. */
    drain?: DrainStatus | null;
    /** Effective autopilot state. When on, the agent opens the PR itself, so the manual
        Open-PR button is redundant noise and is hidden. */
    autopilotOn?: boolean;
    /** Backlog issue this session was spawned for; drives the leftmost open-issue link.
        null = no linked issue. */
    issueNumber?: number | null;
    /** When true and repoPath is set, the post-merge toast offers a combined
        "Decommission & update local" action that also fast-forwards the local default branch. */
    isolated?: boolean;
    /** The session's base branch (e.g. "main"); used by the combined fast-forward action. */
    baseBranch?: string;
    /** Offer to tear down THIS session after its PR is merged; called with the merged session's id. */
    ondecommission?: (id: string) => void;
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

  // Critic-findings popover (read the full verdict body without leaving the app)
  let showReview = $state(false);
  let wrapEl = $state<HTMLElement | null>(null);
  // The findings popover is modal (a scrim makes it modal on every size), so it
  // needs real focus semantics: focus moves in on open, restores to the opener on
  // close, and Tab is trapped inside. reviewPopEl is the dialog container;
  // reviewOpener is the chip that opened it (so focus can return there).
  let reviewPopEl = $state<HTMLElement | null>(null);
  let reviewOpener: HTMLElement | null = null;

  // Repo-automation panel (pill-anchored popover; replaces the icon-toggle horde)
  let showAutomation = $state(false);

  // two-step confirm for destructive actions (mirrors decommission UX)
  let armed = $state<"merge" | "redeploy" | "review" | "review-plan" | null>(null);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  function arm(which: "merge" | "redeploy" | "review" | "review-plan"): boolean {
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
      // remember which chip opened the dialog so focus can be restored on close;
      // fall back to the active element (e.g. keyboard activation without currentTarget)
      reviewOpener =
        (e?.currentTarget as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
      showPr = false; // one popover at a time
      showAutomation = false;
    }
  }

  function toggleAutomation() {
    showAutomation = !showAutomation;
    if (showAutomation) {
      showPr = false;
      showReview = false; // one popover at a time
      // The critic/auto-address/learnings toggles now live behind this pill, so their
      // discovery coachmarks re-home onto it: arm the first still-unseen one on open.
      armFirstUnseenAutomation();
    }
  }

  // Escape / click-outside dismiss the findings + automation popovers
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (showReview) showReview = false;
      if (showAutomation) showAutomation = false;
    }
  }
  function onWindowPointerdown(e: PointerEvent) {
    if (wrapEl && !wrapEl.contains(e.target as Node)) {
      if (showReview) showReview = false;
      if (showAutomation) showAutomation = false;
    }
  }

  // Modal focus management for the findings dialog, scoped strictly to showReview
  // (the PR popover + AutomationPanel are unaffected). On open: move focus into the
  // dialog. On close: restore focus to the opener — guarded so a now-detached opener
  // (e.g. a session switch reset showReview while the dialog was open) is a no-op.
  $effect(() => {
    if (showReview && reviewPopEl) {
      reviewPopEl.focus();
    } else if (!showReview) {
      const opener = reviewOpener;
      reviewOpener = null;
      if (opener?.isConnected) opener.focus();
    }
  });

  // Minimal Tab focus-trap. Focusable nodes are enumerated DYNAMICALLY at trap time
  // so links inside the rendered (sanitized markdown) body are included; the dialog
  // container itself (tabindex="-1") is excluded by the selector.
  function onReviewKeydown(e: KeyboardEvent) {
    if (e.key !== "Tab" || !reviewPopEl) return;
    const nodes = reviewPopEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === reviewPopEl) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || active === reviewPopEl) {
        e.preventDefault();
        first.focus();
      }
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

  // Queue the post-merge confirmation toast. Local-forge merges get a plain confirmation;
  // remote-forge merges add a one-click Decommission, upgraded to "Decommission & update
  // local" for isolated sessions (which also fast-forwards the local default branch). The
  // FF target + isolation (isIsolated/ffPath/ffBranch) are captured by the caller at merge
  // time — see doMerge. They MUST travel together: mixing a freshly-rebound isolated flag
  // with the prior session's FF target would fast-forward the wrong checkout.
  function showMergedToast(
    kind: string,
    mergedId: string,
    isIsolated: boolean,
    ffPath: string,
    ffBranch: string,
  ) {
    const text = m.toast_merged({ name: name || mergedId });
    if (kind === "local") {
      toasts.info(text);
      return;
    }
    const update = isIsolated && !!ffPath;
    toasts.info(text, {
      action: {
        label: update ? m.gitrail_decommission_update_action() : m.gitrail_decommission_action(),
        run: () => {
          ondecommission?.(mergedId);
          if (update) pullMainAndToast(ffPath, ffBranch);
        },
      },
      duration: 15_000,
      key: `decommission-offer:${mergedId}`,
    });
  }

  // skipArm lets the inline Retry re-run a confirmed action without a second arm tap
  async function doMerge(skipArm = false) {
    if (!skipArm && !arm("merge")) return;
    busy = true;
    err = null;
    retry = null;
    try {
      const mergedId = sessionId;
      // Capture the session identity AND its FF target/isolation before the await —
      // the GitRail instance rebinds on a session switch, and the toast lives 15s, so
      // a live read could pair a new session's isolated flag with the old FF target.
      const isIsolated = isolated;
      const ffPath = repoPath;
      const ffBranch = baseBranch;
      git = { kind: git?.kind ?? "github", ...(await mergePr(sessionId)) };
      showMergedToast(git.kind, mergedId, isIsolated, ffPath, ffBranch);
    } catch (e) {
      // prefer the known local cause over a raw server string
      err =
        git?.checks === "failure"
          ? m.gitrail_merge_failed_checks()
          : git && isConflicting(git)
            ? m.gitrail_merge_failed_unmergeable()
            : m.gitrail_merge_failed({ reason: reason(e, m.gitrail_merge()) });
      retry = () => doMerge(true);
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

  const mergeBlocked = $derived(
    !git ||
      isConflicting(git) ||
      busy ||
      git.isDraft === true ||
      (git.mergeStateStatus && git.mergeStateStatus !== "unknown"
        ? git.mergeStateStatus === "blocked" || git.mergeStateStatus === "behind"
        : git.checks === "failure"),
  );

  const mergeBlockedReason = $derived(
    !mergeBlocked
      ? undefined
      : busy
        ? m.gitrail_merge_blocked_busy()
        : git?.isDraft === true
          ? m.gitrail_merge_blocked_draft()
          : git && isConflicting(git)
            ? m.gitrail_merge_blocked_conflict()
            : git?.mergeStateStatus === "behind"
              ? m.gitrail_merge_blocked_behind()
              : git?.mergeStateStatus === "blocked"
                ? m.gitrail_merge_blocked_protected()
                : git?.checks === "failure"
                  ? m.gitrail_merge_blocked_checks()
                  : // Unreachable: the merge button renders only under git.state==="open",
                    // so `git` is truthy and `mergeBlocked` ⇒ one predicate above always holds.
                    undefined,
  );

  const local = $derived(git?.kind === "local");

  const verdict = $derived(reviews.map[sessionId]);
  const reviewing = $derived(reviews.isReviewing(sessionId));
  const pillReviewing = $derived(reviewing || planGates.isReviewing(sessionId));
  const chip = $derived(criticChip(verdict, reviewing));
  // Manual critic trigger: only when the auto path's own precondition holds (open PR, CI
  // cleared — green OR a no-CI repo's terminal "none") AND the repo has the critic enabled.
  // Mirrors the server's forceReview guard (checksCleared) so a shown button is never
  // server-rejected. Reviewing is allowed (label becomes "Restart").
  const canReview = $derived(
    git?.state === "open" &&
      checksCleared(git.checks, git.noCi) &&
      repoConfig.flags(repoPath).critic,
  );
  const reviewLabel = $derived(
    armed === "review"
      ? m.gitrail_confirm_review()
      : reviewing
        ? m.gitrail_restart_review()
        : verdict
          ? m.gitrail_rereview()
          : m.gitrail_review(),
  );
  // Manual plan-review trigger: visible only while the plan gate is active
  // (planPhase === "planning"), matching PlanPanel's canReviewNow.
  const canReviewPlan = $derived(planPhase === "planning");
  const planReviewing = $derived(planGates.isReviewing(sessionId) || awaitingPlanReview);
  // Only `approved` is a genuine block: `force` re-reviews an unchanged/at-cap plan, but the
  // server never bypasses `approved`, so a click there would dead no-op. Pass GitRail's own
  // `planReviewing` (store flag ∪ the 3 s optimistic bridge) so the block can't re-enable mid-bridge.
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
  // Render the (AI-authored) findings as markdown, sanitized before @html.
  // Dynamically imported so marked/DOMPurify stay off the first-paint critical path;
  // a static import here would hoist both into the main chunk and defeat the same
  // lazy-loading in every other consumer (SessionRecap, PlanPanel, ...).
  // Gated on showReview so the browser-only sanitizer never runs during SSR.
  let renderedBody = $state("");
  $effect(() => {
    const body = showReview ? verdict?.body : undefined;
    if (!body) {
      renderedBody = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (alive)
          renderedBody = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
      })
      .catch((e) => {
        // Never assigns to renderedBody — a failed load must not leave unsanitized
        // markup, and the `err` state above is the PR-action error channel, not this.
        console.warn("Review body markdown render failed", e);
      });
    return () => {
      alive = false;
    };
  });
  const autoCount = $derived(automationCount(repoConfig.flags(repoPath)));
  let reviewFlash = $state<string | null>(null);
  let reviewFlashErr = $state(false);

  // Coachmark: which feature is currently "armed" (popover open on first reveal).
  // armedId is set when the automation pill is first opened while a feature is unseen;
  // cleared on onseen (markSeen) or onclose (dismiss without marking seen).
  let armedId = $state<string | null>(null);

  // Feature ids whose controls moved behind the automation pill; their discovery
  // coachmarks now anchor on the pill instead of their (deleted) individual toggles.
  const PILL_FEATURE_IDS = ["critic", "auto-address", "learnings"] as const;

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

  async function doReview() {
    if (!arm("review")) return; // first click arms, second confirms
    try {
      const status = await reviewPr(sessionId);
      // "started" → the REVIEWING badge (via WS) is the feedback; nothing to show. Fail-closed:
      // a decline or error must never read as success.
      if (status === "skipped") toasts.info(m.gitrail_review_skipped());
      else if (status !== "started")
        toasts.info(m.gitrail_review_failed(), {
          alert: true,
          key: `review-pr:${sessionId}`,
        });
    } catch {
      toasts.info(m.gitrail_review_failed(), {
        alert: true,
        key: `review-pr:${sessionId}`,
      });
    }
  }

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

  async function sendReviewToAgent() {
    if (!verdict?.body) return;
    try {
      await replySession(sessionId, `Address this code review feedback:\n\n${verdict.body}`);
      showReview = false; // panel closing is the success feedback; dismiss it
    } catch {
      reviewFlash = m.gitrail_send_review_failed();
      reviewFlashErr = true;
      setTimeout(() => (reviewFlash = null), 1500);
    }
  }

  // The mobile rail is a hidden-scrollbar horizontal scroller; without a visible
  // bar nothing hints that trailing controls (auto-pill, verdict chip) scroll off
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
      // shifts scrollWidth without resizing that box (Merge arming to 'confirm ✓',
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

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

{#if git}
  <!-- dim the rest of the page behind the findings popover (mirrors the compose-bar
       sheet). Sits OUTSIDE wrapEl so a backdrop click trips the existing
       click-outside dismiss; Escape closes it too. Purely visual → aria-hidden. -->
  {#if showReview && verdict}
    <div class="review-scrim" aria-hidden="true"></div>
  {/if}
  <!-- touch-only dim+blur behind the automation sheet. Like .review-scrim it sits
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
        {mergeBlocked}
        {mergeBlockedReason}
        {ready}
        {showReady}
        {status}
        {sessionId}
        {mobile}
        {chip}
        {showReview}
        {canReview}
        {reviewLabel}
        {canReviewPlan}
        {planReviewing}
        {planReviewLabel}
        {planReviewBlockedReason}
        {startPr}
        togglePrDraft={doTogglePrDraft}
        {doMerge}
        {doRedeploy}
        {toggleReview}
        {doReview}
        {doReviewPlan}
      />

      {#if repoPath}
        <span class="rail-sep" aria-hidden="true"></span>
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
          use:coachTarget={"learnings"}
          onclick={toggleAutomation}
        >
          ⚙ {m.automation_pill_label()}
          <span class="auto-count" class:on={autoCount > 0}>{autoCount}/{AUTOMATION_TOTAL}</span>
          {#if automationHasUnseen}<span class="new-dot" aria-hidden="true"></span><span
              class="sr-only">{m.newdot_aria()}</span
            >{/if}
        </button>
      {/if}

      {#if err}
        <span class="err" role="alert" title={err}>{err}</span>
        {#if retry}
          <button class="gbtn" type="button" disabled={busy} onclick={() => retry?.()}
            >{m.common_retry()}</button
          >
        {/if}
      {/if}
    </span>

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
    {/if}

    {#if showReview && verdict}
      <div
        class="review-pop"
        role="dialog"
        aria-modal="true"
        aria-label={m.gitrail_review_title()}
        tabindex="-1"
        bind:this={reviewPopEl}
        onkeydown={onReviewKeydown}
      >
        <div class="review-head">
          {#if chip.kind === "reviewing"}
            <span class="rv-label critic-reviewing" title={m.criticbadge_reviewing_title()}>
              <span class="rev-dot" aria-hidden="true"></span>{m.criticbadge_reviewing()}
            </span>
          {:else}
            <span class="rv-label critic-{verdict.decision}">{criticBadgeLabel(verdict)}</span>
          {/if}
          {#if git.url}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
            <a class="rv-prlink" href={git.url} target="_blank" rel="noopener">PR #{git.number} ↗</a
            >
          {/if}
          <button
            class="gbtn"
            type="button"
            onclick={() => (showReview = false)}
            aria-label={m.common_close()}>✕</button
          >
        </div>
        {#if verdict.summary}
          <p class="rv-summary">{verdict.summary}</p>
        {/if}
        {#if verdict.body}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
          <div class="rv-body">{@html renderedBody}</div>
        {/if}
        {#if verdict.decision !== "error" && verdict.body}
          <div class="review-actions">
            {#if reviewFlash}<span
                class:err={reviewFlashErr}
                class:ok={!reviewFlashErr}
                title={reviewFlash}>{reviewFlash}</span
              >{/if}
            <button
              class="gbtn"
              type="button"
              disabled={busy || chip.kind === "reviewing"}
              title={chip.kind === "reviewing"
                ? m.gitrail_send_review_reviewing_title()
                : undefined}
              onclick={sendReviewToAgent}
            >
              {m.gitrail_send_review()}
            </button>
          </div>
        {/if}
      </div>
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
  /* own positioning context so .pr-pop/.auto-pop/.review-pop anchor here in the
     desktop (non-mobile) mount, not to some far ancestor. On mobile the wrapper
     is narrower than the strip, so it goes position:static and the popovers
     anchor to the wider .vp-git-strip instead — see .git-rail-wrap.mobile. */
  .git-rail-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
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
  /* Rail buttons (⚙ automation pill, err/Retry) take the 6px chip radius for
     chip-row cohesion (DESIGN.md #1541). Scoped to .rail so the PR-compose /
     findings-popover dialog buttons keep the standalone 2px. */
  .rail .gbtn {
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
     (.pr-pop/.auto-pop/.review-pop) anchor to the full-width .vp-git-strip
     (itself position:relative). Anchored to this narrow wrapper, a right:8px
     popover would shoot off the left screen edge. */
  .git-rail-wrap.mobile {
    position: static;
    flex: 1 1 auto;
    min-width: 0;
  }
  .rail.mobile {
    width: 100%;
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
  .rail.mobile :global(.gbtn) {
    min-height: var(--mobile-actionbar-hit);
    padding: 6px 9px;
    font-size: var(--fs-base);
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
  /* automation divider breathes 14px each side on mobile (8px margin + the .rail 6px gap),
     matching the new status-sep. Scoped to .rail.mobile so the base .rail-sep (shared with the
     test-only desktop mount) is untouched. */
  .rail.mobile .rail-sep {
    margin: 0 8px;
  }
  .rail.mobile :global(.dot) {
    width: 9px;
    height: 9px;
  }

  .err,
  .ok {
    font-size: var(--fs-micro);
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    color: var(--color-red);
  }
  .ok {
    color: var(--color-green);
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
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    padding: 4px 6px;
    resize: vertical;
  }

  .pr-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  /* full-page dim behind the findings popover, matching the compose-bar sheet */
  .review-scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--color-scrim);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
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

  /* findings popover: same anchoring as .pr-pop, wider + scrollable body.
     Rides above .review-scrim (z-index 50) so it stays lit while the page dims.
     On touch (@media pointer: coarse, below) this absolute anchor is overridden
     into a centered fixed modal sheet — anchored to the 44px strip it would hang
     below and clip the body + action footer out of reach. */
  .review-pop {
    position: absolute;
    top: 100%;
    right: 8px;
    z-index: 51;
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: min(480px, 90vw);
    max-height: 60vh;
    /* clip to the box so the scrollable body — not the popover — absorbs
       overflow; without this the action footer escapes below max-height and,
       on short (unfolded-fold) viewports, lands off-screen + unreachable */
    overflow: hidden;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }

  .review-head {
    display: flex;
    align-items: center;
    gap: 8px;
    /* head + footer stay pinned; only .rv-body scrolls */
    flex-shrink: 0;
  }
  .rv-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--color-muted);
  }
  /* pulsing status dot in the popover-head label */
  .rv-label.critic-reviewing .rev-dot {
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
  .rv-label.critic-reviewing {
    color: var(--color-amber);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .rv-label.critic-changes_requested {
    color: var(--color-amber);
  }
  .rv-label.critic-commented {
    color: var(--color-blue);
  }
  .rv-label.critic-error {
    color: var(--color-faint);
  }
  .rv-prlink {
    font-size: var(--fs-meta);
    color: var(--color-muted);
    text-decoration: none;
  }
  .rv-prlink:hover {
    color: var(--color-ink-bright);
  }
  .review-head .gbtn {
    margin-left: auto;
    padding: 0 6px;
    line-height: 1.6;
  }

  .rv-summary {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    /* pinned alongside head/footer; only .rv-body scrolls */
    flex-shrink: 0;
  }
  .rv-body {
    margin: 0;
    /* the lone scroller: min-height:0 lets it shrink within the flex column
       (default min-height:auto would refuse, pushing the footer out of view) */
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
    padding: 6px 8px;
    overflow-wrap: anywhere;
  }
  /* markdown rendered via {@html} — children aren't scoped, so target globally */
  .rv-body :global(> *:first-child) {
    margin-top: 0;
  }
  .rv-body :global(> *:last-child) {
    margin-bottom: 0;
  }
  .rv-body :global(p),
  .rv-body :global(ul),
  .rv-body :global(ol) {
    margin: 0 0 8px;
  }
  .rv-body :global(ul),
  .rv-body :global(ol) {
    padding-left: 18px;
  }
  .rv-body :global(li) {
    margin: 2px 0;
  }
  .rv-body :global(h1),
  .rv-body :global(h2),
  .rv-body :global(h3),
  .rv-body :global(h4) {
    margin: 12px 0 6px;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .rv-body :global(a) {
    color: var(--color-blue);
    text-decoration: underline;
  }
  .rv-body :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    background: var(--color-line);
    border-radius: 2px;
    padding: 0 3px;
    overflow-wrap: anywhere;
  }
  .rv-body :global(pre) {
    margin: 0 0 8px;
    padding: 6px 8px;
    background: var(--color-bg, var(--color-line));
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .rv-body :global(pre code) {
    background: none;
    padding: 0;
    overflow-wrap: anywhere;
  }
  .rv-body :global(blockquote) {
    margin: 0 0 8px;
    padding-left: 8px;
    border-left: 2px solid var(--color-line);
    color: var(--color-muted);
  }
  .rv-body :global(table) {
    width: 100%;
    margin: 0 0 8px;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .rv-body :global(th),
  .rv-body :global(td) {
    padding: 2px 6px;
    border: 1px solid var(--color-line);
    text-align: left;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .review-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--color-line);
    /* pinned footer: never compressed away by a tall body */
    flex-shrink: 0;
  }

  /* Touch layouts (phones + unfolded folds — the repo's canonical coarse-pointer
     gate). The strip is position:static here, so the absolute .review-pop hangs
     below the 44px strip and clips. Override it into a centered fixed modal sheet
     over the existing .review-scrim. z-index:51 already sits above the scrim's 50;
     the existing overflow:hidden + .rv-body scroller + pinned head/footer keep the
     action footer reachable. */
  @media (pointer: coarse) {
    .review-pop {
      position: fixed;
      top: 50%;
      left: 50%;
      right: auto;
      transform: translate(-50%, -50%);
      margin-top: 0;
      width: min(480px, 92vw);
      max-height: 85vh;
    }
    /* the rail's 40px tap-target rule is scoped to .rail.mobile, not this popover —
       give the dialog's own controls a ≥40px touch target too */
    .review-head .gbtn,
    .review-actions .gbtn {
      min-height: 40px;
    }
  }
</style>
