<script lang="ts">
  import type { BlockedEntry } from "$lib/triage";
  import { m } from "$lib/paraglide/messages";

  let {
    entries,
    nowMs,
    onreply,
    ondismiss,
    onopen,
    onclose,
  }: {
    entries: BlockedEntry[];
    nowMs: number;
    onreply: (id: string, text: string) => void;
    ondismiss: (id: string) => void;
    onopen: (id: string) => void;
    onclose: () => void;
  } = $props();

  let selected = $state<Record<string, boolean>>({});
  let drafts = $state<Record<string, string>>({});
  let batchText = $state("");

  const selectedIds = $derived(
    entries.filter((e) => selected[e.session.id]).map((e) => e.session.id),
  );

  function waited(since: number): string {
    const s = Math.max(0, Math.round((nowMs - since) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  }

  function sendBatch() {
    const t = batchText;
    if (!t) return;
    for (const id of selectedIds) onreply(id, t);
    batchText = "";
    selected = {};
  }
</script>

<aside class="drawer">
  <header>
    <span class="title">{m.common_needs_you({ count: entries.length })}</span>
    <button class="x" onclick={onclose} aria-label={m.triage_close_aria()}>✕</button>
  </header>

  {#if entries.length === 0}
    <p class="empty">{m.triage_empty()}</p>
  {/if}

  {#snippet consoleBtn(id: string, desig: string)}
    <button
      type="button"
      class="to-console"
      onclick={() => onopen(id)}
      aria-label={m.triage_open_console_aria({ desig })}
    >
      ⤢ {m.triage_open_console()}
    </button>
  {/snippet}

  {#each entries as e (e.session.id)}
    <section class="row">
      <div class="head">
        <input
          type="checkbox"
          bind:checked={selected[e.session.id]}
          aria-label={m.triage_checkbox_aria({ desig: e.session.desig })}
        />
        <span class="desig">{e.session.desig}</span>
        <span class="name">{e.session.name}</span>
        <span class="waited">{waited(e.since)}</span>
      </div>

      {#if e.reason.shape === "stall"}
        <div class="stall-head">
          <p class="stall-note">{m.triage_stall_note()}</p>
          <button
            class="dismiss"
            onclick={() => ondismiss(e.session.id)}
            aria-label={m.triage_dismiss_aria({ desig: e.session.desig })}
          >
            {m.triage_dismiss_button()}
          </button>
        </div>
      {/if}

      <pre class="tail">{e.reason.tail.join("\n")}</pre>

      {#if e.reason.shape === "awaiting-input" || e.reason.shape === "stall"}
        <form
          class="reply"
          onsubmit={(ev) => {
            ev.preventDefault();
            const t = drafts[e.session.id] ?? "";
            if (t) onreply(e.session.id, t);
            drafts[e.session.id] = "";
          }}
        >
          <input
            placeholder={m.triage_reply_placeholder()}
            aria-label={m.triage_reply_aria({ desig: e.session.desig })}
            bind:value={drafts[e.session.id]}
          />
          <button type="submit">{m.triage_send_button()}</button>
          {@render consoleBtn(e.session.id, e.session.desig)}
        </form>
      {:else}
        <div class="opts">
          {#each e.reason.options as o (o.send)}
            <button onclick={() => onreply(e.session.id, o.send)}>{o.label}</button>
          {/each}
          {@render consoleBtn(e.session.id, e.session.desig)}
        </div>
      {/if}
    </section>
  {/each}

  {#if selectedIds.length > 1}
    <footer class="batch">
      <span>{m.triage_batch_label({ count: selectedIds.length })}</span>
      <input
        placeholder={m.triage_batch_placeholder()}
        aria-label={m.triage_batch_reply_aria()}
        bind:value={batchText}
      />
      <button onclick={sendBatch}>{m.triage_batch_send({ count: selectedIds.length })}</button>
    </footer>
  {/if}
</aside>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(440px, 100vw);
    height: 100vh;
    background: var(--color-panel);
    border-left: 1px solid var(--color-line-bright);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    overflow-y: auto;
    z-index: 50;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    color: var(--color-red);
    letter-spacing: 0.18em;
    font-size: 12px;
  }
  .x {
    background: none;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    min-width: 40px;
    min-height: 40px;
    font-size: 15px;
  }
  .empty {
    color: var(--color-muted);
    font-size: 13px;
  }
  .row {
    border: 1px solid var(--color-line);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .desig {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .name {
    color: var(--color-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .waited {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .stall-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .stall-note {
    margin: 0;
    color: var(--color-amber);
    font-size: 12px;
    flex: 1;
  }
  .dismiss {
    min-height: 32px;
    padding: 4px 10px;
    font-size: 12px;
    color: var(--color-muted);
  }
  .tail {
    margin: 0;
    padding: 8px;
    background: var(--color-inset);
    color: var(--color-term-fg);
    border: 1px solid var(--color-line);
    font-size: 11.5px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 160px;
    overflow-y: auto;
  }
  .opts,
  .reply,
  .batch {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  button {
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    padding: 6px 12px;
    cursor: pointer;
  }
  /* reply / option / batch controls are the drawer's primary actions and the
     drawer goes full-screen on phones — keep them finger-sized (≥40px) */
  .opts button,
  .reply button,
  .reply input,
  .batch button,
  .batch input {
    min-height: 40px;
  }
  /* secondary action: jump into this session's full console (with the
     ↑↓←→/Esc/Ctrl bar) — the inline reply only covers one-liners */
  .to-console {
    flex: 0 0 auto;
    background: transparent;
    border-color: var(--color-line-bright);
    color: var(--color-muted);
    white-space: nowrap;
  }
  .to-console:active {
    background: var(--color-line);
    color: var(--color-ink-bright);
  }
  input {
    flex: 1;
    min-width: 120px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    padding: 6px 8px;
  }
  .batch {
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
    font-size: 12px;
    color: var(--color-muted);
  }
</style>
