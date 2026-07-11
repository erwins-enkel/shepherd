<script lang="ts">
  import type { AgentProvider, UpNextItem, UpNextSection } from "$lib/types";
  import type { HerdStore } from "$lib/store.svelte";
  import { upNext } from "$lib/up-next.svelte";
  import { refreshUpNext, startUpNext, type UpNextStartChoice } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import { SvelteSet } from "svelte/reactivity";
  import { EMPTY_REPO_FILTER } from "./queue-strip";
  import { onMount } from "svelte";
  import ModelCliPicker from "./new-task/ModelCliPicker.svelte";
  import UpNextSortMenu from "./UpNextSortMenu.svelte";
  import {
    capacitySuggestedProvider,
    claudeUsageHoldLikely,
    readyAgentProviders,
  } from "$lib/provider-capacity";

  type SortMode = "recommended" | "newest" | "oldest" | "title-asc" | "title-desc";
  type RenderGroup = {
    id: string;
    title: string;
    kind: "priority" | "normal" | "repo";
    items: UpNextItem[];
    totalCount: number;
    cap: number;
  };

  // Open the Backlog overlay from the empty state (threaded up through Herd to +page).
  // repoFilter: selected repo paths of the active chip-rail filter (empty = unfiltered) — scopes
  // the queue to those repos, identical to how the session lenses filter. filteredRepo is the
  // pre-computed display name ("N repos" for a multi-selection) for the empty-state copy.
  let {
    onbacklog,
    repoFilter = EMPTY_REPO_FILTER,
    filteredRepo = null,
    launchContext = null,
  }: {
    onbacklog?: () => void;
    repoFilter?: ReadonlySet<string>;
    filteredRepo?: string | null;
    launchContext?: {
      store: Pick<HerdStore, "diagnostics" | "usageLimits">;
      defaultAgentProvider: AgentProvider;
      fableAvailable: boolean;
      upnextSkipCliPicker: boolean;
      usageHoldEnabled: boolean;
      usageHoldPct: number;
      nowMs: number;
    } | null;
  } = $props();

  // On lens-open: repaint the cached snapshot and kick a server recompute (GET /api/up-next
  // triggers a background refresh that lands in place via the upnext:snapshot WS event), so the
  // lens reflects "now" rather than the last app-load — not just on-app-load (#1169 spec).
  onMount(() => {
    sortMode = readStoredSortMode();
    void upNext.load();
  });

  // Display caps mirror src/up-next-core PRIORITY_CAP / REPO_CAP; the server returns the full
  // ranked list and we reveal the rest in place via "show all N".
  const PRIORITY_CAP = 10;
  const REPO_CAP = 5;
  const NORMAL_CAP = 5;
  const SORT_STORAGE_KEY = "shepherd.upnext.sort";
  // Manual starts bypass the per-repo maxAuto drain cap, so a large batch could launch a swarm
  // unintentionally — confirm above this many selected (issue #1169 tunable).
  const CONFIRM_THRESHOLD = 3;
  const SORT_MODES: SortMode[] = ["recommended", "newest", "oldest", "title-asc", "title-desc"];
  const SORT_LABELS: Record<SortMode, () => string> = {
    recommended: m.upnext_sort_recommended,
    newest: m.upnext_sort_newest,
    oldest: m.upnext_sort_oldest,
    "title-asc": m.upnext_sort_title_asc,
    "title-desc": m.upnext_sort_title_desc,
  };
  let sortMode = $state<SortMode>("newest");

  function validSortMode(value: string | null): SortMode {
    return SORT_MODES.includes(value as SortMode) ? (value as SortMode) : "newest";
  }

  function readStoredSortMode(): SortMode {
    try {
      return validSortMode(localStorage.getItem(SORT_STORAGE_KEY));
    } catch {
      return "newest";
    }
  }

  function setSortMode(mode: SortMode) {
    sortMode = mode;
    try {
      localStorage.setItem(SORT_STORAGE_KEY, mode);
    } catch {
      /* storage may be blocked */
    }
  }

  // Sort is a compact icon button opening an anchored listbox menu (see
  // UpNextSortMenu). Rect is captured on open so the portaled menu can position
  // itself under the trigger; the menu handles Esc/outside-click/scroll dismiss.
  let sortBtn = $state<HTMLButtonElement>();
  let sortMenuOpen = $state(false);
  let sortAnchor = $state<DOMRect | null>(null);
  const sortOptions = $derived(
    SORT_MODES.map((mode) => ({ value: mode, label: SORT_LABELS[mode]() })),
  );
  function toggleSortMenu() {
    if (sortMenuOpen) {
      sortMenuOpen = false;
      return;
    }
    if (sortBtn) sortAnchor = sortBtn.getBoundingClientRect();
    sortMenuOpen = true;
  }
  function selectSort(value: string) {
    setSortMode(validSortMode(value));
    sortMenuOpen = false;
  }

  const snap = $derived(upNext.snapshot);
  // The chip-rail repo filter scopes the queue to one repo, identical to the session lenses.
  // Repo sections drop unless they match; the cross-repo priority section keeps only its items
  // from the active repo (re-counting totalCount so "show all N" stays honest).
  const sections = $derived.by(() => {
    const all = snap?.sections ?? [];
    if (repoFilter.size === 0) return all;
    return all
      .map((s): UpNextSection | null => {
        if (s.kind === "repo") return s.repoPath != null && repoFilter.has(s.repoPath) ? s : null;
        const items = s.items.filter((it) => repoFilter.has(it.repoPath));
        return items.length > 0 ? { ...s, items, totalCount: items.length } : null;
      })
      .filter((s): s is UpNextSection => s !== null);
  });
  // Empty ("all caught up") only once the server has actually produced a snapshot; a null/
  // never-computed snapshot shows loading, not the all-clear.
  const computed = $derived(snap?.generatedAt != null);
  // A fetch failure must not masquerade as "all caught up" (#1221), but it also must not blank
  // out work we can still show. Surface the error only when there is nothing to display:
  //   - server-side: repos whose fetch errored AND the (unfiltered) snapshot is empty. Keyed off
  //     snap.sections — not the filtered `sections` — so a legitimately-empty repo filter over a
  //     non-empty queue still reads as "empty", not "failed".
  //   - client-side: the GET itself threw AND there is no usable cached work to render — a failed
  //     lens-open after a successful app-load peek keeps painting the cached queue, not the error.
  const loadFailed = $derived(
    (computed && (snap?.failedRepoCount ?? 0) > 0 && (snap?.sections.length ?? 0) === 0) ||
      (upNext.loadError && sections.length === 0),
  );
  const isEmpty = $derived(computed && !loadFailed && sections.length === 0);
  const updatedAgo = $derived(
    snap?.generatedAt != null ? formatAgo(clock.current - snap.generatedAt) : null,
  );

  // Selection keyed by repoPath#number (issue numbers repeat across repos).
  const keyOf = (it: UpNextItem) => `${it.repoPath}#${it.number}`;
  const selected = new SvelteSet<string>();
  const expanded = new SvelteSet<string>();
  let starting = $state(false);
  let confirmPending = $state(false);

  const sectionKey = (s: UpNextSection) =>
    s.kind === "priority" ? "priority" : (s.repoPath ?? "");
  const capOf = (s: UpNextSection) => (s.kind === "priority" ? PRIORITY_CAP : REPO_CAP);
  const repoBase = (p: string | null) => p?.split("/").filter(Boolean).at(-1) ?? "";
  function sectionTitle(s: UpNextSection): string {
    return s.kind === "priority"
      ? m.upnext_priority_section()
      : (s.repoLabel ?? repoBase(s.repoPath));
  }
  function stableCompare(a: UpNextItem, b: UpNextItem): number {
    return (
      a.repoLabel.localeCompare(b.repoLabel) ||
      a.repoPath.localeCompare(b.repoPath) ||
      a.number - b.number
    );
  }
  function compareItems(a: UpNextItem, b: UpNextItem): number {
    if (sortMode === "newest") return b.createdAt - a.createdAt || stableCompare(a, b);
    if (sortMode === "oldest") return a.createdAt - b.createdAt || stableCompare(a, b);
    if (sortMode === "title-asc") return a.title.localeCompare(b.title) || stableCompare(a, b);
    if (sortMode === "title-desc") return b.title.localeCompare(a.title) || stableCompare(a, b);
    return stableCompare(a, b);
  }
  function sortItems(items: UpNextItem[]): UpNextItem[] {
    return sortMode === "recommended" ? items : [...items].sort(compareItems);
  }
  const renderGroups = $derived.by((): RenderGroup[] => {
    if (sortMode === "recommended") {
      return sections.map((s) => ({
        id: sectionKey(s),
        title: sectionTitle(s),
        kind: s.kind === "priority" ? "priority" : "repo",
        items: s.items,
        totalCount: s.totalCount,
        cap: capOf(s),
      }));
    }

    // Epic rows are aged by their parent epic's createdAt in src/up-next-core.ts,
    // even though the displayed title/number is the next actionable child.
    const all = sections.flatMap((s) => s.items);
    const priority = sortItems(all.filter((it) => it.priority));
    const normal = sortItems(all.filter((it) => !it.priority));
    const groups: RenderGroup[] = [];
    if (priority.length > 0) {
      groups.push({
        id: "priority",
        title: m.upnext_priority_section(),
        kind: "priority",
        items: priority,
        totalCount: priority.length,
        cap: PRIORITY_CAP,
      });
    }
    if (normal.length > 0) {
      groups.push({
        id: "normal",
        title: m.upnext_normal_section(),
        kind: "normal",
        items: normal,
        totalCount: normal.length,
        cap: NORMAL_CAP,
      });
    }
    return groups;
  });
  const visibleRepoCount = $derived(
    new Set(sections.flatMap((s) => s.items.map((it) => it.repoPath))).size,
  );
  const showRepoContext = $derived(sortMode !== "recommended" && visibleRepoCount > 1);
  function shownItems(g: RenderGroup): UpNextItem[] {
    return expanded.has(g.id) ? g.items : g.items.slice(0, g.cap);
  }

  // Selected items still present in the current snapshot (a refresh may have dropped some).
  const selectedItems = $derived(
    renderGroups.flatMap((g) => g.items).filter((it) => selected.has(keyOf(it))),
  );
  const selectedCount = $derived(selectedItems.length);
  const usageLimits = $derived(launchContext?.store.usageLimits ?? null);
  const diagnostics = $derived(launchContext?.store.diagnostics ?? null);
  const defaultAgentProvider = $derived(launchContext?.defaultAgentProvider ?? "claude");
  const fableAvailable = $derived(launchContext?.fableAvailable ?? true);
  const nowMs = $derived(launchContext?.nowMs ?? clock.current);
  const holdLikely = $derived(
    claudeUsageHoldLikely(
      usageLimits,
      launchContext?.usageHoldEnabled ?? false,
      launchContext?.usageHoldPct ?? 80,
    ),
  );
  const heldProviders = $derived(new Set<AgentProvider>(holdLikely ? ["claude"] : []));
  const suggestedProvider = $derived(
    capacitySuggestedProvider(defaultAgentProvider, diagnostics, heldProviders),
  );
  const readyProviders = $derived(readyAgentProviders(diagnostics));
  const skipCliPicker = $derived(launchContext?.upnextSkipCliPicker ?? false);
  let picker = $state<{ items: UpNextItem[]; x: number; y: number; opener: HTMLElement } | null>(
    null,
  );

  function toggle(it: UpNextItem) {
    const k = keyOf(it);
    if (selected.has(k)) selected.delete(k);
    else selected.add(k);
    confirmPending = false; // selection changed — re-confirm if still over threshold
  }
  function toggleExpand(g: RenderGroup) {
    if (expanded.has(g.id)) expanded.delete(g.id);
    else expanded.add(g.id);
  }

  async function doStart(items: UpNextItem[], choice?: UpNextStartChoice) {
    if (starting || items.length === 0) return;
    starting = true;
    confirmPending = false;
    try {
      const res = await startUpNext(
        items.map((it) => ({ repoPath: it.repoPath, issueRef: it.issueRef })),
        choice,
      );
      if (res.created.length > 0) {
        toasts.info(m.upnext_started({ count: res.created.length }), { key: "upnext-started" });
      }
      if (res.held.length > 0) {
        toasts.info(m.upnext_held({ count: res.held.length }), { key: "upnext-held" });
      }
      if (res.errors.length > 0) {
        // Failure surfaced as a 12s alert — tone-namespaced dedupe key so repeats collapse.
        toasts.info(m.upnext_start_failed({ count: res.errors.length }), {
          key: "upnext-start-failed",
          alert: true,
        });
      }
      if (res.created.length === 0 && res.held.length === 0 && res.errors.length === 0) {
        toasts.info(m.upnext_start_failed({ count: items.length }), {
          key: "upnext-start-failed",
          alert: true,
        });
      }
      // Clear only the ones we just started; the WS snapshot refresh removes them shortly.
      for (const it of items) selected.delete(keyOf(it));
    } catch {
      toasts.info(m.upnext_start_failed({ count: items.length }), {
        key: "upnext-start-failed",
        alert: true,
      });
    } finally {
      starting = false;
    }
  }

  function openPicker(items: UpNextItem[], opener: HTMLElement) {
    const r = opener.getBoundingClientRect();
    picker = { items, x: r.left, y: r.bottom + 4, opener };
  }

  function requestStart(items: UpNextItem[], opener: HTMLElement) {
    if (starting || picker || items.length === 0) return;
    if (readyProviders.length >= 2) {
      if (skipCliPicker) {
        void doStart(items, { agentProvider: suggestedProvider });
        return;
      }
      openPicker(items, opener);
      return;
    }
    if (readyProviders.length === 1) {
      void doStart(items, { agentProvider: readyProviders[0]! });
      return;
    }
    void doStart(items);
  }

  function startSelected(e: MouseEvent) {
    if (selectedCount > CONFIRM_THRESHOLD && !confirmPending) {
      confirmPending = true;
      return;
    }
    requestStart(selectedItems, e.currentTarget as HTMLElement);
  }

  function confirmPicker(choice: UpNextStartChoice) {
    const p = picker;
    picker = null;
    if (!p) return;
    void doStart(p.items, choice);
  }

  let refreshing = $state(false);
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshUpNext();
    } catch {
      /* the background loop / WS will still update */
    } finally {
      refreshing = false;
    }
  }
</script>

{#snippet pill(label: string, cls: string)}
  <span class="un-pill {cls}">{label}</span>
{/snippet}

{#snippet row(it: UpNextItem, showRepo: boolean)}
  <li class="un-row">
    <label class="un-check">
      <input
        type="checkbox"
        checked={selected.has(keyOf(it))}
        onchange={() => toggle(it)}
        aria-label={m.upnext_select_aria({ number: it.number, title: it.title })}
      />
    </label>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
    <a class="un-link" href={it.url} target="_blank" rel="noopener noreferrer">
      <span class="un-num">#{it.number}</span>
      <span class="un-title">{it.title}</span>
      {#if showRepo}
        <span class="un-repo">{it.repoLabel || repoBase(it.repoPath)}</span>
      {/if}
    </a>
    <span class="un-pills">
      {#if it.priority}{@render pill(m.upnext_pill_priority(), "un-pill-priority")}{/if}
      {#if it.kind === "epic"}{@render pill(m.upnext_pill_epic(), "un-pill-epic")}{/if}
      {#if it.kind === "bug"}{@render pill(m.upnext_pill_bug(), "un-pill-bug")}{/if}
    </span>
    <span class="un-age">{formatAgo(clock.current - it.createdAt)}</span>
    <button
      type="button"
      class="un-start"
      disabled={starting}
      onclick={(e) => requestStart([it], e.currentTarget as HTMLElement)}
      title={m.upnext_start()}>{m.upnext_start()}</button
    >
  </li>
{/snippet}

<section class="upnext" aria-label={m.upnext_title()}>
  <header class="un-head">
    <span class="un-title-h">{m.upnext_title()}</span>
    {#if updatedAgo}
      <span class="un-updated">{m.upnext_updated_ago({ ago: updatedAgo })}</span>
    {/if}
    <button
      type="button"
      class="un-refresh"
      disabled={refreshing}
      aria-busy={refreshing}
      title={m.upnext_refresh()}
      aria-label={m.upnext_refresh()}
      onclick={refresh}>⟳</button
    >
    <div class="un-sortwrap">
      <button
        bind:this={sortBtn}
        type="button"
        class="un-sortbtn"
        aria-haspopup="listbox"
        aria-expanded={sortMenuOpen}
        title={m.upnext_sort_by({ mode: SORT_LABELS[sortMode]() })}
        aria-label={m.upnext_sort_by({ mode: SORT_LABELS[sortMode]() })}
        onclick={toggleSortMenu}>⇅</button
      >
    </div>
  </header>

  {#if selectedCount > 0}
    <div class="un-batch" role="region" aria-label={m.upnext_batch_aria()}>
      {#if confirmPending}
        <span class="un-confirm-text">{m.upnext_confirm({ count: selectedCount })}</span>
        <button
          type="button"
          class="un-batch-go un-confirm"
          disabled={starting}
          onclick={startSelected}>{m.upnext_confirm_yes()}</button
        >
        <button type="button" class="un-batch-cancel" onclick={() => (confirmPending = false)}
          >{m.common_cancel()}</button
        >
      {:else}
        <button type="button" class="un-batch-go" disabled={starting} onclick={startSelected}
          >{m.upnext_start_selected({ count: selectedCount })}</button
        >
        <button type="button" class="un-batch-cancel" onclick={() => selected.clear()}
          >{m.upnext_clear_selection()}</button
        >
      {/if}
    </div>
  {/if}

  <div class="un-body">
    {#if loadFailed}
      <!-- Fetch failed (GET threw, or every-/some-repo issue fetch errored into an empty queue):
           surface it rather than implying an empty backlog. The header ⟳ retries. -->
      <p class="un-muted">{m.common_issues_load_failed()}</p>
    {:else if !computed}
      <!-- No server snapshot yet (first compute in flight) → loading, never the all-clear. -->
      <p class="un-muted">{m.common_loading()}</p>
    {:else if isEmpty}
      <div class="un-empty">
        <p class="un-muted">
          {filteredRepo ? m.upnext_repo_filter_empty({ repo: filteredRepo }) : m.upnext_empty()}
        </p>
        {#if onbacklog}
          <button type="button" class="un-backlog-link" onclick={() => onbacklog?.()}
            >{m.upnext_open_backlog()}</button
          >
        {/if}
      </div>
    {:else}
      {#each renderGroups as g (g.id)}
        <div class="un-section">
          <p class="un-section-head" class:un-section-head-priority={g.kind === "priority"}>
            {g.title}
          </p>
          <ul class="un-list">
            {#each shownItems(g) as it (keyOf(it))}
              {@render row(it, showRepoContext)}
            {/each}
          </ul>
          {#if g.totalCount > g.cap}
            <button type="button" class="un-expand" onclick={() => toggleExpand(g)}>
              {expanded.has(g.id)
                ? m.upnext_show_less()
                : m.upnext_show_all({ count: g.totalCount })}
            </button>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</section>

{#if sortMenuOpen && sortAnchor}
  <UpNextSortMenu
    anchor={sortAnchor}
    opener={sortBtn}
    current={sortMode}
    options={sortOptions}
    label={m.upnext_sort_aria()}
    onselect={selectSort}
    onclose={() => (sortMenuOpen = false)}
  />
{/if}

{#if picker}
  <ModelCliPicker
    x={picker.x}
    y={picker.y}
    title={m.upnext_picker_title()}
    confirmLabel={m.upnext_picker_confirm()}
    {fableAvailable}
    initialProvider={suggestedProvider}
    {usageLimits}
    {nowMs}
    {holdLikely}
    opener={picker.opener}
    onconfirm={confirmPicker}
    onclose={() => (picker = null)}
  />
{/if}

<style>
  .upnext {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }

  /* Single-line by design: the header never wraps a control to a second line
     (issue: sort ⇅ dropped below the row at narrow mobile widths in the wider
     monospace fallback). nowrap + fixed-size icons; the text spans are the
     shrink valve (min-width:0 + ellipsis), so a too-narrow panel truncates the
     text rather than wrapping a button. Both spans shrink so a valve exists even
     in the loading state, where .un-updated is absent. */
  .un-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--color-line);
  }
  .un-title-h {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .un-updated {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  /* Sort ⇅ trigger sits at the header's right edge; refresh ⟳ stays beside the
     time. Both are compact ~30px controls matching the panel's dense chrome
     (deliberate sub-44px tap targets — waiver noted in the PR). */
  .un-sortwrap {
    flex: none;
    margin-left: auto;
    display: inline-flex;
  }
  .un-refresh,
  .un-sortbtn {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    min-width: 30px;
    padding: 0 7px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-lg);
    line-height: 1;
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .un-refresh:hover:not(:disabled),
  .un-sortbtn:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .un-refresh:focus-visible,
  .un-sortbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .un-refresh:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .un-batch {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--color-line);
    background: var(--color-inset);
    flex-wrap: wrap;
  }
  .un-confirm-text {
    font-size: var(--fs-meta);
    color: var(--color-amber);
  }
  .un-batch-go {
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    padding: 4px 11px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .un-batch-go:hover:not(:disabled) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .un-batch-go:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .un-batch-cancel {
    background: none;
    border: 0;
    color: var(--color-muted);
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
  }
  .un-batch-cancel:hover {
    color: var(--color-ink);
  }

  .un-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px 16px;
  }
  .un-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .un-section-head {
    margin: 0;
    font-size: var(--fs-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
  }
  /* Priority is the cross-repo headline tier — amber, the "needs you / actionable" hue. */
  .un-section-head-priority {
    color: var(--color-amber);
  }

  .un-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .un-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
  }
  .un-check {
    display: flex;
    align-items: center;
  }
  .un-check input {
    cursor: pointer;
  }
  .un-link {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 1;
    text-decoration: none;
    color: var(--color-ink);
  }
  .un-link:hover .un-title {
    color: var(--color-amber);
  }
  .un-num {
    font-size: var(--fs-micro);
    color: var(--color-muted);
    flex: none;
  }
  .un-title {
    font-size: var(--fs-meta);
    color: var(--color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.12s ease;
  }
  .un-repo {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    flex: none;
  }
  .un-pills {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .un-pill {
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 0 4px;
    color: var(--color-muted);
  }
  .un-pill-priority {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .un-pill-bug {
    color: var(--color-red);
    border-color: var(--color-red);
  }
  .un-pill-epic {
    color: var(--color-ink-bright);
    border-color: var(--color-line-bright);
  }
  .un-age {
    font-size: var(--fs-micro);
    color: var(--color-faint);
    flex: none;
  }
  .un-start {
    flex: none;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      border-color 0.12s ease;
  }
  .un-start:hover:not(:disabled) {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .un-start:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  .un-start:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .un-expand {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 2px 0 0;
    font: inherit;
    font-size: var(--fs-micro);
    color: var(--color-muted);
    cursor: pointer;
  }
  .un-expand:hover {
    color: var(--color-amber);
  }

  .un-muted {
    margin: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .un-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .un-backlog-link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-amber);
    cursor: pointer;
    text-decoration: underline;
  }
  .un-backlog-link:hover {
    color: var(--color-amber);
    text-decoration: none;
  }
  .un-backlog-link:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
</style>
