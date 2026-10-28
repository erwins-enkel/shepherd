<script lang="ts">
  import type { Session } from "#lib/types.js";
  import { planGates, spawnNotices } from "#lib/reviews.svelte.js";
  import {
    dismissQuota,
    releasePlanGate,
    replySession,
    resumeQuota,
    reviewPlan,
    getPlanDraft,
    isPlanReviewError,
    planReviewStarted,
    type PlanReviewError,
  } from "#lib/api.js";
  import {
    canOfferPlanReview,
    canRelease,
    canShowPlanStallActions,
    canTriggerPlanReview,
    planEdited,
    planGateChip,
  } from "./plan-gate-badge";
  import SpawnFailureNotice from "./SpawnFailureNotice.svelte";
  import { dialog } from "#lib/a11yDialog.js";
  import { portal } from "#lib/portal.js";
  import { m } from "#lib/paraglide/messages.js";
  import { environmentLabel, providerLabel } from "#lib/reviewer-env.js";
  import { DOCS_URL } from "#lib/build-info.js";
  import EffortSwitchNotice from "./EffortSwitchNotice.svelte";
  import { effortSwitchState } from "#lib/effort-switch.js";
  import { sessionEnvironment } from "#lib/session-env.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { planAnchorTarget, planOutline, splitReviewerNotes } from "#lib/plan-outline.js";
  import PlanModeSwitch, { type PlanViewMode } from "./plan-panel/PlanModeSwitch.svelte";
  import PlanToc from "./plan-panel/PlanToc.svelte";
  import PlanVerdictCard from "./plan-panel/PlanVerdictCard.svelte";
  import PlanDocument from "./plan-panel/PlanDocument.svelte";

  let { session, onclose }: { session: Session; onclose: () => void } = $props();

  const docsHref = `${DOCS_URL}reference/configuration/`;
  const gate = $derived(planGates.map[session.id]);
  // Plan blocks are the planning agent's own proposed structures. The "inferred" badge
  // (and its glossary tooltip) is recap-specific: it warns that a recap card was
  // model-extracted and "not verified against the real diff." In the plan-before-execution
  // view there is no diff and no recap model, so that caveat is false and confusing here —
  // strip the flag so the badge doesn't render in this context (it still shows in recaps).
  const planBlocks = $derived(
    (gate?.blocks ?? []).map((b) =>
      "inferred" in b && b.inferred ? { ...b, inferred: false } : b,
    ),
  );
  const reviewing = $derived(planGates.isReviewing(session.id));
  let draft = $state<string | null>(null);
  let draftStatus = $state<"loading" | "missing" | "loaded" | "error">("loading");
  let draftRevision = $state(0);
  $effect(() => {
    const id = session.id;
    // Opening, session switches, review signals and manual attempts each refresh the artifact.
    void reviewing;
    void draftRevision;
    draft = null;
    if (session.planPhase !== "planning" || session.status === "archived" || gate) return;
    draftStatus = "loading";
    let alive = true;
    getPlanDraft(id)
      .then((text) => {
        if (!alive) return;
        draft = text;
        draftStatus = text === null ? "missing" : "loaded";
      })
      .catch(() => {
        if (alive) draftStatus = "error";
      });
    return () => {
      alive = false;
    };
  });
  const planText = $derived(gate?.plan ?? draft ?? "");
  // Both texts are agent-authored and untrusted: they render only through MarkdownBody, i.e. the
  // shared sanitizer (#lib/sanitize-html), never as raw HTML.
  const outline = $derived(planOutline(planText));
  const planBytes = $derived(new TextEncoder().encode(planText).length);
  const verdict = $derived(splitReviewerNotes(gate?.body ?? ""));
  const verdictTone = $derived(
    gate?.decision === "approved"
      ? "ready"
      : gate?.decision === "changes_requested"
        ? "changes"
        : "error",
  );
  const release = $derived(
    gate
      ? {
          round: gate.round,
          cap: gate.cap,
          approved: gate.approved,
          findings: gate.findings.length,
          notes: verdict.notes.length,
        }
      : null,
  );
  const agentName = $derived(providerLabel(session.agentProvider ?? "claude"));
  let mode = $state<PlanViewMode>("read");
  let bodyEl = $state<HTMLElement | null>(null);
  function jump(anchor: string) {
    if (bodyEl) planAnchorTarget(bodyEl, anchor, outline)?.scrollIntoView({ block: "start" });
  }
  const emptyPlanLabel = $derived(
    gate || session.planPhase !== "planning"
      ? m.planpanel_empty()
      : draftStatus === "error"
        ? m.planpanel_draft_load_failed()
        : draftStatus === "missing"
          ? m.planpanel_plan_unavailable()
          : m.planpanel_draft_loading(),
  );
  const chip = $derived(planGateChip(session, gate, reviewing));
  const releasable = $derived(canRelease(session, gate));
  const planning = $derived(session.planPhase === "planning");
  // Manual re-review: always available while planning; during execution ONLY for a plan edited
  // after approval (#2224), whose re-review can re-gate the session.
  const canReviewNow = $derived(canOfferPlanReview(session, gate));
  // During execution the plan is viewable read-only — hide Go (issue #809). Not the Review control:
  // an edited plan is exactly what an executing operator needs to act on.
  const readonly = $derived(!planning);
  // The live plan no longer matches what was approved — what the panel renders below is the
  // APPROVED snapshot, not what the agent is working from.
  const edited = $derived(planEdited(gate));
  // question-form answers steer back to the PLANNING agent — only while planning (the gate + its
  // questions persist past approval), with submit locked while a review is in flight.
  const planAnswerCtx = $derived(
    planning ? { sessionId: session.id, locked: reviewing } : undefined,
  );
  const planStalled = $derived(canShowPlanStallActions(session, gate, reviewing));
  // #1944: a REFUSED plan-gate spawn. Rendered INDEPENDENTLY of `planStalled` — deliberately.
  // canShowPlanStallActions requires `gate?.decision === "changes_requested" && round >= cap`, and
  // a refusal writes no gate row at all, so borrowing that predicate would leave the operator with
  // no surface whatsoever: planGateChip yields "planning" and the Resume/Dismiss menu never opens.
  const spawnFailure = $derived(
    (() => {
      const n = spawnNotices.for(session.id, "plan");
      return n?.severity === "failed" ? n : null;
    })(),
  );

  // Whether the rework budget is spent. Mirrors the server's at-cap hold (plan-gate.ts
  // applyChangesRequested + startedStatus) — which keys on `round >= cap` ALONE, so this must too: an
  // `error` gate carries its round and stays re-reviewable, and its next `request-changes` verdict is
  // held exactly the same way. Narrowing on `decision === "changes_requested"` here would clear the
  // note the server just told us to show. Clears `heldAtCap` once the streak leaves the cap.
  const atCap = $derived(!!gate && !gate.approved && gate.round >= gate.cap);
  // The live rework streak — drives the "a click spends a round" hint. Narrowed to a
  // changes-requested verdict on purpose: that's the state whose {round}/{cap} the operator sees.
  const rework = $derived(
    gate?.decision === "changes_requested" && !gate.approved ? gate : undefined,
  );
  // Only an UNEDITED `approved` gate renders the Review control inert: `force` re-reviews an
  // unchanged plan, and since #2224 an EDITED approved one, so only that state dead no-ops. (The
  // `reviewing` case is handled by the in-flight spinner path.)
  const planReviewBlock = $derived(canTriggerPlanReview(session, gate, reviewing));
  // The control's inert state, resolved once here rather than re-tested per attribute: the template
  // stays declarative and its synthetic complexity stays under the Tier-1 Svelte bar (.fallowrc.jsonc).
  const reviewInert = $derived(planReviewBlock === "approved");
  // Once a verdict exists the control re-runs it; before that it starts the first review.
  const reviewLabel = $derived(gate ? m.planpanel_review_again() : m.planpanel_review_now());
  const reviewAriaLabel = $derived(
    reviewInert ? `${reviewLabel} — ${m.planpanel_review_already_approved()}` : undefined,
  );
  // Rendered whenever the footer has at least one control: Review (planning, or an edited plan
  // mid-execution) or Go (planning only).
  const showActions = $derived(!readonly || canReviewNow);
  let envOpen = $state(false);

  const planEnv = $derived(
    // The tier actually in force (#3434): observed → active → planning selection.
    environmentLabel(
      session.agentProvider ?? "claude",
      session.model,
      sessionEnvironment(session).effortTier,
    ),
  );
  // Live reviewer env for the in-flight run — carried on the reviewing signal (+ bootstrap), so the
  // CLI/model identity is known before a gate exists (notably the FIRST review). Prefer it when its
  // provider resolved to a real CLI; else fall back to the persisted gate fields (a finished/prior
  // round, or an adopted-orphan run whose CLI couldn't be resolved).
  const liveReviewEnv = $derived(planGates.reviewerEnvFor(session.id));
  const reviewProvider = $derived(liveReviewEnv?.provider ?? gate?.reviewerProvider ?? null);
  const reviewModel = $derived(liveReviewEnv?.provider ? liveReviewEnv.model : gate?.reviewerModel);
  const reviewEffort = $derived(
    liveReviewEnv?.provider ? liveReviewEnv.effort : gate?.reviewerEffort,
  );
  const reviewEnv = $derived(environmentLabel(reviewProvider, reviewModel, reviewEffort));
  const reviewerName = $derived(reviewProvider ? providerLabel(reviewProvider) : null);
  // In-flight button identity: shows the reviewer triple ONLY when a real (non-null) provider is
  // known, so an adopted-orphan {provider:null,…} or the pre-first-verdict bridge window falls back
  // to a plain "Reviewing…" rather than surfacing an ugly "unavailable · <model>" string. Composed
  // here (not inline in the template) so the branch lives in the script, keeping the <template>
  // synthetic complexity under the Tier-1 Svelte bar (.fallowrc.jsonc).
  const reviewingButtonLabel = $derived(
    reviewProvider ? m.planpanel_reviewing_env({ env: reviewEnv }) : m.planpanel_reviewing(),
  );
  // The at-cap note must never point at a CTA that isn't on screen — so it keys off `planStalled`,
  // the SAME predicate that renders the button (canShowPlanStallActions), not a re-derived subset of
  // it. That predicate needs more than a `changes_requested` verdict: it also requires the review to
  // be finished (`!reviewing`) and the session parked. Both matter here — the note is set on the
  // click, i.e. precisely while the review is in flight and the CTA is hidden. Whenever the button is
  // absent (review running, session running, or an `error` verdict), the note says Resume APPEARS
  // once it can, which is exactly what happens. Derived live, so it re-points itself the moment the
  // CTA lands.
  const atCapNote = $derived(
    planStalled ? m.planpanel_review_at_cap() : m.planpanel_review_at_cap_no_resume(),
  );
  // A re-review is no longer free of the rework budget: since #1759 its findings are steered back and
  // it SPENDS a round, so a few clicks exhaust the budget. The only other surface for that is the
  // {round}/{cap} counter, which doesn't say what a click costs — so the control says it itself.
  const reviewHint = $derived(
    rework && !atCap
      ? m.plangate_review_spends_round({ round: rework.round, cap: rework.cap })
      : undefined,
  );

  let busy = $state(false);
  // Set on a "started" trigger to bridge the window between the HTTP reply and the WS `reviewing`
  // flag: the server emits `reviewing` before replying, but if that message lags the response the
  // button would briefly flip back to "Review plan now" (a reprise of the original blink). Held
  // until `reviewing` is observed, with a backstop timeout so a lost event can't wedge the spinner.
  let awaitingReview = $state(false);
  // Outcome of the last manual review trigger that produced no live run, so the panel can explain
  // that it couldn't start. Auto-dismissed so it can't go stale between clicks.
  // null = no note (fresh page, or a real review is/was in flight). The cause is not guessed from the
  // cached gate — `force` makes any "unchanged/approved" claim false, and a plugin abort is unknowable.
  let outcome = $state<"skipped" | PlanReviewError | null>(null);
  // Persistent while the current planning state has no usable `.shepherd-plan.md` artifact.
  // Unlike `outcome`, this must not auto-dismiss: it explains why Review cannot start.
  let planUnavailable = $state(false);
  // The last Re-review click started a run on an already-at-cap rework streak: it is a REAL review
  // (it can still approve), but a `request-changes` verdict won't be steered to the agent — Resume
  // is the affordance that delivers (#1759). Unlike `outcome` this must survive the run itself (the
  // reviewing flag doesn't clear it), so it's cleared only when the streak leaves the cap.
  let heldAtCap = $state(false);
  // A review is visibly in flight from the click until the WS reviewing flag clears.
  const inFlight = $derived(busy || reviewing || awaitingReview);
  let quotaBusy = $state<"resume" | "dismiss" | null>(null);
  let quotaOutcome = $state<"unreachable" | "not-stalled" | "error" | null>(null);

  // Once the WS `reviewing` flag takes over the in-flight indicator, drop the bridge and any
  // stale no-op/error note — a real run supersedes both.
  $effect(() => {
    if (reviewing) {
      awaitingReview = false;
      outcome = null;
      planUnavailable = false;
      quotaOutcome = null;
    }
  });

  $effect(() => {
    if (gate || !canReviewNow) planUnavailable = false;
  });

  // The at-cap warning stands until the streak actually leaves the cap (a Resume/Dismiss reset, or an
  // approval) — it describes the gate's state, not the click, so it must outlive both the run and the
  // 6s `outcome` expiry.
  $effect(() => {
    if (!atCap) heldAtCap = false;
  });

  // Backstop: if the `reviewing` event never arrives (lost/late), don't wedge the spinner.
  $effect(() => {
    if (!awaitingReview) return;
    const t = setTimeout(() => (awaitingReview = false), 4000);
    return () => clearTimeout(t);
  });

  // The note is a transient confirmation, not persistent state — expire it so it can't linger
  // and contradict a plan that changed since.
  $effect(() => {
    if (!outcome) return;
    const t = setTimeout(() => (outcome = null), 6000);
    return () => clearTimeout(t);
  });

  // A Go the server withheld (#3434): its 409 code bridges until the gate update carrying the same
  // `effortSwitchError` arrives over WS. Any other refusal gets the generic failure note.
  let goRefusal = $state<"busy" | "unconfirmed" | "error" | null>(null);
  const effortSwitch = $derived(
    effortSwitchState(
      session,
      gate,
      goRefusal === "busy" || goRefusal === "unconfirmed" ? goRefusal : null,
    ),
  );

  async function go(skipEffortSwitch = false) {
    if (busy || !releasable) return;
    busy = true;
    goRefusal = null;
    try {
      const res = skipEffortSwitch
        ? await releasePlanGate(session.id, { skipEffortSwitch: true })
        : await releasePlanGate(session.id);
      if (res.ok) onclose();
      else goRefusal = res.code ?? "error";
    } catch {
      goRefusal = "error";
    } finally {
      busy = false;
    }
  }

  async function review() {
    // `reviewInert` is guarded HERE, not at the click site: the button stays focusable and
    // screen-reader-announced (aria-disabled + label), so the no-op belongs in the handler.
    if (inFlight || !canReviewNow || reviewInert) return;
    busy = true;
    outcome = null;
    planUnavailable = false;
    try {
      const status = await reviewPlan(session.id);
      // started (either flavour) → bridge to the WS reviewing flag so the spinner doesn't blink back.
      // "started-at-cap" is a REAL run, but the rework budget is spent: if it requests changes again,
      // those findings will not be steered to the agent. Say so (#1759) — it used to be
      // indistinguishable from a round that landed.
      // "skipped" → the review couldn't start (a race, an approval landing, a planPhase flip, or a
      // plugin abort). The cause is unknowable from here, so the note stays causally silent.
      if (planReviewStarted(status)) {
        awaitingReview = true;
        heldAtCap = status === "started-at-cap";
      } else if (status === "plan-unavailable" && !reviewing) planUnavailable = true;
      else if (status === "skipped" && !reviewing) outcome = "skipped";
      else if (isPlanReviewError(status)) outcome = status; // name the specific cause
    } catch {
      // The trigger request itself failed (network / non-2xx) — surface it like a spawn failure.
      outcome = "error-spawn";
    } finally {
      busy = false;
      draftRevision++;
    }
  }

  async function resumeStalledPlan() {
    if (!planStalled || quotaBusy) return;
    quotaBusy = "resume";
    quotaOutcome = null;
    try {
      const { status } = await resumeQuota(session.id);
      if (status === "resumed") {
        onclose();
      } else if (status === "unreachable") {
        quotaOutcome = "unreachable";
      } else if (status === "not-stalled") {
        quotaOutcome = "not-stalled";
      } else {
        quotaOutcome = "error";
      }
    } catch {
      quotaOutcome = "error";
    } finally {
      quotaBusy = null;
    }
  }

  async function dismissStalledPlan() {
    if (!planStalled || quotaBusy) return;
    quotaBusy = "dismiss";
    quotaOutcome = null;
    try {
      const { status } = await dismissQuota(session.id);
      if (status === "dismissed") {
        onclose();
      } else if (status === "not-stalled") {
        quotaOutcome = "not-stalled";
      } else {
        quotaOutcome = "error";
      }
    } catch {
      quotaOutcome = "error";
    } finally {
      quotaBusy = null;
    }
  }

  // A note to the planning agent rides the ordinary steer, like the epic draft's amend line. Only
  // while planning: during execution a steer would reach the implementing agent instead.
  const canNote = $derived(planning && session.status !== "archived");
  let noteText = $state("");
  let noteBusy = $state(false);
  async function sendNote() {
    const text = noteText.trim();
    if (!text || noteBusy || !canNote) return;
    noteBusy = true;
    try {
      await replySession(session.id, text);
      noteText = "";
      toasts.info(m.planpanel_note_sent({ agent: agentName }));
    } catch {
      toasts.info(m.planpanel_note_failed(), {
        key: `plan-note:${session.id}`,
        sticky: true,
        alert: true,
      });
    } finally {
      noteBusy = false;
    }
  }

  const statusNoteId = $derived(`plan-status-${session.id}`);
  const statusNote = $derived(planStatusNote(chip, planStalled));
  const statusTone = $derived(planStatusTone(chip));
  const chipLabel = $derived(planChipLabel(chip));
  // The header chip follows the status line's tone; a running review pulses amber.
  const chipTone = $derived(chip.kind === "reviewing" ? "changes" : statusTone);

  // Footer attribute state, resolved in the script for the same reason as `reviewInert` above —
  // the markup stays declarative and each template unit stays under the Tier-1 Svelte bar.
  const describedBy = $derived(statusNote ? statusNoteId : undefined);
  const reviewAriaDisabled = $derived(reviewInert ? "true" : undefined);
  const reviewDisabled = $derived(inFlight || !!quotaBusy);
  const goDisabled = $derived(busy || !!quotaBusy || !releasable);

  function planStatusNote(currentChip: typeof chip, stalledActionsVisible: boolean): string | null {
    switch (currentChip.kind) {
      case "ready":
        return m.planpanel_status_ready();
      case "changes":
        return stalledActionsVisible
          ? m.planpanel_status_changes_stalled()
          : m.planpanel_status_changes();
      case "error":
        return m.planpanel_status_error();
      case "planning":
        return m.planpanel_status_planning();
      case "reviewing":
        return m.planpanel_status_reviewing();
      case "view":
        return m.planpanel_status_view();
      case "edited":
        return m.planpanel_status_edited();
      case "none":
        return null;
    }
  }

  function planChipLabel(currentChip: typeof chip): string | null {
    switch (currentChip.kind) {
      case "ready":
        return m.planpanel_chip_ready();
      case "changes":
        return m.planpanel_chip_changes({ round: currentChip.round, cap: currentChip.cap });
      case "error":
        return m.planpanel_chip_error();
      case "planning":
        return m.planpanel_chip_planning();
      case "reviewing":
        return m.planpanel_chip_reviewing();
      case "view":
        return m.planpanel_chip_view();
      case "edited":
        return m.planpanel_chip_edited();
      case "none":
        return null;
    }
  }

  function planStatusTone(currentChip: typeof chip): "ready" | "changes" | "error" | "muted" {
    if (currentChip.kind === "ready") return "ready";
    if (currentChip.kind === "changes" || currentChip.kind === "edited") return "changes";
    if (currentChip.kind === "error") return "error";
    return "muted";
  }
</script>

<svelte:window
  onclick={() => {
    envOpen = false;
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") envOpen = false;
  }}
/>

<!-- `class="overlay"` is load-bearing beyond styling: Viewport's shouldForwardEscape and +page's
     anyOverlayOpen() stand down on it (see EpicDraftModal). -->
<div
  class="overlay"
  role="presentation"
  use:portal
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.planpanel_title()}
    use:dialog={{ onclose }}
  >
    {@render headerBar()}

    <!-- The dialog's only scroller. On a wide card it becomes two columns: a sticky table of
         contents beside the verdict and the plan; narrower, the contents fold above them. -->
    <div class="body" bind:this={bodyEl}>
      <PlanToc
        sections={outline.sections}
        verdictTone={gate ? verdictTone : null}
        hasBlocks={planBlocks.length > 0}
        {release}
        onjump={jump}
      />
      <article class="doc">
        <SpawnFailureNotice notice={spawnFailure} />
        {#if gate}
          <PlanVerdictCard
            {gate}
            reviewer={reviewerName}
            notes={verdict.notes}
            rationale={verdict.rest}
            tone={verdictTone}
          />
        {/if}
        <PlanDocument
          {outline}
          bytes={planBytes}
          agent={agentName}
          asOf={gate ? gate.updatedAt : null}
          blocks={planBlocks}
          answerCtx={planAnswerCtx}
          unreviewed={!gate && !!draft}
          {edited}
          emptyLabel={emptyPlanLabel}
        />
      </article>
    </div>

    {@render footerBar()}
  </div>
</div>

<!-- Canonical top bar: a back chevron returns to the session view, the session title rides in the
     middle (mirrors Viewport's mobile header), the gate state and the view switch sit right. -->
{#snippet headerBar()}
  <header class="chead">
    <button type="button" class="back" onclick={onclose} aria-label={m.planpanel_back_aria()}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"
        ><path d="M10 3 5 8l5 5" /></svg
      >
    </button>
    <div class="htitle">
      <span class="micro">{m.planpanel_title()}</span>
      <span class="sname" title={session.name}>{session.name}</span>
      <div class="envline" aria-label={m.planpanel_env_aria()}>
        <span class="env-chip" title={planEnv}>
          <span class="env-label">{m.planpanel_env_plan()}</span>
          <span class="env-value">{planEnv}</span>
        </span>
        <span class="env-chip" title={reviewEnv}>
          <span class="env-label">{m.planpanel_env_review()}</span>
          <span class="env-value">{reviewEnv}</span>
        </span>
        {@render envInfo()}
      </div>
    </div>
    {#if chipLabel}
      <span class="state-chip {chipTone}" class:pulse={chip.kind === "reviewing"}>
        <span class="dot" aria-hidden="true"></span>{chipLabel}
      </span>
    {/if}
    <PlanModeSwitch {mode} onselect={(next) => (mode = next)} />
  </header>
{/snippet}

{#snippet envInfo()}
  <span class="env-info">
    <button
      type="button"
      class="env-help"
      aria-label={m.planpanel_env_help_aria()}
      aria-expanded={envOpen}
      onclick={(e) => {
        e.stopPropagation();
        envOpen = !envOpen;
      }}
    >
      i
    </button>
    {#if envOpen}
      <div
        class="env-pop"
        role="dialog"
        tabindex="-1"
        aria-label={m.planpanel_env_popover_title()}
        onclick={(e) => {
          e.stopPropagation();
        }}
        onkeydown={(e) => {
          if (e.key === "Escape") envOpen = false;
          e.stopPropagation();
        }}
      >
        <strong>{m.planpanel_env_popover_title()}</strong>
        <span>{m.planpanel_env_popover_body()}</span>
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external docs URL -->
        <a href={docsHref} target="_blank" rel="noopener noreferrer"
          >{m.planpanel_env_docs_link()}</a
        >
      </div>
    {/if}
  </span>
{/snippet}

<!-- Pinned footer: never scrolls away. A note to the planner, the transient outcome notes, then the
     status line beside the gate's actions. -->
{#snippet footerBar()}
  <footer class="foot">
    {#if canNote}
      <div class="note-row">
        <input
          class="note-input"
          type="text"
          bind:value={noteText}
          disabled={noteBusy}
          aria-label={m.planpanel_note_label({ agent: agentName })}
          placeholder={m.planpanel_note_placeholder({ agent: agentName })}
          onkeydown={(e) => {
            if (e.key === "Enter" && !e.isComposing) void sendNote();
          }}
        />
        <button
          type="button"
          class="send"
          disabled={noteBusy || !noteText.trim()}
          onclick={() => void sendNote()}>{m.planpanel_note_send()}</button
        >
      </div>
    {/if}
    {@render outcomeNotes()}
    <div class="foot-row">
      {#if statusNote}
        <p id={statusNoteId} class="status-note {statusTone}">
          <span class="dot" aria-hidden="true"></span>{statusNote}
        </p>
      {/if}
      {#if planStalled}
        <div class="quota-actions" aria-describedby={describedBy}>
          <button
            type="button"
            class="quota-btn primary"
            onclick={resumeStalledPlan}
            disabled={quotaBusy !== null}
          >
            {quotaBusy === "resume" ? m.planpanel_quota_resuming() : m.planpanel_quota_resume()}
          </button>
          <button
            type="button"
            class="quota-btn"
            onclick={dismissStalledPlan}
            disabled={quotaBusy !== null}
          >
            {quotaBusy === "dismiss" ? m.planpanel_quota_dismissing() : m.planpanel_quota_dismiss()}
          </button>
        </div>
      {/if}
      {@render actionsFooter()}
    </div>
  </footer>
{/snippet}

{#snippet outcomeNotes()}
  {#if heldAtCap}
    <p class="note" role="status">{atCapNote}</p>
  {/if}

  {#if planUnavailable}
    <p class="note" role="status">{m.planpanel_review_plan_unavailable()}</p>
  {:else if outcome === "skipped"}
    <p class="note" role="status">{m.planpanel_review_nothing_to_review()}</p>
  {:else if outcome === "error-spawn"}
    <p class="note err" role="alert">{m.planpanel_review_failed_spawn()}</p>
  {:else if outcome === "error-worktree"}
    <p class="note err" role="alert">{m.planpanel_review_failed_worktree()}</p>
  {:else if outcome === "error-auth"}
    <p class="note err" role="alert">{m.planpanel_review_failed_auth()}</p>
  {/if}

  {#if effortSwitch}
    <EffortSwitchNotice state={effortSwitch} {busy} ongo={(skip) => void go(skip)} />
  {:else if goRefusal === "error"}
    <p class="note err" role="alert">{m.hold_cta_go_failed()}</p>
  {/if}

  {#if quotaOutcome === "unreachable"}
    <p class="note err" role="alert">{m.planpanel_quota_unreachable()}</p>
  {:else if quotaOutcome === "not-stalled"}
    <p class="note" role="status">{m.planpanel_quota_not_stalled()}</p>
  {:else if quotaOutcome === "error"}
    <p class="note err" role="alert">{m.planpanel_quota_failed()}</p>
  {/if}

  {#if showActions && reviewInert}
    <p class="note" role="status">{m.planpanel_review_already_approved()}</p>
  {/if}
{/snippet}

<!-- The Review control as its own unit: its in-flight/idle label swap is what pushed the footer
     over the template-complexity bar as one block. -->
{#snippet reviewButton()}
  <button
    type="button"
    class="review"
    disabled={reviewDisabled}
    aria-disabled={reviewAriaDisabled}
    aria-label={reviewAriaLabel}
    title={reviewHint}
    onclick={review}
  >
    {#if inFlight}
      <span class="rev-dot" aria-hidden="true"></span><span class="rev-text"
        >{reviewingButtonLabel}</span
      >
    {:else}
      {reviewLabel}
    {/if}
  </button>
{/snippet}

<!-- The gate's own actions, likewise: fallow scores a top-level {#snippet} as its own unit, which
     keeps the footer within the health bar. -->
{#snippet actionsFooter()}
  {#if showActions}
    <div class="actions" aria-describedby={describedBy}>
      {#if canReviewNow}
        {@render reviewButton()}
      {/if}
      {#if !readonly}
        <button
          type="button"
          class="go"
          onclick={() => go()}
          disabled={goDisabled}
          aria-describedby={describedBy}
        >
          <span class="go-glyph" aria-hidden="true">▸</span>{m.planpanel_go()}
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
  }
  /* Fixed header and footer around one scroller (.body), the epic-draft dialog's shape. The card is
     the container the plan's two-column layout and its table of contents query. */
  .card {
    position: relative;
    box-sizing: border-box;
    width: min(1240px, 92vw);
    max-height: 90dvh;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }
  .chead {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    min-width: 0;
    padding: 10px 16px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }
  .back {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    cursor: pointer;
  }
  .back:hover {
    background: var(--color-hover);
  }
  .back svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }
  .htitle {
    display: flex;
    flex: 1 1 260px;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  /* session title — ellipsizes within the bar so it never widens the sheet */
  .sname {
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .envline {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    flex-wrap: wrap;
    margin-top: 3px;
  }
  .env-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
    max-width: min(42ch, 100%);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 2px 5px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    line-height: 1.2;
  }
  .env-label {
    color: var(--color-faint);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    flex-shrink: 0;
  }
  .env-value {
    color: var(--color-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .env-info {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }
  .env-help {
    width: 19px;
    height: 19px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-micro);
    line-height: 1;
    cursor: pointer;
  }
  .env-help:hover,
  .env-help[aria-expanded="true"] {
    border-color: var(--color-line-bright);
    color: var(--color-ink);
    background: var(--color-hover);
  }
  .env-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: 7px;
    width: min(320px, 86vw);
    padding: 10px 12px;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    color: var(--color-ink);
    font-size: var(--fs-meta);
    line-height: 1.35;
    letter-spacing: 0.02em;
  }
  .env-pop strong {
    color: var(--color-ink-bright);
    font-size: var(--fs-meta);
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }
  .env-pop a {
    color: var(--color-blue);
    text-decoration: none;
  }
  .env-pop a:hover {
    text-decoration: underline;
  }
  /* The gate state at a glance — the same tones as the footer's status line. */
  .state-chip {
    --tone: var(--color-muted);
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid color-mix(in oklab, var(--tone) 40%, transparent);
    border-radius: 2px;
    background: color-mix(in oklab, var(--tone) 9%, transparent);
    color: var(--tone);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .state-chip.ready {
    --tone: var(--color-green);
  }
  .state-chip.changes {
    --tone: var(--color-amber);
  }
  .state-chip.error {
    --tone: var(--color-red);
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .state-chip.pulse .dot {
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pp-pulse 1.1s ease-in-out infinite !important;
  }

  .body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    padding: 14px 16px 24px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  @container (min-width: 880px) {
    .body {
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr);
      column-gap: 32px;
      align-items: start;
      padding: 0 24px;
    }
    .doc {
      padding: 18px 0 40px;
    }
  }
  .doc {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 30px;
  }

  .foot {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px 12px;
    border-top: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .note-row {
    display: flex;
    gap: 8px;
  }
  .note-input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 4px 10px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    outline: none;
  }
  .note-input:focus {
    border-color: var(--color-amber);
  }
  .note-input:disabled {
    opacity: 0.5;
  }
  .foot-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions,
  .quota-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    /* Let the in-flight Review button (which carries the CLI·model·effort triple) drop to its own
       line instead of pushing the row past the sheet on a narrow (~320px) phone. */
    flex-wrap: wrap;
    max-width: 100%;
  }
  .note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  .note.err {
    color: var(--color-red);
  }
  .status-note {
    display: inline-flex;
    flex: 1 1 260px;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.35;
  }
  .status-note.ready {
    color: var(--color-green);
  }
  .status-note.changes {
    color: var(--color-amber);
  }
  .status-note.error {
    color: var(--color-red);
  }
  .review,
  .go,
  .quota-btn,
  .send {
    min-height: 44px;
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0 14px;
    border-radius: 2px;
    cursor: pointer;
  }
  .review {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    /* When in-flight the label is the full CLI·model·effort triple. Cap it to the row and let the
       text WRAP (not truncate) so the identity the operator asked to see stays fully legible at
       ~320px; the dot stays pinned (flex-shrink:0 below). */
    max-width: 100%;
    min-width: 0;
    flex-wrap: wrap;
  }
  .rev-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .quota-btn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  /* plan reviewer running now: amber pulsing dot (mirrors PlanGateBadge) */
  .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
    flex-shrink: 0;
    /* functional status motion — exempt from the reduced-motion blanket (app.css) */
    animation: pp-pulse 1.1s ease-in-out infinite !important;
  }
  @keyframes pp-pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  .go {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px;
    border-color: var(--color-green);
    color: var(--color-green);
    font-weight: 600;
    box-shadow: inset 0 0 18px -10px var(--color-green);
  }
  .go-glyph {
    line-height: 1;
  }
  .review:disabled,
  .go:disabled,
  .quota-btn:disabled,
  .send:disabled,
  /* Inert (approved) — kept focusable so its aria-label reason is keyboard-reachable,
     unlike bare `disabled`. */
  .review[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }

  /* phone: a full-bleed sheet, edge to edge — no side margins, no corner brackets, nothing to swing
     sideways. The view switch takes its own row under the title. */
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      max-width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .chead {
      padding: 10px;
    }
    .htitle {
      flex-basis: calc(100% - 64px);
    }
    .state-chip {
      margin-left: 54px;
    }
    .foot {
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
  }
</style>
