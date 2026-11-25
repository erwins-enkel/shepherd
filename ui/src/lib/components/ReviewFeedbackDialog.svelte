<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { dialog } from "#lib/a11yDialog.js";
  import { dismissReviewFeedback, sendReviewFeedback } from "#lib/api.js";
  import { m } from "#lib/paraglide/messages.js";
  import { getLocale } from "#lib/paraglide/runtime.js";
  import { portal } from "#lib/portal.js";
  import { renderMarkdown } from "#lib/sanitize-html.js";
  import { relativeTimeAgo } from "#lib/format.js";
  import { clock } from "#lib/now.svelte.js";
  import { reviewFeedback } from "#lib/review-feedback.svelte.js";
  import type { ReviewFeedbackSendRefusal } from "#lib/types.js";
  import { firstSafeHttpUrl } from "#lib/url.js";
  import { feedbackWhere } from "./review-feedback-view";

  // PR review feedback waiting for a session's agent (#4126): comments from people with write
  // access and allowlisted review bots. The operator picks which go to the agent as one steer, or
  // dismisses them. Modal on every layout, modeled on PrFindingsDialog. Opened from the Herd card's
  // badge and the git rail's chip; use:dialog restores focus to the opener on close.
  let {
    sessionId,
    prNumber = null,
    prUrl = null,
    onclose,
  }: {
    sessionId: string;
    prNumber?: number | null;
    prUrl?: string | null;
    onclose: () => void;
  } = $props();

  const items = $derived(reviewFeedback.items(sessionId));
  const autoPaused = $derived(reviewFeedback.autoPaused(sessionId));
  // Track what the operator UNticked, so an item arriving while the dialog is open starts ticked.
  const unticked = new SvelteSet<string>();
  const selected = $derived(items.filter((i) => !unticked.has(i.id)).map((i) => i.id));
  const safePrUrl = $derived(firstSafeHttpUrl(prUrl));

  let busy = $state(false);
  let error = $state<ReviewFeedbackSendRefusal | null>(null);

  // Why a send delivered nothing (#4144); the items stay listed either way.
  const REFUSAL_COPY: Record<ReviewFeedbackSendRefusal, () => string> = {
    not_running: m.reviewfeedback_not_running,
    no_pr: m.reviewfeedback_refused_no_pr,
    pr_closed: m.reviewfeedback_refused_pr_closed,
    nothing_pending: m.reviewfeedback_refused_nothing_pending,
    busy: m.reviewfeedback_refused_busy,
    failed: m.reviewfeedback_failed,
  };

  // Everything was sent or dismissed (here or on another client): nothing left to show.
  $effect(() => {
    if (items.length === 0 && !busy) onclose();
  });

  // Comment bodies are untrusted Markdown: rendered and sanitized before {@html}.
  let rendered = $state<Record<string, string>>({});
  $effect(() => {
    let alive = true;
    for (const item of items) {
      if (!item.body) continue;
      renderMarkdown(item.body)
        .then((html) => {
          if (alive) rendered = { ...rendered, [item.id]: html };
        })
        .catch((e) => {
          // Never assigns: a failed load must not leave unsanitized markup.
          console.warn("Review feedback markdown render failed", e);
        });
    }
    return () => {
      alive = false;
    };
  });

  function focusSelf(node: HTMLElement) {
    node.focus({ preventScroll: true });
  }

  function toggle(id: string, on: boolean) {
    if (on) unticked.delete(id);
    else unticked.add(id);
  }

  async function run(action: (ids: string[]) => Promise<ReviewFeedbackSendRefusal | null>) {
    const ids = selected;
    if (!ids.length || busy) return;
    busy = true;
    error = null;
    try {
      // No optimistic removal: the server's session:review-feedback event (sent before the HTTP
      // reply) is the truth — a send delivers at most 20 items and keeps the overflow pending.
      error = await action(ids);
    } catch {
      error = "failed";
    } finally {
      busy = false;
    }
  }

  const send = () => run((ids) => sendReviewFeedback(sessionId, ids));
  const dismiss = () =>
    run(async (ids) => {
      await dismissReviewFeedback(sessionId, ids);
      return null;
    });
</script>

<!-- Purely visual for AT; a pointer can dismiss on it, a keyboard has Escape and the ✕. -->
<div class="rf-scrim scrim" use:portal aria-hidden="true" onclick={onclose}></div>
<div
  class="rf-pop"
  role="dialog"
  aria-modal="true"
  aria-label={m.reviewfeedback_title()}
  tabindex="-1"
  use:portal
  use:dialog={{ onclose }}
  use:focusSelf
>
  <div class="rf-head">
    <span class="rf-title">{m.reviewfeedback_title()}</span>
    {#if safePrUrl && prNumber != null}
      <!-- eslint-disable svelte/no-navigation-without-resolve -- external git-host URL, not an app route -->
      <a class="rf-prlink" href={safePrUrl} target="_blank" rel="noopener">
        PR #{prNumber} ↗
      </a>
      <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {/if}
    <button class="gbtn rf-close" type="button" onclick={onclose} aria-label={m.common_close()}>
      ✕
    </button>
  </div>
  <p class="rf-intro">{m.reviewfeedback_intro()}</p>
  {#if autoPaused}
    <p class="rf-paused" role="status">{m.reviewfeedback_paused_note()}</p>
  {/if}
  <ul class="rf-list">
    {#each items as item (item.id)}
      {@const where = feedbackWhere(item)}
      <li class="rf-item">
        <label class="rf-meta">
          <input
            type="checkbox"
            checked={!unticked.has(item.id)}
            disabled={busy}
            aria-label={m.reviewfeedback_select({ author: item.author })}
            onchange={(e) => toggle(item.id, e.currentTarget.checked)}
          />
          <span class="rf-author">@{item.author}</span>
          {#if item.isBot}<span class="rf-bot">{m.reviewfeedback_bot()}</span>{/if}
          <span class={["rf-where", { mono: where.mono }]}>{where.text}</span>
          <span class="rf-time">{relativeTimeAgo(item.createdAt, clock.current, getLocale())}</span>
        </label>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via renderMarkdown (#lib/sanitize-html) above -->
        <div class="rf-body">{@html rendered[item.id] ?? ""}</div>
      </li>
    {/each}
  </ul>
  <div class="rf-actions">
    {#if error}
      <span class="err" role="alert">
        {REFUSAL_COPY[error]()}
      </span>
    {/if}
    <button class="gbtn" type="button" disabled={busy || !selected.length} onclick={dismiss}>
      {m.reviewfeedback_dismiss()}
    </button>
    <button
      class="gbtn primary"
      type="button"
      disabled={busy || !selected.length}
      aria-busy={busy}
      onclick={send}
    >
      {m.reviewfeedback_send()}
    </button>
  </div>
</div>

<style>
  /* portaled to <body>; the dialog (z-index 51) rides above this */
  .rf-scrim {
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
  .gbtn.primary {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .gbtn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .err {
    margin-right: auto;
    font-size: var(--fs-micro);
    color: var(--color-red);
  }
  .rf-pop {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 51;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: min(560px, 92vw);
    max-height: 85vh;
    overflow: hidden;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    box-shadow: 0 6px 20px color-mix(in srgb, var(--color-bg) 70%, transparent);
  }
  .rf-pop:focus {
    outline: none;
  }
  .rf-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .rf-title {
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-amber);
  }
  .rf-prlink {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    text-decoration: none;
  }
  .rf-prlink:hover {
    color: var(--color-ink-bright);
  }
  .rf-close {
    margin-left: auto;
    padding: 0 6px;
    line-height: 1.6;
  }
  .rf-intro,
  .rf-paused {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    flex-shrink: 0;
  }
  .rf-paused {
    color: var(--color-amber);
  }
  /* the lone scroller: head, notes and the action footer stay pinned */
  .rf-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rf-item {
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    padding: 6px 8px;
  }
  .rf-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .rf-author {
    font-family: var(--font-mono);
    color: var(--color-ink-bright);
  }
  .rf-bot {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0 4px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .rf-where.mono {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .rf-time {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .rf-body {
    margin-top: 4px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  /* markdown rendered via {@html} — children aren't scoped, so target globally */
  .rf-body :global(> *:first-child) {
    margin-top: 0;
  }
  .rf-body :global(> *:last-child) {
    margin-bottom: 0;
  }
  .rf-body :global(p),
  .rf-body :global(ul),
  .rf-body :global(ol),
  .rf-body :global(blockquote) {
    margin: 0 0 8px;
  }
  .rf-body :global(ul),
  .rf-body :global(ol) {
    padding-left: 18px;
  }
  .rf-body :global(a) {
    color: var(--color-blue);
    text-decoration: underline;
  }
  .rf-body :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    background: var(--color-line);
    border-radius: 2px;
    padding: 0 3px;
  }
  .rf-body :global(pre) {
    margin: 0 0 8px;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .rf-body :global(pre code) {
    background: none;
    padding: 0;
  }
  .rf-body :global(blockquote) {
    padding-left: 8px;
    border-left: 2px solid var(--color-line);
    color: var(--color-muted);
  }
  .rf-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--color-line);
    flex-shrink: 0;
  }
  /* the dialog's own controls get a ≥40px touch target */
  @media (pointer: coarse) {
    .rf-close,
    .rf-actions .gbtn {
      min-height: 40px;
    }
  }
</style>
