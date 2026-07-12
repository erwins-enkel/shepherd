<script lang="ts">
  import { listIssues, getEpics, getEpic } from "$lib/api";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";
  import type { Issue, Steer, EpicSummary, Epic, DrainStatus } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import {
    filterIssues,
    hideOthers,
    hideActive,
    hideSubIssues,
    sortEpicsFirst,
    filterByAuthor,
    filterByLabels,
    distinctAuthors,
    distinctLabels,
    labelColorMap,
  } from "./issues-panel";
  import { issuesFilter } from "$lib/issues-filter.svelte";
  import { backlogRefresh } from "$lib/backlog-refresh.svelte";
  import IssueRow from "./issues-panel/IssueRow.svelte";
  import IssueFilterPopover from "./IssueFilterPopover.svelte";
  import RepoLink from "./RepoLink.svelte";
  import { SvelteSet, SvelteMap } from "svelte/reactivity";
  import { tick, untrack } from "svelte";

  // ACTIVE_LABEL (used in IssueRow) is the label the drain stamps on an issue it has
  // claimed (auto session or human-linked task). Highlighted so a claimed issue reads
  // as "already taken" at a glance in the backlog.

  let {
    repoPath,
    onnewtask,
    onquick = undefined,
    bodyPreview = false,
    age = false,
    epics = undefined,
    drain = null,
    expandEpic = null,
  }: {
    repoPath: string;
    onnewtask: (issue: Issue) => void;
    /** Quick-launch: spawn a session with the picked issue action's prompt + this
     *  issue, skipping the New Task dialog. Omitted → no action buttons are shown. */
    onquick?: (issue: Issue, action: Steer) => void;
    bodyPreview?: boolean;
    age?: boolean;
    /** Live epic record from the store, keyed `${repoPath}#${parentIssueNumber}`.
     *  When present, WS-pushed updates refresh open panels without a re-fetch. */
    epics?: Record<string, Epic>;
    /** This repo's live drain status — forwarded to an expanded epic row's panel so it
     *  can surface the hold reason. Null when disabled / unknown. */
    drain?: DrainStatus | null;
    /** When set (e.g. from an EPIC badge click), expand that epic's row and scroll
     *  it into view — used to land the user on a specific epic in the backlog. */
    expandEpic?: number | null;
  } = $props();

  // Issue-scoped steers render as one quick-launch button each on every row.
  // Also gated to steers bound to this panel's repo (or universal ones).
  const issueActions = $derived(
    steers.list.filter((s) => s.onIssues && steerAppliesToRepo(s, repos.nameFor(repoPath))),
  );

  let issues = $state<Issue[]>([]);
  let slug = $state<string | null>(null);
  let repoUrl = $state<string | null>(null);
  let viewer = $state<string | null>(null);
  let loading = $state(true);
  // True when the forge listing failed (rate-limited gh, network, un-authed CLI):
  // the empty issues[] is a fetch failure, not a genuine zero. Mirrors
  // PromptSources — distinguishes "couldn't load" from "no open issues".
  let loadError = $state(false);
  let filter = $state("");
  // Repo-scoped author + label filters. Selection is local (not the global issuesFilter
  // store) because the option sets are repo-specific; reset on repo change and pruned on
  // refresh (see the reconcile effect below). Options are derived from the RAW `issues`
  // list so picking one value doesn't drop the others from the picker.
  let selectedAuthor = $state<string | null>(null);
  const selectedLabels = new SvelteSet<string>();
  let availableAuthors = $derived(distinctAuthors(issues));
  let availableLabels = $derived(distinctLabels(issues));
  let labelColorsMap = $derived(labelColorMap(issues));
  // Epic summaries for this repo: number → EpicSummary.
  let epicByNumber = $state<Map<number, EpicSummary>>(new Map());
  let nativeSubIssues = $state<Set<number>>(new Set());
  let epicsLoaded = $state(false);
  // True once a getEpics attempt for this repo has SETTLED (success or failure), so the
  // epic-first sort is final. Gates the targeted expand-scroll below: scrolling before
  // the sort settles would center the epic at a provisional (un-pinned) position that the
  // re-sort then yanks away, stranding the viewport among unrelated issues. Reset (→false)
  // ONLY on repo change; set (→true) in EVERY getEpics settle (mount + softRefresh, then +
  // catch, inside the rp/ticket guard) so a backlogRefresh bump that supersedes the mount
  // fetch mid-navigation still flips it via the winning fetch — never latched false.
  let epicsSettled = $state(false);
  // Compose the assignee filter (#824) → "hide in progress" filter → sub-issue filter → text filter.
  // The mine chip only shows when `viewer` is known, so hideOthers is a no-op
  // identity otherwise (fail open); hideActive is viewer-agnostic.
  let assigneeFiltered = $derived(hideOthers(issues, viewer, issuesFilter.hideOthers));
  // Expose per-issue assignees on the rows whenever the mine & unassigned filter (#824)
  // isn't hiding others' issues — i.e. when it's toggled off, or fails open because the
  // viewer is unknown. With the filter active, every visible issue is mine-or-unassigned,
  // so an assignee chip would be redundant.
  let showAssignees = $derived(!issuesFilter.hideOthers || viewer == null);
  let activeFiltered = $derived(hideActive(assigneeFiltered, issuesFilter.hideActive));
  let epicParentNums = $derived(new Set(epicByNumber.keys()));
  let subFiltered = $derived(
    hideSubIssues(
      activeFiltered,
      issuesFilter.hideSubIssues && epicsLoaded,
      nativeSubIssues,
      epicParentNums,
    ),
  );
  // Author + label filters (repo-scoped), applied AFTER the toggle filters and BEFORE the
  // text search. Kept as a named intermediate so the empty-state block can attribute a miss
  // to the structured filters (this being empty) vs. the text search (this non-empty but
  // visibleIssues empty).
  let authorLabelFiltered = $derived(
    filterByLabels(filterByAuthor(subFiltered, selectedAuthor), selectedLabels),
  );

  // Prune any selected author/label that a refresh removed from the current issue set.
  // Without this, an absent-but-selected value keeps filtering while its picker entry is
  // gone (the popover only renders present options), stranding the list unclearable. Keyed
  // on the derived option sets (which depend on `issues`, not on the selection), so it can't
  // loop; writes are untracked. A still-present selection that merely drops the author list
  // below the popover's >=2 threshold is handled there (the section stays rendered).
  $effect(() => {
    const authors = availableAuthors;
    const labels = availableLabels;
    untrack(() => {
      if (selectedAuthor != null && !authors.includes(selectedAuthor)) selectedAuthor = null;
      for (const label of [...selectedLabels]) {
        if (!labels.includes(label)) selectedLabels.delete(label);
      }
    });
  });
  // Epic parents float to the top of the backlog (stable within each group), so
  // epics are the first thing the operator sees. Applied after text filtering.
  //
  // Force-include the navigated-to epic (expandEpic): an explicit "go to this epic" must
  // always land on it, even when a toggle filter (hideOthers / hideActive / hideSubIssues)
  // would drop its parent row. Deduped — only re-added when it actually fell out of
  // subFiltered — so the {#each} key and the epic-issue-row-<n> DOM id stay unique. Added
  // BEFORE filterIssues so the TEXT search still applies (at navigation time `filter` is
  // "" from the repo-change reset); sortEpicsFirst then pins it to the top once epics settle.
  let visibleIssues = $derived.by(() => {
    const base =
      expandEpic != null && !authorLabelFiltered.some((i) => i.number === expandEpic)
        ? [...issues.filter((i) => i.number === expandEpic), ...authorLabelFiltered]
        : authorLabelFiltered;
    return sortEpicsFirst(filterIssues(base, filter), epicParentNums);
  });
  // True when there ARE open issues but the assignee filter hid them all — drives
  // the distinct "all assigned to others" empty state (vs the text no-match state).
  let allHiddenByAssignee = $derived(
    issues.length > 0 && assigneeFiltered.length === 0 && viewer != null && issuesFilter.hideOthers,
  );
  // The active filter emptied the remainder the assignee filter left behind.
  let allHiddenByActive = $derived(
    !allHiddenByAssignee &&
      assigneeFiltered.length > 0 &&
      activeFiltered.length === 0 &&
      issuesFilter.hideActive,
  );
  // The sub-issue filter emptied the remainder the active filter left behind.
  let allHiddenBySubIssues = $derived(
    !allHiddenByAssignee &&
      !allHiddenByActive &&
      activeFiltered.length > 0 &&
      subFiltered.length === 0 &&
      issuesFilter.hideSubIssues &&
      epicsLoaded,
  );
  // Set of expanded epic issue numbers (SvelteSet for fine-grained reactivity).
  const expanded = new SvelteSet<number>();
  let defaultEpicSeeded = $state(false);
  // One-shot fetch cache: issue number → fetched Epic (avoids re-fetching on re-render).
  const fetched = new SvelteMap<number, Epic>();

  // Fetch sequence tokens: the soft refresh below runs the SAME requests concurrently
  // with a possibly still-in-flight mount/repo-change fetch for the SAME repo, so the
  // `rp !== repoPath` guard alone can't stop a late-settling older request from
  // clobbering a newer result (or its .catch from stamping loadError over fresh
  // data). Every fetch takes a ticket; only the holder of the latest ticket applies.
  // Plain (non-reactive) counters on purpose — they're guards, not UI state.
  let issuesSeq = 0;
  let epicsSeq = 0;

  $effect(() => {
    const rp = repoPath;
    loading = true;
    loadError = false;
    filter = "";
    selectedAuthor = null;
    selectedLabels.clear();
    expanded.clear();
    defaultEpicSeeded = false;
    epicByNumber = new Map();
    nativeSubIssues = new Set();
    epicsLoaded = false;
    epicsSettled = false;
    fetched.clear();
    epicFetchSeq.clear();
    epicFetchPending.clear();
    const issuesTicket = ++issuesSeq;
    listIssues(rp)
      .then((r) => {
        if (rp !== repoPath || issuesTicket !== issuesSeq) return;
        slug = r.slug;
        repoUrl = r.webUrl;
        issues = r.issues;
        viewer = r.viewer;
        loadError = r.error != null;
        loading = false;
      })
      .catch(() => {
        // Mirror the success path's staleness guard: a rejection from a
        // previously-selected repo (or a superseded request) must not stamp a
        // sticky load-failed banner onto the data now showing.
        if (rp !== repoPath || issuesTicket !== issuesSeq) return;
        loadError = true;
        loading = false;
      });
    const epicsTicket = ++epicsSeq;
    getEpics(rp)
      .then((r) => {
        if (rp !== repoPath || epicsTicket !== epicsSeq) return;
        epicByNumber = new Map(r.epics.map((s) => [s.parentIssueNumber, s]));
        nativeSubIssues = new Set(r.subIssues);
        epicsLoaded = true;
        epicsSettled = true;
      })
      .catch(() => {
        // Epics are an enhancement, not blocking — but the sort is now final (empty),
        // so mark settled (guarded like the success path) to release the epic-scroll.
        if (rp !== repoPath || epicsTicket !== epicsSeq) return;
        epicsSettled = true;
      });
  });

  // Soft refresh on the global backlogRefresh nonce (bumped by +page's resync() on
  // tab wake / socket re-open): re-pull issues + epic summaries + expanded epic
  // panels WITHOUT the hard reset above — filter text, expanded rows and the
  // rendered list survive; old data stays on screen until (and unless) fresh data
  // lands. The latch swallows the effect's FIRST execution per mount: the nonce is
  // page-lifetime, so the {#if}-mounted drawer routinely mounts with nonce > 0
  // right after the repoPath effect already fetched — a `nonce === 0` check would
  // double-fetch on every open after the first wake. Plain variable on purpose:
  // it's a latch, not UI state. untrack keys the effect on the nonce alone.
  let lastSeenNonce: number | undefined;
  $effect(() => {
    const n = backlogRefresh.nonce;
    if (lastSeenNonce === undefined || n === lastSeenNonce) {
      lastSeenNonce = n;
      return;
    }
    lastSeenNonce = n;
    untrack(() => softRefresh(repoPath));
  });

  function softRefresh(rp: string) {
    const issuesTicket = ++issuesSeq;
    listIssues(rp)
      .then((r) => {
        if (rp !== repoPath || issuesTicket !== issuesSeq) return;
        // Apply only clean results: on a failed listing (r.error) the old list is
        // more useful than an empty one + failure banner mid-session. But when
        // there IS no old list — the mount fetch lost its ticket to this refresh
        // and was discarded — surface the failure instead of an eternal skeleton.
        if (r.error != null) {
          if (loading) {
            loadError = true;
            loading = false;
          }
          return;
        }
        slug = r.slug;
        repoUrl = r.webUrl;
        issues = r.issues;
        viewer = r.viewer;
        loadError = false;
        // This result is now the newest state — display it even if the (superseded)
        // mount fetch never settled; otherwise fresh data hides behind the skeleton.
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath || issuesTicket !== issuesSeq) return;
        if (loading) {
          loadError = true;
          loading = false;
        }
      });
    const epicsTicket = ++epicsSeq;
    getEpics(rp)
      .then((r) => {
        if (rp !== repoPath || epicsTicket !== epicsSeq) return;
        epicByNumber = new Map(r.epics.map((s) => [s.parentIssueNumber, s]));
        nativeSubIssues = new Set(r.subIssues);
        epicsLoaded = true;
        // Also flip epicsSettled here (never reset it in softRefresh): if a bump
        // supersedes the still-in-flight mount getEpics during epic-badge navigation,
        // THIS ticket-winning fetch is what releases the epic-scroll.
        epicsSettled = true;
      })
      .catch(() => {
        if (rp !== repoPath || epicsTicket !== epicsSeq) return;
        epicsSettled = true;
      });
    // One-shot epic cache: drop what's no longer on screen, then refresh every
    // EXPANDED panel the live store doesn't cover (store-backed panels are refreshed
    // by +page's resync re-pull; idle/pruned epics exist only in `fetched`). Iterating
    // `expanded` — not `fetched.keys()` — also re-seeds a panel whose live record the
    // store PRUNED (completed epic) since it was expanded, which left it in neither.
    for (const num of [...fetched.keys()]) {
      if (!expanded.has(num)) fetched.delete(num);
    }
    for (const num of expanded) {
      if (epics?.[`${rp}#${num}`]) continue;
      fetchEpicInto(rp, num);
    }
  }

  // Per-number fetch tickets for the one-shot epic cache — same role as issuesSeq/
  // epicsSeq above. Applied results must ALSO still be expanded: a late settle for a
  // since-collapsed epic would otherwise re-seed `fetched`, and the next expand would
  // serve that stale entry without refetching. Plain Map on purpose (guard, not UI
  // state); cleared on repo change alongside `fetched`.
  // Deliberately plain (non-reactive) on purpose — fetch guards, NOT UI state; a
  // SvelteMap/SvelteSet would make the backfill $effect re-run on its own writes.
  // Ticket VALUES come from one shared monotonic counter (never reset), NOT a
  // per-number restart-from-1: after an A→B→A repo flip the repo-change effect
  // clears this map, and per-number numbering would re-mint the same ticket a
  // still-in-flight fetch from the first visit already holds — letting its stale
  // settle pass the guard and its finally unmark the newer fetch's pending flag.
  let epicFetchTicket = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const epicFetchSeq = new Map<number, number>();
  // In-flight numbers, so the backfill effect below doesn't re-fire a fetch that is
  // merely still pending (epicFor stays undefined until it settles). The `finally`
  // only clears the flag while it still holds the latest ticket — an older settle
  // must not unmark a newer in-flight fetch.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- same guard rationale
  const epicFetchPending = new Set<number>();
  function fetchEpicInto(rp: string, num: number) {
    const ticket = ++epicFetchTicket;
    epicFetchSeq.set(num, ticket);
    epicFetchPending.add(num);
    getEpic(rp, num)
      .then((e) => {
        if (rp !== repoPath || epicFetchSeq.get(num) !== ticket || !expanded.has(num)) return;
        // The live store gained a record mid-flight (epic:update seeded it while
        // this fetch ran): our snapshot predates that run — caching it would make
        // a LATER finished-prune fall back to pre-run counts, and the backfill
        // would see a defined record and never refetch. Drop it; the panel is
        // rendering live, and the prune-backfill path will fetch fresh.
        if (epics?.[`${rp}#${num}`]) return;
        fetched.set(num, e);
      })
      .catch(() => {})
      .finally(() => {
        if (epicFetchSeq.get(num) === ticket) epicFetchPending.delete(num);
      });
  }

  /** Return the live store value for an epic if available, else the cached fetch result. */
  function epicFor(n: number): Epic | undefined {
    return epics?.[`${repoPath}#${n}`] ?? fetched.get(n);
  }

  // Sole owner of the one-shot fetch: any EXPANDED row with a record in NEITHER
  // source gets fetched into the cache. Covers the first expand (expandEpicRow just
  // records intent) AND the live store pruning a completed epic out from under an
  // already-open panel — without this the panel would flip to its loading state and
  // stick there until collapse/re-expand. Reactive on `expanded`, the `epics` prop
  // and `fetched`, so a successful fetch (or a prune) re-evaluates and settles; a
  // failed fetch stays absent until the next expanded/epics change retries it —
  // the same recovery the old expand-time one-shot had.
  $effect(() => {
    for (const num of expanded) {
      // A live record is authoritative while it exists — anything the one-shot
      // path holds for this number predates the run. Invalidate a pending fetch
      // (a settle AFTER a seed-then-prune-within-one-flight would pass the
      // settle-time guard, epics[key] being undefined again by then) and drop a
      // stale cached entry, so a later finished-prune always refetches fresh
      // instead of falling back to pre-run counts.
      if (epics?.[`${repoPath}#${num}`]) {
        if (epicFetchPending.has(num)) {
          epicFetchSeq.set(num, ++epicFetchTicket);
          epicFetchPending.delete(num);
        }
        if (fetched.has(num)) fetched.delete(num);
        continue;
      }
      if (!epicFor(num) && !epicFetchPending.has(num)) untrack(() => fetchEpicInto(repoPath, num));
    }
  });

  /** Author filter: null clears it (radio "All authors"). */
  function pickAuthor(author: string | null) {
    selectedAuthor = author;
  }

  /** Label filter: toggle a label in/out of the AND-set. */
  function toggleLabel(label: string) {
    if (selectedLabels.has(label)) selectedLabels.delete(label);
    else selectedLabels.add(label);
  }

  /** Expand an epic's panel; the backfill effect above fetches it if needed. */
  function expandEpicRow(number: number) {
    expanded.add(number);
  }

  function toggleEpic(number: number) {
    if (expanded.has(number)) {
      expanded.delete(number);
    } else {
      expandEpicRow(number);
    }
  }

  $effect(() => {
    if (defaultEpicSeeded) return;
    if (expandEpic != null) {
      defaultEpicSeeded = true;
      return;
    }
    if (!epicsSettled || visibleIssues.length === 0 || epicByNumber.size === 0) return;
    const firstEpic = visibleIssues.find((issue) => epicByNumber.has(issue.number));
    if (!firstEpic) return;
    defaultEpicSeeded = true;
    expandEpicRow(firstEpic.number);
  });

  // Targeted expand+scroll driven by the `expandEpic` prop (e.g. EPIC badge click).
  // The expand fires as soon as a target is set; the scroll waits until the issue
  // row exists in the DOM (issues load async). Both are one-shot per target value.
  let scrolledTo = $state<number | null>(null);
  let appliedExpand = $state<number | null>(null);
  $effect(() => {
    const target = expandEpic;
    if (target == null) {
      appliedExpand = null;
      scrolledTo = null;
      return;
    }
    // Expand exactly once per target value. Keying off `appliedExpand` (NOT the
    // reactive `expanded` membership) means a later user collapse of the targeted
    // epic no longer re-fires this effect into re-expanding it.
    if (target !== appliedExpand) {
      appliedExpand = target;
      if (!expanded.has(target)) expandEpicRow(target);
    }
    // Scroll once the epic list has SETTLED into its final sorted order (epicsSettled)
    // AND the targeted row is actually rendered. Keying off `visibleIssues` (the sorted,
    // force-included, rendered list) — not raw `issues` — is what makes this land on the
    // epic's final top position instead of a provisional pre-sort spot; gating on
    // `epicsSettled` closes the listIssues-vs-getEpics race that would otherwise fire the
    // one-shot scroll before sortEpicsFirst pins the epic to the top.
    if (target !== scrolledTo && epicsSettled && visibleIssues.some((i) => i.number === target)) {
      scrolledTo = target;
      tick().then(() => {
        const el = document.getElementById(`epic-issue-row-${target}`);
        el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      });
    }
  });
</script>

<div class="issues-panel">
  <div class="issues-header">
    {m.issuespanel_title()}<RepoLink {slug} webUrl={repoUrl} />
  </div>

  <div class="issues-list">
    {#if loading}
      <div class="muted">{m.common_loading()}</div>
    {:else if loadError}
      <div class="muted">{m.common_issues_load_failed()}</div>
    {:else if slug === null}
      <div class="muted">{m.issuespanel_no_host()}</div>
    {:else if issues.length === 0}
      <div class="muted">{m.common_no_open_issues()}</div>
    {:else}
      <div class="filter-bar">
        <input
          class="issue-filter"
          type="search"
          bind:value={filter}
          placeholder={m.issuespanel_filter_placeholder()}
          aria-label={m.issuespanel_filter_placeholder()}
        />
        <IssueFilterPopover
          showMine={viewer != null}
          coachTargets
          authors={availableAuthors}
          labels={availableLabels}
          labelColors={labelColorsMap}
          {selectedAuthor}
          selectedLabels={[...selectedLabels]}
          onauthor={pickAuthor}
          ontogglelabel={toggleLabel}
        />
      </div>
      <!-- Only surface an empty-state reason when the rendered list is truly empty: a
           force-included navigated-to epic (Fix B) keeps visibleIssues non-empty, so a
           "hidden by filter" message must not sit above the one epic row we deliberately show. -->
      {#if visibleIssues.length === 0}
        {#if allHiddenByAssignee}
          <div class="muted">{m.issues_filter_all_assigned_to_others()}</div>
        {:else if allHiddenByActive}
          <div class="muted">{m.issues_filter_all_in_progress()}</div>
        {:else if allHiddenBySubIssues}
          <div class="muted">{m.issues_filter_all_sub_issues()}</div>
        {:else if authorLabelFiltered.length === 0}
          <!-- Structured author/label filters emptied it (even if a search term is also
               present) — a generic filter miss, not the search-specific copy. -->
          <div class="muted">{m.issues_filter_no_match()}</div>
        {:else}
          <div class="muted">{m.issuespanel_no_match()}</div>
        {/if}
      {/if}
      {#each visibleIssues as issue (issue.number)}
        {@const isExpanded = expanded.has(issue.number)}
        <IssueRow
          {issue}
          epicSummary={epicByNumber.get(issue.number)}
          {isExpanded}
          epic={epicFor(issue.number)}
          {repoPath}
          {drain}
          {bodyPreview}
          {age}
          {showAssignees}
          {issueActions}
          {onnewtask}
          {onquick}
          ontoggleepic={toggleEpic}
        />
      {/each}
    {/if}
  </div>
</div>

<style>
  .issues-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }

  .issues-header {
    padding: 6px 12px;
    margin-bottom: 8px; /* gap below the border to the flush sticky filter — margin (outside the border), not padding */
    font-size: var(--fs-micro);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-line);
    flex-shrink: 0;
  }

  .issues-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .issues-list::-webkit-scrollbar {
    width: 4px;
  }
  .issues-list::-webkit-scrollbar-track {
    background: transparent;
  }
  .issues-list::-webkit-scrollbar-thumb {
    background: var(--color-faint);
    border-radius: 2px;
  }

  /* Search field + the IssueFilterPopover "Filters" trigger pinned above the scrolling rows. */
  .filter-bar {
    position: sticky;
    top: 0;
    z-index: 1;
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    gap: 6px;
    background: var(--color-inset);
  }

  /* Search field — same recipe as the command filter in PromptSources (.cmd-filter). */
  .issue-filter {
    flex: 1;
    min-width: 0;
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    padding: 4px 8px;
    border-radius: 2px;
  }

  .issue-filter:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 4px 0;
  }

  @media (max-width: 768px) {
    .issues-list {
      -webkit-overflow-scrolling: touch;
    }
  }
</style>
