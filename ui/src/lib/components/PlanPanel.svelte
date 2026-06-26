<script lang="ts">
  import type { Session } from "$lib/types";
  import { planGates } from "$lib/reviews.svelte";
  import { releasePlanGate, reviewPlan } from "$lib/api";
  import { canRelease } from "./plan-gate-badge";
  import { dialog } from "$lib/a11yDialog";
  import { portal } from "$lib/portal";
  import { m } from "$lib/paraglide/messages";
  import VisualReview from "./VisualReview.svelte";

  let { session, onclose }: { session: Session; onclose: () => void } = $props();

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
  // why nothing changed: "unchanged" = server deduped (plan unchanged / already approved),
  // "error" = the reviewer failed to spawn. Auto-dismissed so it can't go stale between clicks.
  // null = no note (fresh page, or a real review is/was in flight).
  let outcome = $state<"unchanged" | "error" | null>(null);
  // A review is visibly in flight from the click until the WS reviewing flag clears.
  const inFlight = $derived(busy || reviewing || awaitingReview);

  // Once the WS `reviewing` flag takes over the in-flight indicator, drop the bridge and any
  // stale no-op/error note — a real run supersedes both.
  $effect(() => {
    if (reviewing) {
      awaitingReview = false;
      outcome = null;
    }
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
    try {
      const status = await reviewPlan(session.id);
      // "started" → bridge to the WS reviewing flag so the spinner doesn't blink back.
      // "skipped" → unchanged plan / already approved; "error" → spawn failed.
      if (status === "started") awaitingReview = true;
      else if (status === "skipped" && !reviewing) outcome = "unchanged";
      else if (status === "error") outcome = "error";
    } catch {
      // The trigger request itself failed (network / non-2xx) — surface it like a spawn failure.
      outcome = "error";
    } finally {
      busy = false;
    }
  }
</script>

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
          <p class="empty">{m.planpanel_empty()}</p>
        {/if}
      </section>

      {#if gate}
        <section class="verdict">
          <div class="micro">{m.planpanel_verdict()}</div>
          {#if gate.summary}
            <p class="summary">{gate.summary}</p>
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

      {#if outcome === "unchanged"}
        <p class="note" role="status">{m.planpanel_review_unchanged()}</p>
      {:else if outcome === "error"}
        <p class="note err" role="alert">{m.planpanel_review_failed()}</p>
      {/if}

      {#if !readonly}
        <div class="actions">
          {#if canReviewNow}
            <button type="button" class="review" onclick={review} disabled={inFlight}>
              {#if inFlight}
                <span class="rev-dot" aria-hidden="true"></span>{m.planpanel_reviewing()}
              {:else}
                {m.planpanel_review_now()}
              {/if}
            </button>
          {/if}
          <button type="button" class="go" onclick={go} disabled={busy || !releasable}>
            {m.planpanel_go()}
          </button>
        </div>
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
  .review,
  .go {
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
  }
  /* plan reviewer running now: amber pulsing dot (mirrors PlanGateBadge) */
  .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
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
  .go:disabled {
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
