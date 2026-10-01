<script lang="ts">
  import type { UpNextItem, UpNextSection } from "$lib/types";
  import { upNext } from "$lib/up-next.svelte";
  import { upNextKey as keyOf, upNextUi } from "$lib/up-next-ui.svelte";
  import { UpNextStarter, type UpNextLaunchContext } from "$lib/up-next-start.svelte";
  import { refreshUpNext } from "$lib/api";
  import { formatAgo } from "$lib/format";
  import { clock } from "$lib/now.svelte";
  import { m } from "$lib/paraglide/messages";
  import { SvelteSet } from "svelte/reactivity";
  import { EMPTY_REPO_FILTER } from "./queue-strip";
  import { onMount } from "svelte";
  import UpNextBand, { type UpNextBandGroup } from "./UpNextBand.svelte";
  import UpNextPreview from "./UpNextPreview.svelte";
  import UpNextSortMenu from "./UpNextSortMenu.svelte";
  import UpNextStartPicker from "./UpNextStartPicker.svelte";

  type SortMode = "recommended" | "newest" | "oldest" | "title-asc" | "title-desc";
  type RenderGroup = UpNextBandGroup;

  // Open the Backlog overlay from the empty state (threaded up through Herd to +page).
  // repoFilter: selected repo paths of the active chip-rail filter (empty = unfiltered) — scopes
  // the queue to those repos, identical to how the session lenses filter. filteredRepo is the
  // pre-computed display name ("N repos" for a multi-selection) for the empty-state copy.
  // flow: the phone's stacked list — there is no main area beside it, so the preview a title
  // click opens swaps in place of the list instead (desktop renders it in +page's main area).
  let {
    onbacklog,
    repoFilter = EMPTY_REPO_FILTER,
    filteredRepo = null,
    launchContext = null,
    flow = false,
  }: {
    onbacklog?: () => void;
    repoFilter?: ReadonlySet<string>;
    filteredRepo?: string | null;
    launchContext?: UpNextLaunchContext | null;
    flow?: boolean;
  } = $props();

  // On lens-open: repaint the cached snapshot and kick a server recompute (GET /api/up-next
  // triggers a background refresh that lands in place via the upnext:snapshot WS event), so the
  // lens reflects "now" rather than the last app-load — not just on-app-load (#1169 spec).
  onMount(() => {
    sortMode = readStoredSortMode();
    readStoredCollapsed();
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
  const COLLAPSED_STORAGE_KEY = "shepherd.upnext.collapsed";
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

  // Bands the operator folded away, by group id; remembered like the sort mode.
  const collapsed = new SvelteSet<string>();
  function readStoredCollapsed() {
    try {
      const ids: unknown = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]");
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") collapsed.add(id);
    } catch {
      /* storage may be blocked or hold junk */
    }
  }
  function toggleCollapsed(g: RenderGroup) {
    if (collapsed.has(g.id)) collapsed.delete(g.id);
    else collapsed.add(g.id);
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed]));
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

  // Selection is shared with the main-area preview (its "select" box ticks the same row).
  const selected = upNextUi.selected;
  const expanded = new SvelteSet<string>();
  const starter = new UpNextStarter(() => launchContext);
  let confirmPending = $state(false);

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
        tone: "var(--color-amber)",
        items: priority,
        totalCount: priority.length,
        cap: PRIORITY_CAP,
      });
    }

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch map, rebuilt per derive
    const bands = new Map<string, { title: string; items: UpNextItem[] }>();
    for (const it of sortItems(all.filter((it) => !it.priority))) {
      const label = bandLabel(it);
      const bandKey = label?.toLowerCase() ?? null;
      const id = LABEL_ID_PREFIX + (bandKey ?? "");
      const band = bands.get(id) ?? { title: label ?? m.upnext_unlabeled_section(), items: [] };
      band.items.push(it);
      bands.set(id, band);
    }
    const rank = (id: string) =>
      id === LABEL_ID_PREFIX + BUG_LABEL ? 0 : id === LABEL_ID_PREFIX ? 2 : 1;
    let toneIndex = 0;
    for (const [id, band] of [...bands].sort(([a], [b]) => rank(a) - rank(b))) {
      const tone =
        id === LABEL_ID_PREFIX + BUG_LABEL
          ? "var(--color-red)"
          : id === LABEL_ID_PREFIX
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

  // Priority and epic are Up Next workflow badges, so suppress their exact forge
  // label duplicates while retaining every other real label and color.
  function displayLabels(it: UpNextItem): string[] {
    return it.labels.filter((label) => {
      const normalized = label.toLowerCase();
      if (normalized === PRIORITY_LABEL) return false;
      return !(it.kind === "epic" && normalized === "epic");
    });
  }
  // The preview's ‹ › step through the rows in on-screen band order.
  $effect(() => {
    upNextUi.order = renderGroups.flatMap((g) => g.items.map(keyOf));
  });

  // Selected items still present in the current snapshot (a refresh may have dropped some).
  const selectedItems = $derived(
    renderGroups.flatMap((g) => g.items).filter((it) => selected.has(keyOf(it))),
  );
  const selectedCount = $derived(selectedItems.length);

  function toggle(it: UpNextItem) {
    upNextUi.toggle(keyOf(it));
    confirmPending = false; // selection changed — re-confirm if still over threshold
  }
  function toggleExpand(g: RenderGroup) {
    if (expanded.has(g.id)) expanded.delete(g.id);
    else expanded.add(g.id);
  }

  function startSelected(e: MouseEvent) {
    if (selectedCount > CONFIRM_THRESHOLD && !confirmPending) {
      confirmPending = true;
      return;
    }
    confirmPending = false;
    starter.request(selectedItems, e.currentTarget as HTMLElement);
  }

  // On the phone the preview takes the list's place (see `flow`).
  const flowPreview = $derived(flow && upNextUi.previewKey !== null);

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

{#if flowPreview}
  <UpNextPreview {launchContext} onback={() => (upNextUi.previewKey = null)} />
{:else}
  <section class="upnext" class:flow aria-label={m.upnext_title()}>
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
          <UpNextBand
            group={g}
            open={!collapsed.has(g.id)}
            expanded={expanded.has(g.id)}
            showRepo={showRepoContext}
            labelsOf={displayLabels}
            onfold={() => toggleCollapsed(g)}
            onexpand={() => toggleExpand(g)}
            ontick={toggle}
          />
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
            disabled={starter.starting}
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
          <button
            type="button"
            class="un-batch-go"
            disabled={starter.starting}
            onclick={startSelected}>{m.upnext_start_selected({ count: selectedCount })}</button
          >
        {/if}
      </div>
    {/if}
  </section>
{/if}

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

<UpNextStartPicker {starter} />

<style>
  /* No overflow of its own: the Herd's .units scrolls, so the sticky batch bar binds to that
     scrollport. A scroll container here never scrolled (it grows to its content), which left
     the bar parked after the last row instead of on screen. */
  .upnext {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
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

  /* Starting a batch goes through this bar: tick rows, then start them. Sticky to the
     bottom of the visible list so it stays reachable however deep the last tick was. */
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
  /* Phone: the page scrolls and the fixed ActionBar covers its bottom edge — stick above it. */
  .upnext.flow .un-batch {
    bottom: calc(
      var(--mobile-actionbar-h) + max(var(--mobile-actionbar-pad), env(safe-area-inset-bottom))
    );
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

  @media (max-width: 768px), (pointer: coarse) {
    .un-batch-go {
      min-height: var(--mobile-actionbar-hit);
    }
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
