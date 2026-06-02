<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import type { Leftover } from "$lib/types";
  import { dialog } from "$lib/a11yDialog";
  import { m } from "$lib/paraglide/messages";

  let {
    leftovers,
    onclose,
    onconfirm,
  }: {
    leftovers: Leftover[];
    /** Close the session only — leave everything running. */
    onclose: () => void;
    /** Terminate the checked leftovers, then close. */
    onconfirm: (keys: string[]) => void;
  } = $props();

  // Track de-selection (empty = everything checked) so "terminate & close" cleans
  // up the lot by default; tracking the negative avoids seeding state from a prop.
  let deselected = new SvelteSet<string>();
  const checkedKeys = $derived(leftovers.filter((l) => !deselected.has(l.key)).map((l) => l.key));

  function toggle(key: string) {
    if (deselected.has(key)) deselected.delete(key);
    else deselected.add(key);
  }
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
    aria-label={m.leftover_title()}
    use:dialog={{ onclose }}
  >
    <div class="chead">
      <span class="micro">{m.leftover_title()}</span>
      <button type="button" class="x" onclick={onclose} aria-label={m.common_close()}>✕</button>
    </div>

    <p class="desc">{m.leftover_desc()}</p>

    <div class="rows">
      {#each leftovers as l (l.key)}
        <label class="row">
          <input type="checkbox" checked={!deselected.has(l.key)} onchange={() => toggle(l.key)} />
          <span class="nm">{l.name}</span>
          {#if l.port != null}<span class="port">{m.leftover_port({ port: l.port })}</span>{/if}
        </label>
      {/each}
    </div>

    <div class="actions">
      <button type="button" class="ghost" onclick={onclose}>{m.leftover_close_only()}</button>
      <button
        type="button"
        class="run"
        disabled={checkedKeys.length === 0}
        onclick={() => onconfirm(checkedKeys)}
      >
        {m.leftover_terminate()}
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
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-size: 13px;
    cursor: pointer;
  }
  .row:last-child {
    border-bottom: 0;
  }
  .nm {
    font-family: var(--font-mono, monospace);
  }
  .port {
    margin-left: auto;
    color: var(--color-muted);
    font-size: 11.5px;
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
