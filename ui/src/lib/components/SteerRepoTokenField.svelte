<script module lang="ts">
  // Per-instance id seed for the combobox/listbox aria wiring (module-scoped so it is
  // shared across instances and SSR-stable — no crypto/random in render).
  let idCounter = 0;
  function nextId(): number {
    idCounter += 1;
    return idCounter;
  }
</script>

<script lang="ts">
  import type { RepoEntry } from "$lib/types";
  import { m } from "$lib/paraglide/messages";

  // The 9c repo-scope control (the "SICHTBAR AUF" block): a token field whose scope state is
  // encoded entirely by `value` — `undefined` = ALLE (the ✱ token), an array = per-repo
  // selection (possibly empty while editing). The field takes the repo ARRAY, not the store,
  // and derives its candidate + suggestion sets internally so it stays self-contained.
  let {
    value,
    repos,
    onchange,
  }: {
    value: string[] | undefined;
    repos: RepoEntry[];
    onchange: (next: string[] | undefined) => void;
  } = $props();

  const idBase = `steer-repos-${nextId()}`;
  const listboxId = `${idBase}-listbox`;

  let rootEl = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let inputText = $state("");
  let menuOpen = $state(false);
  let activeIndex = $state(0);

  const isAll = $derived(value === undefined);
  const selected = $derived(value ?? []);
  // typeahead candidate set — unique repo names, mirroring ReposStore.knownNames exactly
  const candidateNames = $derived([...new Set(repos.map((r) => r.name))].sort());
  const total = $derived(candidateNames.length);

  const query = $derived(inputText.trim().toLowerCase());
  const matches = $derived(
    query === ""
      ? []
      : candidateNames.filter((n) => !selected.includes(n) && n.toLowerCase().includes(query)),
  );
  const showMenu = $derived(menuOpen && matches.length > 0);
  const activeOption = $derived(matches.length ? Math.min(activeIndex, matches.length - 1) : 0);

  // recently-active suggestions: repos with activity, excluding hidden + already-selected,
  // ranked by lastUsedAt desc then recentAgentCount desc, deduped by name, capped at 3.
  const suggestions = $derived(
    repos
      .filter((r) => r.lastUsedAt != null && !r.hidden && !selected.includes(r.name))
      .sort(
        (a, b) =>
          (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
          (b.recentAgentCount ?? 0) - (a.recentAgentCount ?? 0),
      )
      .map((r) => r.name)
      .filter((n, i, arr) => arr.indexOf(n) === i)
      .slice(0, 3),
  );

  // split a candidate into [before, match, after] so the matched run renders in amber
  function parts(name: string): [string, string, string] {
    const i = query === "" ? -1 : name.toLowerCase().indexOf(query);
    if (i < 0) return [name, "", ""];
    return [name.slice(0, i), name.slice(i, i + query.length), name.slice(i + query.length)];
  }

  function addToken(name: string) {
    const base = value ?? [];
    if (!base.includes(name)) onchange([...base, name]);
    inputText = "";
    menuOpen = false;
    activeIndex = 0;
    inputEl?.focus();
  }

  function removeToken(name: string) {
    onchange((value ?? []).filter((n) => n !== name));
    inputEl?.focus();
  }

  // removing the ✱ token → selection mode with zero tokens (input focused)
  function removeAllToken() {
    onchange([]);
    inputEl?.focus();
  }

  // tapping the ✱ ALLE REPOS suggestion → back to ALLE (the exclusive ✱ token)
  function chooseAll() {
    inputText = "";
    menuOpen = false;
    onchange(undefined);
  }

  function onInput(e: Event) {
    inputText = (e.currentTarget as HTMLInputElement).value;
    // typing while ✱ is present switches to selection mode; the typed filter stays
    if (isAll && inputText.trim() !== "") onchange([]);
    activeIndex = 0;
    menuOpen = inputText.trim() !== "";
  }

  function onArrowDown(e: KeyboardEvent) {
    if (matches.length === 0) return;
    e.preventDefault();
    if (!menuOpen) menuOpen = true;
    else activeIndex = (activeOption + 1) % matches.length;
  }
  function onArrowUp(e: KeyboardEvent) {
    if (!showMenu) return;
    e.preventDefault();
    activeIndex = (activeOption - 1 + matches.length) % matches.length;
  }
  function onEnter(e: KeyboardEvent) {
    if (!showMenu) return;
    e.preventDefault();
    addToken(matches[activeOption]!);
  }
  function onEscape(e: KeyboardEvent) {
    if (!menuOpen) return;
    e.preventDefault();
    menuOpen = false;
  }
  function onBackspace(e: KeyboardEvent) {
    if (inputText !== "") return;
    e.preventDefault();
    // backspace on an empty input removes the last token (or the ✱ token → selection mode)
    if (isAll) removeAllToken();
    else if (selected.length) onchange(selected.slice(0, -1));
  }
  const keyHandlers: Record<string, (e: KeyboardEvent) => void> = {
    ArrowDown: onArrowDown,
    ArrowUp: onArrowUp,
    Enter: onEnter,
    Escape: onEscape,
    Backspace: onBackspace,
  };
  function onKeydown(e: KeyboardEvent) {
    keyHandlers[e.key]?.(e);
  }

  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text")?.trim();
    if (text && candidateNames.includes(text) && !selected.includes(text)) {
      e.preventDefault();
      addToken(text);
    }
  }

  // Revert an empty selection to ALLE only when focus genuinely leaves the field. Focus moving
  // between the input, a token, a typeahead option or a suggestion chip stays inside rootEl and
  // must NOT revert — that would drop a mid-selection `[]` back to ✱ prematurely.
  function onRootFocusout(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && rootEl?.contains(next)) return;
    menuOpen = false;
    inputText = "";
    if (Array.isArray(value) && value.length === 0) onchange(undefined);
  }
</script>

<div class="visible-on" bind:this={rootEl} onfocusout={onRootFocusout}>
  <div class="label-row">
    <span class="flabel">{m.steerseditor_field_visible_on()}</span>
    {#if !isAll}
      <span class="count">{m.steerseditor_repo_count_of({ n: selected.length, total })}</span>
    {/if}
  </div>

  <div class="field">
    {#if isAll}
      <span class="token token-all">
        ✱ {m.steerseditor_repos_all()}
        <button
          type="button"
          class="tx"
          aria-label={m.steerseditor_scope_all_remove_aria()}
          onmousedown={(e) => e.preventDefault()}
          onclick={removeAllToken}>✕</button
        >
      </span>
    {:else}
      {#each selected as name (name)}
        <span class="token">
          {name}
          <button
            type="button"
            class="tx"
            aria-label={m.steerseditor_repos_remove_aria()}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => removeToken(name)}>✕</button
          >
        </span>
      {/each}
    {/if}
    <input
      bind:this={inputEl}
      class="tinput"
      role="combobox"
      aria-expanded={showMenu}
      aria-controls={listboxId}
      aria-activedescendant={showMenu ? `${idBase}-opt-${activeOption}` : undefined}
      aria-autocomplete="list"
      placeholder={m.steerseditor_repo_placeholder()}
      bind:value={inputText}
      oninput={onInput}
      onkeydown={onKeydown}
      onpaste={onPaste}
    />

    {#if showMenu}
      <ul class="typeahead" id={listboxId} role="listbox">
        {#each matches as name, i (name)}
          {@const p = parts(name)}
          <!-- Combobox listbox option: selection is keyboard-driven from the input via
               aria-activedescendant (↑↓/↵); the click is the pointer affordance. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={`${idBase}-opt-${i}`}
            role="option"
            aria-selected={i === activeOption}
            class="opt"
            class:active={i === activeOption}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => addToken(name)}
          >
            {p[0]}<span class="hl">{p[1]}</span>{p[2]}
          </li>
        {/each}
        <li class="hint" aria-hidden="true">{m.steerseditor_typeahead_hint()}</li>
      </ul>
    {/if}
  </div>

  <div class="suggest-row">
    <span class="flabel">{m.steerseditor_suggestions()}</span>
    {#each suggestions as name (name)}
      <button
        type="button"
        class="chip"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => addToken(name)}>+ {name}</button
      >
    {/each}
    {#if !isAll}
      <button
        type="button"
        class="chip chip-all"
        onmousedown={(e) => e.preventDefault()}
        onclick={chooseAll}>✱ {m.steerseditor_repos_all()}</button
      >
    {/if}
  </div>
</div>

<style>
  .visible-on {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .label-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .flabel {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .count {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  /* the token field — a standalone input surface (2px radius per the design system) */
  .field {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
  }
  /* chips/tokens carry the 6px radius */
  .token {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line);
    border-radius: 6px;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .token-all {
    border-color: var(--color-line-bright);
    color: var(--color-ink-bright);
  }
  .tx {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--color-muted);
    font: inherit;
    line-height: 1;
  }
  .tx:hover {
    color: var(--color-red);
  }
  .tinput {
    flex: 1 1 80px;
    min-width: 80px;
    background: transparent;
    border: none;
    outline: none;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-meta);
    caret-color: var(--color-amber);
    padding: 2px 0;
  }
  .tinput::placeholder {
    color: var(--color-faint);
  }
  /* anchored, non-blocking typeahead popover — the design system's earned shadow exception */
  .typeahead {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    width: min(260px, 100%);
    z-index: 60;
    list-style: none;
    margin-block: 4px 0;
    padding: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: var(--shadow-popover);
    max-height: 240px;
    overflow-y: auto;
  }
  .opt {
    display: flex;
    align-items: center;
    min-height: 34px;
    padding: 0 12px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .opt.active {
    background: var(--color-sel);
    color: var(--color-ink-bright);
  }
  .hl {
    color: var(--color-amber);
  }
  .typeahead .hint {
    padding: 7px 12px;
    font-size: var(--fs-micro);
    letter-spacing: 0.1em;
    color: var(--color-faint);
    border-top: 1px solid var(--color-line);
  }
  .suggest-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: transparent;
    border: 1px dashed var(--color-line);
    border-radius: 6px;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .chip:hover {
    background: var(--color-hover);
    color: var(--color-ink);
  }
  /* the ✱ ALLE REPOS suggestion reads slightly brighter than the repo suggestions */
  .chip-all {
    color: var(--color-ink);
  }
  @media (max-width: 768px) {
    .token,
    .chip,
    .tx {
      min-height: 40px;
    }
  }
</style>
