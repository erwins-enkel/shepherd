<script lang="ts">
  import type { EpicDraftChild } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { epicDrafts } from "$lib/epic-draft.svelte";
  import { approveEpicDraft, replySession, archiveSession } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import EpicDraftChildRow from "$lib/components/EpicDraftChildRow.svelte";

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

  const titleByKey = $derived(new Map(children.map((c) => [c.key, c.title])));
  function blockedLabel(child: EpicDraftChild): string {
    return child.blockedBy.map((k) => titleByKey.get(k) ?? k).join(", ");
  }

  let approving = $state(false);
  let abortArmed = $state(false);
  let amendText = $state("");

  async function approve() {
    if (approving) return;
    approving = true;
    try {
      const r = await approveEpicDraft(sessionId);
      toasts.info(m.epicdraft_approve_success({ n: r.parentNumber }));
    } catch (e) {
      toasts.info(e instanceof Error ? e.message : m.epicdraft_approve_failed(), {
        key: `epicdraft-approve-${sessionId}`,
        sticky: true,
        alert: true,
      });
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
      <div class="body">
        {#if awaiting}
          <p class="hint">{m.epicdraft_awaiting_hint()}</p>
        {/if}

        <!-- Parent -->
        <section class="parent">
          <span class="section-label">{m.epicdraft_parent_label()}</span>
          <h4 class="parent-title">{draft.parent.title}</h4>
          {#if draft.parent.body}<p class="parent-body">{draft.parent.body}</p>{/if}
          {#if draft.parent.acceptanceCriteria.length}
            <span class="sub-label">{m.epicdraft_acceptance_label()}</span>
            <ul class="crit">
              {#each draft.parent.acceptanceCriteria as c, i (i)}<li>{c}</li>{/each}
            </ul>
          {/if}
          {#if draft.parent.nonGoals.length}
            <span class="sub-label">{m.epicdraft_nongoals_label()}</span>
            <ul class="crit">
              {#each draft.parent.nonGoals as g, i (i)}<li>{g}</li>{/each}
            </ul>
          {/if}
        </section>

        <!-- Children (dependency DAG rendered as an ordered list with blocked-by annotations) -->
        <section class="children">
          <span class="section-label">{m.epicdraft_children_label({ count: children.length })}</span
          >
          <ol class="list">
            {#each children as child, i (child.key)}
              <EpicDraftChildRow
                {child}
                index={i}
                materializedNumber={draft.materializedChildren[child.key] ?? null}
                blockedLabel={blockedLabel(child)}
              />
            {/each}
          </ol>
        </section>
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
            <button
              type="button"
              class="btn approve"
              disabled={approving}
              onclick={() => void approve()}
            >
              <span class="approve-glyph" aria-hidden="true">▸</span>
              {approving ? m.epicdraft_approving() : m.epicdraft_approve()}
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
    width: min(760px, 100%);
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

  .hint {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid color-mix(in oklab, var(--color-amber) 30%, transparent);
    border-radius: 3px;
    background: color-mix(in oklab, var(--color-amber) 10%, transparent);
    color: var(--color-ink-bright);
    font-size: var(--fs-base);
    line-height: 1.5;
  }

  .parent,
  .children {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .section-label,
  .sub-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .sub-label {
    margin-top: 4px;
    color: var(--color-faint);
  }
  .parent-title {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .parent-body {
    margin: 0;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .crit {
    margin: 0;
    padding-left: 18px;
    color: var(--color-ink);
    font-size: var(--fs-base);
    line-height: 1.5;
  }

  .list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
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
    align-items: center;
    gap: 10px;
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
