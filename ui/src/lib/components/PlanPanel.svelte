<script lang="ts">
  import type { Session } from "$lib/types";
  import { planGates } from "$lib/reviews.svelte";
  import { releasePlanGate, reviewPlan } from "$lib/api";
  import { canRelease } from "./plan-gate-badge";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let { session, onclose }: { session: Session; onclose: () => void } = $props();

  const gate = $derived(planGates.map[session.id]);
  const reviewing = $derived(planGates.isReviewing(session.id));
  const releasable = $derived(canRelease(session, gate));
  // Manual re-review only makes sense while still planning (not once executing).
  const canReviewNow = $derived(session.planPhase === "planning");

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
  // True after a manual review that the server deduped (plan unchanged / already approved): the
  // reviewer never spawned, so `reviewing` stays false and the verdict won't change — without this
  // the button would just blink and leave the operator wondering whether anything happened.
  let unchanged = $state(false);
  // A review is visibly in flight from the click until the WS reviewing flag clears.
  const inFlight = $derived(busy || reviewing);

  // A live review (or a fresh verdict landing) supersedes the "unchanged" note.
  $effect(() => {
    if (reviewing) unchanged = false;
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
    unchanged = false;
    try {
      const { started } = await reviewPlan(session.id);
      // Server deduped the unchanged plan — flag it so the panel explains the no-op.
      if (!started && !reviewing) unchanged = true;
    } catch {
      /* verdict arrives via WS; surfacing the error here is out of scope */
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
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
    <div class="chead">
      <span class="micro">{m.planpanel_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <section class="plan">
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

    {#if unchanged}
      <p class="note" role="status">{m.planpanel_review_unchanged()}</p>
    {/if}

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
    width: min(640px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
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
  .chead {
    display: flex;
    align-items: center;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
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
</style>
