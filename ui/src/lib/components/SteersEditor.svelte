<script lang="ts">
  import { onMount } from "svelte";
  import { steers } from "$lib/steers.svelte";
  import type { Steer } from "$lib/types";

  let draft = $state<Steer[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);

  function syncFromStore() {
    draft = steers.list.map((s) => ({ ...s }));
  }

  onMount(async () => {
    if (!steers.loaded) await steers.load();
    syncFromStore();
  });

  function add() {
    draft = [...draft, { id: crypto.randomUUID(), label: "", text: "" }];
    saved = false;
  }
  function remove(id: string) {
    draft = draft.filter((s) => s.id !== id);
    saved = false;
  }

  const valid = $derived(
    draft.length <= 40 && draft.every((s) => s.label.trim() !== "" && s.text.trim() !== ""),
  );

  async function save() {
    if (!valid || saving) return;
    saving = true;
    error = null;
    try {
      await steers.save(draft.map((s) => ({ ...s, label: s.label.trim(), text: s.text.trim() })));
      syncFromStore();
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to save";
    } finally {
      saving = false;
    }
  }
</script>

<div class="editor">
  <span class="micro">Saved&nbsp;Steers</span>
  <div class="rows">
    {#each draft as s (s.id)}
      <div class="srow">
        <input
          class="label"
          bind:value={s.label}
          placeholder="label"
          oninput={() => (saved = false)}
        />
        <input
          class="text"
          bind:value={s.text}
          placeholder="prompt text"
          oninput={() => (saved = false)}
        />
        <button type="button" class="del" aria-label="delete steer" onclick={() => remove(s.id)}
          >✕</button
        >
      </div>
    {/each}
    {#if draft.length === 0}
      <div class="placeholder">no steers yet</div>
    {/if}
  </div>

  {#if error}<div class="err">{error}</div>{/if}

  <div class="actions">
    <button type="button" class="add" onclick={add} disabled={draft.length >= 40}>+ Add</button>
    <button type="button" class="save" disabled={!valid || saving} onclick={save}>
      {saving ? "Saving…" : saved ? "Saved ✓" : "Save steers"}
    </button>
  </div>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
  }
  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .srow {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .srow input {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 12.5px;
    padding: 6px 8px;
  }
  .srow .label {
    flex: 0 0 34%;
    min-width: 0;
  }
  .srow .text {
    flex: 1;
    min-width: 0;
  }
  .del {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    padding: 6px 8px;
  }
  .placeholder {
    color: var(--color-faint);
    font-size: 11.5px;
    padding: 6px 2px;
  }
  .err {
    color: var(--color-red);
    font-size: 11.5px;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .add,
  .save {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 8px 12px;
    cursor: pointer;
  }
  .save {
    margin-left: auto;
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .save:disabled,
  .add:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @media (max-width: 768px) {
    .add,
    .save,
    .del {
      min-height: 40px;
    }
  }
</style>
