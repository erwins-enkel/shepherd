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
  // One tinted band: the cross-repo priority tier, or one label (bug, enhancement, …, none).
  // bandKey is the lower-cased label the band stands for, so rows can drop it from their
  // own label line; tone is the CSS color the band and its heading are tinted with.
  type RenderGroup = {
    id: string;
    title: string;
    bandKey: string | null;
    tone: string;
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
  const LABEL_CAP = 5;
  const BUG_LABEL = "bug";
  const LABEL_ID_PREFIX = "label:";
  // Label bands are series, not status: categorical data hues in first-appearance order.
  // Bug keeps red (a defect is the one label with a status meaning), priority keeps amber.
  const LABEL_TONES = [3, 1, 2, 4, 5, 6].map((n) => `var(--color-data-${n})`);
  const SORT_STORAGE_KEY = "shepherd.upnext.sort";
  // Manual starts bypass the per-repo maxAuto drain cap, so a large batch could launch a swarm
  // unintentionally — confirm above this many selected (issue #1169 tunable).
  const CONFIRM_THRESHOLD = 3;
  const PRIORITY_LABEL = "shepherd:priority";
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

  // The chip-rail repo filter scopes the queue to one repo, identical to the session lenses.
  // Repo sections drop unless they match; the cross-repo priority section keeps only its items
  // from the active repo (re-counting totalCount so "show all N" stays honest). Identity when no
  // repo chip is active.
  function applyRepoFilter(list: UpNextSection[]): UpNextSection[] {
    if (repoFilter.size === 0) return list;
    return list
      .map((s): UpNextSection | null => {
        if (s.kind === "repo") return s.repoPath != null && repoFilter.has(s.repoPath) ? s : null;
        const items = s.items.filter((it) => repoFilter.has(it.repoPath));
        return items.length > 0 ? { ...s, items, totalCount: items.length } : null;
      })
      .filter((s): s is UpNextSection => s !== null);
  }

  const snap = $derived(upNext.snapshot);
  // Blocked/non-startable work is excluded server-side (src/up-next-core.ts) — Up Next only ever
  // lists startable rows — so the panel just applies the repo-chip filter.
  const sections = $derived(applyRepoFilter(snap?.sections ?? []));
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

  const repoBase = (p: string | null) => p?.split("/").filter(Boolean).at(-1) ?? "";
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
  // The label a non-priority row is banded under: bug wins, else its first remaining label.
  function bandLabel(it: UpNextItem): string | null {
    const labels = displayLabels(it);
    return labels.find((label) => label.toLowerCase() === BUG_LABEL) ?? labels[0] ?? null;
  }

  // Bands: priority first, then one per label — bug leading, the rest in first-appearance
  // order of the sorted queue, unlabeled work last. "Recommended" keeps the server rank
  // (priority tier, then repos in warm order) inside each band; the other modes sort it.
  // Epic rows are aged by their parent epic's createdAt in src/up-next-core.ts,
  // even though the displayed title/number is the next actionable child.
  const renderGroups = $derived.by((): RenderGroup[] => {
    const all = sections.flatMap((s) => s.items);
    const groups: RenderGroup[] = [];
    const priority = sortItems(all.filter((it) => it.priority));
    if (priority.length > 0) {
      groups.push({
        id: "priority",
        title: m.upnext_priority_section(),
        bandKey: null,
        tone: "var(--color-amber)",
        items: priority,
        totalCount: priority.length,
        cap: PRIORITY_CAP,
      });
    }

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch map, rebuilt per derive
    const bands = new Map<string, { title: string; bandKey: string | null; items: UpNextItem[] }>();
    for (const it of sortItems(all.filter((it) => !it.priority))) {
      const label = bandLabel(it);
      const bandKey = label?.toLowerCase() ?? null;
      const id = LABEL_ID_PREFIX + (bandKey ?? "");
      const band = bands.get(id) ?? {
        title: label ?? m.upnext_unlabeled_section(),
        bandKey,
        items: [],
      };
      band.items.push(it);
      bands.set(id, band);
    }
    const rank = (id: string) =>
      id === LABEL_ID_PREFIX + BUG_LABEL ? 0 : id === LABEL_ID_PREFIX ? 2 : 1;
    let toneIndex = 0;
    for (const [id, band] of [...bands].sort(([a], [b]) => rank(a) - rank(b))) {
      const tone =
        band.bandKey === BUG_LABEL
          ? "var(--color-red)"
          : band.bandKey === null
            ? "var(--color-muted)"
            : LABEL_TONES[toneIndex++ % LABEL_TONES.length]!;
      groups.push({
        id,
        ...band,
        tone,
        totalCount: band.items.length,
        cap: LABEL_CAP,
      });
    }
    return groups;
  });
  const visibleRepoCount = $derived(
    new Set(sections.flatMap((s) => s.items.map((it) => it.repoPath))).size,
  );
  // Bands mix repos, so a row names its repo whenever more than one is on screen.
  const showRepoContext = $derived(visibleRepoCount > 1);
  function shownItems(g: RenderGroup): UpNextItem[] {
    return expanded.has(g.id) ? g.items : g.items.slice(0, g.cap);
  }

  // Priority and epic are Up Next workflow badges, so suppress their exact forge
  // label duplicates while retaining every other real label and color.
  function displayLabels(it: UpNextItem): string[] {
    return it.labels.filter((label) => {
      const normalized = label.toLowerCase();
      if (normalized === PRIORITY_LABEL) return false;
      return !(it.kind === "epic" && normalized === "epic");
    });
  }
  // A row's own label line leaves out the label its band already names.
  function rowLabels(it: UpNextItem, g: RenderGroup): string[] {
    return displayLabels(it).filter((label) => label.toLowerCase() !== g.bandKey);
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

{#snippet row(it: UpNextItem, g: RenderGroup, showRepo: boolean)}
  {@const labels = rowLabels(it, g)}
  <li class="un-row" class:un-row-selected={selected.has(keyOf(it))}>
    <label class="un-check">
      <input
        type="checkbox"
        checked={selected.has(keyOf(it))}
        onchange={() => toggle(it)}
        aria-label={m.upnext_select_aria({ number: it.number, title: it.title })}
      />
    </label>
    <div class="un-main">
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external forge URL, not an app route -->
      <a class="un-link" href={it.url} target="_blank" rel="noopener noreferrer">{it.title}</a>
      {#if showRepo || it.kind === "epic" || labels.length > 0}
        <span class="un-sub">
          {#if it.kind === "epic"}<span class="un-pill">{m.upnext_pill_epic()}</span>{/if}
          {#if showRepo}<span>{it.repoLabel || repoBase(it.repoPath)}</span>{/if}
          {#each labels as label (label)}<span>{label}</span>{/each}
        </span>
      {/if}
    </div>
    <span class="un-meta">
      <span class="un-num">#{it.number}</span>
      <span class="un-age">{formatAgo(clock.current - it.createdAt)}</span>
    </span>
  </li>
{/snippet}

<section class="upnext" aria-label={m.upnext_title()}>
  <header class="un-head">
    <div class="un-head-text">
      <span class="un-title-h">{m.upnext_title()}</span>
      {#if updatedAgo}
        <span class="un-updated">{m.upnext_updated_ago({ ago: updatedAgo })}</span>
      {/if}
    </div>
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
          {#if filteredRepo}
            {m.upnext_repo_filter_empty({ repo: filteredRepo })}
          {:else}
            {m.upnext_empty()}
          {/if}
        </p>
        {#if onbacklog}
          <button type="button" class="un-backlog-link" onclick={() => onbacklog?.()}
            >{m.upnext_open_backlog()}</button
          >
        {/if}
      </div>
    {:else}
      {#each renderGroups as g (g.id)}
        <div class="un-section" style:--band={g.tone}>
          <p class="un-section-head">
            <span class="un-section-title">{g.title}</span>
            <span class="un-section-count">{g.totalCount}</span>
          </p>
          <ul class="un-list">
            {#each shownItems(g) as it (keyOf(it))}
              {@render row(it, g, showRepoContext)}
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
        <span class="un-batch-count">{m.upnext_selected_count({ count: selectedCount })}</span>
        <button type="button" class="un-batch-cancel" onclick={() => selected.clear()}
          >{m.upnext_clear_selection()}</button
        >
        <button type="button" class="un-batch-go" disabled={starting} onclick={startSelected}
          >{m.upnext_start_selected({ count: selectedCount })}</button
        >
      {/if}
    </div>
  {/if}
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
     monospace fallback). nowrap + fixed-size icons; the stacked title/updated
     text is the shrink valve (min-width:0 + ellipsis per line), so a too-narrow
     panel truncates text rather than wrapping a button. */
  .un-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--color-line);
  }
  .un-head-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .un-title-h,
  .un-updated {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-meta);
  }
  .un-title-h {
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-ink-bright);
    font-weight: 700;
  }
  .un-updated {
    color: var(--color-muted);
  }
  /* Refresh ⟳ and sort ⇅ sit at the header's right edge. Both are compact ~30px
     controls matching the panel's dense chrome (deliberate sub-44px tap targets —
     waiver noted in the PR). */
  .un-sortwrap {
    flex: none;
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

  /* Starting always goes through this bar: tick rows, then start them. Sticky to
     the bottom of the .upnext scroll container so it stays reachable however
     deep in a long list the last row was ticked. */
  .un-batch {
    position: sticky;
    bottom: 0;
    z-index: 2;
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 8px 14px;
    border-top: 1px solid var(--color-line-bright);
    background: var(--color-inset);
    flex-wrap: wrap;
  }
  .un-batch-count {
    flex: 1;
    font-size: var(--fs-meta);
    color: var(--color-ink);
  }
  .un-confirm-text {
    flex: 1;
    font-size: var(--fs-meta);
    color: var(--color-amber);
  }
  .un-batch-go {
    min-height: 32px;
    background: transparent;
    border: 1px solid var(--color-amber);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    font-weight: 700;
    padding: 4px 12px;
    cursor: pointer;
    transition:
      color 0.12s ease,
      background 0.12s ease;
  }
  .un-batch-go:hover:not(:disabled) {
    background: var(--color-amber);
    color: var(--color-bg);
  }
  .un-batch-go:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
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
  }
  .un-body > .un-muted,
  .un-body > .un-empty {
    padding: 14px;
  }

  /* One band per group, tinted with its --band tone (set inline per group). */
  .un-section {
    display: flex;
    flex-direction: column;
  }
  .un-section-head {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 7px 14px;
    font-size: var(--fs-micro);
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--band);
    background: color-mix(in srgb, var(--band) 9%, var(--color-panel));
    border-block: 1px solid color-mix(in srgb, var(--band) 26%, var(--color-panel));
  }
  .un-section-title {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .un-section-count {
    flex: none;
    letter-spacing: 0;
  }

  .un-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  /* The title owns the row's width and wraps instead of truncating; number and age
     move to a narrow right-aligned column so nothing competes with it. */
  .un-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--color-line);
    transition: background 0.12s;
  }
  .un-row:hover,
  .un-row:focus-within {
    background: var(--color-hover);
  }
  .un-row.un-row-selected {
    background: var(--color-sel);
  }
  .un-check {
    flex: none;
    display: flex;
    align-items: center;
    padding-top: 2px;
  }
  .un-check input {
    margin: 0;
    accent-color: var(--color-amber);
    cursor: pointer;
  }
  .un-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .un-link {
    font-size: var(--fs-base);
    line-height: 1.45;
    color: var(--color-ink-bright);
    text-decoration: none;
    overflow-wrap: anywhere;
    transition: color 0.12s ease;
  }
  .un-link:hover {
    color: var(--color-amber);
  }
  .un-link:focus-visible {
    outline: none;
    box-shadow: 0 1px 0 var(--color-amber);
  }
  .un-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .un-pill {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 0 4px;
    color: var(--color-ink-bright);
  }
  .un-meta {
    flex: none;
    min-width: 5ch;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    padding-top: 2px;
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .un-age {
    color: var(--color-faint);
  }

  @media (max-width: 768px), (pointer: coarse) {
    .un-check {
      justify-content: center;
      min-width: var(--mobile-actionbar-hit);
      min-height: var(--mobile-actionbar-hit);
      padding-top: 0;
    }
    .un-link {
      display: flex;
      align-items: center;
      min-height: var(--mobile-actionbar-hit);
    }
    .un-batch-go {
      min-height: var(--mobile-actionbar-hit);
    }
  }

  .un-expand {
    align-self: flex-start;
    background: none;
    border: 0;
    padding: 8px 14px;
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
  .un-empty .un-muted {
    padding: 0;
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
