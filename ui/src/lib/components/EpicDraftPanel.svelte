<script lang="ts">
  import type { EpicDraftChild } from "$lib/types";
  import { epicDrafts } from "$lib/epic-draft.svelte";
  import { approveEpicDraft, replySession, archiveSession } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { m } from "$lib/paraglide/messages";
  import EpicDraftChildRow from "$lib/components/EpicDraftChildRow.svelte";

  let {
    sessionId,
    epicAuthoring,
    sessionLive,
  }: {
    sessionId: string;
    /** Whether this session is an epic-authoring session (drives whether the panel shows). */
    epicAuthoring: boolean;
    /** Whether the session process is still live (Amend steers it; disabled when it has ended). */
    sessionLive: boolean;
  } = $props();

  // Load the draft once when the panel mounts / the session changes (survives a page reload);
  // WS `session:epic-draft` events keep it fresh thereafter.
  $effect(() => {
    if (epicAuthoring) void epicDrafts.load(sessionId);
  });

  const draft = $derived(epicDrafts.get(sessionId) ?? null);
  const visible = $derived(epicAuthoring || draft !== null);
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

{#if visible}
  <div
    class="edp"
    class:is-awaiting={awaiting}
    role="region"
    aria-label={m.epicdraft_panel_title()}
  >
    <div class="edp-head">
      <span class="edp-title">{m.epicdraft_panel_title()}</span>
      {#if statusChip}
        <span
          class="edp-chip"
          class:edp-chip-awaiting={awaiting}
          class:edp-chip-busy={status === "materializing"}
          class:edp-chip-done={status === "approved"}
        >
          {#if awaiting}<span class="edp-dot" aria-hidden="true"></span>{/if}{statusChip}
        </span>
      {/if}
    </div>

    {#if !draft || children.length === 0}
      <p class="edp-empty">{m.epicdraft_empty()}</p>
    {:else}
      {#if awaiting}
        <p class="edp-hint">{m.epicdraft_awaiting_hint()}</p>
      {:else if status === "materializing"}
        <p class="edp-note">{m.epicdraft_materializing_note()}</p>
      {:else if status === "approved"}
        <p class="edp-note edp-note-done">
          {m.epicdraft_created()}
          {#if draft.parentUrl && draft.parentNumber != null}
            <span aria-hidden="true">·</span>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL -->
            <a class="edp-link" href={draft.parentUrl} target="_blank" rel="noopener noreferrer"
              >{m.epicdraft_view_parent({ n: draft.parentNumber })}</a
            >
          {/if}
        </p>
      {/if}

      <!-- Parent -->
      <section class="edp-parent">
        <span class="edp-section-label">{m.epicdraft_parent_label()}</span>
        <h4 class="edp-parent-title">{draft.parent.title}</h4>
        {#if draft.parent.body}<p class="edp-body">{draft.parent.body}</p>{/if}
        {#if draft.parent.acceptanceCriteria.length}
          <span class="edp-sub-label">{m.epicdraft_acceptance_label()}</span>
          <ul class="edp-crit">
            {#each draft.parent.acceptanceCriteria as c, i (i)}<li>{c}</li>{/each}
          </ul>
        {/if}
        {#if draft.parent.nonGoals.length}
          <span class="edp-sub-label">{m.epicdraft_nongoals_label()}</span>
          <ul class="edp-crit">
            {#each draft.parent.nonGoals as g, i (i)}<li>{g}</li>{/each}
          </ul>
        {/if}
      </section>

      <!-- Children (dependency DAG rendered as an ordered list with blocked-by annotations) -->
      <section class="edp-children">
        <span class="edp-section-label"
          >{m.epicdraft_children_label({ count: children.length })}</span
        >
        <ol class="edp-list">
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

      {#if awaiting}
        <div class="edp-amend">
          <input
            class="edp-amend-input"
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
            class="edp-btn"
            disabled={!sessionLive || !amendText.trim()}
            onclick={() => void sendAmend()}>{m.epicdraft_amend_send()}</button
          >
        </div>
        <div class="edp-footer">
          <button
            type="button"
            class="edp-btn edp-abort"
            class:is-armed={abortArmed}
            onclick={() => void abort()}
            onmouseleave={() => (abortArmed = false)}
            onblur={() => (abortArmed = false)}
            >{abortArmed ? m.epicdraft_abort_confirm() : m.epicdraft_abort()}</button
          >
          <button
            type="button"
            class="edp-btn edp-approve"
            disabled={approving}
            onclick={() => void approve()}
          >
            <span class="edp-approve-glyph" aria-hidden="true">▸</span>
            {approving ? m.epicdraft_approving() : m.epicdraft_approve()}
          </button>
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .edp {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    background: var(--color-panel);
    border-top: 1px solid var(--color-line);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
  }
  .is-awaiting {
    background: color-mix(in oklab, var(--color-amber) 6%, var(--color-panel));
  }

  .edp-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .edp-title {
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .edp-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .edp-chip-awaiting {
    color: var(--color-amber);
  }
  .edp-chip-busy {
    color: var(--color-faint);
  }
  .edp-chip-done {
    color: var(--status-done);
  }
  .edp-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-amber);
  }

  .edp-empty,
  .edp-note {
    margin: 0;
    color: var(--color-faint);
    font-size: var(--fs-micro);
  }
  .edp-note-done {
    color: var(--status-done);
  }
  .edp-link {
    color: var(--color-accent);
  }

  .edp-hint {
    margin: 0;
    padding: 5px 8px;
    border: 1px solid color-mix(in oklab, var(--color-amber) 30%, transparent);
    border-radius: 3px;
    background: color-mix(in oklab, var(--color-amber) 10%, transparent);
    color: var(--color-ink-bright);
    font-size: var(--fs-micro);
    line-height: 1.45;
  }

  .edp-parent,
  .edp-children {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .edp-section-label,
  .edp-sub-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .edp-sub-label {
    margin-top: 3px;
    color: var(--color-faint);
  }
  .edp-parent-title {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .edp-body {
    margin: 0;
    color: var(--color-muted);
    font-size: var(--fs-micro);
    line-height: 1.45;
    white-space: pre-wrap;
  }
  .edp-crit {
    margin: 0;
    padding-left: 16px;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  .edp-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 40vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
  }
  .edp-amend {
    display: flex;
    gap: 6px;
    padding-top: 2px;
  }
  .edp-amend-input {
    flex: 1;
    min-width: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-micro);
    padding: 2px 6px;
    outline: none;
  }
  .edp-amend-input:focus {
    border-color: var(--color-amber);
  }
  .edp-amend-input:disabled {
    opacity: 0.5;
  }

  .edp-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 2px;
  }

  .edp-btn {
    background: none;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-micro);
    padding: 2px 8px;
    cursor: pointer;
    line-height: 1.4;
  }
  .edp-btn:hover:not(:disabled),
  .edp-btn:focus-visible:not(:disabled) {
    color: var(--color-ink-bright);
    border-color: var(--color-ink);
  }
  .edp-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .edp-abort {
    margin-right: auto;
  }
  .edp-abort:hover:not(:disabled),
  .edp-abort.is-armed {
    color: var(--color-red);
    border-color: var(--color-red);
  }

  .edp-approve {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--color-amber);
    border-color: var(--color-amber);
    font-weight: 600;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .edp-approve:hover:not(:disabled),
  .edp-approve:focus-visible:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
    box-shadow:
      inset 0 0 0 1px var(--color-amber),
      inset 0 0 22px -8px var(--color-amber);
  }
  .edp-approve-glyph {
    font-size: var(--fs-micro);
    line-height: 1;
  }
</style>
