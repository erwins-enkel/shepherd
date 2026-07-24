<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { flip } from "svelte/animate";
  import { dragHandleZone, dragHandle } from "svelte-dnd-action";
  import type { DndEvent } from "svelte-dnd-action";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import EmojiPicker from "$lib/components/EmojiPicker.svelte";
  import SlashCommandMenu from "$lib/components/SlashCommandMenu.svelte";
  import SteerRepoTokenField from "$lib/components/SteerRepoTokenField.svelte";
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
  // accordion lists every steer; this jumps straight to the one the operator picked.
  let { focusSteerId = null, query = "" }: { focusSteerId?: string | null; query?: string } =
    $props();

  const flipDurationMs = 150;
  const MAX = 40;

  let rootEl = $state<HTMLDivElement | null>(null);
  let draft = $state<Steer[]>([]);
  // the single expanded row (accordion — one open at a time); null = all collapsed
  let openId = $state<string | null>(null);
  // steer id whose emoji picker is open; null = closed
  let pickerFor = $state<string | null>(null);
  // steer id whose inline "really remove?" confirm is showing; null = none
  let confirmRemoveId = $state<string | null>(null);

  // autosave readout state
  let saving = $state(false);
  let savedAt = $state<string | null>(null);
  let error = $state<string | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // ── inline slash-command autocomplete for each steer's prompt field (kept from the
  //    "Roomier steer editor" feature) ──
  let allCommands = $state<SlashCommand[]>([]);
  let slashFor = $state<string | null>(null);
  let slashQuery = $state("");
  let slashTrigger = $state<"/" | "$" | "@">("/");
  let slashIndex = $state(0);
  let activeTa: HTMLTextAreaElement | null = null;
  const slashMatches = $derived(slashFor ? filterCommands(allCommands, slashQuery) : []);

  // ids present in the last persisted list — a draft row whose id is absent is a new,
  // not-yet-saved row (isolated from the persisted baseline by the autosave policy).
  const persistedIds = $derived(new Set(steers.list.map((s) => s.id)));
  const scopeless = $derived(draft.some((s) => !s.inSteerBar && !s.onIssues));

  function rowValid(s: Steer): boolean {
    return s.label.trim() !== "" && s.text.trim() !== "" && (s.inSteerBar || s.onIssues);
  }

  function cloneSteer(s: Steer): Steer {
    return {
      ...s,
      repos: s.repos ? [...s.repos] : undefined,
      agentProviders: s.agentProviders ? [...s.agentProviders] : undefined,
    };
  }

  // trim + normalise an empty repo selection back to "all repos" before persisting
  function cleanSteer(s: Steer): Steer {
    return {
      ...s,
      label: s.label.trim(),
      text: s.text.trim(),
      repos: s.repos && s.repos.length ? s.repos : undefined,
    };
  }

  // Persisted rows are always included (dropping one would delete it server-side); a new
  // row joins only once it is individually valid, so a half-authored row can't block the
  // all-or-nothing PUT nor corrupt the saved baseline.
  function buildPayload(): Steer[] {
    return draft.filter((s) => persistedIds.has(s.id) || rowValid(s));
  }

  onMount(async () => {
    if (!steers.loaded) await steers.load();
    if (!repos.loaded) await repos.load();
    // seed the working list from the store plus any in-progress draft recovered from a
    // previous close (see onDestroy); then clear the recovery buffer.
    const recovered = steers.draftBuffer.map((s) => s.id);
    draft = [...steers.list.map(cloneSteer), ...steers.draftBuffer.map(cloneSteer)];
    steers.draftBuffer = [];
    getCommands("")
      .then((r) => (allCommands = r.commands))
      .catch(() => (allCommands = []));
    // focus target: the explicitly-picked steer wins, else a recovered in-progress row
    const focusId =
      focusSteerId && draft.some((s) => s.id === focusSteerId)
        ? focusSteerId
        : (recovered[0] ?? null);
    if (focusId) {
      openId = focusId;
      focusRow(focusId);
    }
  });

  onDestroy(() => {
    // (1) flush a still-pending debounced edit independently, so a valid baseline change
    // persists on close even if an invalid new row is also present.
    const pendingDebounce = saveTimer !== null;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (pendingDebounce) {
      const payload = buildPayload();
      if (!payload.some((s) => !rowValid(s))) void steers.save(payload.map(cleanSteer));
    }
    // (2) recover content-bearing invalid new rows (empty ones carry nothing → dropped).
    const pids = new Set(steers.list.map((s) => s.id));
    steers.draftBuffer = draft
      .filter(
        (s) => !pids.has(s.id) && !rowValid(s) && (s.label.trim() !== "" || s.text.trim() !== ""),
      )
      .map(cloneSteer);
  });

  function focusRow(id: string) {
    requestAnimationFrame(() => {
      const row = rootEl?.querySelector<HTMLElement>(`.srow[data-steer-id="${CSS.escape(id)}"]`);
      const el =
        row?.querySelector<HTMLElement>("textarea.ptext") ??
        row?.querySelector<HTMLElement>("input.ntext");
      el?.scrollIntoView({ block: "center" });
      el?.focus();
    });
  }

  // ── autosave ──
  function nowHHMM(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, 500);
  }

  function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void flush();
  }

  async function flush() {
    const payload = buildPayload();
    // a persisted row edited into an invalid state would 400 the whole PUT → block, and
    // let the scopeless banner / the incomplete field itself point at what to fix.
    if (payload.some((s) => !rowValid(s))) return;
    saving = true;
    error = null;
    try {
      await steers.save(payload.map(cleanSteer));
      savedAt = nowHHMM();
    } catch (e) {
      error = e instanceof Error ? e.message : m.steerseditor_save_failed();
    } finally {
      saving = false;
    }
  }

  // ── list mutations ──
  function toggle(id: string) {
    confirmRemoveId = null;
    if (openId === id) {
      collapse(id);
      openId = null;
    } else {
      if (openId) collapse(openId);
      openId = id;
    }
  }

  // on collapse, revert a transient empty repo selection back to "all repos"
  function collapse(id: string) {
    const s = draft.find((x) => x.id === id);
    if (s && Array.isArray(s.repos) && s.repos.length === 0) s.repos = undefined;
    if (slashFor === id) slashFor = null;
    if (pickerFor === id) pickerFor = null;
  }

  function add() {
    if (draft.length >= MAX) return;
    if (openId) collapse(openId);
    const s: Steer = {
      id: crypto.randomUUID(),
      label: "",
      text: "",
      inSteerBar: true,
      onIssues: false,
    };
    draft = [...draft, s];
    openId = s.id;
    confirmRemoveId = null;
    focusRow(s.id);
  }

  function requestRemove(id: string) {
    confirmRemoveId = id;
  }
  function cancelRemove() {
    confirmRemoveId = null;
  }
  function confirmRemove(id: string) {
    draft = draft.filter((s) => s.id !== id);
    if (openId === id) openId = null;
    if (pickerFor === id) pickerFor = null;
    confirmRemoveId = null;
    saveNow();
  }
  // cancel the confirm when focus leaves its controls (its buttons preventDefault on
  // mousedown, so clicking ✓/✕ keeps focus and the gesture completes before this fires)
  function onConfirmFocusout(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement).contains(next)) return;
    confirmRemoveId = null;
  }

  function pickEmoji(s: Steer, emoji: string | null) {
    s.emoji = emoji ?? undefined;
    pickerFor = null;
    saveNow();
  }
  function onToggle() {
    saveNow();
  }
  function onScopeChange(s: Steer, next: string[] | undefined) {
    s.repos = next;
    saveNow();
  }

  function onConsider(e: CustomEvent<DndEvent<Steer>>) {
    draft = e.detail.items;
  }
  function onFinalize(e: CustomEvent<DndEvent<Steer>>) {
    draft = e.detail.items;
    saveNow();
  }

  // collapsed-row scope readout: the ✱ ALLE chip, else "1 repo" / "N repos"
  function scopeReadout(s: Steer): { chip: boolean; text: string } {
    const n = s.repos?.length ?? 0;
    if (n === 0) return { chip: true, text: "" };
    if (n === 1) return { chip: false, text: m.steerseditor_repos_count_one() };
    return { chip: false, text: m.steerseditor_repos_count({ n }) };
  }

  // ── prompt field: autogrow + slash-command menu (kept behaviour) ──
  function autogrow(ta: HTMLTextAreaElement) {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }
  function onTextFocus(e: FocusEvent) {
    activeTa = e.currentTarget as HTMLTextAreaElement;
    autogrow(activeTa);
  }
  function onTextInput(s: Steer, e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement;
    activeTa = ta;
    autogrow(ta);
    scheduleSave();
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
    ta.style.height = "";
    // the slash menu picks via mousedown+preventDefault, so it never blurs here
    if (slashFor === s.id) slashFor = null;
    saveNow();
  }
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
    scheduleSave();
    queueMicrotask(() => {
      if (!ta) return;
      ta.focus();
      autogrow(ta);
      ta.setSelectionRange(next.caret, next.caret);
    });
  }
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

  const preventDefault = (e: Event) => e.preventDefault();
</script>

<div class="editor" bind:this={rootEl}>
  <p class="hint"><HighlightText text={m.steerseditor_hint()} {query} /></p>

  <div class="panel">
    <div class="phead">
      <span class="htitle"><HighlightText text={m.steerseditor_title()} {query} /></span>
      <span class="hcount">{draft.length}</span>
      <span class="readout" aria-live="polite">
        {#if saving}
          {m.steerseditor_saving()}
        {:else if savedAt}
          {m.steerseditor_autosaved()} <span class="ok">✓</span> {savedAt}
        {/if}
      </span>
    </div>

    <div
      class="rows"
      use:dragHandleZone={{ items: draft, flipDurationMs }}
      onconsider={onConsider}
      onfinalize={onFinalize}
    >
      {#each draft as s (s.id)}
        <div
          class="srow"
          class:open={openId === s.id}
          data-steer-id={s.id}
          animate:flip={{ duration: flipDurationMs }}
        >
          <div class="rhead">
            <span
              class="grip"
              use:dragHandle
              aria-label={m.steerseditor_reorder_aria()}
              title={m.steerseditor_reorder_aria()}>⠿</span
            >
            <span class="etile" class:unset={!s.emoji}>{s.emoji ?? "+"}</span>
            <button
              type="button"
              class="rtitle"
              aria-expanded={openId === s.id}
              onclick={() => toggle(s.id)}
            >
              <span class="rname" class:empty={!s.label.trim()}
                >{s.label.trim() || m.steerseditor_label_placeholder()}</span
              >
              {#if openId !== s.id}
                {@const sc = scopeReadout(s)}
                <span class="rpreview">{s.text}</span>
                <span class="ro">
                  {#if s.inSteerBar}<span class="ro-p">{m.steerseditor_scope_bar()}</span>{/if}
                  {#if s.onIssues}<span class="ro-p">{m.steerseditor_scope_issues()}</span>{/if}
                  {#if sc.chip}
                    <span class="ro-all">✱ {m.steerseditor_scope_all_short()}</span>
                  {:else}
                    <span class="ro-p">{sc.text}</span>
                  {/if}
                </span>
              {/if}
              <span class="chev">{openId === s.id ? "⌃" : "⌄"}</span>
            </button>
          </div>

          {#if openId === s.id}
            <div class="rbody">
              <div class="ne-row">
                <label class="fld ntext-fld">
                  <span class="flabel">{m.steerseditor_field_name()}</span>
                  <input
                    class="ntext"
                    bind:value={s.label}
                    placeholder={m.steerseditor_label_placeholder()}
                    aria-label={m.steerseditor_label_aria()}
                    oninput={scheduleSave}
                    onblur={saveNow}
                  />
                </label>
                <div class="fld emoji-fld">
                  <span class="flabel">{m.steerseditor_field_emoji()}</span>
                  <button
                    type="button"
                    class="emoji-btn"
                    aria-label={m.steerseditor_emoji_aria()}
                    title={m.steerseditor_emoji_aria()}
                    onclick={() => (pickerFor = pickerFor === s.id ? null : s.id)}
                  >
                    <span class="ebig" class:unset={!s.emoji}>{s.emoji ?? "+"}</span>
                    <span class="ecaret" aria-hidden="true">▾</span>
                  </button>
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
              </div>

              <SteerRepoTokenField
                value={s.repos}
                repos={repos.entries}
                onchange={(next) => onScopeChange(s, next)}
              />

              <div class="fld">
                <span class="flabel">{m.steerseditor_field_prompt()}</span>
                <div class="text-wrap">
                  <textarea
                    class="ptext"
                    rows="3"
                    bind:value={s.text}
                    placeholder={m.steerseditor_text_placeholder()}
                    aria-label={m.steerseditor_text_aria()}
                    onfocus={onTextFocus}
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
              </div>

              <div class="show-row">
                <span class="flabel">{m.steerseditor_field_show_in()}</span>
                <label class="cbx" class:on={s.inSteerBar}>
                  <input type="checkbox" bind:checked={s.inSteerBar} onchange={onToggle} />
                  <span class="box" aria-hidden="true"
                    >{#if s.inSteerBar}✓{/if}</span
                  >
                  <span class="cbx-txt">{m.steerseditor_placement_bar()}</span>
                </label>
                <label class="cbx" class:on={s.onIssues}>
                  <input type="checkbox" bind:checked={s.onIssues} onchange={onToggle} />
                  <span class="box" aria-hidden="true"
                    >{#if s.onIssues}✓{/if}</span
                  >
                  <span class="cbx-txt">{m.steerseditor_placement_issues()}</span>
                </label>

                <span class="remove-wrap" onfocusout={onConfirmFocusout}>
                  {#if confirmRemoveId === s.id}
                    <span class="rc-q">{m.steerseditor_remove_confirm()}</span>
                    <button
                      type="button"
                      class="rc-yes"
                      aria-label={m.steerseditor_remove_yes_aria()}
                      onmousedown={preventDefault}
                      onclick={() => confirmRemove(s.id)}>✓</button
                    >
                    <button
                      type="button"
                      class="rc-no"
                      aria-label={m.steerseditor_remove_no_aria()}
                      onmousedown={preventDefault}
                      onclick={cancelRemove}>✕</button
                    >
                  {:else}
                    <button type="button" class="rc-open" onclick={() => requestRemove(s.id)}
                      >{m.steerseditor_remove()}</button
                    >
                  {/if}
                </span>
              </div>
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

    <div class="pfoot">
      <button type="button" class="add" onclick={add} disabled={draft.length >= MAX}
        >{m.steerseditor_add()}</button
      >
      <span class="foot-hint">{m.steerseditor_add_hint()}</span>
    </div>
  </div>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 8px;
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
  }
  .hint {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    margin: 0;
  }
  /* the paneled list (mockup: header · rows · footer) */
  .panel {
    display: flex;
    flex-direction: column;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-radius: 2px;
  }
  .phead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }
  .htitle {
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink);
  }
  .hcount {
    font-size: var(--fs-meta);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .readout {
    margin-left: auto;
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .readout .ok {
    color: var(--color-green);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 16px;
  }
  .srow {
    border: 1px solid var(--color-line);
    background: var(--color-panel-2);
    border-radius: 2px;
  }
  .srow.open {
    border-color: var(--color-line-bright);
  }
  .rhead {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 0 10px;
  }
  .grip {
    flex: 0 0 auto;
    color: var(--color-faint);
    cursor: grab;
    user-select: none;
    touch-action: none;
    line-height: 1;
  }
  .grip:active {
    cursor: grabbing;
  }
  .etile {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    font-size: var(--fs-lg);
  }
  .etile.unset {
    color: var(--color-faint);
    font-size: var(--fs-base);
  }
  /* the row title/expand target — flex so the preview + readout fill the middle */
  .rtitle {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }
  .rhead:hover {
    background: var(--color-hover);
  }
  .rname {
    flex: 0 0 auto;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--color-ink-bright);
  }
  .rname.empty {
    color: var(--color-faint);
    font-weight: 400;
    font-style: italic;
  }
  .rpreview {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .ro {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .ro > * + *::before {
    content: "·";
    margin: 0 5px;
    color: var(--color-faint);
  }
  .ro-all {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    padding: 1px 6px;
    color: var(--color-muted);
  }
  .chev {
    flex: 0 0 auto;
    color: var(--color-muted);
    font-size: var(--fs-meta);
  }
  /* ── expanded editor body ── */
  .rbody {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px 12px 14px;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .flabel {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .ne-row {
    display: flex;
    gap: 10px;
  }
  .ntext-fld {
    flex: 1 1 auto;
  }
  .emoji-fld {
    position: relative;
    width: 110px;
    flex: 0 0 auto;
  }
  .ntext {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 9px 10px;
  }
  .ntext:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .emoji-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink-bright);
    cursor: pointer;
    font: inherit;
    padding: 7px 10px;
  }
  .emoji-btn:focus-visible {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .ebig {
    font-size: var(--fs-lg);
  }
  .ebig.unset {
    color: var(--color-faint);
    font-size: var(--fs-base);
  }
  .ecaret {
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .picker {
    position: absolute;
    z-index: 60;
    top: 100%;
    right: 0;
    margin-top: 4px;
  }
  .text-wrap {
    position: relative;
    display: flex;
  }
  .ptext {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 4.5em;
    resize: none;
    overflow: hidden;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-base);
    line-height: 1.5;
    padding: 10px;
  }
  .ptext:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  /* ── ANZEIGEN IN: checkboxes + two-step remove ── */
  .show-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
  }
  .cbx {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .cbx.on {
    color: var(--color-ink);
  }
  .cbx input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .box {
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-green);
    font-size: var(--fs-micro);
    line-height: 1;
  }
  .cbx.on .box {
    border-color: var(--color-line-bright);
  }
  .cbx input:focus-visible + .box {
    outline: 2px solid var(--color-line-bright);
    outline-offset: 1px;
  }
  .remove-wrap {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .rc-open,
  .rc-q {
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
    color: var(--color-red);
  }
  .rc-open {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.1em;
  }
  .rc-yes,
  .rc-no {
    background: none;
    border: none;
    padding: 0 2px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }
  .rc-yes {
    color: var(--color-green);
  }
  .rc-no {
    color: var(--color-red);
  }
  /* ── footer ── */
  .pfoot {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--color-line);
  }
  /* the section's only amber control */
  .add {
    display: inline-flex;
    align-items: center;
    min-height: 40px;
    padding: 0 16px;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .add:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .foot-hint {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-faint);
  }
  .placeholder {
    color: var(--color-faint);
    font-size: var(--fs-meta);
    padding: 6px 2px;
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
    padding: 0 16px 8px;
  }
  @media (max-width: 768px) {
    .add,
    .emoji-btn,
    .cbx,
    .rc-open,
    .rc-yes,
    .rc-no {
      min-height: 40px;
    }
    .grip {
      min-width: 40px;
      display: inline-flex;
      justify-content: center;
    }
    .ptext {
      min-height: 30vh;
    }
  }
</style>
