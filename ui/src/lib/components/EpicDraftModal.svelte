<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { dialog } from "$lib/a11yDialog";
  import { epicDrafts } from "$lib/epic-draft.svelte";
  import { replySession, archiveSession } from "$lib/api";
  import { approveEpic } from "$lib/epic-approve";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import { childWaves, splitMarkdownSections } from "$lib/epic-draft-outline";
  import EpicDraftToc from "$lib/components/EpicDraftToc.svelte";
  import EpicDraftDocument from "$lib/components/EpicDraftDocument.svelte";

  let {
    sessionId,
    sessionLive,
    onclose,
  }: {
    sessionId: string;
    /** Whether the session process is still live (Amend steers it; disabled when it has ended). */
    sessionLive: boolean;
    onclose: () => void;
  } = $props();

  // Read the store directly (rather than taking the draft as a prop) so the dialog follows the WS
  // `session:epic-draft` events live: on Approve it walks draft → materializing → approved under
  // our feet, and the footer swaps to the parent link without the dialog closing.
  const draft = $derived(epicDrafts.get(sessionId) ?? null);
  const status = $derived(draft?.status ?? null);
  const children = $derived(draft?.children ?? []);
  const awaiting = $derived(status === "draft" && children.length > 0);

  // The parent body is the agent's Markdown: split at its headings so every part gets an anchor and
  // a table-of-contents entry, then render each part instead of printing raw `##`/`**`.
  const sections = $derived(splitMarkdownSections(draft?.parent.body ?? ""));
  const waves = $derived(childWaves(children));

  let bodyEl = $state<HTMLElement | null>(null);
  function jump(anchor: string) {
    bodyEl
      ?.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`)
      ?.scrollIntoView({ block: "start" });
  }

  // Seen marks: a child counts as seen once half its row has stayed on screen for a moment, so
  // scrolling past (or the rows showing before the Markdown above them has loaded) doesn't count.
  // A review aid, not a gate — an amended draft (new children array) starts over.
  const SEEN_DWELL_MS = 800;
  const seen = new SvelteSet<string>();
  $effect(() => {
    const root = bodyEl;
    void children;
    seen.clear();
    if (!root) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- timer bookkeeping, never rendered
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.childKey;
          if (!key) continue;
          clearTimeout(pending.get(key));
          pending.delete(key);
          if (e.isIntersecting)
            pending.set(
              key,
              setTimeout(() => seen.add(key), SEEN_DWELL_MS),
            );
        }
      },
      { root, threshold: 0.5 },
    );
    for (const row of root.querySelectorAll("[data-child-key]")) observer.observe(row);
    return () => {
      observer.disconnect();
      for (const timer of pending.values()) clearTimeout(timer);
    };
  });

  let approving = $state(false);
  let abortArmed = $state(false);
  let amendText = $state("");

  async function approve() {
    if (approving) return;
    // Capture the session: this dialog can close (and Viewport closes it on a session switch) long
    // before a ~25s materialize returns. approveEpic owns the outcome from here — it lives outside
    // the component tree precisely so the result is still reported if this modal is gone.
    const sid = sessionId;
    approving = true;
    try {
      await approveEpic(sid);
    } finally {
      approving = false;
    }
  }

  async function sendAmend() {
    const text = amendText.trim();
    if (!text || !sessionLive) return;
    try {
      await replySession(sessionId, text);
      amendText = "";
      toasts.info(m.epicdraft_amend_sent());
    } catch {
      toasts.info(m.epicdraft_amend_failed(), {
        key: `epicdraft-amend-${sessionId}`,
        sticky: true,
        alert: true,
      });
    }
  }

  async function abort() {
    if (!abortArmed) {
      abortArmed = true;
      return;
    }
    try {
      await archiveSession(sessionId);
    } catch {
      toasts.info(m.epicdraft_abort_failed(), {
        key: `epicdraft-abort-${sessionId}`,
        sticky: true,
        alert: true,
      });
    }
  }

  const statusChip = $derived(
    status === "approved"
      ? m.epicdraft_status_approved()
      : status === "materializing"
        ? m.epicdraft_status_materializing()
        : awaiting
          ? m.epicdraft_awaiting_chip()
          : "",
  );
</script>

<!-- Blocking review dialog. Two things about `class="overlay"` are load-bearing, so don't rename it
     and don't drop the scoped rule below:
       • the scoped .overlay rule supplies position/scrim/z-index; the global app.css .overlay rule
         only layers the blur (same split as DiagnoseRows.svelte:149).
       • Viewport's shouldForwardEscape stands down on `querySelector(".overlay, .drawer")` — under
         any other class name a desktop Escape would be forwarded into the PTY instead of closing
         this dialog, and +page's anyOverlayOpen() would let j/k/n/r fire behind it. -->
<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="card"
    role="dialog"
    aria-modal="true"
    aria-label={m.epicdraft_panel_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.epicdraft_panel_title()}</span>
      {#if statusChip}
        <span
          class="chip"
          class:chip-awaiting={awaiting}
          class:chip-busy={status === "materializing"}
          class:chip-done={status === "approved"}
        >
          {#if awaiting}<span class="dot" aria-hidden="true"></span>{/if}{statusChip}
        </span>
      {/if}
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    {#if !draft || children.length === 0}
      <p class="empty">{m.epicdraft_empty()}</p>
    {:else}
      <!-- The body is the dialog's only scroller. On a wide card it becomes two columns: a sticky
           table of contents (with the approve outcome) beside the rendered draft. -->
      <div class="body" bind:this={bodyEl}>
        <EpicDraftToc
          {sections}
          hasAcceptance={draft.parent.acceptanceCriteria.length > 0}
          hasNonGoals={draft.parent.nonGoals.length > 0}
          {children}
          {waves}
          {seen}
          showOutcome={awaiting}
          onjump={jump}
        />
        <EpicDraftDocument {draft} {sections} {waves} {awaiting} onjump={jump} />
      </div>

      <!-- Footer: pinned, never scrolls away. While the draft awaits review it carries the actions;
           once Approve is fired the dialog STAYS OPEN and this swaps to the progress note, then to
           the parent-issue link — auto-closing would yank that link away the instant it appears. -->
      <div class="actions">
        {#if awaiting}
          <div class="amend">
            <input
              class="amend-input"
              type="text"
              bind:value={amendText}
              disabled={!sessionLive}
              placeholder={sessionLive
                ? m.epicdraft_amend_placeholder()
                : m.epicdraft_amend_offline()}
              aria-label={m.epicdraft_amend_placeholder()}
              onkeydown={(e) => {
                if (e.key === "Enter") void sendAmend();
              }}
            />
            <button
              type="button"
              class="btn"
              disabled={!sessionLive || !amendText.trim()}
              onclick={() => void sendAmend()}>{m.epicdraft_amend_send()}</button
            >
          </div>
          <div class="footer-row">
            <button
              type="button"
              class="btn abort"
              class:is-armed={abortArmed}
              onclick={() => void abort()}
              onmouseleave={() => (abortArmed = false)}
              onblur={() => (abortArmed = false)}
              >{abortArmed ? m.epicdraft_abort_confirm() : m.epicdraft_abort()}</button
            >
            <span class="seen-progress"
              >{m.epicdraft_seen_progress({ seen: seen.size, total: children.length })}</span
            >
            <button
              type="button"
              class="btn approve"
              disabled={approving}
              onclick={() => void approve()}
            >
              <span class="approve-glyph" aria-hidden="true">▸</span>
              {approving
                ? m.epicdraft_approving()
                : m.epicdraft_approve_count({ count: children.length + 1 })}
            </button>
          </div>
        {:else if status === "materializing"}
          <p class="note" aria-live="polite">{m.epicdraft_materializing_note()}</p>
        {:else if status === "approved"}
          <p class="note note-done" aria-live="polite">
            {m.epicdraft_created()}
            {#if draft.parentUrl && draft.parentNumber != null}
              <span aria-hidden="true">·</span>
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
              <a class="link" href={draft.parentUrl} target="_blank" rel="noopener noreferrer"
                >{m.epicdraft_view_parent({ n: draft.parentNumber })}</a
              >
            {/if}
          </p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Scoped half of the backdrop — position, scrim and stacking. The global app.css `.overlay`
     rule contributes the blur only, so this block is NOT redundant (see the comment on the
     element above, and DiagnoseRows.svelte:149). */
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
    padding: 16px;
  }
  .card {
    box-sizing: border-box;
    width: min(1240px, 100%);
    container-type: inline-size;
    max-height: 90dvh;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 14px 16px 12px;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
  }

  .chead {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    margin-left: auto;
    min-width: 44px;
    min-height: 44px;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: var(--fs-lg);
  }
  .x:hover,
  .x:focus-visible {
    color: var(--color-amber);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .chip-awaiting {
    color: var(--color-amber);
  }
  .chip-busy {
    color: var(--color-faint);
  }
  .chip-done {
    color: var(--status-done);
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
  }

  /* The dialog's only scroller. The card is a flex column, so min-height:0 is what lets this
     shrink below its content and keeps the pinned footer on screen. */
  .body {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
  }
  @container (min-width: 880px) {
    .body {
      display: grid;
      grid-template-columns: 232px minmax(0, 1fr);
      column-gap: 32px;
      align-items: start;
    }
  }

  .empty,
  .note {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-base);
  }
  .note-done {
    color: var(--status-done);
  }
  .link {
    color: var(--color-accent);
  }

  .actions {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--color-line);
  }
  .amend {
    display: flex;
    gap: 8px;
  }
  .amend-input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    padding: 4px 8px;
    outline: none;
  }
  .amend-input:focus {
    border-color: var(--color-amber);
  }
  .amend-input:disabled {
    opacity: 0.5;
  }

  .footer-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }
  .seen-progress {
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }

  .btn {
    min-height: 44px;
    background: none;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-base);
    padding: 4px 14px;
    cursor: pointer;
    line-height: 1.4;
  }
  .btn:hover:not(:disabled),
  .btn:focus-visible:not(:disabled) {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .abort {
    margin-right: auto;
  }
  .abort:hover:not(:disabled),
  .abort.is-armed {
    color: var(--color-red);
    border-color: var(--color-red);
  }

  .approve {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--color-amber);
    border-color: var(--color-amber);
    font-weight: 600;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .approve:hover:not(:disabled),
  .approve:focus-visible:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 22px -8px var(--color-amber);
  }
  .approve-glyph {
    font-size: var(--fs-meta);
    line-height: 1;
  }
</style>
