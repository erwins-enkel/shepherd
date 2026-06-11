<script lang="ts">
  import { onMount } from "svelte";
  import { flip } from "svelte/animate";
  import { dragHandleZone, dragHandle } from "svelte-dnd-action";
  import type { DndEvent } from "svelte-dnd-action";
  import { steers } from "$lib/steers.svelte";
  import EmojiPicker from "$lib/components/EmojiPicker.svelte";
  import type { Steer } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  const flipDurationMs = 150;

  let draft = $state<Steer[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  // steer id whose emoji picker is open; null = closed
  let pickerFor = $state<string | null>(null);

  function reorder(e: CustomEvent<DndEvent<Steer>>) {
    draft = e.detail.items;
    saved = false;
  }

  function syncFromStore() {
    draft = steers.list.map((s) => ({ ...s }));
  }

  onMount(async () => {
    if (!steers.loaded) await steers.load();
    syncFromStore();
  });

  function add() {
    draft = [
      ...draft,
      { id: crypto.randomUUID(), label: "", text: "", inSteerBar: true, onIssues: false },
    ];
    saved = false;
  }
  function remove(id: string) {
    draft = draft.filter((s) => s.id !== id);
    if (pickerFor === id) pickerFor = null;
    saved = false;
  }
  function pickEmoji(s: Steer, emoji: string | null) {
    s.emoji = emoji ?? undefined;
    pickerFor = null;
    saved = false;
  }
  function toggleScope(s: Steer, key: "inSteerBar" | "onIssues") {
    s[key] = !s[key];
    saved = false;
  }

  // A steer with both surfaces off renders nowhere (bar, issues, broadcast) — block
  // the save and point at it rather than persisting an invisible entry.
  const scopeless = $derived(draft.some((s) => !s.inSteerBar && !s.onIssues));
  const valid = $derived(
    draft.length <= 40 &&
      !scopeless &&
      draft.every((s) => s.label.trim() !== "" && s.text.trim() !== ""),
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
      error = e instanceof Error ? e.message : m.steerseditor_save_failed();
    } finally {
      saving = false;
    }
  }
</script>

<div class="editor">
  <span class="micro">{m.steerseditor_title()}</span>
  <p class="hint">{m.steerseditor_hint()}</p>
  <div
    class="rows"
    use:dragHandleZone={{ items: draft, flipDurationMs }}
    onconsider={reorder}
    onfinalize={reorder}
  >
    {#each draft as s (s.id)}
      <div class="srow" animate:flip={{ duration: flipDurationMs }}>
        <span
          class="grip"
          use:dragHandle
          aria-label={m.steerseditor_reorder_aria()}
          title={m.steerseditor_reorder_aria()}>⠿</span
        >
        <button
          type="button"
          class="emoji-btn"
          class:unset={!s.emoji}
          aria-label={m.steerseditor_emoji_aria()}
          title={m.steerseditor_emoji_aria()}
          onclick={() => (pickerFor = pickerFor === s.id ? null : s.id)}>{s.emoji ?? "+"}</button
        >
        <input
          class="label"
          bind:value={s.label}
          placeholder={m.steerseditor_label_placeholder()}
          aria-label={m.steerseditor_label_aria()}
          oninput={() => (saved = false)}
        />
        <input
          class="text"
          bind:value={s.text}
          placeholder={m.steerseditor_text_placeholder()}
          aria-label={m.steerseditor_text_aria()}
          oninput={() => (saved = false)}
        />
        <div class="scopes" class:none={!s.inSteerBar && !s.onIssues}>
          <button
            type="button"
            class="scope"
            class:on={s.inSteerBar}
            aria-pressed={s.inSteerBar}
            title={m.steerseditor_scope_bar_title()}
            onclick={() => toggleScope(s, "inSteerBar")}>{m.steerseditor_scope_bar()}</button
          >
          <button
            type="button"
            class="scope"
            class:on={s.onIssues}
            aria-pressed={s.onIssues}
            title={m.steerseditor_scope_issues_title()}
            onclick={() => toggleScope(s, "onIssues")}>{m.steerseditor_scope_issues()}</button
          >
        </div>
        <button
          type="button"
          class="del"
          aria-label={m.steerseditor_delete_aria()}
          onclick={() => remove(s.id)}>✕</button
        >
        {#if pickerFor === s.id}
          <div class="picker">
            <EmojiPicker
              value={s.emoji ?? null}
              onpick={(emoji) => pickEmoji(s, emoji)}
              onclose={() => (pickerFor = null)}
            />
          </div>
        {/if}
      </div>
    {/each}
    {#if draft.length === 0}
      <div class="placeholder">{m.steerseditor_empty()}</div>
    {/if}
  </div>

  {#if scopeless}<div class="err">{m.steerseditor_scope_none_error()}</div>{/if}
  {#if error}<div class="err">{error}</div>{/if}

  <div class="actions">
    <button type="button" class="add" onclick={add} disabled={draft.length >= 40}
      >{m.steerseditor_add()}</button
    >
    <button type="button" class="save" disabled={!valid || saving} onclick={save}>
      {saving ? m.steerseditor_saving() : saved ? m.steerseditor_saved() : m.steerseditor_save()}
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
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .srow {
    position: relative;
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .grip {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    padding: 0 6px;
    color: var(--color-muted);
    cursor: grab;
    user-select: none;
    touch-action: none;
    line-height: 1;
  }
  .grip:active {
    cursor: grabbing;
  }
  .srow input {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 6px 8px;
  }
  .srow .label {
    flex: 1 1 26%;
    min-width: 0;
  }
  .srow .text {
    flex: 2 1 38%;
    min-width: 0;
  }
  .emoji-btn {
    flex: 0 0 auto;
    min-width: 32px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-base);
    padding: 6px 4px;
    line-height: 1;
  }
  .emoji-btn.unset {
    color: var(--color-faint);
  }
  .scopes {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
  }
  .scope {
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 6px 7px;
  }
  .scope.on {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  /* both surfaces off → this row blocks the save; tint its toggles to point at it */
  .scopes.none .scope {
    border-color: var(--color-red);
    color: var(--color-red);
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
  /* anchored, non-modal emoji popover (same pattern as RepoSelect's icon picker) */
  .picker {
    position: absolute;
    z-index: 60;
    top: 100%;
    left: 24px;
    margin-top: 4px;
  }
  .placeholder {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    padding: 6px 2px;
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
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
    font-size: var(--fs-meta);
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
    .del,
    .scope,
    .emoji-btn {
      min-height: 40px;
    }
    .grip {
      min-width: 40px;
    }
  }
</style>
