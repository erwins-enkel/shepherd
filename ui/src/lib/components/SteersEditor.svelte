<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { flip } from "svelte/animate";
  import { dragHandleZone, dragHandle } from "svelte-dnd-action";
  import type { DndEvent } from "svelte-dnd-action";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import EmojiPicker from "$lib/components/EmojiPicker.svelte";
  import SlashCommandMenu from "$lib/components/SlashCommandMenu.svelte";
  import { getCommands } from "$lib/api";
  import {
    matchSlashTrigger,
    filterCommands,
    applyCommandPick,
    applyMentionPick,
    commandInvocationName,
    commandProviders,
  } from "$lib/slash";
  import type { Steer, SlashCommand } from "$lib/types";
  import HighlightText from "$lib/components/settings/HighlightText.svelte";
  import { m } from "$lib/paraglide/messages";

  // Steer to expand + focus on open (from a steer chip's right-click → "Edit"). The
  // editor lists every steer; this jumps straight to the one the operator picked.
  let { focusSteerId = null, query = "" }: { focusSteerId?: string | null; query?: string } =
    $props();

  const flipDurationMs = 150;

  let rootEl = $state<HTMLDivElement | null>(null);
  let draft = $state<Steer[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  // steer id whose emoji picker is open; null = closed
  let pickerFor = $state<string | null>(null);
  // steer id whose repo popover is open; null = closed
  let reposFor = $state<string | null>(null);
  let reposPopEl = $state<HTMLDivElement | null>(null);
  // steer id currently being edited (its prompt field is focused). While set, that
  // row expands to a full-width, multi-line layout and — on mobile — becomes the
  // only row on screen, so a long prompt or a typed /command is fully readable.
  let editingId = $state<string | null>(null);

  // ── inline slash-command autocomplete for each steer's prompt field ──
  // A steer can now be bound to specific repos (s.repos), but that binding only
  // gates WHERE the steer appears (bar/issues) — it doesn't change which slash
  // commands are offered while editing its prompt. So we still load the
  // user-scope command index here: passing no repo to /api/commands yields the
  // user/.claude commands + skills only, the layer common to every session.
  let allCommands = $state<SlashCommand[]>([]);
  // steer id whose slash menu is open; null = closed (only one field is focused
  // at a time, so a single set of menu state covers the whole list).
  let slashFor = $state<string | null>(null);
  let slashQuery = $state("");
  let slashTrigger = $state<"/" | "$" | "@">("/");
  let slashIndex = $state(0);
  // the textarea currently driving the menu, for caret reads + post-pick refocus
  let activeTa: HTMLTextAreaElement | null = null;
  const slashMatches = $derived(slashFor ? filterCommands(allCommands, slashQuery) : []);

  function reorder(e: CustomEvent<DndEvent<Steer>>) {
    draft = e.detail.items;
    saved = false;
  }

  function syncFromStore() {
    draft = steers.list.map((s) => ({ ...s }));
  }

  onMount(async () => {
    if (!steers.loaded) await steers.load();
    if (!repos.loaded) await repos.load();
    syncFromStore();
    getCommands("")
      .then((r) => (allCommands = r.commands))
      .catch(() => (allCommands = []));
    // Targeted edit: scroll the chosen steer's row into view and focus its prompt
    // field. Focusing fires onTextFocus, which expands the row (editingId) and
    // autogrows the field — so the operator lands directly in the steer they picked.
    if (focusSteerId && draft.some((s) => s.id === focusSteerId)) {
      requestAnimationFrame(() => {
        const ta = rootEl?.querySelector<HTMLTextAreaElement>(
          `.srow[data-steer-id="${CSS.escape(focusSteerId!)}"] textarea.text`,
        );
        ta?.scrollIntoView({ block: "center" });
        ta?.focus();
      });
    }
  });

  // Grow the focused prompt field to fit its content; at rest it collapses back to
  // a single line so the row list stays compact. This is the "click-in → bigger"
  // behaviour: a long steer prompt is fully visible and editable once focused.
  function autogrow(ta: HTMLTextAreaElement) {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }

  function onTextFocus(s: Steer, e: FocusEvent) {
    activeTa = e.currentTarget as HTMLTextAreaElement;
    editingId = s.id;
    autogrow(activeTa);
  }

  function onTextInput(s: Steer, e: Event) {
    saved = false;
    const ta = e.currentTarget as HTMLTextAreaElement;
    activeTa = ta;
    autogrow(ta);
    // open/refresh the menu from the caret, or close it once the text is no longer
    // a leading `/token` (mirrors the ComposeBar / New Task picker).
    const trigger = matchSlashTrigger(s.text, ta.selectionStart ?? s.text.length);
    if (trigger) {
      slashFor = s.id;
      slashQuery = trigger.query;
      slashTrigger = trigger.trigger;
      slashIndex = 0;
    } else if (slashFor === s.id) {
      slashFor = null;
    }
  }

  function onTextBlur(s: Steer, e: FocusEvent) {
    const ta = e.currentTarget as HTMLTextAreaElement;
    ta.style.height = ""; // collapse to one line
    if (slashFor === s.id) slashFor = null;
    // Focus moving to another control inside this same row (label, emoji, scope
    // toggles, the emoji popover) keeps edit mode — those stay usable in-place, so
    // only leaving the row collapses it and (on mobile) restores the full list. The
    // slash menu picks via mousedown+preventDefault, so it never blurs here at all.
    const next = e.relatedTarget as HTMLElement | null;
    if (next && ta.closest(".srow")?.contains(next)) return;
    if (editingId === s.id) editingId = null;
  }

  // Explicit "Done" affordance for the expanded row: blur the field so edit mode
  // ends and every steer is shown again (mobile keyboards can hide the global Save).
  function finishEditing() {
    editingId = null;
    slashFor = null;
    activeTa?.blur();
  }

  // Replace the typed `/query` with the chosen command, hoisting it to the front —
  // Claude only runs a *leading* slash command, so any surrounding text becomes its
  // argument. Caret lands past `/name ` so arguments can be typed straight away.
  function pickCommand(s: Steer, cmd: SlashCommand) {
    const ta = activeTa;
    const caret = ta?.selectionStart ?? s.text.length;
    const trigger = matchSlashTrigger(s.text, caret);
    const start = trigger?.start ?? 0;
    const providers = commandProviders(cmd);
    const provider =
      (trigger?.trigger === "$" || trigger?.trigger === "@") && providers.includes("codex")
        ? "codex"
        : providers.includes("claude")
          ? "claude"
          : providers[0]!;
    const next =
      provider === "codex"
        ? applyMentionPick(s.text, start, caret, commandInvocationName(cmd))
        : applyCommandPick(s.text, start, caret, commandInvocationName(cmd));
    s.text = next.value;
    s.agentProviders = providers.length === 1 ? providers : undefined;
    slashFor = null;
    saved = false;
    queueMicrotask(() => {
      if (!ta) return;
      ta.focus();
      autogrow(ta);
      ta.setSelectionRange(next.caret, next.caret);
    });
  }

  // While the menu is open, arrows/Enter/Tab/Escape drive the picker instead of the
  // textarea (a tap on a row works regardless).
  function onTextKeydown(s: Steer, e: KeyboardEvent) {
    if (slashFor !== s.id) return;
    if (slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(s, slashMatches[slashIndex]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        slashFor = null;
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      slashFor = null;
    }
  }

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
    if (editingId === id) editingId = null;
    if (reposFor === id) reposFor = null;
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
  function toggleRepo(s: Steer, name: string) {
    const cur = new SvelteSet(s.repos ?? []);
    if (cur.has(name)) cur.delete(name);
    else cur.add(name);
    s.repos = cur.size ? [...cur] : undefined;
    saved = false;
  }

  // Dismiss the repos popover on Esc + outside pointerdown, mirroring
  // IssueFilterPopover. Deferred a tick so the click that opened it (which fires
  // the same pointerdown) doesn't immediately close it again.
  $effect(() => {
    if (!reposFor) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") reposFor = null;
    }
    function onPointerdown(e: PointerEvent) {
      if (reposPopEl && !reposPopEl.contains(e.target as Node)) reposFor = null;
    }
    const tid = setTimeout(() => {
      window.addEventListener("keydown", onKeydown);
      window.addEventListener("pointerdown", onPointerdown);
    }, 0);
    return () => {
      clearTimeout(tid);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("pointerdown", onPointerdown);
    };
  });

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
      editingId = null; // saving exits edit mode → the full list is shown again
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : m.steerseditor_save_failed();
    } finally {
      saving = false;
    }
  }
</script>

<div class="editor" bind:this={rootEl}>
  <span class="micro"><HighlightText text={m.steerseditor_title()} {query} /></span>
  <p class="hint"><HighlightText text={m.steerseditor_hint()} {query} /></p>
  <div
    class="rows"
    class:focusing={editingId !== null}
    use:dragHandleZone={{ items: draft, flipDurationMs }}
    onconsider={reorder}
    onfinalize={reorder}
  >
    {#each draft as s (s.id)}
      <div
        class="srow"
        class:editing={editingId === s.id}
        data-steer-id={s.id}
        animate:flip={{ duration: flipDurationMs }}
      >
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
        <div class="text-wrap">
          <textarea
            class="text"
            rows="1"
            bind:value={s.text}
            placeholder={m.steerseditor_text_placeholder()}
            aria-label={m.steerseditor_text_aria()}
            onfocus={(e) => onTextFocus(s, e)}
            oninput={(e) => onTextInput(s, e)}
            onblur={(e) => onTextBlur(s, e)}
            onkeydown={(e) => onTextKeydown(s, e)}></textarea>
          {#if slashFor === s.id}
            <SlashCommandMenu
              commands={slashMatches}
              activeIndex={slashIndex}
              provider={slashTrigger === "/" ? "claude" : "codex"}
              placement="down"
              onpick={(cmd) => pickCommand(s, cmd)}
              onhover={(i) => (slashIndex = i)}
            />
          {/if}
        </div>
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
          <button
            type="button"
            class="scope"
            class:on={!!s.repos?.length}
            aria-haspopup="dialog"
            aria-expanded={reposFor === s.id}
            title={m.steerseditor_repos_title()}
            onclick={() => (reposFor = reposFor === s.id ? null : s.id)}
            >{s.repos?.length
              ? m.steerseditor_repos_count({ n: s.repos.length })
              : m.steerseditor_repos_all()}</button
          >
        </div>
        <button
          type="button"
          class="del"
          aria-label={m.steerseditor_delete_aria()}
          onclick={() => remove(s.id)}>✕</button
        >
        {#if editingId === s.id}
          <button
            type="button"
            class="done"
            title={m.steerseditor_done_title()}
            onmousedown={(e) => e.preventDefault()}
            onclick={finishEditing}>{m.steerseditor_done()}</button
          >
        {/if}
        {#if pickerFor === s.id}
          <div class="picker">
            <EmojiPicker
              value={s.emoji ?? null}
              onpick={(emoji) => pickEmoji(s, emoji)}
              onclose={() => (pickerFor = null)}
            />
          </div>
        {/if}
        {#if reposFor === s.id}
          <div
            class="repos-pop"
            role="dialog"
            aria-label={m.steerseditor_repos_heading()}
            bind:this={reposPopEl}
          >
            <span class="rp-heading">{m.steerseditor_repos_heading()}</span>
            {#if repos.entries.length === 0}
              <p class="rp-empty">{m.steerseditor_repos_empty()}</p>
            {:else}
              <ul class="rp-list">
                {#each repos.entries as entry (entry.name)}
                  <li class="rp-row">
                    <label class="rp-label">
                      <input
                        type="checkbox"
                        checked={s.repos?.includes(entry.name) ?? false}
                        onchange={() => toggleRepo(s, entry.name)}
                      />
                      <span>{entry.name}</span>
                    </label>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if s.repos?.some((name) => !repos.knownNames.includes(name))}
              <ul class="rp-list rp-unknown">
                {#each s.repos.filter((name) => !repos.knownNames.includes(name)) as name (name)}
                  <li class="rp-row rp-chip">
                    <span class="rp-unknown-label">{name} — {m.steerseditor_repos_unknown()}</span>
                    <button
                      type="button"
                      class="rp-remove"
                      aria-label={m.steerseditor_repos_remove_aria()}
                      onclick={() => toggleRepo(s, name)}>✕</button
                    >
                  </li>
                {/each}
              </ul>
            {/if}
            <p class="rp-hint">{m.steerseditor_repos_hint()}</p>
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
    /* top-aligned so the controls stay level with the first line when the prompt
       field grows to multiple lines on focus */
    align-items: flex-start;
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
  .srow input,
  .srow textarea {
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
  /* anchors the slash-command menu (absolutely positioned) to the prompt field */
  .text-wrap {
    position: relative;
    flex: 2 1 38%;
    min-width: 0;
    display: flex;
  }
  /* one-line at rest (compact list), autogrows to its content while focused —
     JS sets an inline height on focus/input and clears it on blur. */
  .srow .text {
    flex: 1 1 auto;
    min-width: 0;
    resize: none;
    overflow: hidden;
    line-height: 1.4;
  }
  /* ── edit mode: the focused row expands to a full-width, stacked layout so a long
     prompt / typed /command is fully readable; the controls wrap below it. ── */
  .srow.editing {
    flex-wrap: wrap;
    gap: 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 8px;
  }
  .srow.editing .grip {
    display: none; /* no reordering while a single row is expanded */
  }
  .srow.editing .emoji-btn {
    order: 1;
  }
  .srow.editing .label {
    order: 2;
    flex: 1 1 auto;
  }
  .srow.editing .del {
    order: 3;
  }
  .srow.editing .text-wrap {
    order: 4;
    flex: 1 1 100%; /* full width forces the controls onto their own lines */
  }
  .srow.editing .text {
    min-height: 6.5em;
  }
  .srow.editing .scopes {
    order: 5;
  }
  .srow.editing .done {
    order: 6;
    margin-left: auto;
  }
  /* On mobile, isolate the row being edited — show only that steer on screen. */
  @media (max-width: 768px) {
    .rows.focusing .srow:not(.editing) {
      display: none;
    }
    .srow.editing .text {
      min-height: 30vh;
    }
  }
  .done {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 6px 10px;
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
  /* anchored, non-modal repos popover — no aria-modal, no scrim (small anchored
     popover exemption in the design system); dismissed via the Esc/outside-click
     $effect above rather than a backdrop. */
  .repos-pop {
    position: absolute;
    z-index: 60;
    top: 100%;
    right: 0;
    margin-top: 4px;
    width: 220px;
    max-width: min(220px, calc(100vw - 16px));
    max-height: 60vh;
    overflow-y: auto;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rp-heading {
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .rp-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .rp-row {
    display: flex;
    align-items: center;
  }
  .rp-label {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 6px 4px;
    font-size: var(--fs-lg);
    color: var(--color-ink-bright);
    cursor: pointer;
  }
  .rp-label input[type="checkbox"] {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    cursor: pointer;
  }
  .rp-empty {
    color: var(--color-faint);
    font-size: var(--fs-lg);
    margin: 4px 0;
  }
  .rp-unknown {
    border-top: 1px solid var(--color-line);
    padding-top: 4px;
  }
  .rp-chip {
    justify-content: space-between;
    gap: 8px;
    min-height: 44px;
    padding: 6px 4px;
  }
  .rp-unknown-label {
    color: var(--color-red);
    font-size: var(--fs-lg);
  }
  .rp-remove {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-red);
    cursor: pointer;
    font: inherit;
  }
  .rp-hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
    border-top: 1px solid var(--color-line);
    padding-top: 6px;
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
    .done,
    .emoji-btn {
      min-height: 40px;
    }
    .grip {
      min-width: 40px;
    }
  }
</style>
