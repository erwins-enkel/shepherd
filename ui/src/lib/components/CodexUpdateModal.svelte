<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { CodexReleaseNotesResult, CodexUpdateStatus, CodexUpdateResult } from "$lib/types";
  import { applyCodexUpdate, fetchCodexReleaseNotes } from "$lib/api";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";
  import CodexReleaseNotes from "./CodexReleaseNotes.svelte";

  let {
    update,
    log = [],
    done = null,
    onconfirm,
    onclose,
    loadReleaseNotes = fetchCodexReleaseNotes,
    notesTimeoutMs = 16_000,
  }: {
    update: CodexUpdateStatus;
    log?: string[];
    done?: CodexUpdateResult | null;
    onconfirm?: () => void;
    onclose?: () => void;
    loadReleaseNotes?: (signal: AbortSignal) => Promise<CodexReleaseNotesResult>;
    notesTimeoutMs?: number;
  } = $props();

  let submitting = $state(false);
  let error = $state<string | null>(null);
  let logEl = $state<HTMLPreElement | null>(null);
  let releaseNotes = $state<CodexReleaseNotesResult | null>(null);
  let notesFinished = $state(false);

  const CODEX_RELEASES_URL = "https://github.com/openai/codex/releases";
  const displayedCurrent = $derived(done?.from ?? update.current);
  const displayedLatest = $derived(done?.to ?? update.latest);
  const visibleReleaseNotes = $derived(
    releaseNotes?.current === update.current && releaseNotes?.latest === update.latest
      ? releaseNotes
      : null,
  );

  onMount(() => {
    const controller = new AbortController();
    let alive = true;
    let settled = false;
    const timeout = setTimeout(() => {
      controller.abort();
      if (alive && !settled) notesFinished = true;
    }, notesTimeoutMs);
    loadReleaseNotes(controller.signal)
      .then((result) => {
        if (alive && !controller.signal.aborted) releaseNotes = result;
      })
      .catch(() => {
        if (alive) releaseNotes = null;
      })
      .finally(() => {
        settled = true;
        clearTimeout(timeout);
        if (alive) notesFinished = true;
      });
    return () => {
      alive = false;
      clearTimeout(timeout);
      controller.abort();
    };
  });

  // `codex update` runs server-side in a managed child; shepherd stays up and the
  // modal resolves itself via the `done` result. Busy only while the update is in
  // flight; a terminal `done` ends it so the operator can read the ✓/✗ outcome and close.
  const busy = $derived(submitting && !done);

  async function confirm() {
    submitting = true;
    error = null;
    try {
      await applyCodexUpdate();
      onconfirm?.();
    } catch (e) {
      error = e instanceof Error ? e.message : "update failed";
      submitting = false;
    }
  }

  // Auto-scroll the log pane to bottom whenever new lines arrive.
  $effect(() => {
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
    aria-label={m.codexupdate_title()}
    use:dialog={{ onclose: () => !busy && onclose?.() }}
  >
    <div class="chead">
      <span class="micro">{m.codexupdate_title()}</span>
      <!-- The ✕ is ALWAYS available as a deliberate escape hatch: the install runs
           server-side in a managed child independent of this modal, so dismissing
           never cancels it. A missed `done` event (WS drop) would otherwise trap
           the operator in the busy state. Backdrop/Esc stay gated on !busy. -->
      <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
        >✕</button
      >
    </div>

    {#if displayedCurrent && displayedLatest}
      <div class="summary">
        <span class="versions"
          >{m.codexupdate_versions({
            current: displayedCurrent,
            latest: displayedLatest,
          })}</span
        >
      </div>
    {/if}

    <a class="all-notes" href={CODEX_RELEASES_URL} target="_blank" rel="noopener noreferrer"
      >{m.codexupdate_all_notes_link()} ↗</a
    >

    {#if !submitting}
      <section class="release-history" aria-labelledby="codex-release-notes-heading">
        <h2 id="codex-release-notes-heading" class="micro">{m.codexupdate_notes_heading()}</h2>
        {#if !notesFinished}
          <div class="notes-state" aria-live="polite">{m.codexupdate_notes_loading()}</div>
        {:else}
          {#if visibleReleaseNotes}
            {#each visibleReleaseNotes.notes as note (note.version)}
              <article class="release-note">
                <h3>v{note.version}</h3>
                <CodexReleaseNotes version={note.version} body={note.body} />
              </article>
            {/each}
          {/if}
          {#if !visibleReleaseNotes || !visibleReleaseNotes.complete}
            <div class="notes-state incomplete" aria-live="polite">
              {m.codexupdate_notes_incomplete()}
            </div>
          {/if}
        {/if}
      </section>
    {/if}

    <div class="instructions">{m.codexupdate_instructions()}</div>

    {#if submitting}
      {#if done}
        <div class="status" class:ok={done.ok} class:fail={!done.ok} aria-live="polite">
          {#if done.ok}
            {m.codexupdate_done_ok({ latest: done.to ?? update.latest ?? "" })}
          {:else if done.onPathBinary}
            {m.codexupdate_done_fail_stuck({
              current: done.to ?? update.current ?? "",
              path: done.onPathBinary,
            })}
          {:else}
            {m.codexupdate_done_fail({ current: done.to ?? update.current ?? "" })}
          {/if}
        </div>
      {:else}
        <div class="status" aria-live="polite">{m.codexupdate_busy()}</div>
      {/if}
      {#if log.length > 0}
        <div class="log-label micro">{m.codexupdate_log_label()}</div>
        <pre class="log" bind:this={logEl}>{log.join("\n")}</pre>
      {/if}
    {/if}
    {#if error}<div class="err">{error}</div>{/if}

    <div class="actions">
      {#if done}
        <button type="button" class="later" onclick={() => onclose?.()}>{m.common_close()}</button>
      {:else if !busy}
        <button type="button" class="later" onclick={() => onclose?.()}
          >{m.codexupdate_later()}</button
        >
      {/if}
      {#if !done}
        <button type="button" class="run" onclick={confirm} disabled={busy}>
          {m.codexupdate_confirm()}
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
    box-sizing: border-box;
    width: min(520px, 100%);
    max-height: 80dvh;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-x: clip;
    overflow-y: auto;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    padding: 18px 18px 16px;
    box-shadow: inset 0 0 30px -16px var(--color-blue);
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
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: 0;
    right: 0;
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
    color: var(--color-blue);
    font-size: var(--fs-xl);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }
  .all-notes {
    align-self: flex-start;
    color: var(--color-blue);
    font-size: var(--fs-meta);
    text-decoration: underline;
    letter-spacing: 0.04em;
  }
  .all-notes:hover {
    color: var(--color-amber);
  }
  .instructions {
    border: 1px solid var(--color-line-bright);
    background: color-mix(in srgb, var(--color-blue) 8%, transparent);
    padding: 10px 12px;
    font-size: var(--fs-base);
    line-height: 1.5;
    color: var(--color-ink-bright);
  }
  .release-history {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 48px;
    max-height: 36dvh;
    overflow-y: auto;
    padding: 12px;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
  }
  .release-history h2,
  .release-history h3 {
    margin: 0;
  }
  .release-note {
    padding-top: 10px;
    border-top: 1px solid var(--color-line);
  }
  .release-note h3 {
    margin-bottom: 8px;
    color: var(--color-blue);
    font-size: var(--fs-base);
  }
  .notes-state {
    color: var(--color-muted);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .notes-state.incomplete {
    color: var(--color-warn);
  }
  .status {
    color: var(--color-blue);
    font-size: var(--fs-base);
  }
  .status.ok {
    color: var(--color-green, var(--color-blue));
  }
  .status.fail {
    color: var(--color-red);
  }
  .log-label {
    margin-bottom: -8px;
  }
  .log {
    flex: 1 1 96px;
    margin: 0;
    min-height: 96px;
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
    border: 1px solid var(--color-blue);
    color: var(--color-blue);
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
    box-shadow: inset 0 0 18px -10px var(--color-blue);
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  /* phones: rise as a full-height sheet so the actions stay pinned + thumb-reachable */
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
      padding: calc(16px + env(safe-area-inset-top)) 16px calc(14px + env(safe-area-inset-bottom));
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .x {
      min-width: 44px;
      min-height: 44px;
      margin: -14px -14px -10px 0;
    }
    .later,
    .run {
      min-height: 44px;
      flex: 1;
    }
    .actions {
      margin-top: auto;
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
