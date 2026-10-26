<script lang="ts">
  import type { UpNextItem, UpNextSection } from "#lib/types.js";
  import { upNext } from "#lib/up-next.svelte.js";
  import { upNextKey as keyOf, upNextPrKey, upNextUi } from "#lib/up-next-ui.svelte.js";
  import { UpNextPrActions } from "#lib/up-next-pr-actions.svelte.js";
  import { UpNextStarter, type UpNextLaunchContext } from "#lib/up-next-start.svelte.js";
  import { refreshUpNext } from "#lib/api.js";
  import { formatAgo } from "#lib/format.js";
  import { clock } from "#lib/now.svelte.js";
  import { m } from "#lib/paraglide/messages.js";
  import { SvelteSet } from "svelte/reactivity";
  import { EMPTY_REPO_FILTER } from "./queue-strip";
  import { onMount } from "svelte";
  import UpNextBand, { type UpNextBandGroup, type UpNextPrBandGroup } from "./UpNextBand.svelte";
  import UpNextBatchBar from "./UpNextBatchBar.svelte";
  import UpNextKindHeader from "./UpNextKindHeader.svelte";
  import UpNextPrBlock from "./UpNextPrBlock.svelte";
  import UpNextReader from "./UpNextReader.svelte";
  import MergeConfirmHost from "./MergeConfirmHost.svelte";
  import { PR_BAND_TONE, prBandGroups, prsInRepos } from "./up-next-prs";
  import { prBandTitle } from "./up-next-pr-copy";
  import UpNextSortMenu from "./UpNextSortMenu.svelte";
  import UpNextStartPicker from "./UpNextStartPicker.svelte";
  import UpNextFilterFlyout from "./UpNextFilterFlyout.svelte";
  import UpNextFilterChips from "./UpNextFilterChips.svelte";
  import UpNextFilteredEmpty from "./UpNextFilteredEmpty.svelte";
  import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";
  import { coachTarget } from "#lib/actions/coachTarget.svelte.js";
  import {
    activeChips,
    activeRuleCount,
    forkRepos,
    hiddenFor,
    labelOptions,
  } from "./up-next-filter";

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
    onsettings = undefined,
  }: {
    onbacklog?: () => void;
    /** Open Settings › Workspace (the default issue filter's full editor, #3019); with
     *  "repo-overrides", at its per-repo exceptions (#3020). */
    onsettings?: (focus?: "repo-overrides") => void;
    repoFilter?: ReadonlySet<string>;
    filteredRepo?: string | null;
    launchContext?: UpNextLaunchContext | null;
    flow?: boolean;
  } = $props();

  // The mounted lens owns demand; closed lenses only remember invalidations.
  onMount(() => {
    sortMode = readStoredSortMode();
    readStoredCollapsed();
    void issueFilterSettings.ensureLoaded();
    return upNext.open();
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
  function toggleCollapsed(g: Pick<RenderGroup, "id">) {
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
  // Waiting PRs (server-classified), scoped by the repo chips like the issues. A PR just merged
  // or handed to a fix session stays hidden until the server's next snapshot drops it.
  const prs = $derived(
    prsInRepos(snap?.pullRequests ?? [], repoFilter).filter(
      (pr) => !upNextUi.hidesActed(upNextPrKey(pr), clock.current),
    ),
  );
  const prGroups = $derived(
    prBandGroups(prs).map((g): UpNextPrBandGroup => ({
      kind: "pr",
      id: `pr:${g.band}`,
      title: prBandTitle(g.band),
      tone: PR_BAND_TONE[g.band],
      items: g.items,
      totalCount: g.items.length,
      cap: LABEL_CAP,
    })),
  );
  const loadFailed = $derived(
    (computed &&
      (snap?.failedRepoCount ?? 0) > 0 &&
      (snap?.sections.length ?? 0) === 0 &&
      (snap?.pullRequests?.length ?? 0) === 0) ||
      (upNext.loadError && sections.length === 0 && prs.length === 0),
  );
  const isEmpty = $derived(computed && !loadFailed && sections.length === 0 && prs.length === 0);

  // The default issue filter (#3018): the server applies it; the panel shows what it hides.
  const filter = $derived(issueFilterSettings.value);
  const ruleCount = $derived(filter ? activeRuleCount(filter) : 0);
  const filterChips = $derived(filter ? activeChips(filter) : []);
  const hidden = $derived(hiddenFor(snap?.filter, repoFilter));
  // hiddenBy covers the whole queue, so the per-rule breakdown only shows unscoped.
  const hiddenBy = $derived(repoFilter.size === 0 ? snap?.filter?.hiddenBy : undefined);
  let panelEl = $state<HTMLElement>();
  let headEl = $state<HTMLElement>();
  let filterBtn = $state<HTMLButtonElement>();
  let chipsEl = $state<HTMLButtonElement>();
  let filterOpen = $state(false);
  function closeFilter() {
    filterOpen = false;
    filterBtn?.focus();
  }
  const updatedAgo = $derived(
    snap?.generatedAt != null ? formatAgo(clock.current - snap.generatedAt) : null,
  );

  // Selection is shared with the main-area preview (its "select" box ticks the same row).
  const selected = upNextUi.selected;
  const expanded = new SvelteSet<string>();
  const starter = new UpNextStarter(() => launchContext);
  const prActions = new UpNextPrActions(() => launchContext);
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
        label: null,
        tone: "var(--color-amber)",
        items: priority,
        totalCount: priority.length,
        cap: PRIORITY_CAP,
      });
    }

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local scratch map, rebuilt per derive
    const bands = new Map<string, { title: string; label: string | null; items: UpNextItem[] }>();
    for (const it of sortItems(all.filter((it) => !it.priority))) {
      const label = bandLabel(it);
      const bandKey = label?.toLowerCase() ?? null;
      const id = LABEL_ID_PREFIX + (bandKey ?? "");
      const band = bands.get(id) ?? {
        title: label ?? m.upnext_unlabeled_section(),
        label,
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
  const issueCount = $derived(renderGroups.reduce((n, g) => n + g.items.length, 0));
  // Under a PR block the issues get their own header — or, filtered away, the filter's note.
  const issueHeader = $derived(prGroups.length > 0 && (renderGroups.length > 0 || hidden > 0));
  const issuesFilteredAway = $derived(
    prGroups.length > 0 && renderGroups.length === 0 && hidden > 0,
  );
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
  // The preview's ‹ › step through the rows in on-screen band order — issues and PRs apart.
  $effect(() => {
    upNextUi.order = renderGroups.flatMap((g) => g.items.map(keyOf));
    upNextUi.prOrder = prGroups.flatMap((g) => g.items.map(upNextPrKey));
  });

  // Selected items still present in the current snapshot (a refresh may have dropped some).
  const selectedItems = $derived(
    renderGroups.flatMap((g) => g.items).filter((it) => selected.has(keyOf(it))),
  );
  const selectedCount = $derived(selectedItems.length);
  const selectedPrs = $derived(prs.filter((pr) => selected.has(upNextPrKey(pr))));
  const selectedPrCount = $derived(selectedPrs.length);
  // Each batch button consumes only its own kind of selection.
  function launchTrain() {
    if (selectedPrCount < 2) return;
    launchContext?.onlaunchtrain?.(selectedPrs);
  }

  function toggle(it: UpNextItem) {
    upNextUi.toggle(keyOf(it));
    confirmPending = false; // selection changed — re-confirm if still over threshold
  }
  function toggleExpand(g: Pick<RenderGroup, "id">) {
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
  <UpNextReader {launchContext} onback={() => (upNextUi.previewKey = null)} />
{:else}
  <section class="upnext" class:flow aria-label={m.upnext_title()} bind:this={panelEl}>
    <header class="un-head" bind:this={headEl}>
      <div class="un-head-text">
        <span class="un-title-h">{m.upnext_title()}</span>
        {#if updatedAgo}
          <span class="un-updated">{m.upnext_updated_ago({ ago: updatedAgo })}</span>
        {/if}
      </div>
      {#if filter}
        <button
          bind:this={filterBtn}
          type="button"
          class={["un-filterbtn", { active: filterOpen || ruleCount > 0 }]}
          aria-haspopup="dialog"
          aria-expanded={filterOpen}
          aria-label={m.upnext_filter_button_aria({ count: ruleCount })}
          title={m.upnext_filter_title()}
          onclick={() => (filterOpen ? closeFilter() : (filterOpen = true))}
          use:coachTarget={"upnext-filter"}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M1.5 2.5h11L8.25 7.4v3.6l-2.5 1.2V7.4L1.5 2.5Z" stroke="currentColor" />
          </svg>
          {#if ruleCount > 0}<span class="badge" aria-hidden="true">{ruleCount}</span>{/if}
        </button>
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

    {#if filterChips.length > 0}
      <UpNextFilterChips
        bind:el={chipsEl}
        chips={filterChips}
        {hidden}
        onopen={() => (filterOpen = true)}
      />
    {/if}

    <div class="un-body">
      {#if loadFailed}
        <!-- Fetch failed (GET threw, or every-/some-repo issue fetch errored into an empty queue):
           surface it rather than implying an empty backlog. The header ⟳ retries. -->
        <p class="un-muted">{m.common_issues_load_failed()}</p>
      {:else if !computed}
        <!-- No server snapshot yet (first compute in flight) → loading, never the all-clear. -->
        <p class="un-muted">{m.common_loading()}</p>
      {:else if isEmpty && hidden > 0}
        <UpNextFilteredEmpty
          {hidden}
          {hiddenBy}
          onadjust={filter ? () => (filterOpen = true) : undefined}
          {onbacklog}
        />
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
        <!-- PRs waiting on the operator lead; the issues follow under their own header. -->
        {#if prGroups.length > 0}
          <UpNextPrBlock
            groups={prGroups}
            count={prs.length}
            showRepo={showRepoContext}
            actions={prActions}
            isOpen={(id) => !collapsed.has(id)}
            isExpanded={(id) => expanded.has(id)}
            onfold={(id) => toggleCollapsed({ id })}
            onexpand={(id) => toggleExpand({ id })}
          />
        {/if}
        {#if issueHeader}
          <UpNextKindHeader
            title={m.upnext_issue_kind_title()}
            sub={m.upnext_issue_kind_sub()}
            count={issueCount}
          />
        {/if}
        {#if issuesFilteredAway}
          <UpNextFilteredEmpty
            {hidden}
            {hiddenBy}
            onadjust={filter ? () => (filterOpen = true) : undefined}
            {onbacklog}
          />
        {/if}
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

    {#if selectedCount > 0 || selectedPrCount > 0}
      <UpNextBatchBar
        issues={selectedCount}
        prs={selectedPrCount}
        {flow}
        confirming={confirmPending}
        starting={starter.starting}
        canTrain={!!launchContext?.onlaunchtrain}
        onclear={() => selected.clear()}
        onstart={startSelected}
        oncancelconfirm={() => (confirmPending = false)}
        ontrain={launchTrain}
      />
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

{#if filterOpen && filter && panelEl && headEl}
  <UpNextFilterFlyout
    reference={flow ? headEl : panelEl}
    trigger={filterBtn}
    inside={[filterBtn, chipsEl]}
    {flow}
    {filter}
    stats={snap?.filter}
    labels={labelOptions(snap, filter.hiddenLabels)}
    forkRepos={forkRepos(snap)}
    onchange={(patch) => void issueFilterSettings.update(patch)}
    onreset={() => void issueFilterSettings.reset()}
    onclose={closeFilter}
    {onsettings}
  />
{/if}

<UpNextStartPicker {starter} />
<MergeConfirmHost flow={prActions.mergeFlow} />

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
     controls matching the panel's dense desktop chrome; on the phone (`flow`) they grow
     to full touch targets (see below). */
  .un-sortwrap {
    flex: none;
    display: inline-flex;
  }
  .un-refresh,
  .un-sortbtn,
  .un-filterbtn {
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
  .un-sortbtn:hover,
  .un-filterbtn:hover {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .un-refresh:focus-visible,
  .un-sortbtn:focus-visible,
  .un-filterbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* Funnel + active-rule badge: the IssueFilterPopover icon-only .filter-chip + .badge recipe. */
  .un-filterbtn {
    gap: 4px;
  }
  .un-filterbtn.active {
    color: var(--color-ink-bright);
    background: var(--color-inset);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-muted);
    font-size: var(--fs-micro);
    font-family: var(--font-mono);
    line-height: 1;
  }
  .un-refresh:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Phone: the page scrolls edge-to-edge and the chrome that owned the top safe-area inset
     slides away on scroll-down — pin band headings below the notch, not under it. */
  .upnext.flow :global(.un-section-head) {
    top: env(safe-area-inset-top, 0px);
  }

  .un-body {
    display: flex;
    flex-direction: column;
  }
  .un-body > .un-muted,
  .un-body > .un-empty {
    padding: 14px;
  }

  /* Phone: every header icon is a full touch target. */
  .upnext.flow .un-refresh,
  .upnext.flow .un-sortbtn,
  .upnext.flow .un-filterbtn {
    height: var(--mobile-actionbar-hit);
    min-width: var(--mobile-actionbar-hit);
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
