<script lang="ts">
  import type { Session } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    sessions,
    leftovers,
    onclose,
    onconfirm,
  }: {
    sessions: Session[];
    /** Total leftover subprocesses across the listed sessions that will be terminated. */
    leftovers: number;
    onclose: () => void;
    /** Clear all listed sessions (worktree + agent + merged branch). */
    onconfirm: () => void;
  } = $props();
</script>

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
    aria-label={m.clearmerged_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.clearmerged_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <p class="desc">{m.clearmerged_desc({ count: sessions.length })}</p>

    <div class="rows">
      {#each sessions as s (s.id)}
        <div class="row">
          <span class="desig">{s.desig}</span>
          <span class="nm">{s.name}</span>
        </div>
      {/each}
    </div>

    {#if leftovers > 0}
      <p class="warn">{m.clearmerged_leftovers({ count: leftovers })}</p>
    {/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={onclose}>{m.common_cancel()}</button>
      <button type="button" class="run" disabled={sessions.length === 0} onclick={onconfirm}>
        {m.clearmerged_confirm({ count: sessions.length })}
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
    z-index: 20;
  }
  .card {
    width: min(440px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
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
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .desc {
    margin: 0;
    color: var(--color-ink);
    font-size: 12.5px;
    line-height: 1.4;
  }
  .rows {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    display: flex;
    flex-direction: column;
    max-height: 200px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-size: 13px;
  }
  .row:last-child {
    border-bottom: 0;
  }
  .desig {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--color-blue);
  }
  .nm {
    font-family: var(--font-mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .warn {
    margin: 0;
    color: var(--color-amber);
    font-size: 11.5px;
    line-height: 1.4;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }
  .ghost,
  .run {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .run {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
  }
</style>
