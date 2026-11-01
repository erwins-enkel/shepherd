<script lang="ts">
  import { dialog } from "#lib/a11yDialog.js";
  import { replySession } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import { portal } from "#lib/portal.js";
  import { renderMarkdown } from "#lib/sanitize-html.js";
  import type { GitState, ReviewVerdict } from "#lib/types.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { criticBadgeLabel, criticTitle, type CriticChip } from "./critic-badge";
  import PlanDriftNote from "./git-rail/PlanDriftNote.svelte";

  // The critic's full verdict, readable without leaving the app. Modal on every layout, opened
  // from the git strip or the merge row. An opener that wants focus back focuses itself first:
  // use:dialog restores to whatever held focus when this mounted.
  let {
    sessionId,
    verdict,
    chip,
    git,
    busy = false,
    onclose,
  }: {
    sessionId: string;
    verdict: ReviewVerdict;
    chip: CriticChip;
    git: GitState;
    busy?: boolean;
    onclose: () => void;
  } = $props();

  // Runs after use:dialog captured the opener. Focus lands on the dialog itself, so a stray Enter
  // can't follow the PR link, its first control.
  function focusSelf(node: HTMLElement) {
    node.focus({ preventScroll: true });
  }

  // Render the (AI-authored) findings as markdown, sanitized before @html. renderMarkdown loads
  // marked/DOMPurify lazily, off the first-paint critical path.
  let renderedBody = $state("");
  $effect(() => {
    const body = verdict.body;
    if (!body) {
      renderedBody = "";
      return;
    }
    let alive = true;
    renderMarkdown(body)
      .then((html) => {
        if (alive) renderedBody = html;
      })
      .catch((e) => {
        // Never assigns to renderedBody: a failed load must not leave unsanitized markup.
        console.warn("Review body markdown render failed", e);
      });
    return () => {
      alive = false;
    };
  });

  let sendFailed = $state(false);
  let sendFailedTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(sendFailedTimer));

  async function sendReviewToAgent() {
    if (!verdict.body) return;
    try {
      await replySession(sessionId, `Address this code review feedback:\n\n${verdict.body}`);
      onclose(); // closing is the success feedback
    } catch {
      sendFailed = true;
      clearTimeout(sendFailedTimer);
      sendFailedTimer = setTimeout(() => (sendFailed = false), 1500);
    }
  }
</script>

<!-- Purely visual for AT; a pointer can dismiss on it, a keyboard has Escape and the ✕. -->
<div class="review-scrim scrim" use:portal aria-hidden="true" onclick={onclose}></div>
<div
  class="review-pop"
  role="dialog"
  aria-modal="true"
  aria-label={m.gitrail_review_title()}
  tabindex="-1"
  use:portal
  use:dialog={{ onclose }}
  use:focusSelf
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
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
      <a
        class="rv-prlink"
        href={firstSafeHttpUrl(git.url) ?? undefined}
        target="_blank"
        rel="noopener">PR #{git.number} ↗</a
      >
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
    <button class="gbtn" type="button" onclick={onclose} aria-label={m.common_close()}>✕</button>
  </div>
  <!-- A no-verdict `error` carries NO prose at all — `summary` is "" and `body` is "" too — so this
       must render the server-authored reason code, or the dialog opens completely empty. Same
       shape as the plan gate's (PlanPanel); criticTitle resolves code → locale → summary. -->
  {#if verdict.summaryCode || verdict.summary}
    <p class="rv-summary">{criticTitle(verdict)}</p>
  {/if}
  <!-- #2155: renders nothing unless the critic measured a real departure from the plan. -->
  <PlanDriftNote {verdict} />
  {#if verdict.body}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via renderMarkdown (#lib/sanitize-html) above -->
    <div class="rv-body">{@html renderedBody}</div>
  {/if}
  {#if verdict.decision !== "error" && verdict.body}
    <div class="review-actions">
      {#if sendFailed}<span class="err" title={m.gitrail_send_review_failed()}
          >{m.gitrail_send_review_failed()}</span
        >{/if}
      <button
        class="gbtn"
        type="button"
        disabled={busy || chip.kind === "reviewing"}
        title={chip.kind === "reviewing" ? m.gitrail_send_review_reviewing_title() : undefined}
        onclick={sendReviewToAgent}
      >
        {m.gitrail_send_review()}
      </button>
    </div>
  {/if}
</div>

<style>
  /* portaled to <body>; the dialog (z-index 51) rides above this */
  .review-scrim {
    z-index: 50;
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
  .err {
    font-size: var(--fs-micro);
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-red);
  }
  .review-pop {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: min(480px, 92vw);
    max-height: 85vh;
    /* clip to the box so the scrollable body — not the dialog — absorbs overflow; the action
       footer stays reachable on short viewports */
    overflow: hidden;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  }

  .review-pop:focus {
    outline: none;
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

  /* the dialog's own controls get a ≥40px touch target */
  @media (pointer: coarse) {
    .review-head .gbtn,
    .review-actions .gbtn {
      min-height: 40px;
    }
  }
</style>
