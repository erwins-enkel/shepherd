<script lang="ts">
  import { onMount } from "svelte";
  import { getPostgresRepos, type PostgresRepo } from "#lib/api.js";
  import { repoConfig } from "#lib/reviews.svelte.js";
  import { repos } from "#lib/repos.svelte.js";
  import { searchRepos } from "#lib/repo-search.js";
  import type { PostgresMode, RepoEntry } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import HighlightText from "./HighlightText.svelte";
  import "./settings-controls.css";

  // Settings › Resources › Postgres "Repos with Postgres" (#4232): the repos whose agents may ask
  // for a database, each with a ✕ that turns it off at once, plus a search that turns one on. It
  // writes repo_config.postgresMode through the same repo-config store as Repo settings → Agent,
  // so a toggle there shows here too. Keys are realpaths, like the server's repo_config. Stays
  // editable while the global switch is off: pick repos first, then turn Postgres on. Adding a repo
  // sets on-request; an auto repo (a database at every spawn, #4238) carries a tag.
  let { globalEnabled, query = "" }: { globalEnabled: boolean; query?: string } = $props();
  const q = $derived(query.trim());

  const idBase = $props.id();
  const titleId = `${idBase}-title`;
  const listboxId = `${idBase}-listbox`;
  const MAX_OPTIONS = 8;

  type Row = { repoPath: string; name: string };

  let fetched = $state<PostgresRepo[] | null>(null);
  let failed = $state(false);
  let error = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);
  let text = $state("");
  let menuOpen = $state(false);
  let activeIndex = $state(0);

  onMount(async () => {
    try {
      fetched = (await getPostgresRepos()).repos;
    } catch {
      failed = true;
    }
  });

  // One entry per realpath (a repo reachable under two spellings is still one repo).
  const byRealPath = $derived(new Map(repos.entries.map((e) => [e.realPath, e])));
  const fetchedPaths = $derived(new Set((fetched ?? []).map((r) => r.repoPath)));
  // An older server lists no mode: its listed repos are on-request.
  const fetchedModes = $derived(
    new Map(
      (fetched ?? []).map((r): [string, PostgresMode] => [r.repoPath, r.mode ?? "on-request"]),
    ),
  );

  // The store holds this tab's writes (here or in the Repo settings window) and any config it
  // loaded; it wins over the list fetched on open. A rolled-back write can leave `undefined`.
  function modeOf(repoPath: string): PostgresMode {
    const path = byRealPath.get(repoPath)?.path ?? repoPath;
    const mode = repoConfig.postgresMode[repoPath] ?? repoConfig.postgresMode[path];
    return mode ?? fetchedModes.get(repoPath) ?? "off";
  }
  const isOn = (repoPath: string) => modeOf(repoPath) !== "off";

  // The fetched rows plus any known repo the store turned on in this tab.
  const rows = $derived.by((): Row[] => {
    const known = [...byRealPath.values()]
      .filter((e) => !fetchedPaths.has(e.realPath))
      .map((e) => ({ repoPath: e.realPath, name: e.name }));
    return [...(fetched ?? []), ...known]
      .filter((r) => isOn(r.repoPath))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  const searchKey = (e: RepoEntry) => ({
    name: e.name,
    aliases: [e.remoteSlug, e.display].filter((a): a is string => !!a),
    recentAgentCount: e.recentAgentCount,
    lastUsedAt: e.lastUsedAt,
  });

  // Hidden repos count too: hiding is about the Backlog panel, not about Postgres.
  const candidates = $derived(
    text.trim() === ""
      ? []
      : searchRepos(
          text,
          [...byRealPath.values()].filter((e) => !isOn(e.realPath)),
          searchKey,
        ).slice(0, MAX_OPTIONS),
  );
  const showMenu = $derived(menuOpen && candidates.length > 0);
  const activeOption = $derived(
    candidates.length ? Math.min(activeIndex, candidates.length - 1) : 0,
  );

  async function save(repoPath: string, name: string, postgresMode: PostgresMode) {
    const res = await repoConfig.write(repoPath, { postgresMode });
    error = res === null ? m.postgres_repos_save_failed({ repo: name }) : "";
  }

  function add(entry: RepoEntry) {
    text = "";
    menuOpen = false;
    activeIndex = 0;
    inputEl?.focus();
    void save(entry.realPath, entry.name, "on-request");
  }

  // The ✕ leaves with its row, so focus moves to the search field.
  function remove(row: Row) {
    inputEl?.focus();
    void save(row.repoPath, row.name, "off");
  }

  function onInput() {
    activeIndex = 0;
    menuOpen = text.trim() !== "";
  }

  function onArrowDown(e: KeyboardEvent) {
    if (candidates.length === 0) return;
    e.preventDefault();
    if (!menuOpen) menuOpen = true;
    else activeIndex = (activeOption + 1) % candidates.length;
  }
  function onArrowUp(e: KeyboardEvent) {
    if (!showMenu) return;
    e.preventDefault();
    activeIndex = (activeOption - 1 + candidates.length) % candidates.length;
  }
  function onEnter(e: KeyboardEvent) {
    if (!showMenu) return;
    e.preventDefault();
    add(candidates[activeOption]!);
  }
  function onEscape(e: KeyboardEvent) {
    if (!menuOpen) return;
    e.preventDefault();
    menuOpen = false;
  }
  const keyHandlers: Record<string, (e: KeyboardEvent) => void> = {
    ArrowDown: onArrowDown,
    ArrowUp: onArrowUp,
    Enter: onEnter,
    Escape: onEscape,
  };
  function onKeydown(e: KeyboardEvent) {
    keyHandlers[e.key]?.(e);
  }
</script>

<section class="pg-repos" aria-labelledby={titleId}>
  <div class="head">
    <span class="glabel" id={titleId}>
      <HighlightText text={m.postgres_repos_title()} query={q} />
    </span>
    {#if fetched || failed}<span class="count">{rows.length}</span>{/if}
  </div>
  <p class="hint"><HighlightText text={m.postgres_repos_hint()} query={q} /></p>
  {#if !globalEnabled}<p class="hint">{m.postgres_repos_global_off()}</p>{/if}
  {#if failed}<p class="hint">{m.postgres_repos_load_failed()}</p>{/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}

  <div class="body">
    {#if rows.length > 0}
      <ul class="rows">
        {#each rows as r (r.repoPath)}
          <li class="row" data-repo={r.name}>
            <span class="label">
              <span class="name">{r.name}</span>
              {#if modeOf(r.repoPath) === "auto"}
                <span class="badge">{m.postgres_repos_auto_tag()}</span>
              {/if}
            </span>
            <button
              type="button"
              class="tx"
              aria-label={m.postgres_repos_remove_aria({ repo: r.name })}
              onclick={() => remove(r)}
            >
              ✕
            </button>
          </li>
        {/each}
      </ul>
    {:else if fetched}
      <p class="none">{m.postgres_repos_none()}</p>
    {/if}

    <div class="add">
      <input
        bind:this={inputEl}
        class="set-txt"
        type="text"
        role="combobox"
        aria-label={m.postgres_repos_add()}
        aria-expanded={showMenu}
        aria-controls={listboxId}
        aria-activedescendant={showMenu ? `${idBase}-opt-${activeOption}` : undefined}
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
        placeholder={m.postgres_repos_add()}
        bind:value={text}
        oninput={onInput}
        onkeydown={onKeydown}
        onblur={() => (menuOpen = false)}
      />
      {#if showMenu}
        <ul class="typeahead" id={listboxId} role="listbox" aria-label={m.postgres_repos_add()}>
          {#each candidates as entry, i (entry.realPath)}
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
              onclick={() => add(entry)}
            >
              {entry.name}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</section>

<style>
  .pg-repos {
    border-top: 1px solid var(--color-line);
    margin-top: 12px;
    padding: 6px 0 12px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 0 6px;
  }
  .glabel {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .count {
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }
  .hint,
  .none,
  .err {
    margin: 0 0 8px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .none {
    color: var(--color-ink);
  }
  .err {
    color: var(--color-red);
  }
  .body {
    max-width: 420px;
  }
  .rows {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-line);
  }
  .label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  /* the /design-system badge recipe: an inline, read-only micro-label */
  .badge {
    flex: none;
    font-size: var(--fs-micro);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 1px 6px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
  }
  .tx {
    flex: none;
    background: none;
    border: none;
    padding: 2px 6px;
    cursor: pointer;
    color: var(--color-muted);
    font: inherit;
    line-height: 1;
  }
  .tx:hover {
    color: var(--color-red);
  }
  .tx:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .add {
    position: relative;
  }
  .set-txt::placeholder {
    color: var(--color-faint);
  }
  /* anchored, non-blocking typeahead popover — the design system's earned shadow exception */
  .typeahead {
    position: absolute;
    top: 100%;
    left: 0;
    width: 100%;
    z-index: 60;
    list-style: none;
    margin: 4px 0 0;
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
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    color: var(--color-muted);
    cursor: pointer;
  }
  .opt.active {
    background: var(--color-sel);
    color: var(--color-ink-bright);
  }
  @media (max-width: 768px) {
    .tx,
    .opt {
      min-height: 44px;
    }
  }
</style>
