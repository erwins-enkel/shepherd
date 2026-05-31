<script lang="ts">
  import type { UpdateStatus } from "$lib/types";
  import { applyUpdate } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  let {
    update,
    updating = false,
    onconfirm,
    onclose,
  }: {
    update: UpdateStatus;
    updating?: boolean;
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();

  let submitting = $state(false);
  let error = $state<string | null>(null);

  async function confirm() {
    submitting = true;
    error = null;
    try {
      await applyUpdate();
      onconfirm?.(); // store marks `updating`; the page reloads once the new build is live
    } catch (e) {
      error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      submitting = false;
    }
  }

  const busy = $derived(submitting || updating);
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !busy) onclose?.();
  }}
>
  <div class="card bracket">
    <div class="chead">
      <span class="micro">{m.updatemodal_available()}</span>
      {#if !busy}
        <button type="button" class="x" onclick={() => onclose?.()} aria-label={m.common_close()}
          >✕</button
        >
      {/if}
    </div>

    <div class="summary">
      <span class="count">{update.behind}</span>
      <span class="micro"
        >{update.behind === 1 ? m.updatemodal_commits_one() : m.updatemodal_commits_other()}</span
      >
      {#if update.current && update.latest}
        <span class="shas micro">{update.current} → {update.latest}</span>
      {/if}
    </div>

    <div class="commits">
      {#each update.commits as c (c.sha)}
        <div class="commit">
          <span class="sha">{c.sha}</span>
          <span class="subject">{c.subject}</span>
        </div>
      {/each}
    </div>

    {#if busy}
      <div class="status">{m.updatemodal_status()}</div>
    {/if}
    {#if error}<div class="err">{error}</div>{/if}

    <div class="actions">
      {#if !busy}
        <button type="button" class="later" onclick={() => onclose?.()}
          >{m.updatemodal_later()}</button
        >
      {/if}
      <button type="button" class="run" onclick={confirm} disabled={busy}>
        {busy ? m.updatemodal_updating() : m.updatemodal_update_now()}
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
  .summary .count {
    color: var(--color-amber);
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .summary .shas {
    margin-left: auto;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .commits {
    overflow-y: auto;
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .commit {
    display: flex;
    gap: 9px;
    align-items: baseline;
    font-size: 12.5px;
  }
  .commit .sha {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .commit .subject {
    color: var(--color-ink-bright);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    color: var(--color-amber);
    font-size: 12px;
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
