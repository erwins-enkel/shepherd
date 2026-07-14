<script lang="ts">
  import type { Session } from "$lib/types";
  import { planGates } from "$lib/reviews.svelte";
  import {
    dismissQuota,
    releasePlanGate,
    resumeQuota,
    reviewPlan,
    isPlanReviewError,
    planReviewStarted,
    type PlanReviewError,
  } from "$lib/api";
  import {
    canRelease,
    canShowPlanStallActions,
    canTriggerPlanReview,
    planGateChip,
  } from "./plan-gate-badge";
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";
  import { m } from "$lib/paraglide/messages";
  import { environmentLabel } from "$lib/reviewer-env";
  import { DOCS_URL } from "$lib/build-info";
  import VisualReview from "./VisualReview.svelte";

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
  const chip = $derived(planGateChip(session, gate, reviewing));
  const releasable = $derived(canRelease(session, gate));
  // Manual re-review only makes sense while still planning (not once executing).
  const canReviewNow = $derived(session.planPhase === "planning");
  // During execution the plan is viewable read-only — hide Go + Review (issue #809).
  const readonly = $derived(session.planPhase !== "planning");
  // question-form answers steer back to the planning agent — only while planning (the gate +
  // its questions persist past approval), with submit locked while a review is in flight.
  const planAnswerCtx = $derived(
    canReviewNow ? { sessionId: session.id, locked: reviewing } : undefined,
  );
  const planStalled = $derived(canShowPlanStallActions(session, gate, reviewing));
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
  // Only `approved` renders the Review control inert: `force` re-reviews an unchanged plan, but the
  // server never bypasses `approved`. (The `reviewing` case is handled by the in-flight spinner path.)
  const planReviewBlock = $derived(canTriggerPlanReview(session, gate, reviewing));
  let envOpen = $state(false);

  const planEnv = $derived(
    environmentLabel(session.agentProvider ?? "claude", session.model, session.effort),
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

  // Render the plan + reviewer body as markdown, SANITIZED before @html. Both are
  // agent-authored — the planning agent and the reviewer ingest untrusted input (issue
  // bodies, repo contents), so their markdown is untrusted and must be scrubbed of any
  // embedded HTML/scripts. Mirrors GitRail's critic-body render: marked + DOMPurify are
  // dynamically imported on first render (off the critical path; the browser-only
  // sanitizer never runs during SSR).
  let planHtml = $state("");
  let bodyHtml = $state("");
  $effect(() => {
    const plan = gate?.plan ?? "";
    const body = gate?.body ?? "";
    if (!plan && !body) {
      planHtml = "";
      bodyHtml = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        if (!alive) return;
        planHtml = plan ? DOMPurify.sanitize(marked.parse(plan, { async: false }) as string) : "";
        bodyHtml = body ? DOMPurify.sanitize(marked.parse(body, { async: false }) as string) : "";
      })
      .catch((err) => {
        // Markdown render is progressive enhancement; warn so a broken load isn't swallowed.
        console.warn("plan markdown render failed", err);
      });
    return () => {
      alive = false;
    };
  });

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

  async function go() {
    if (busy || !releasable) return;
    busy = true;
    try {
      await releasePlanGate(session.id);
      onclose();
    } finally {
      busy = false;
    }
  }

  async function review() {
    if (inFlight || !canReviewNow) return;
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

  const statusNoteId = $derived(`plan-status-${session.id}`);
  const statusNote = $derived(planStatusNote(chip, planStalled));
  const statusTone = $derived(planStatusTone(chip));

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
      case "none":
        return null;
    }
  }

  function planStatusTone(currentChip: typeof chip): "ready" | "changes" | "error" | "muted" {
    if (currentChip.kind === "ready") return "ready";
    if (currentChip.kind === "changes") return "changes";
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
    <!-- Canonical top bar: a back chevron returns to the session view, the session
         title rides in the middle (mirrors Viewport's mobile header). Replaces the
         lone ✕ so the dialog reads like every other full-screen view on mobile. -->
    <header class="chead">
      <button type="button" class="back" onclick={onclose} aria-label={m.planpanel_back_aria()}
        >‹</button
      >
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
        </div>
      </div>
    </header>

    <div class="body">
      <section class="plan">
        {#if planBlocks.length > 0}
          <div class="plan-blocks">
            <span class="micro plan-blocks-caption">{m.planpanel_proposed_caption()}</span>
            <VisualReview blocks={planBlocks} answerCtx={planAnswerCtx} />
          </div>
        {/if}
        {#if planHtml}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- plan markdown, DOMPurify-sanitized above -->
          <div class="md">{@html planHtml}</div>
        {:else}
          <p class="empty">
            {#if canReviewNow && !gate}
              {m.planpanel_plan_unavailable()}
            {:else}
              {m.planpanel_empty()}
            {/if}
          </p>
        {/if}
      </section>

      {#if gate}
        <section class="verdict">
          <div class="micro">{m.planpanel_verdict()}</div>
          {#if gate.summaryCode || gate.summary}
            <p class="summary">{gate.summaryCode ? m.planpanel_no_verdict() : gate.summary}</p>
          {/if}
          {#if bodyHtml}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- reviewer markdown, DOMPurify-sanitized above -->
            <div class="md">{@html bodyHtml}</div>
          {/if}
          {#if gate.findings.length > 0}
            <div class="micro findings-head">{m.planpanel_findings()}</div>
            <ul class="findings">
              {#each gate.findings as f, i (i)}
                <li>{f}</li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

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

      {#if statusNote}
        <p id={statusNoteId} class="status-note {statusTone}">
          {statusNote}
        </p>
      {/if}

      {#if planStalled}
        <div class="quota-actions" aria-describedby={statusNote ? statusNoteId : undefined}>
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
      {#if quotaOutcome === "unreachable"}
        <p class="note err" role="alert">{m.planpanel_quota_unreachable()}</p>
      {:else if quotaOutcome === "not-stalled"}
        <p class="note" role="status">{m.planpanel_quota_not_stalled()}</p>
      {:else if quotaOutcome === "error"}
        <p class="note err" role="alert">{m.planpanel_quota_failed()}</p>
      {/if}

      {#if !readonly}
        <div class="actions" aria-describedby={statusNote ? statusNoteId : undefined}>
          {#if canReviewNow}
            <button
              type="button"
              class="review"
              disabled={inFlight || !!quotaBusy}
              aria-disabled={planReviewBlock === "approved" ? "true" : undefined}
              aria-label={planReviewBlock === "approved"
                ? `${m.planpanel_review_now()} — ${m.planpanel_review_already_approved()}`
                : undefined}
              title={reviewHint}
              onclick={() => {
                if (planReviewBlock === "approved") return;
                review();
              }}
            >
              {#if inFlight}
                <span class="rev-dot" aria-hidden="true"></span><span class="rev-text"
                  >{reviewingButtonLabel}</span
                >
              {:else}
                {m.planpanel_review_now()}
              {/if}
            </button>
          {/if}
          <button
            type="button"
            class="go"
            onclick={go}
            disabled={busy || !!quotaBusy || !releasable}
            aria-describedby={statusNote ? statusNoteId : undefined}
          >
            {m.planpanel_go()}
          </button>
        </div>
        {#if planReviewBlock === "approved"}
          <p class="note" role="status">{m.planpanel_review_already_approved()}</p>
        {/if}
      {/if}
    </div>
  </div>
</div>

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
  .card {
    position: relative;
    /* Desktop plans carry diagrams, data-model cards, diffs and tables — give
       them room. Running prose is capped to a readable measure separately
       (.md/.summary/.findings) so widening the sheet helps structure without
       letting paragraphs sprawl. */
    width: min(1040px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    /* lock horizontal axis: long code/plan text wraps or scrolls inside its own
       block (.md pre), never swings the whole sheet sideways on touch. */
    overflow-x: hidden;
    overscroll-behavior: contain;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
  }
  /* scrollable content below the sticky top bar */
  .body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
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
  /* sticky top bar — same idiom as Viewport's .vp-head / BacklogView's .overlay-head:
     back control left, title alongside, a hairline rule under it. */
  .chead {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 8px 12px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
    position: sticky;
    top: 0;
    z-index: 1;
  }
  /* canonical back chevron — mirrors Viewport's .back */
  .back {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-xl);
    line-height: 1;
    padding: 2px 11px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .back:hover {
    background: var(--color-hover);
  }
  .htitle {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
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
  .plan-blocks {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--color-line);
  }
  .plan-blocks-caption {
    color: var(--color-muted);
  }
  .plan,
  .verdict {
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    padding: 10px 12px;
  }
  .verdict {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .summary {
    margin: 0;
    max-width: 74ch;
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
  }
  .empty {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-base);
  }
  .md {
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  /* Cap running text to a comfortable measure on wide desktop sheets; leave
     pre/table free to use the full width. */
  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    max-width: 74ch;
  }
  .md :global(pre) {
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 8px 10px;
    overflow-x: auto;
  }
  .md :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .findings-head {
    margin-top: 2px;
    color: var(--color-amber);
  }
  .findings {
    margin: 0;
    max-width: 74ch;
    padding-left: 18px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.45;
  }
  .findings li {
    margin-bottom: 3px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 2px;
    /* Let the in-flight Review button (which now carries the CLI·model·effort triple) drop to its
       own line instead of pushing the row past the sheet on a narrow (~320px) phone. */
    flex-wrap: wrap;
  }
  .quota-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    text-align: right;
  }
  .note.err {
    color: var(--color-red);
  }
  .status-note {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-meta);
    line-height: 1.35;
    text-align: right;
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
  .quota-btn {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 8px 14px;
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
    border-color: var(--color-green);
    color: var(--color-green);
    box-shadow: inset 0 0 18px -10px var(--color-green);
  }
  .review:disabled,
  .go:disabled,
  .quota-btn:disabled,
  /* Inert (approved) — kept focusable so its aria-label reason is keyboard-reachable,
     unlike bare `disabled`. */
  .review[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }

  /* phone: a full-bleed sheet, edge to edge — no side margins, no corner brackets,
     nothing to swing sideways. Matches the LeftoverDialog full-screen idiom. */
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
    /* edge-to-edge plan content: trim the body's side gutter and let the plan /
       verdict bands span the full screen width (no side border, no rounding) so
       long code, tables and data-model cards use every available pixel. The bands
       keep their inner text inset; actions/notes keep the slim body gutter so
       buttons don't collide with the screen edge. */
    .body {
      padding: 12px 10px;
    }
    .plan,
    .verdict {
      margin-left: -10px;
      margin-right: -10px;
      border-left: 0;
      border-right: 0;
      border-radius: 0;
    }
  }
</style>
