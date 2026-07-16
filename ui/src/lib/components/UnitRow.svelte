<script module lang="ts">
  import { MediaQuery } from "svelte/reactivity";

  // Single-open invariant across every row: the close-fn of the currently open
  // row. Opening another row closes this one first.
  let openRow: (() => void) | null = $state(null);

  // Exactly one row-level decommission affordance per device: primary-coarse
  // pointers get the swipe-to-reveal gesture, primary-fine pointers (incl.
  // touchscreen laptops) the hover ✕ button — never both. `(pointer: coarse)`
  // matches the app's layout gates (+page.svelte `touch`, the reveal CSS's
  // `(hover: hover) and (pointer: fine)`). Module-level so N rows share one
  // matchMedia listener.
  const coarse = new MediaQuery("(pointer: coarse)");
</script>

<script lang="ts">
  import type { Session, GitState, SessionActivity, HoldReason, LivenessState } from "$lib/types";
  import { STATUS_COLOR, canResume, canRelaunch, isStrandedLiveness } from "$lib/format";
  import { displayStatus } from "$lib/display-status";
  import {
    resumeSession,
    releasePlanGate,
    reviewPlan,
    isPlanReviewError,
    resumeQuota,
    retryCi,
  } from "$lib/api";
  import CardMenu from "./CardMenu.svelte";
  import TaskIdButton from "./TaskIdButton.svelte";
  import { longPress } from "./longpress";
  import { isMerging } from "./merge-train";
  import StatusPip from "./StatusPip.svelte";
  import TimePopover from "./TimePopover.svelte";
  import HeartbeatStrip from "./HeartbeatStrip.svelte";
  import Stepper from "./Stepper.svelte";
  import { reviews, planGates } from "$lib/reviews.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { m } from "$lib/paraglide/messages";
  import { modelLabel } from "$lib/model-label";
  import { onDestroy } from "svelte";
  import UnitRowRight from "./unit-row/UnitRowRight.svelte";
  import { rowHold } from "$lib/hold-row";
  import { holdAwaitsOperator } from "$lib/hold";
  import { checksCleared } from "$lib/checks-cleared";
  import {
    REVEAL_PX,
    snapOffset,
    pressDecom,
    swipeGesture,
    type SwipeCallbacks,
    type DecomState,
  } from "./swipe";

  let {
    session,
    selected,
    nowMs,
    onselect,
    git,
    activity,
    previewPort = null,
    previewServeFailed = false,
    onpreview,
    ondecommission,
    onrename,
    onrelaunch,
    onrelaunchElsewhere,
    onvariant,
    onreplace,
    repoFilter = undefined,
    onrepofilter,
    workingBlocked = {},
    liveness = undefined,
    quotaKind = null,
    hold = undefined,
    onackmanualsteps,
    onshowowed,
  }: {
    session: Session;
    selected: boolean;
    nowMs: number;
    onselect: (id: string) => void;
    git?: GitState;
    // live per-session signal (heartbeat); undefined until first event
    activity?: SessionActivity;
    // live preview-listener port; non-null surfaces the Preview badge (server-driven, no iframe inference)
    previewPort?: number | null;
    // true when the server's tailscale serve registration failed; surfaces a degraded (amber) badge
    previewServeFailed?: boolean;
    // Preview badge clicked → select this session + open its Viewport preview pane
    onpreview?: (id: string, target?: "inline" | "tab") => void;
    // when provided, the row gains a decommission affordance — coarse pointers get
    // the left-swipe gesture, fine pointers a hover-revealed ✕ button, and the
    // right-click / long-press CardMenu offers it on both
    ondecommission?: (id: string) => void;
    // when provided, the right-click / long-press CardMenu gains a Rename action
    onrename?: (id: string) => void;
    // when provided, the right-click / long-press CardMenu gains a two-step armed
    // Relaunch action (spawns a fresh replacement + decommissions this session)
    onrelaunch?: (id: string) => void;
    // when provided, the CardMenu gains a one-click "Relaunch elsewhere" item that
    // opens the new-task composer pre-filled from this session (cross-repo relaunch)
    onrelaunchElsewhere?: (id: string) => void;
    // when provided, the CardMenu gains "Start as variant…" / "Continue with…" items that open
    // the provider/model picker anchored at the passed coords (comparison experiments)
    onvariant?: (id: string, anchor: { x: number; y: number }) => void;
    onreplace?: (id: string, anchor: { x: number; y: number }) => void;
    // active page-level repo filter (selected repo paths); drives the icon's pressed state
    repoFilter?: ReadonlySet<string>;
    // when provided, clicking the inline repo emoji scopes the herd to this repo. Always a
    // plain (non-additive) select — reset to this one repo (Shift multi-select lives on the
    // RepoSwitcher pills, not the card emoji).
    onrepofilter?: (repoPath: string, additive: boolean) => void;
    // working-while-blocked display flags (whole store map); feeds displayStatus only
    workingBlocked?: Record<string, boolean>;
    // this session's agent liveness; "stranded" triggers the distinct "agent died — revive" framing (#1630)
    liveness?: LivenessState;
    // quota block kind for this session; non-null surfaces the quota badge
    quotaKind?: "rework" | "review" | "error" | "plan" | null;
    // hold reason for this session; when present renders a muted "why parked" subline
    hold?: HoldReason;
    // when provided, the manual-steps chip gains an "Ack" CTA that clears the auto-merge gate (#1060)
    onackmanualsteps?: (id: string) => void;
    // when provided, the manual-steps chip becomes a button that opens the Owed lens (#1275)
    onshowowed?: (id: string) => void;
  } = $props();

  // Every status-driven DISPLAY branch below reads this, not session.status: a
  // working-while-blocked session gets the full working treatment. Behavioral
  // reads (canResume) stay on the raw status.
  const dStatus = $derived(displayStatus(session, workingBlocked));

  // The agent has stopped and awaits a DIRECT operator action → a subordinate red
  // card wash (--wash-attention). See holdAwaitsOperator for the (deliberately
  // narrow, agency-based) hold set. Two gates keep the wash honest:
  //  - dStatus !== "running": a mid-turn session is the ACTOR, not waiting on you.
  //    The server emits some operator-waiting holds (notably plan-rework) for a
  //    still-running planning session that is actively addressing the requested
  //    changes — that is the agent's turn, so it must not read as "you're up".
  //    Using dStatus (not raw status) also excludes a working-while-blocked session
  //    (display-running, shows the amber working pip), keeping the wash in step with
  //    the pip rather than fighting it.
  //  - !readyToMerge: a green ✓ (actionable-complete) card never takes a red wash
  //    under it (Four-Light Rule).
  const awaitsOperator = $derived(
    !session.readyToMerge && dStatus !== "running" && !!hold && holdAwaitsOperator(hold),
  );

  // repo the unit works in — the last path segment of its repoPath (e.g. "community-map")
  const repoName = $derived(session.repoPath.split("/").filter(Boolean).at(-1) ?? session.repoPath);

  // True when an un-acked, non-POST-MERGE manual step holds this session's auto-merge (#1060).
  // POST-MERGE-only steps never gate, so they show the chip but no Ack CTA. Mirrors the server
  // hasBlockingManualSteps predicate (src/automerge-core.ts).
  const hasBlockingManualSteps = $derived(
    session.manualStepsAckedAt == null && session.manualSteps.some((s) => !s.postMerge),
  );
  // Terminal (merged/closed) cards no longer have an auto-merge gate to clear, so the
  // Ack CTA is moot there (#1478). Merged additionally gets a verb label on the count
  // chip since it's now the actual resolution route (→ Owed lens).
  const isMerged = $derived(git?.state === "merged");
  const isTerminal = $derived(git?.state === "merged" || git?.state === "closed");
  // Verb label on merged cards (the count chip is the resolution route → Owed); neutral count
  // elsewhere. Extracted from the template to keep it under the complexity bar.
  const manualStepsChipLabel = $derived(
    isMerged
      ? m.unitrow_resolve_manual_steps({ count: session.manualSteps.length })
      : m.unitrow_manual_steps({ count: session.manualSteps.length }),
  );
  const showAckCta = $derived(hasBlockingManualSteps && !isTerminal && !!onackmanualsteps);
  const repoIcon = $derived(projectIcons.iconFor(session.repoPath));
  const repoFiltered = $derived(repoFilter?.has(session.repoPath) ?? false);
  function toggleRepoFilter() {
    // Non-additive: a plain click resets the filter to this repo (or clears it when this repo
    // is already the sole selection — handled by the page's nextRepoFilter).
    onrepofilter?.(session.repoPath, false);
  }

  const swipe = $derived(!!ondecommission && coarse.current);

  const PREVIEW_CHOICE_WIDTH = 150;
  const PREVIEW_CHOICE_FALLBACK_HEIGHT = 64;
  const PREVIEW_CHOICE_MARGIN = 8;
  const PREVIEW_CHOICE_GAP = 4;
  let previewChoice = $state<{ top: number; left: number; anchor: HTMLElement } | null>(null);
  let previewChoiceEl = $state<HTMLElement | null>(null);

  function previewChoicePosition(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = typeof window === "undefined" ? rect.right : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? rect.bottom : window.innerHeight;
    const choiceRect = previewChoiceEl?.getBoundingClientRect();
    const choiceWidth = choiceRect?.width ?? PREVIEW_CHOICE_WIDTH;
    const choiceHeight = choiceRect?.height ?? PREVIEW_CHOICE_FALLBACK_HEIGHT;
    const belowTop = rect.bottom + PREVIEW_CHOICE_GAP;
    const aboveTop = rect.top - PREVIEW_CHOICE_GAP - choiceHeight;
    const maxTop = Math.max(
      PREVIEW_CHOICE_MARGIN,
      viewportHeight - PREVIEW_CHOICE_MARGIN - choiceHeight,
    );
    const preferredTop =
      belowTop + choiceHeight <= viewportHeight - PREVIEW_CHOICE_MARGIN ? belowTop : aboveTop;
    return {
      top: Math.max(PREVIEW_CHOICE_MARGIN, Math.min(preferredTop, maxTop)),
      left: Math.max(
        PREVIEW_CHOICE_MARGIN,
        Math.min(rect.right - choiceWidth, viewportWidth - PREVIEW_CHOICE_MARGIN - choiceWidth),
      ),
      anchor,
    };
  }

  function togglePreviewChoice(anchor: HTMLElement) {
    previewChoice = previewChoice?.anchor === anchor ? null : previewChoicePosition(anchor);
  }

  $effect(() => {
    if (previewPort == null) closePreviewChoice();
  });

  $effect(() => {
    if (!previewChoice || !previewChoiceEl) return;
    const next = previewChoicePosition(previewChoice.anchor);
    if (next.top !== previewChoice.top || next.left !== previewChoice.left) previewChoice = next;
  });

  function closePreviewChoice() {
    previewChoice = null;
  }

  function choosePreview(target: "inline" | "tab") {
    closePreviewChoice();
    onpreview?.(session.id, target);
  }

  function onPreviewChoiceKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") closePreviewChoice();
    e.stopPropagation();
  }

  $effect(() => {
    if (!previewChoice) return;
    const onPointerDown = (e: PointerEvent) => {
      const choice = previewChoice;
      if (!choice) return;
      const target = e.target as Node;
      if (previewChoiceEl?.contains(target) || choice.anchor.contains(target)) return;
      closePreviewChoice();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreviewChoice();
    };
    const onReposition = () => {
      if (previewChoice) previewChoice = previewChoicePosition(previewChoice.anchor);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  });

  // gesture state
  let offset = $state(0); // px the row is slid left (negative); 0 = closed
  let dragging = $state(false); // finger down + tracking x → suppress snap transition

  // arm/confirm state for the revealed action
  let decom = $state<DecomState>("idle");
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  function disarm() {
    clearTimeout(armTimer);
    decom = "idle";
  }
  function close() {
    offset = 0;
    disarm();
    if (openRow === close) openRow = null;
  }
  function openReveal() {
    if (openRow && openRow !== close) openRow();
    offset = -REVEAL_PX;
    openRow = close;
  }

  const swipeCb: SwipeCallbacks = {
    current: () => offset,
    onOffset: (px) => (offset = px),
    onDragging: (b) => (dragging = b),
    onRelease: () => (snapOffset(offset) === -REVEAL_PX ? openReveal() : close()),
    requestClose: close,
  };

  function pressDecommission() {
    const { state, fire } = pressDecom(decom);
    decom = state;
    if (state === "armed") {
      clearTimeout(armTimer);
      armTimer = setTimeout(disarm, 3000);
    }
    if (fire) {
      clearTimeout(armTimer);
      ondecommission?.(session.id);
      close(); // row will drop from the store; close defensively
    }
  }

  onDestroy(() => {
    clearTimeout(armTimer);
    clearTimeout(tipTimer);
    clearTimeout(goArmTimer);
    clearTimeout(retryArmTimer);
    if (openRow === close) openRow = null;
  });

  const reviewing = $derived(reviews.isReviewing(session.id));
  const idleOpenCleared = $derived(
    git?.state === "open" &&
      checksCleared(git.checks, git.noCi) &&
      session.status !== "running" &&
      session.status !== "blocked" &&
      !reviewing,
  );
  const changesRequested = $derived(idleOpenCleared && !!git?.reviewBlock);
  const branchProtectionBlocked = $derived(
    idleOpenCleared && !git?.reviewBlock && git?.mergeStateStatus === "blocked",
  );

  // plan-gate row state. NOTE: `reviewing` above is the CRITIC store (reviews.isReviewing) —
  // this is the PLAN-GATE reviewer flag, a DIFFERENT store. Do not reuse the name `reviewing`.
  // Named `holdRow` (not `row`): the `{#snippet row()}` below already owns that identifier.
  const planGate = $derived(planGates.map[session.id]);
  const planReviewing = $derived(planGates.isReviewing(session.id));
  const holdRow = $derived(rowHold(session, planGate, planReviewing, hold));

  // Go two-step arm (distinct names from decommission's armTimer/disarm above): releasing an
  // approved plan gate is irreversible (starts execution), so the first click only arms.
  let goArmed = $state(false);
  let goArmTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmGo() {
    clearTimeout(goArmTimer);
    goArmed = false;
  }

  // Retry CI also arms on first click (it touches CI), self-disarming after a few seconds — the
  // same two-step ActionRunRow's rerun uses. Separate from the Go arm (distinct action + copy).
  let retryArmed = $state(false);
  let retryArmTimer: ReturnType<typeof setTimeout> | undefined;
  function disarmRetry() {
    clearTimeout(retryArmTimer);
    retryArmed = false;
  }

  let ctaBusy = $state(false);

  // Armed "Go?" / "Retry CI?" swaps in for the plain label; kept in the script so the .u-hold
  // template stays under the Svelte-template complexity bar (the block lives in holdSubline).
  const ctaLabel = $derived(
    holdRow.action?.kind === "go" && goArmed
      ? m.hold_cta_go_arm()
      : holdRow.action?.kind === "retry-ci" && retryArmed
        ? m.hold_cta_retry_ci_arm()
        : (holdRow.action?.label ?? ""),
  );

  function onHoldCta(e: MouseEvent) {
    e.stopPropagation();
    const a = holdRow.action;
    if (!a) return;
    if (a.kind === "go") {
      if (!goArmed) {
        goArmed = true;
        clearTimeout(goArmTimer);
        goArmTimer = setTimeout(disarmGo, 3000);
        return;
      }
      disarmGo();
      void doGo();
    } else if (a.kind === "retry-ci") {
      if (!retryArmed) {
        retryArmed = true;
        clearTimeout(retryArmTimer);
        retryArmTimer = setTimeout(disarmRetry, 4000);
        return;
      }
      disarmRetry();
      void doRetryCi();
    } else if (a.kind === "rereview") void doReview();
    else if (a.kind === "resume") void doResume();
    else if (a.kind === "answer") openPlanPanel();
    else if (a.kind === "reply") onselect(session.id);
  }

  async function doGo() {
    if (ctaBusy) return;
    ctaBusy = true;
    try {
      const ok = await releasePlanGate(session.id); // false on 409, no throw; rejects on network error
      if (!ok)
        toasts.info(m.hold_cta_go_failed(), {
          alert: true,
          key: `hold-cta:go:${session.id}`,
        });
      // No optimistic hide: the CTA disappears only when the WS gate/planPhase update arrives.
    } catch {
      toasts.info(m.hold_cta_go_failed(), {
        alert: true,
        key: `hold-cta:go:${session.id}`,
      });
    } finally {
      ctaBusy = false;
    }
  }

  async function doReview() {
    if (ctaBusy || planReviewing) return;
    ctaBusy = true;
    try {
      const status = await reviewPlan(session.id);
      // A real run either way; "started-at-cap" warns that its findings won't be re-sent (#1759).
      if (status === "started-at-cap")
        // 12s + hover-pause (alert), not the 4s notice tier: this warns that the run the
        // operator just paid for will not deliver its findings. Keyed so repeat clicks replace.
        toasts.info(m.plangate_review_at_cap(), {
          alert: true,
          key: `review-plan-at-cap:${session.id}`,
        });
      else if (status === "started") toasts.info(m.plangate_review_started());
      else if (status === "plan-unavailable" && !planGates.isReviewing(session.id))
        toasts.info(m.gitrail_review_plan_unavailable());
      else if (status === "skipped" && !planGates.isReviewing(session.id))
        toasts.info(m.plangate_review_skipped_stalled());
      else if (isPlanReviewError(status))
        toasts.info(m.gitrail_review_plan_failed(), {
          alert: true,
          key: `hold-cta:review:${session.id}`,
        });
    } catch {
      toasts.info(m.gitrail_review_plan_failed(), {
        alert: true,
        key: `hold-cta:review:${session.id}`,
      });
    } finally {
      ctaBusy = false;
    }
  }

  async function doResume() {
    if (ctaBusy) return;
    ctaBusy = true;
    try {
      const { status } = await resumeQuota(session.id);
      // resumed → nothing (the WS gate update clears the row). A row has no inline outcome
      // surface (unlike PlanPanel's quotaOutcome), so surface non-success as a transient toast.
      if (status !== "resumed") toasts.info(m.hold_cta_resume_failed());
    } catch {
      toasts.info(m.hold_cta_resume_failed());
    } finally {
      ctaBusy = false;
    }
  }

  // Retry CI: the ci-red hold carries the PR number; the server resolves that PR head's latest
  // failed run and reruns its failed jobs. `unsupported` (non-GitHub forge) / `no-run` (nothing to
  // retry) are expected outcomes → transient info; a genuine failure (throw) is a 12s alert.
  async function doRetryCi() {
    const pr = hold?.params?.pr;
    if (ctaBusy || pr == null) return;
    ctaBusy = true;
    try {
      const { ok, reason } = await retryCi(session.repoPath, pr);
      if (ok) toasts.info(m.hold_cta_retry_ci_started());
      else if (reason === "unsupported") toasts.info(m.hold_cta_retry_ci_unsupported());
      else if (reason === "no-run") toasts.info(m.hold_cta_retry_ci_no_run());
    } catch {
      toasts.info(m.hold_cta_retry_ci_failed(), {
        alert: true,
        key: `hold-cta:retry-ci:${session.id}`,
      });
    } finally {
      ctaBusy = false;
    }
  }

  let openPanelTick = $state(0);
  function openPlanPanel() {
    openPanelTick++;
  }

  // The status slot renders only for merging / ready; every other state (incl.
  // running — the left StatusPip carries that) shows nothing, so only then does
  // #u-status-{id} exist. Build the overlay's aria-describedby so it omits that id
  // when the slot is empty — no dangling IDREF.
  const describedBy = $derived(
    [
      `u-repo-${session.id}`,
      `u-sub-${session.id}`,
      changesRequested ||
      branchProtectionBlocked ||
      isMerging(session, nowMs) ||
      session.readyToMerge
        ? `u-status-${session.id}`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  );

  // live signals (heartbeat) only make sense while the agent works
  const live = $derived(dStatus === "running");
  // stepper conveys "how close to finishing" across the active lifecycle (not archived)
  const showStepper = $derived(
    dStatus === "running" || dStatus === "blocked" || dStatus === "done",
  );
  // PrBadge's merged/closed state duplicates the Stepper's terminal chip; when
  // that chip renders (same git.state), drop PrBadge so the terminal state shows
  // once (the semantic green/faint chip). Open/draft PRs keep PrBadge as normal.
  const stepperTerminal = $derived(
    showStepper && !session.readyToMerge && (git?.state === "merged" || git?.state === "closed"),
  );

  // Decommission is deferred behind an undo window: while it's open, the row is
  // doomed-but-still-present. Dim it so the operator sees it's on its way out.
  const decommissioning = $derived(toasts.pendingUndo(session.id));

  // Right-click (desktop) / long-press (touch) opens a small action menu on the
  // card. Resume is the headline action for a session parked at a shell;
  // decommission rides along wherever the parent wired it.
  // Deliberately NOT liveness-gated (no claudeAlive arg, unlike the Viewport
  // header): the menu only opens on an explicit gesture, so it doesn't add bar
  // noise — and it stays the force-resume escape hatch should the /proc sweep
  // ever misreport a session as alive.
  const resumable = $derived(canResume(session));
  // Stranded (herdr-restored husk): a daemon restart left this session's pane a bare shell (#1630).
  // Gets a distinct inline "agent died — revive" affordance instead of the quiet CardMenu Resume.
  const stranded = $derived(isStrandedLiveness(liveness));
  // One view-model for the inline subline so the template renders a single snippet (no stranded-vs-hold
  // branch in the row markup): stranded wins, else the parked "why" line + its one-click CTA.
  const sublineView = $derived(
    stranded
      ? {
          line: m.stranded_agent_died(),
          cls: "hold-cta--resume",
          title: m.stranded_revive_title(),
          label: m.stranded_revive(),
          run: reviveStrandedRow,
          hasAction: true,
          stranded: true,
        }
      : holdRow.line
        ? {
            line: holdRow.line,
            cls: holdRow.action ? `hold-cta--${holdRow.action.kind}` : "",
            title: holdRow.action?.title ?? "",
            label: ctaLabel,
            run: onHoldCta,
            hasAction: !!holdRow.action,
            stranded: false,
          }
        : null,
  );
  // Relaunch is offered only for an in-flight task (see canRelaunch) AND only when the
  // parent wired a handler — never on a concluded/merged record, where it would spawn a
  // duplicate and tear down the finished row.
  const relaunchable = $derived(!!onrelaunch && canRelaunch(session, git, nowMs));
  // Relaunch-elsewhere reuses the same eligibility as Relaunch, just routed to the
  // cross-repo composer instead of the in-place two-step arm.
  const relaunchElsewhereAble = $derived(!!onrelaunchElsewhere && canRelaunch(session, git, nowMs));
  // Variant / replace share Relaunch's eligibility — both spawn a fresh run from this session.
  // Never offer variant/replace on the experiment's comparison run — re-running its read-only
  // compare prompt as a "variant" is nonsensical, and a relaunch would strip its experiment role.
  const comparisonRow = $derived(session.experimentRole === "comparison");
  const variantable = $derived(!!onvariant && !comparisonRow && canRelaunch(session, git, nowMs));
  const replaceable = $derived(!!onreplace && !comparisonRow && canRelaunch(session, git, nowMs));
  let hitEl = $state<HTMLButtonElement>();
  let elapsedEl = $state<HTMLSpanElement>();
  let menu = $state<{ x: number; y: number; opener: HTMLElement } | null>(null);
  // Returns whether a menu actually opened (so the long-press can decide whether to
  // swallow the trailing tap). No-ops when nothing to offer or one is already open.
  const hasMenu = $derived(
    resumable ||
      !!ondecommission ||
      !!onrename ||
      relaunchable ||
      relaunchElsewhereAble ||
      variantable ||
      replaceable,
  );
  function openMenuAt(x: number, y: number): boolean {
    if (menu || !hasMenu) return false;
    menu = { x, y, opener: hitEl! };
    return true;
  }
  function onContextMenu(e: MouseEvent) {
    if (!hasMenu) return; // nothing to offer → leave native menu
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY);
  }
  async function resumeFromMenu() {
    menu = null;
    onselect(session.id); // focus it so the rebuilt terminal lands in view
    try {
      await resumeSession(session.id, true);
    } catch {
      toasts.info(m.cardmenu_resume_failed({ name: session.name }));
    }
  }
  // Inline "Revive" from the stranded card affordance — force-resume the husk (#1630).
  async function reviveStrandedRow() {
    if (ctaBusy) return;
    ctaBusy = true;
    onselect(session.id); // focus it so the rebuilt terminal lands in view
    try {
      await resumeSession(session.id, true);
    } catch {
      toasts.info(m.cardmenu_resume_failed({ name: session.name }));
    } finally {
      ctaBusy = false;
    }
  }
  function decommissionFromMenu() {
    menu = null;
    ondecommission?.(session.id);
  }
  function renameFromMenu() {
    menu = null;
    onrename?.(session.id);
  }
  function relaunchFromMenu() {
    menu = null;
    onrelaunch?.(session.id);
  }
  function relaunchElsewhereFromMenu() {
    menu = null;
    onrelaunchElsewhere?.(session.id);
  }
  // Hand the menu's anchor coords to the parent so it can open the picker in the same spot.
  function variantFromMenu() {
    const anchor = menu ? { x: menu.x, y: menu.y } : { x: 0, y: 0 };
    menu = null;
    onvariant?.(session.id, anchor);
  }
  function replaceFromMenu() {
    const anchor = menu ? { x: menu.x, y: menu.y } : { x: 0, y: 0 };
    menu = null;
    onreplace?.(session.id, anchor);
  }

  // Time-breakdown popover: the .unit-hit overlay is the row's only click/
  // keyboard surface, but its mouse trigger is bounds-gated to the wall-clock
  // (.elapsed) — onHitMove latches when the cursor enters/leaves the clock's
  // rect, arming the 450ms hover-intent once on enter (not on every move) so
  // sweeping the cursor across the list doesn't cascade popovers. Keyboard focus
  // on the card still reveals it immediately; the popover anchors to the clock.
  // The clock rect is measured once on card-enter and cached so the per-move
  // bounds test never reads layout; bounded staleness is fine (the clock barely
  // shifts during a hover, the popover anchors off a fresh read in tipShow, and
  // it closes on scroll/resize).
  let tipRect = $state<DOMRect | null>(null);
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  let overClock = false; // pointer currently within the cached clock bounds
  let clockRect: DOMRect | null = null; // wall-clock bounds, cached on card-enter
  function tipShow(delay = 450) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => (tipRect = elapsedEl?.getBoundingClientRect() ?? null), delay);
  }
  function tipHide() {
    clearTimeout(tipTimer);
    tipRect = null;
    overClock = false;
  }
  function onHitEnter() {
    clockRect = elapsedEl?.getBoundingClientRect() ?? null;
  }
  function onHitMove(e: MouseEvent) {
    const r = clockRect;
    const inside =
      !!r &&
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom;
    if (inside === overClock) return;
    overClock = inside;
    if (inside) tipShow();
    else tipHide();
  }
</script>

{#snippet holdSubline()}
  {#if sublineView}
    <div class="u-hold" class:u-stranded={sublineView.stranded}>
      <span class="u-hold-text">{sublineView.line}</span>
      {#if sublineView.hasAction}
        <button
          type="button"
          class="hold-cta {sublineView.cls}"
          title={sublineView.title}
          disabled={ctaBusy}
          onclick={sublineView.run}>{sublineView.label}</button
        >
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet row()}
  <div
    class="unit"
    class:sel={selected}
    class:has-activity={live}
    class:awaits-operator={awaitsOperator}
    class:decommissioning
    data-unit-id={session.id}
    style="--rule:{session.readyToMerge ? 'var(--color-green)' : STATUS_COLOR[dStatus]}"
  >
    <!-- no native title here (was repoPath): the TimePopover carries the repo
         path as its first line, and a native tooltip would double up with it -->
    <button
      bind:this={hitEl}
      class="unit-hit"
      type="button"
      aria-label={m.unit_open_aria({ name: session.name })}
      aria-describedby={describedBy}
      onclick={() => {
        tipHide();
        onselect(session.id);
      }}
      oncontextmenu={(e) => {
        tipHide();
        onContextMenu(e);
      }}
      onmouseenter={onHitEnter}
      onmousemove={onHitMove}
      onmouseleave={tipHide}
      onfocus={() => {
        if (hitEl?.matches(":focus-visible")) tipShow(0);
      }}
      onblur={tipHide}
      onkeydown={(e) => {
        if (e.key === "Escape" && tipRect) tipHide();
      }}
      use:longPress={{ onTrigger: openMenuAt }}
    ></button>
    <div class="pip-col">
      <StatusPip
        status={dStatus}
        ready={session.readyToMerge}
        merging={isMerging(session, nowMs)}
        tip
      />
    </div>

    <div class="u-main">
      <div class="u-top">
        {#if repoIcon && onrepofilter}
          <!-- The emoji doubles as the repo-filter toggle: hover names the repo,
               click narrows the herd to it, click again clears. role=button (not a
               nested <button> — the row overlay is a sibling button) raised above
               the .unit-hit overlay like the preview badge, with stopPropagation so
               the row's own select doesn't also fire. -->
          <span
            class="name-icon actionable"
            role="button"
            tabindex="0"
            title={repoName}
            aria-pressed={repoFiltered}
            aria-label={repoFiltered
              ? m.unitrow_repo_filter_clear_aria({ repo: repoName })
              : m.unitrow_repo_filter_aria({ repo: repoName })}
            onclick={(e) => {
              e.stopPropagation();
              toggleRepoFilter();
            }}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                toggleRepoFilter();
              }
            }}>{repoIcon}</span
          >
        {:else if repoIcon}
          <!-- no title here: the .unit-hit overlay covers this span, so its own
               tooltip could never surface — the overlay's repoPath title serves
               the hover instead -->
          <span class="name-icon" aria-hidden="true">{repoIcon}</span>
        {/if}
        <span class="name">{session.name}</span>
      </div>
      <!-- A configured project emoji identifies the repo on its own, so it moves
           in front of the name and the repo line is dropped to save a row — but
           stays sr-only so the aria-describedby chain keeps announcing the repo.
           repoPath tooltip lives on .unit-hit (overlay covers this area), so it
           still surfaces on row hover either way. -->
      {#if repoIcon}
        <span class="sr-only" id="u-repo-{session.id}">{repoName}</span>
      {:else}
        <div class="u-repo" id="u-repo-{session.id}">
          <span class="repo-glyph" aria-hidden="true">▣</span>{repoName}
        </div>
      {/if}
      <div class="u-sub" id="u-sub-{session.id}">
        {session.prompt}
        {#if dStatus === "running"}
          <span class="car" aria-hidden="true">▏</span>
        {/if}
      </div>
      {@render holdSubline()}
    </div>

    <UnitRowRight
      {session}
      {selected}
      {onselect}
      {git}
      {nowMs}
      {ondecommission}
      {previewPort}
      {previewServeFailed}
      {onpreview}
      {quotaKind}
      {reviewing}
      {openPanelTick}
      {stepperTerminal}
      {decom}
      coarsePointer={coarse.current}
      {pressDecommission}
      previewChoiceOpen={previewChoice?.anchor != null}
      onpreviewchoice={togglePreviewChoice}
      bind:elapsedEl
    />

    {#if live}
      <div class="u-activity">
        <HeartbeatStrip {activity} {nowMs} onactivate={() => onselect(session.id)} />
      </div>
    {/if}

    <span class="meta">
      <span class="meta-text"
        ><TaskIdButton {session} /> · {session.model
          ? modelLabel(session.model)
          : m.newtask_model_default()}</span
      >
      {#if session.manualSteps.length > 0}
        {#if onshowowed}
          <button
            type="button"
            class="chip-manual-steps chip-manual-steps--link"
            title={m.unitrow_manual_steps_link()}
            onclick={(e) => {
              e.stopPropagation();
              onshowowed?.(session.id);
            }}
          >
            {manualStepsChipLabel}
          </button>
        {:else}
          <span
            class="chip-manual-steps"
            title={m.unitrow_manual_steps({ count: session.manualSteps.length })}
          >
            {m.unitrow_manual_steps({ count: session.manualSteps.length })}
          </span>
        {/if}
        {#if showAckCta}
          <button
            type="button"
            class="manual-steps-ack"
            title={m.unitrow_ack_manual_steps()}
            onclick={(e) => {
              e.stopPropagation();
              onackmanualsteps?.(session.id);
            }}
          >
            {m.unitrow_ack_manual_steps()}
          </button>
        {/if}
      {/if}
      {#if showStepper && !session.readyToMerge}
        <span class="meta-stepper">
          <Stepper
            sessionId={session.id}
            {git}
            readyToMerge={session.readyToMerge}
            planPhase={session.planPhase}
            onactivate={() => onselect(session.id)}
          />
        </span>
      {/if}
    </span>
  </div>
{/snippet}

{#if swipe}
  <div class="swipe-wrap" style="--reveal:{REVEAL_PX}px">
    <div class="reveal" aria-hidden={offset === 0}>
      <button
        class="decom"
        class:armed={decom === "armed"}
        type="button"
        tabindex={offset === 0 ? -1 : 0}
        onclick={pressDecommission}
        title={m.viewport_decommission_title()}
        aria-label={m.viewport_decommission_aria()}
      >
        {decom === "armed" ? m.viewport_confirm_decommission() : m.viewport_decommission()}
      </button>
    </div>
    <div
      class="slider"
      class:dragging
      style="transform:translateX({offset}px)"
      use:swipeGesture={swipeCb}
    >
      {@render row()}
    </div>
  </div>
{:else}
  {@render row()}
{/if}

{#if menu}
  <CardMenu
    x={menu.x}
    y={menu.y}
    {resumable}
    opener={menu.opener}
    onresume={resumeFromMenu}
    onrename={onrename ? renameFromMenu : undefined}
    onrelaunch={relaunchable ? relaunchFromMenu : undefined}
    onrelaunchElsewhere={relaunchElsewhereAble ? relaunchElsewhereFromMenu : undefined}
    onvariant={variantable ? variantFromMenu : undefined}
    onreplace={replaceable ? replaceFromMenu : undefined}
    ondecommission={ondecommission ? decommissionFromMenu : undefined}
    onclose={() => (menu = null)}
  />
{/if}

{#if tipRect && !menu}
  <TimePopover {session} {git} {activity} {nowMs} anchorRect={tipRect} onclose={tipHide} />
{/if}

{#if previewChoice && previewPort != null}
  <div
    class="preview-choice"
    role="dialog"
    aria-label={m.unitrow_preview_choice_label()}
    tabindex="-1"
    bind:this={previewChoiceEl}
    style="top:{previewChoice.top}px;left:{previewChoice.left}px"
    onclick={(e) => e.stopPropagation()}
    onkeydown={onPreviewChoiceKeydown}
  >
    <button type="button" class="preview-choice-btn" onclick={() => choosePreview("inline")}>
      {m.unitrow_preview_open_inline()}
    </button>
    <button type="button" class="preview-choice-btn" onclick={() => choosePreview("tab")}>
      {m.viewport_preview_open_new_tab()}
    </button>
  </div>
{/if}

<style>
  .unit {
    position: relative;
    display: grid;
    grid-template-columns: 16px 1fr auto;
    /* meta (desig · session) drops to a full-width footer row so it no longer
       fights the name for horizontal space — on a compact sidebar the right
       rail used to win and crush the name to an ellipsis stub */
    grid-template-areas:
      "pip main right"
      "pip meta meta";
    column-gap: 12px;
    row-gap: 3px;
    align-items: start;
    padding: 11px 13px 11px 14px;
    border: 1px solid transparent;
    border-radius: 2px;
    cursor: pointer;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    width: 100%;
    transition: opacity 0.18s ease;
  }

  /* Live rows insert a dedicated full-width `act` track between main and meta so
     the heartbeat spans main+right (identical width on every card, independent of
     the badge column). Non-live rows keep the 2-row template above — no extra
     track / row-gap. */
  .unit.has-activity {
    grid-template-areas:
      "pip main  right"
      "pip act   act"
      "pip meta  meta";
  }

  /* deferred decommission: row is doomed but still listed during the undo
     window — fade it so it visibly recedes; restored instantly on UNDO */
  .unit.decommissioning {
    opacity: 0.4;
  }

  /* Transparent overlay that IS the row's click/keyboard target — keeps the
     card a <div> so the interactive PlanGate badge can sit as a sibling instead
     of an (invalid) nested <button>. */
  .unit-hit {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: inherit;
    font: inherit;
    color: inherit;
    /* a long-press opens the card menu — suppress iOS's text/callout gesture so it
       doesn't fight ours (the row has no selectable text anyway) */
    -webkit-touch-callout: none;
    user-select: none;
  }
  .unit-hit:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: -1.5px;
  }

  :global(.unit + .unit),
  :global(.swipe-wrap + .swipe-wrap) {
    margin-top: 2px;
  }

  /* swipe-to-decommission (coarse pointer): the row slides left over a
     destructive action revealed behind it. */
  .swipe-wrap {
    position: relative;
    overflow: hidden;
    border-radius: 2px;
  }

  .reveal {
    position: absolute;
    inset: 0 0 0 auto;
    width: var(--reveal); /* set from REVEAL_PX (swipe.ts) — single source of truth */
    display: flex;
    align-items: stretch;
    justify-content: stretch;
    background: color-mix(in srgb, var(--color-red) 16%, var(--color-panel));
  }

  .reveal .decom {
    flex: 1;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--color-red);
    font-family: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    line-height: 1.3;
    text-transform: uppercase;
    cursor: pointer;
    padding: 6px;
  }
  .reveal .decom.armed {
    background: color-mix(in srgb, var(--color-red) 26%, transparent);
    color: var(--color-ink-bright);
    font-weight: 600;
  }

  .slider {
    position: relative;
    background: var(--color-panel);
    /* vertical pans scroll the list natively; horizontal pans are ours */
    touch-action: pan-y;
    transition: transform 0.18s ease;
    will-change: transform;
  }
  .slider.dragging {
    transition: none;
  }

  .preview-choice {
    position: fixed;
    z-index: 60;
    min-width: 150px;
    max-height: calc(100dvh - 16px);
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
  }
  .preview-choice-btn {
    margin: 0;
    padding: 5px 8px;
    border: 0;
    border-radius: 2px;
    background: transparent;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }
  .preview-choice-btn:hover,
  .preview-choice-btn:focus-visible {
    background: var(--color-hover);
    color: var(--color-ink-bright);
    outline: none;
  }

  @media (pointer: coarse) {
    .preview-choice-btn {
      min-width: 160px;
      min-height: 44px;
      padding: 10px 12px;
      font-size: var(--fs-base);
    }
  }

  .unit::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 1px;
    background: var(--rule, var(--color-faint));
    pointer-events: none;
  }

  .unit:hover {
    border-color: var(--color-line);
    background: var(--color-hover);
  }

  .unit.sel {
    border-color: var(--color-line-bright);
    background:
      radial-gradient(
        120% 140% at 0% 50%,
        color-mix(in srgb, var(--rule) 12%, transparent),
        transparent 70%
      ),
      var(--color-sel);
  }

  /* bracket corners on selected */
  .unit.sel::after {
    content: "";
    position: absolute;
    bottom: -1px;
    right: -1px;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
    border-left: 0;
    border-top: 0;
    pointer-events: none;
  }

  /* Card-level attention wash: the agent has stopped and awaits a direct operator
     action (see awaitsOperator / holdAwaitsOperator). A subordinate red tint that
     makes "you're the next actor" legible at a glance without out-competing the
     blocked pip or the --wash-blocked header. Composed with hover + selection so a
     waiting card keeps its identity in every state; the pip / hold line carry the
     non-color cue (WCAG 1.4.1), this tint only reinforces it. */
  .unit.awaits-operator {
    background: var(--wash-attention);
  }
  .unit.awaits-operator:hover {
    background: color-mix(in srgb, var(--color-hover) 55%, var(--wash-attention));
  }
  .unit.awaits-operator.sel {
    background:
      radial-gradient(
        120% 140% at 0% 50%,
        color-mix(in srgb, var(--rule) 12%, transparent),
        transparent 70%
      ),
      color-mix(in srgb, var(--color-sel) 78%, var(--wash-attention));
  }

  .pip-col {
    grid-area: pip;
    display: flex;
    align-items: flex-start;
    padding-top: 5px;
  }

  .u-main {
    grid-area: main;
    min-width: 0;
  }

  .u-top {
    display: flex;
    align-items: baseline;
    gap: 0;
    min-width: 0;
  }

  /* configured project emoji standing in for the repo line */
  .name-icon {
    flex: none;
    margin-right: 6px;
    font-size: var(--fs-base);
  }
  /* interactive variant: the emoji toggles the repo filter — raised above the
     .unit-hit overlay (same pattern as the preview badge) so it's hover/clickable */
  .name-icon.actionable {
    position: relative;
    z-index: 1;
    cursor: pointer;
    padding: 0 3px;
    margin-left: -3px;
    border-radius: 2px;
  }
  .name-icon.actionable:hover {
    background: var(--color-hover);
  }
  .name-icon.actionable:focus-visible {
    outline: 1.5px solid var(--color-line-bright);
    outline-offset: 0;
  }
  /* Visually hidden but available to screen readers (matches GitRail.svelte) */
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

  .name {
    color: var(--color-ink-bright);
    font-weight: 500;
    letter-spacing: 0.04em;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .u-repo {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--color-ink);
    font-size: var(--fs-meta);
    letter-spacing: 0.04em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 34ch;
  }
  .repo-glyph {
    /* Renders on every icon-less row regardless of status — amber here was the
       biggest remaining contributor to the "orange wall". Muted: it's a repo
       marker, not a state signal. */
    color: var(--color-muted);
    font-size: var(--fs-micro);
    flex-shrink: 0;
  }

  .u-sub {
    color: var(--color-muted);
    margin-top: 3px;
    font-size: var(--fs-base);
    line-height: 1.35;
    /* wrap to a 2nd line — fills the vertical space the right column
       (badge / elapsed / meta) already occupies, then ellipsis */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    max-width: 34ch;
  }

  /* Muted one-liner explaining why this session is parked / held.
     Shown only when a hold reason is present (server-set); mirrors the
     `.u-repo` density — same muted color and meta-size font, single line. */
  .u-hold {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin-top: 3px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.3;
  }
  .u-hold-text {
    min-width: 0;
    max-width: 34ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* Stranded (herdr-restored husk): read as an attention state, not a quiet hold (#1630). */
  .u-stranded .u-hold-text {
    color: var(--color-red);
    font-weight: 600;
  }

  /* Inline one-click action beside the hold subline (Go / Re-review / Resume / Answer) —
     modeled on the .chip-manual-steps--link recipe: outlined micro chip, raised above the
     .unit-hit overlay so it's actually clickable. */
  .hold-cta {
    flex: none;
    position: relative;
    z-index: 1;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-blue);
    border-radius: 2px;
    color: var(--color-blue);
    background: transparent;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .hold-cta::after {
    /* Enlarge the hit target without changing visual geometry. The TOP inset is clamped to
       -2px: the subline sits only 3px below the (2-line) .u-sub prompt, and this button is
       raised above the .unit-hit select overlay — a larger upward bleed would let clicks in
       the prompt band arm the CTA (esp. Go) instead of selecting the row. Downward/sideways
       expansion is safe (the next row paints on top; the subline's sides are non-interactive),
       so the target grows there instead. Deliberately below the 44px mobile bar on this dense
       desktop-primary row. */
    content: "";
    position: absolute;
    inset: -2px -10px -12px -10px;
  }
  .hold-cta:hover {
    background: color-mix(in oklab, var(--color-blue) 12%, transparent);
  }
  .hold-cta:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-blue);
  }
  .hold-cta:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Go releases an APPROVED plan → the actionable-complete green (design-system reserves green
     for READY). The armed "Go?" keeps the same hue. */
  .hold-cta--go {
    border-color: var(--color-green);
    color: var(--color-green);
  }
  .hold-cta--go:hover {
    background: color-mix(in oklab, var(--color-green) 12%, transparent);
  }
  .hold-cta--go:focus-visible {
    box-shadow: inset 0 0 0 1px var(--color-green);
  }

  /* Live activity sub-line: the heartbeat strip. Quiet, single-line — the
     priority signal for a working row without adding a colored badge. */
  .u-activity {
    grid-area: act;
    display: flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    /* stays on the meta rung: this is a dense single-line telemetry row (the
       heartbeat strip), not instructional prose — at --fs-base the act line
       grows taller and crowds the rail's row rhythm */
    font-size: var(--fs-meta);
    line-height: 1.3;
    color: var(--color-muted);
  }
  /* The heartbeat claims the whole activity line on every device — including the
     narrow ≤300px sidebar (no container-query override pins it back). Scoped under
     .u-activity so the rule can't leak to a future global .strip. */
  .u-activity :global(.strip) {
    flex: 1 1 auto;
    width: auto;
    max-width: none;
  }

  .car {
    color: var(--color-amber);
    /* functional in-progress motion — exempt from the reduced-motion blanket (app.css) */
    animation: blink 1.1s steps(1) infinite !important;
  }

  /* Cross-boundary hover reveal for the ✕ button inside UnitRowRight. The
     .row-decom lives in a child component so we use :global() to reach it. */
  @media (hover: hover) and (pointer: fine) {
    .unit:hover :global(.row-decom),
    .unit:focus-within :global(.row-decom) {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .meta {
    grid-area: meta;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .meta-text {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* amber "N manual steps" chip (#1059) — modeled on the epic .chip-migrations recipe; amber
     (--status-warn) reads as caution-pending, never the actionable-complete green. */
  .chip-manual-steps {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    padding: 1px 6px;
    border: 1px solid var(--status-warn);
    border-radius: 2px;
    color: var(--status-warn);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }
  /* chip-as-button variant (#1275) — a <button> resets font/background, so restate the base look
     and layer on the same hover/focus treatment as .manual-steps-ack for a consistent affordance.
     Raised above the .unit-hit overlay (same pattern as .name-icon.actionable / the preview
     badge) so it's actually clickable. */
  .chip-manual-steps--link {
    position: relative;
    z-index: 1;
    font-family: inherit;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .chip-manual-steps--link:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: color-mix(in oklab, var(--status-warn) 20%, transparent);
  }
  .chip-manual-steps--link:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* "Ack" CTA beside the manual-steps chip — warn-toned, micro, clears the auto-merge gate (#1060).
     Raised above the .unit-hit overlay (same pattern as .chip-manual-steps--link above) so it's
     actually clickable — without this it silently sits under the row's full-card click target. */
  .manual-steps-ack {
    position: relative;
    z-index: 1;
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--status-warn);
    border-radius: 2px;
    color: var(--status-warn);
    background: transparent;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s,
      background 0.12s;
  }
  .manual-steps-ack:hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
    background: color-mix(in oklab, var(--status-warn) 12%, transparent);
  }
  .manual-steps-ack:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* thin stage stepper on the quietest row — pushed to the right edge */
  .meta-stepper {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
  }
  @media (max-width: 768px) {
    .unit {
      min-height: 44px;
    }
  }

  /* Touch devices at any width (landscape foldables, tablets) get the same
     44px row floor — the width-based rule above misses coarse pointers > 768px. */
  @media (pointer: coarse) {
    .unit {
      min-height: 44px;
    }
  }

  /* Compact sidebar (touch foldables, narrow picker): the meta footer already
     frees the name from the right rail; here we trade the 2nd prompt line for
     density so more agents stay visible without the card growing taller. */
  @container herd (max-width: 300px) {
    .unit {
      column-gap: 9px;
    }
    .u-sub {
      -webkit-line-clamp: 1;
      line-clamp: 1;
    }
    /* drop the stepper so a narrow sidebar row stays dense and doesn't balloon.
       The heartbeat strip is deliberately NOT pinned narrow here (was flex:none/
       width:64px): on the unfolded-foldable compact sidebar that left it a ~64px
       stub, so it now inherits the full-width default above and spans the activity
       row on every device — matching the strip's "claims the whole activity line"
       intent. */
    .meta-stepper {
      display: none;
    }
  }

  /* Desktop Herd sidebar (never the mobile .units.flow list): drop the badge/
     status rail to its own full-width row beneath the name+prompt so a wide
     badge (e.g. the critic chip) can't crush the name to an ellipsis stub. The
     sidebar is always ≤360px (routes/+page.svelte .grid minmax(244,288)/(300,
     360)), so this is the sidebar's standing layout; the container query is a
     future-proof guard against any hypothetical wide non-flow herd. Scoped to
     :not(.flow) so the wider mobile flow list is genuinely untouched (no
     360-vs-375 cliff). */
  @container herd (max-width: 360px) {
    :global(.units:not(.flow)) .unit {
      grid-template-columns: 16px 1fr;
      grid-template-areas:
        "pip main"
        "pip right"
        "pip meta";
    }
    :global(.units:not(.flow)) .unit.has-activity {
      grid-template-areas:
        "pip main"
        "pip act"
        "pip right"
        "pip meta";
    }
    /* Reserve room on the name row so a long name ellipsizes BEFORE the clock
       rather than sliding under it (the clock still paints over the name —
       pointer-events stops event capture, not painting). 72px clears realistic
       elapsed() widths incl. the multi-day forms "29d 23h" / "100d 23h" (8
       tabular chars) + the right offset. elapsed() has no day cap, so a
       pathological 1000d+ run (9+ chars) would still overflow — accepted: such a
       session is unreachable in practice and it degrades gracefully (the name
       just paints under the clock, same tradeoff as everywhere else here). */
    :global(.units:not(.flow)) .u-top {
      padding-right: 72px;
    }
  }
</style>
