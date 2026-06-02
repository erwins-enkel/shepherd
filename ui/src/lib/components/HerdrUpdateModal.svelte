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
    onconfirm,
    onclose,
  }: {
    update: HerdrUpdateStatus;
    sessions?: number;
    log?: string[];
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();

  let submitting = $state(false);
  let error = $state<string | null>(null);
  let logEl = $state<HTMLPreElement | null>(null);

  // herdr update restarts herdr (ending live panes) then restarts shepherd; the
  // store auto-reconnects once the new build is live, so we just hold the busy state.
  const busy = $derived(submitting);

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
      {#if !busy}
        <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
          >✕</button
        >
      {/if}
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
      <pre class="notes">{update.notes}</pre>
    {/if}

    <div class="instructions">{m.herdrupdate_instructions()}</div>

    {#if sessions > 0}
      <div class="warning">{m.herdrupdate_warning({ count: sessions })}</div>
    {/if}

    {#if busy}
      <div class="status" aria-live="polite">{m.herdrupdate_busy()}</div>
      {#if log.length > 0}
        <div class="log-label micro">{m.herdrupdate_log_label()}</div>
        <pre class="log" bind:this={logEl} aria-live="polite">{log.join("\n")}</pre>
      {/if}
    {/if}
    {#if error}<div class="err">{error}</div>{/if}

    <div class="actions">
      {#if !busy}
        <button type="button" class="later" onclick={() => onclose?.()}
          >{m.herdrupdate_later()}</button
        >
      {/if}
      <button type="button" class="run" onclick={confirm} disabled={busy}>
        {sessions > 0 ? m.herdrupdate_confirm({ count: sessions }) : m.herdrupdate_confirm_plain()}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(3, 6, 5, 0.66);
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
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font-size: 13px;
  }
  .summary {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }
  .summary .versions {
    color: var(--color-amber);
    font-size: 20px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }
  .notes-label {
    margin-bottom: -8px;
  }
  .notes {
    margin: 0;
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 10px 12px;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--color-ink-bright);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .instructions {
    border: 1px solid var(--color-line-bright);
    background: color-mix(in srgb, var(--color-amber) 8%, transparent);
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--color-ink-bright);
  }
  /* destructive-action warning: louder than the neutral instructions block */
  .warning {
    border: 1px solid var(--color-red);
    background: color-mix(in srgb, var(--color-red) 12%, transparent);
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--color-red);
  }
  .status {
    color: var(--color-amber);
    font-size: 12px;
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
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--color-ink-bright);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .err {
    color: var(--color-red);
    font-size: 12px;
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
    background: var(--color-amber);
    border: 1px solid var(--color-amber);
    color: #0c100f;
    font-weight: 600;
    padding: 8px 16px;
    cursor: pointer;
    letter-spacing: 0.06em;
  }
  .run:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
