<script lang="ts">
  import { tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { RepoEntry } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { recentRepos } from "$lib/recentRepos";
  import EmojiPicker from "./EmojiPicker.svelte";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";

  let {
    repos,
    value,
    onchange,
    onclone,
    onfork,
    onnewproject,
    onsync,
    windowDays,
    onescape,
    hideHidden = false,
  }: {
    repos: RepoEntry[];
    value: string;
    onchange: (path: string) => void;
    onclone?: () => void;
    onfork?: () => void;
    onnewproject?: () => void;
    /** Sync a fork repo with its upstream. Awaited so the row shows a busy state
     *  while it runs; the parent owns the toast/refresh. Only fork rows expose it. */
    onsync?: (repo: RepoEntry) => Promise<void> | void;
    /** Day count the server computed recentAgentCount over — named in the per-row label. */
    windowDays: number;
    /** Invoked when an open panel is dismissed via Escape, so the parent can restore
     *  focus — e.g. NewTask refocuses its prompt. */
    onescape?: () => void;
    /** Opt-in: drop repos flagged `hidden` from the default list + recents, but reveal
     *  them once a name search matches. Off by default so the other (backlog/steers/card)
     *  RepoSelect consumers are unaffected. */
    hideHidden?: boolean;
  } = $props();

  let open = $state(false);
  let filter = $state("");
  let root = $state<HTMLElement | null>(null);
  let filterInput = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);

  // Roving keyboard cursor: the filter input keeps DOM focus while open, so it
  // drives a virtual active row (aria-activedescendant) the way EmojiPicker does.
  let activeIdx = $state(0);

  // repo path whose emoji picker is currently open (null = none)
  let pickerFor = $state<string | null>(null);

  function setIcon(path: string, emoji: string | null) {
    projectIcons.set(path, emoji).catch(() => {});
    pickerFor = null;
  }

  // Paths with an in-flight fork sync — disables the row's sync button + shows a
  // spinner glyph. SvelteSet is reactive, so direct add/delete re-render the row.
  const syncing = new SvelteSet<string>();
  async function doSync(r: RepoEntry) {
    if (syncing.has(r.path)) return;
    syncing.add(r.path);
    try {
      await onsync?.(r);
    } finally {
      syncing.delete(r.path);
    }
  }

  /** Pluralized "{count} agents run here in the last {days} days" label for a pinned row. */
  function recentAgentsLabel(count: number): string {
    return count === 1
      ? m.reposelect_recent_agents_one({ count, days: windowDays })
      : m.reposelect_recent_agents_other({ count, days: windowDays });
  }

  // Selected-row lookup stays over the FULL list so an already-selected (e.g. relaunch-
  // seeded) repo still renders in the trigger label even when hideHidden drops it from
  // the dropdown.
  const selected = $derived(repos.find((r) => r.path === value) ?? null);

  // Active search term — drives reveal-on-search: with hideHidden on, hidden repos are
  // absent from the empty-search list but reappear once a matching term is typed.
  const searching = $derived(filter.trim() !== "");

  const filtered = $derived(
    repos
      // Hide flagged repos only while not searching; typing a name reveals them so a
      // hidden repo can still be picked to start a task.
      .filter((r) => !hideHidden || searching || !r.hidden)
      .filter((r) =>
        ((r.remoteSlug ?? "") + " " + r.name + " " + r.display)
          .toLowerCase()
          .includes(filter.toLowerCase()),
      ),
  );

  // The top few repos we've run the most agents on lately (desc by count, then by
  // most-recently-used). Only shown when the list isn't being filtered — once the
  // user types, the shortcut just gets in the way of the search they asked for.
  // Filter hidden BEFORE recentRepos' top-N slice so the pinned rows stay index-aligned
  // with NewTask's Alt+digit shortcut (which filters before too) — recentRepos is the
  // single source of truth for both (see recentRepos.ts).
  const recents = $derived(
    searching ? [] : recentRepos(hideHidden ? repos.filter((r) => !r.hidden) : repos),
  );

  // Single option sequence the keyboard cursor walks: pinned recents first, then the
  // full list. Pinned repos intentionally re-appear below — the group is a shortcut,
  // not a filter. `pinned` tags which section a row belongs to for keying + styling.
  const shown = $derived([
    ...recents.map((r) => ({ repo: r, pinned: true })),
    ...filtered.map((r) => ({ repo: r, pinned: false })),
  ]);

  export function openPanel() {
    open = true;
    filter = "";
    const idx = shown.findIndex((row) => row.repo.path === value);
    activeIdx = idx >= 0 ? idx : 0;
    tick().then(scrollActiveIntoView);
  }

  async function toggle() {
    if (open) {
      open = false;
    } else {
      openPanel();
    }
  }

  function pick(path: string) {
    onchange(path);
    open = false;
    pickerFor = null;
    filter = "";
  }

  $effect(() => {
    if (open && filterInput) {
      filterInput.focus({ preventScroll: true });
    }
  });

  // Keep the keyboard cursor in range if an async update (server/WS poll) shrinks
  // `shown` while the panel is open — otherwise activeIdx could point past the end
  // (stale aria-activedescendant, vanished cursor). Typing resets to top via the
  // filter input's oninput; opening points at the selected repo via toggle().
  $effect(() => {
    if (activeIdx > shown.length - 1) activeIdx = Math.max(0, shown.length - 1);
  });

  // Keyboard-driven row navigation from the focused filter input.
  function onFilterKey(e: KeyboardEvent) {
    if (shown.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, shown.length - 1);
        scrollActiveIntoView();
        break;
      case "ArrowUp":
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        scrollActiveIntoView();
        break;
      case "Enter": {
        e.preventDefault();
        const r = shown[activeIdx]?.repo;
        if (r) pick(r.path);
        break;
      }
      // Escape is handled by the root-node keydown listener below, which closes the panel.
    }
  }

  function scrollActiveIntoView() {
    // Rows are looked up by id, not child index — the list interleaves non-option
    // section headers/dividers, so child index no longer tracks the option index.
    const row = listEl?.querySelector(`#rs-opt-${activeIdx}`) as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }

  $effect(() => {
    const node: HTMLElement | null = root;
    if (!node) return;
    // Re-alias after the guard: TS drops the $state null-narrowing inside the closures below.
    const n = node;
    function onKeydown(e: KeyboardEvent) {
      if (e.key !== "Escape" || !open || e.defaultPrevented) return;
      e.preventDefault();
      open = false;
      pickerFor = null;
      filter = "";
      onescape?.();
    }
    function onClick(e: MouseEvent) {
      if (open && !n.contains(e.target as Node)) {
        open = false;
        pickerFor = null;
        filter = "";
      }
    }
    n.addEventListener("keydown", onKeydown);
    window.addEventListener("click", onClick, true);
    return () => {
      n.removeEventListener("keydown", onKeydown);
      window.removeEventListener("click", onClick, true);
    };
  });
</script>

<div class="rs-root" bind:this={root}>
  <button
    type="button"
    class="rs-trigger"
    onclick={toggle}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    {#if selected}
      <span class="rs-emoji" aria-hidden="true">{projectIcons.iconFor(selected.path) ?? "▣"}</span>
      <b>{selected.remoteSlug ?? selected.name}</b>
      <span class="dim">{selected.display}</span>
    {:else}
      <span class="placeholder">{m.reposelect_placeholder()}</span>
    {/if}
    <span class="chevron" class:open>{open ? "▲" : "▼"}</span>
  </button>

  {#if open}
    <div class="rs-panel">
      <input
        bind:this={filterInput}
        bind:value={filter}
        class="rs-filter"
        placeholder={m.reposelect_filter_placeholder()}
        aria-label={m.reposelect_filter_placeholder()}
        type="text"
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-expanded="true"
        aria-controls="rs-listbox"
        aria-autocomplete="list"
        aria-activedescendant={shown.length ? `rs-opt-${activeIdx}` : undefined}
        oninput={() => (activeIdx = 0)}
        onkeydown={onFilterKey}
      />
      <ul class="rs-list" id="rs-listbox" role="listbox" bind:this={listEl}>
        {#each shown as row, i (row.pinned ? "p:" + row.repo.path : "a:" + row.repo.path)}
          {#if row.pinned && i === 0}
            <li class="rs-group-label" role="presentation">{m.reposelect_recent_heading()}</li>
          {/if}
          {#if !row.pinned && recents.length > 0 && i === recents.length}
            <li class="rs-group-sep" role="presentation"></li>
          {/if}
          {@const r = row.repo}
          <li
            id={`rs-opt-${i}`}
            class="rs-row"
            class:active={r.path === value}
            class:kbd-active={i === activeIdx}
            class:recent={row.pinned}
            role="option"
            aria-selected={i === activeIdx}
            tabindex="-1"
            onclick={() => pick(r.path)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") pick(r.path);
            }}
          >
            <button
              type="button"
              class="rs-emoji-btn"
              title={m.reposelect_set_icon()}
              aria-label={m.reposelect_set_icon()}
              onclick={(e) => {
                e.stopPropagation();
                pickerFor = pickerFor === r.path ? null : r.path;
              }}
            >
              {projectIcons.iconFor(r.path) ?? "▣"}
            </button>
            <b>{r.remoteSlug ?? r.name}</b>
            <span class="dim">{r.display}</span>
            {#if row.pinned}
              {@const label = recentAgentsLabel(r.recentAgentCount ?? 0)}
              <span class="rs-count" title={label} aria-label={label}>
                {r.recentAgentCount}
              </span>
            {/if}
            {#if r.isFork && onsync}
              <button
                type="button"
                class="rs-sync-btn"
                title={m.syncfork_action_title()}
                aria-label={m.syncfork_action_title()}
                disabled={syncing.has(r.path)}
                onclick={(e) => {
                  e.stopPropagation();
                  void doSync(r);
                }}
              >
                {syncing.has(r.path) ? "…" : "⟲"}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      <!-- Live region (always mounted + in the a11y tree while open) so screen
           readers hear when a filter yields zero results. Lives outside the
           listbox so that owns only role=option rows; only the text toggles
           (reliable announce), and the .filled padding keeps the empty state at
           zero visual footprint. -->
      <div class="rs-empty" class:filled={shown.length === 0} role="status" aria-live="polite">
        {shown.length === 0 ? m.reposelect_no_matches() : ""}
      </div>
      {#if onclone}
        <button
          type="button"
          class="rs-clone-row"
          onclick={() => {
            open = false;
            filter = "";
            onclone?.();
          }}
        >
          {m.clonerepo_trigger()}
        </button>
      {/if}
      {#if onfork}
        <!-- coachTarget id "fork-row" must match FeatureAnnouncement.targetId in feature-announcements.ts -->
        <button
          type="button"
          class="rs-clone-row"
          use:coachTarget={"fork-row"}
          onclick={() => {
            open = false;
            filter = "";
            onfork?.();
          }}
        >
          {m.forkrepo_trigger()}
        </button>
      {/if}
      {#if onnewproject}
        <!-- coachTarget id "newproject-row" must match FeatureAnnouncement.targetId in feature-announcements.ts -->
        <button
          type="button"
          class="rs-clone-row"
          use:coachTarget={"newproject-row"}
          onclick={() => {
            open = false;
            filter = "";
            onnewproject?.();
          }}
        >
          {m.newproject_trigger()}
        </button>
      {/if}
      {#if pickerFor !== null}
        <div class="rs-picker">
          <EmojiPicker
            value={projectIcons.iconFor(pickerFor)}
            onpick={(emoji) => setIcon(pickerFor!, emoji)}
            onclose={() => (pickerFor = null)}
          />
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .rs-root {
    position: relative;
    width: 100%;
  }

  .rs-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    cursor: pointer;
    text-align: left;
    overflow: hidden;
  }

  .rs-trigger:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  /* keyboard focus only — flat inset ring in the action color, no outer glow.
     :focus-visible keeps mouse clicks from showing the ring. */
  .rs-trigger:focus-visible {
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .rs-trigger b {
    font-weight: 600;
    flex-shrink: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rs-trigger .dim {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .rs-trigger .placeholder {
    color: var(--color-muted);
    font-style: italic;
  }

  .chevron {
    margin-left: auto;
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }

  .rs-panel {
    position: absolute;
    z-index: 50;
    top: calc(100% + 3px);
    left: 0;
    right: 0;
    background: var(--color-panel);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
  }

  .rs-filter {
    background: var(--color-inset);
    border: 0;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 7px 10px;
    border-radius: 0;
    flex-shrink: 0;
  }

  .rs-filter:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  .rs-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .rs-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--color-line);
    font-size: var(--fs-base);
    color: var(--color-ink-bright);
    overflow: hidden;
  }

  .rs-row b {
    flex-shrink: 0;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rs-row:last-child {
    border-bottom: 0;
  }

  .rs-row:hover {
    background: var(--color-hover);
  }

  /* Virtual keyboard cursor — same amber inset ring as EmojiPicker's .ep-cell.active;
     a background shift alone is invisible on desktop (--hover ≈ --panel). */
  .rs-row.kbd-active {
    background: var(--color-sel);
    outline: 1.5px solid var(--color-amber);
    outline-offset: -1.5px;
  }

  .rs-row.active {
    background: color-mix(in srgb, var(--color-amber) 8%, var(--color-panel));
  }

  .rs-row .dim {
    color: var(--color-muted);
    font-size: var(--fs-meta);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* "recently worked on" shortcut group — pinned rows at the top, set apart from
     the full alphabetical list by a heading, a tinted background and a divider. */
  .rs-group-label {
    padding: 6px 10px 4px;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
  }

  .rs-group-sep {
    height: 0;
    border-top: 1px solid var(--color-line-bright);
  }

  .rs-row.recent {
    background: color-mix(in srgb, var(--color-amber) 5%, var(--color-panel));
  }
  .rs-row.recent:hover {
    background: var(--color-hover);
  }
  .rs-row.recent.kbd-active {
    background: var(--color-sel);
    outline: 1.5px solid var(--color-amber);
    outline-offset: -1.5px;
  }
  .rs-row.recent.active {
    background: color-mix(in srgb, var(--color-amber) 12%, var(--color-panel));
  }

  /* Agent-count badge on a pinned recent row — the metric the group is ranked by. */
  .rs-count {
    flex-shrink: 0;
    margin-left: auto;
    min-width: 18px;
    padding: 0 5px;
    text-align: center;
    font-size: var(--fs-meta);
    font-variant-numeric: tabular-nums;
    color: var(--color-amber);
    background: color-mix(in srgb, var(--color-amber) 12%, transparent);
    border-radius: 999px;
  }

  /* Per-fork "sync with upstream" affordance. margin-left:auto right-aligns it on
     rows without a count chip; on rows that have one, the chip claims the free space
     and the button trails it. */
  .rs-sync-btn {
    flex-shrink: 0;
    margin-left: auto;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    font-size: var(--fs-base);
    line-height: 1;
    padding: 1px 5px;
    cursor: pointer;
    color: var(--color-amber);
  }
  .rs-sync-btn:hover {
    border-color: var(--color-line);
  }
  .rs-sync-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .rs-empty {
    color: var(--color-muted);
    font-size: var(--fs-base);
    font-style: italic;
    text-align: center;
  }
  .rs-empty.filled {
    padding: 10px;
  }

  .rs-clone-row {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 7px 10px;
    cursor: pointer;
    border: 0;
    border-top: 1px solid var(--color-line);
    background: transparent;
    font: inherit;
    font-size: var(--fs-base);
    color: var(--color-amber);
    text-align: left;
  }

  .rs-clone-row:hover {
    background: var(--color-hover);
  }

  .rs-emoji {
    flex-shrink: 0;
    font-size: var(--fs-base);
    line-height: 1;
  }
  .rs-emoji-btn {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    font-size: var(--fs-lg);
    line-height: 1;
    padding: 1px 3px;
    cursor: pointer;
    color: var(--color-amber);
  }
  .rs-emoji-btn:hover {
    border-color: var(--color-amber);
    background: var(--color-hover);
  }
  .rs-picker {
    position: absolute;
    z-index: 60;
    left: 8px;
    margin-top: 4px;
  }

  @media (max-width: 768px) {
    .rs-trigger {
      min-height: 44px;
    }
    /* .rs-filter's 16px no-zoom font-size comes from the global iOS guard in app.css */
    .rs-row {
      min-height: 44px;
    }
  }
</style>
