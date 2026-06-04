<script lang="ts">
  import { tick } from "svelte";
  import type { HerdrUpdateStatus } from "$lib/types";
  import { applyHerdrUpdate } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    update,
    sessions = 0,
    log = [],
    done = null,
    onconfirm,
    onclose,
  }: {
    update: HerdrUpdateStatus;
    sessions?: number;
    log?: string[];
    done?: { ok: boolean; from: string | null; to: string | null; error?: string } | null;
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();

  let submitting = $state(false);
  let error = $state<string | null>(null);
  let logEl = $state<HTMLPreElement | null>(null);

  // Render the (GitHub release) notes as markdown, sanitized before @html.
  // marked + DOMPurify are dynamically imported on first render so they stay
  // off the critical path; the (browser-only) sanitizer never runs during SSR.
  let renderedNotes = $state("");
  $effect(() => {
    const body = update.notes;
    if (!body) {
      renderedNotes = "";
      return;
    }
    let alive = true;
    Promise.all([import("marked"), import("dompurify")])
      .then(([{ marked }, { default: DOMPurify }]) => {
        // External release-note links must open out-of-app, not navigate the
        // SPA away; force target/rel on every anchor during sanitize.
        DOMPurify.addHook("afterSanitizeAttributes", (node) => {
          if (node.tagName === "A") {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer");
          }
        });
        let html: string;
        try {
          html = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
        } finally {
          // Always drop our hook, even if parse/sanitize throws, so it can't
          // leak onto the next render. Scoped to this event so we don't wipe
          // any persistent hooks registered elsewhere on the shared singleton.
          DOMPurify.removeHook("afterSanitizeAttributes");
        }
        if (alive) renderedNotes = html;
      })
      .catch((err) => {
        // Markdown render is progressive enhancement; warn so a broken
        // marked/dompurify load isn't swallowed silently.
        console.warn("herdr release notes markdown render failed", err);
      });
    return () => {
      alive = false;
    };
  });

  // herdr update restarts the herdr server (ending live panes) but shepherd
  // stays up — no reload. The modal resolves itself via the `done` result.
  // Busy only while the update is in flight; a terminal `done` result ends it so
  // the operator can read the ✓/✗ outcome and close. (No page reload anymore —
  // shepherd stays up, so the modal must resolve itself.)
  const busy = $derived(submitting && !done);

  async function confirm() {
    submitting = true;
    error = null;
    try {
      await applyHerdrUpdate();
      onconfirm?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "update failed";
      submitting = false;
    }
  }

  // Auto-scroll the log pane to bottom whenever new lines arrive.
  $effect(() => {
    // read log.length to subscribe to changes
    if (log.length && logEl) {
      tick().then(() => {
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      });
    }
  });
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !busy) onclose?.();
  }}
>
  <div
    class="card bracket"
    role="dialog"
    aria-modal="true"
    aria-label={m.herdrupdate_title()}
    use:dialog={{ onclose: () => !busy && onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{m.herdrupdate_title()}</span>
      <!-- The ✕ is ALWAYS available as a deliberate escape hatch: the update runs
           server-side in a managed child independent of this modal, so dismissing
           never cancels it. Without this, a missed `done` event (e.g. the WS drops
           mid-update and reconnects after it fired) would trap the operator in the
           busy state — shepherd no longer restarts, so there's no forced reload to
           rescue them. Backdrop/Esc stay gated on !busy to avoid accidental close. -->
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    {#if update.current && update.latest}
      <div class="summary">
        <span class="versions"
          >{m.herdrupdate_versions({
            current: update.current,
            latest: update.latest,
          })}</span
        >
      </div>
    {/if}

    {#if update.notes}
      <div class="notes-label micro">{m.herdrupdate_notes_label()}</div>
      {#if renderedNotes}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized via DOMPurify above -->
        <div class="notes">{@html renderedNotes}</div>
      {:else}
        <!-- Fallback before the markdown imports resolve, or if they fail:
             show the raw notes as plain text rather than an empty box. -->
        <pre class="notes notes-raw">{update.notes}</pre>
      {/if}
    {/if}

    <div class="instructions">{m.herdrupdate_instructions()}</div>

    {#if sessions > 0}
      <div class="warning">{m.herdrupdate_warning({ count: sessions })}</div>
    {/if}

    {#if submitting}
      {#if done}
        <div class="status" class:ok={done.ok} class:fail={!done.ok} aria-live="polite">
          {#if done.ok}
            {m.herdrupdate_done_ok({ latest: done.to ?? update.latest ?? "" })}
          {:else}
            {m.herdrupdate_done_fail({ current: done.to ?? update.current ?? "" })}
          {/if}
        </div>
      {:else}
        <div class="status" aria-live="polite">{m.herdrupdate_busy()}</div>
      {/if}
      {#if log.length > 0}
        <div class="log-label micro">{m.herdrupdate_log_label()}</div>
        <pre class="log" bind:this={logEl}>{log.join("\n")}</pre>
      {/if}
    {/if}
    {#if error}<div class="err">{error}</div>{/if}

    <div class="actions">
      {#if done}
        <button type="button" class="later" onclick={() => onclose?.()}>{m.common_close()}</button>
      {:else if !busy}
        <button type="button" class="later" onclick={() => onclose?.()}
          >{m.herdrupdate_later()}</button
        >
      {/if}
      {#if !done}
        <button type="button" class="run" onclick={confirm} disabled={busy}>
          {sessions > 0
            ? m.herdrupdate_confirm({ count: sessions })
            : m.herdrupdate_confirm_plain()}
        </button>
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
    padding: 16px;
  }
  .card {
    position: relative;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 14px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
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
    justify-content: space-between;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-base);
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .summary .versions {
    color: var(--color-amber);
    font-size: var(--fs-xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }
  .notes-label {
    margin-bottom: -8px;
  }
  .notes {
    /* shrinkable flex child: without min-height long release notes refuse to
       shrink below their content and push the actions off-screen */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px 12px;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
    overflow-wrap: anywhere;
  }
  /* raw plain-text fallback (pre-resolve / render failure) */
  .notes-raw {
    margin: 0;
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* markdown rendered via {@html} — children aren't scoped, so target globally */
  .notes :global(> *:first-child) {
    margin-top: 0;
  }
  .notes :global(> *:last-child) {
    margin-bottom: 0;
  }
  .notes :global(p),
  .notes :global(ul),
  .notes :global(ol) {
    margin: 0 0 8px;
  }
  .notes :global(ul),
  .notes :global(ol) {
    padding-left: 18px;
  }
  .notes :global(li) {
    margin: 2px 0;
  }
  .notes :global(h1),
  .notes :global(h2),
  .notes :global(h3),
  .notes :global(h4) {
    margin: 12px 0 6px;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .notes :global(a) {
    color: var(--color-blue);
    text-decoration: underline;
  }
  .notes :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    background: var(--color-line);
    border-radius: 2px;
    padding: 0 3px;
    overflow-wrap: anywhere;
  }
  .notes :global(pre) {
    margin: 0 0 8px;
    padding: 6px 8px;
    background: var(--color-bg, var(--color-line));
    border: 1px solid var(--color-line);
    border-radius: 2px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .notes :global(pre code) {
    background: none;
    padding: 0;
    overflow-wrap: anywhere;
  }
  .notes :global(blockquote) {
    margin: 0 0 8px;
    padding-left: 8px;
    border-left: 2px solid var(--color-line);
    color: var(--color-muted);
  }
  .instructions {
    border: 1px solid var(--color-line-bright);
    background: color-mix(in srgb, var(--color-amber) 8%, transparent);
    padding: 10px 12px;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
  }
  /* destructive-action warning: louder than the neutral instructions block */
  .warning {
    border: 1px solid var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
    padding: 10px 12px;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-red);
  }
  .status {
    color: var(--color-amber);
    font-size: var(--fs-base);
  }
  .status.ok {
    color: var(--color-green, var(--color-amber));
  }
  .status.fail {
    color: var(--color-red);
  }
  .log-label {
    margin-bottom: -8px;
  }
  .log {
    margin: 0;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px 12px;
    font-family: monospace;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-base);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .later {
    background: transparent;
    border: 1px solid var(--color-line-bright);
    color: var(--color-muted);
    padding: 8px 14px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .later:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .run {
    background: transparent;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* phones: rise as a full-height sheet (same pattern as NewTask/UpdateModal)
     so the release notes scroll internally and the actions stay pinned and
     thumb-reachable above the home indicator */
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-height: none;
      height: 100dvh;
      border: 0;
      padding: 16px 16px calc(14px + env(safe-area-inset-bottom));
      animation: sheet-up 0.18s ease-out;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .x {
      min-width: 44px;
      min-height: 44px;
      margin: -14px -14px -10px 0; /* keep the glyph optically in the corner */
    }
    .later,
    .run {
      min-height: 44px;
      flex: 1; /* two thumb-width targets instead of two slivers at the edge */
    }
    .actions {
      margin-top: auto; /* pin to the bottom even when the notes are short */
    }
  }
  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0.6;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
</style>
