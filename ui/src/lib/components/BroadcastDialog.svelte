<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { Session } from "$lib/types";
  import { steers } from "$lib/steers.svelte";
  import { broadcast as apiBroadcast } from "$lib/api";
  import { m } from "$lib/paraglide/messages";

  let { sessions, onclose }: { sessions: Session[]; onclose: () => void } = $props();

  let selected = new SvelteSet<string>();
  let text = $state("");
  let sending = $state(false);
  let result = $state<string | null>(null);

  const allSelected = $derived(sessions.length > 0 && selected.size === sessions.length);
  const canSend = $derived(text.trim().length > 0 && selected.size > 0 && !sending);

  function toggle(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
  function toggleAll() {
    if (allSelected) {
      selected.clear();
    } else {
      for (const s of sessions) selected.add(s.id);
    }
  }

  async function send() {
    if (!canSend) return;
    sending = true;
    result = null;
    try {
      const r = await apiBroadcast(text.trim(), [...selected]);
      result = m.broadcast_result_sent({ sent: r.sent, total: r.total });
      setTimeout(onclose, 800);
    } catch {
      result = m.broadcast_failed();
      sending = false;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div class="card">
    <div class="chead">
      <span class="micro">{m.broadcast_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <div class="row-head">
      <span class="micro">{m.broadcast_targets()}</span>
      <button type="button" class="link" onclick={toggleAll}>
        {allSelected ? m.broadcast_clear_all() : m.broadcast_select_all()}
      </button>
    </div>
    <div class="targets">
      {#if sessions.length === 0}
        <div class="placeholder">{m.broadcast_no_sessions()}</div>
      {:else}
        {#each sessions as s (s.id)}
          <label class="target">
            <input type="checkbox" checked={selected.has(s.id)} onchange={() => toggle(s.id)} />
            <span class="nm">{s.name}</span>
          </label>
        {/each}
      {/if}
    </div>

    <span class="micro">{m.broadcast_steer()}</span>
    <div class="picks">
      {#each steers.list as s (s.id)}
        <button
          type="button"
          class="pick"
          class:on={text === s.text}
          onclick={() => (text = s.text)}
        >
          {s.label}
        </button>
      {/each}
    </div>
    <textarea bind:value={text} rows="2" placeholder={m.broadcast_placeholder()}></textarea>

    {#if result}<div class="result">{result}</div>{/if}

    <button class="run" type="button" disabled={!canSend} onclick={send}>
      {sending ? m.broadcast_sending() : m.broadcast_send_to({ count: selected.size })}
    </button>
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
    z-index: 20;
  }
  .card {
    width: min(460px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  .row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .link {
    background: transparent;
    border: 0;
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .targets {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .target {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-size: 13px;
    cursor: pointer;
  }
  .target:last-child {
    border-bottom: 0;
  }
  .placeholder {
    padding: 14px 12px;
    color: var(--color-faint);
    font-size: 11.5px;
  }
  .picks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pick {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font: inherit;
    font-size: 12px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .pick.on {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  textarea {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 13px;
    padding: 8px;
    resize: vertical;
  }
  .result {
    color: var(--color-amber);
    font-size: 11.5px;
  }
  .run {
    margin-top: 4px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
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
