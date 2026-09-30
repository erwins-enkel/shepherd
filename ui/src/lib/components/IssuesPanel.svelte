<script lang="ts">
  import { listIssues, getEpics, getEpic } from "$lib/api";
  import { steers } from "$lib/steers.svelte";
  import { repos } from "$lib/repos.svelte";
  import { steerAppliesToRepo } from "$lib/steer-scope";
  import type {
    Issue,
    IssueFetchAttempt,
    Steer,
    EpicSummary,
    Epic,
    DrainStatus,
    TaskRunDefaults,
    TaskRunSeed,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import {
    filterIssues,
    hideOthersExceptFlaggedEpics,
    hideActive,
    hideBlockedIssues,
    sortEpicsFirst,
    filterByAuthor,
    filterByLabels,
    distinctAuthors,
    distinctLabels,
    labelColorMap,
    buildIssueRows,
    stepSelection,
    resolveSelection,
    epicKey,
  } from "./issues-panel";
  import { issuesFilter } from "$lib/issues-filter.svelte";
  import { viewerCache } from "$lib/viewer-cache.svelte";
  import { backlogRefresh } from "$lib/backlog-refresh.svelte";
  import IssueListRows from "./issues-panel/IssueListRows.svelte";
  import IssueDetail from "./issues-panel/IssueDetail.svelte";
  import IssueFilterPopover from "./IssueFilterPopover.svelte";
  import RepoLink from "./RepoLink.svelte";
  import IssueLoadAttempts from "./IssueLoadAttempts.svelte";
  import { SvelteSet, SvelteMap } from "svelte/reactivity";
  import { tick, untrack } from "svelte";

  // Backlog Issues tab (#2617): an epic-grouped list (left) and a reading detail of the
  // selected entry (right; on mobile a second level with a back button). This component owns
  // the data, filters and selection; IssueListRows / IssueDetail render them.

  let {
    repoPath,
    onnewtask,
    onquick = undefined,
    oninject = undefined,
    epics = undefined,
    drain = null,
    expandEpic = null,
    mobile = false,
    taskDefaults = undefined,
  }: {
    repoPath: string;
    /** Open the New Task dialog for `issue`, seeded with the run settings the operator changed
     *  in the detail's task box (absent fields keep the dialog's own defaults). */
    onnewtask: (issue: Issue, run?: TaskRunSeed) => void;
    /** Quick-launch: spawn a session with the picked issue action's prompt + this
     *  issue, skipping the New Task dialog. Omitted → no action buttons are shown. */
    onquick?: (issue: Issue, action: Steer) => void;
    /** Inject an issue steer into the New Task dialog (pre-seed prompt + attach issue,
     *  no spawn), from the row's right-click / long-press menu. Omitted → no steer items. */
    oninject?: (issue: Issue, steer: Steer) => void;
    /** Live epic record from the store, keyed `${repoPath}#${parentIssueNumber}`.
     *  When present, WS-pushed updates refresh open panels without a re-fetch. */
    epics?: Record<string, Epic>;
    /** This repo's live drain status — forwarded to an expanded epic row's panel so it
     *  can surface the hold reason. Null when disabled / unknown. */
    drain?: DrainStatus | null;
    /** When set (e.g. from an EPIC badge click), select + expand that epic and scroll it
     *  into view — used to land the user on a specific epic in the backlog. */
    expandEpic?: number | null;
    /** Phone layout: list only; a selection opens the detail as a second level. */
    mobile?: boolean;
    /** Global run defaults the task box pre-fills CLI / model / effort from. */
    taskDefaults?: TaskRunDefaults;
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
  /** The gh transports that ran and failed behind `loadError` (GitHub repos only).
   *  Set wherever loadError is, so a stale trail can never outlive its failure. */
  let loadAttempts = $state<IssueFetchAttempt[]>([]);
  // True when the repo runs in lightweight (local-only) mode — the empty issues[] and
  // null slug are deliberate. Mirrors PromptSources: without it the panel blames a
  // missing git host for a mode the operator switched on in Shepherd.
  let lightweight = $state(false);
  let filter = $state("");
  // Repo-scoped author + label filters. Selection is local (not the global issuesFilter
  // store) because the option sets are repo-specific; reset on repo change and pruned on
  // refresh (see the reconcile effect below). Options are derived from the RAW `issues`
  // list so picking one value doesn't drop the others from the picker.
  let selectedAuthor = $state<string | null>(null);
  const selectedLabels = new SvelteSet<string>();
  let availableAuthors = $derived(distinctAuthors(issues));
  let availableLabels = $derived(
    distinctLabels(issues, { excludeBlocked: issuesFilter.hideBlocked }),
  );
  let labelColorsMap = $derived(labelColorMap(issues));
  // Epic summaries for this repo: number → EpicSummary.
  let epicByNumber = $state<Map<number, EpicSummary>>(new Map());
  let nativeSubIssues = $state<Set<number>>(new Set());
  // True once a getEpics attempt for this repo has SETTLED (success or failure), so the
  // epic-first sort is final. Gates the targeted expand-scroll below: scrolling before
  // the sort settles would center the epic at a provisional (un-pinned) position that the
  // re-sort then yanks away, stranding the viewport among unrelated issues. Reset (→false)
  // ONLY on repo change; set (→true) in EVERY getEpics settle (mount + softRefresh, then +
  // catch, inside the rp/ticket guard) so a backlogRefresh bump that supersedes the mount
  // fetch mid-navigation still flips it via the winning fetch — never latched false.
  let epicsSettled = $state(false);
  // Compose the assignee filter (#824) → "hide in progress" filter → blocked → author/label →
  // text filter. Sub-issues aren't filtered here: the row model lists them only inside their
  // epic (buildIssueRows), so they never appear as singles.
  // The mine chip only shows when `viewer` is known, so hideOthers is a no-op
  // identity otherwise (fail open); hideActive is viewer-agnostic. Flagged epics (someone
  // else is working them, #1616) are exempt so their pill stays visible under the filter.
  let assigneeFiltered = $derived(
    hideOthersExceptFlaggedEpics(issues, viewer, issuesFilter.hideOthers, epicByNumber),
  );
  // Expose per-issue assignees on the rows whenever the mine & unassigned filter (#824)
  // isn't hiding others' issues — i.e. when it's toggled off, or fails open because the
  // viewer is unknown. With the filter active, the only assigned-to-others rows still visible
  // are flagged epics kept by the exemption (#1616) — and those surface their owner via the
  // epic pill ("assigned to X"), not a chip — so keeping the chip hidden stays correct.
  let showAssignees = $derived(!issuesFilter.hideOthers || viewer == null);
  let activeFiltered = $derived(hideActive(assigneeFiltered, issuesFilter.hideActive));
  let epicParentNums = $derived(new Set(epicByNumber.keys()));
  // "Hide blocked" filter, applied BEFORE the author/label filters (see hideBlockedIssues).
  let blockedFiltered = $derived(hideBlockedIssues(activeFiltered, issuesFilter.hideBlocked));
  // Author + label filters (repo-scoped), applied AFTER the toggle filters and BEFORE the
  // text search. Kept as a named intermediate so the empty-state block can attribute a miss
  // to the structured filters (this being empty) vs. the text search (this non-empty but
  // visibleIssues empty).
  let authorLabelFiltered = $derived(
    filterByLabels(filterByAuthor(blockedFiltered, selectedAuthor), selectedLabels),
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
  // always land on it, even when a toggle filter (hideOthers / hideActive / hideBlocked)
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
  // The blocked filter emptied the remainder the active filter left behind.
  let allHiddenByBlocked = $derived(
    !allHiddenByAssignee &&
      !allHiddenByActive &&
      activeFiltered.length > 0 &&
      blockedFiltered.length === 0 &&
      issuesFilter.hideBlocked,
  );
  // Set of expanded epic issue numbers (SvelteSet for fine-grained reactivity).
  const expanded = new SvelteSet<number>();
  let defaultEpicSeeded = $state(false);
  // One-shot fetch cache: issue number → fetched Epic (avoids re-fetching on re-render).
  const fetched = new SvelteMap<number, Epic>();

  // Selected list entry (a row key — see issues-panel.ts) and the run settings the operator
  // changed in its task box. Both reset whenever the selection moves (see select()).
  let selectedKey = $state<string | null>(null);
  let taskRun = $state<TaskRunSeed>({});

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
    loadAttempts = [];
    lightweight = false;
    filter = "";
    selectedAuthor = null;
    selectedLabels.clear();
    expanded.clear();
    selectedKey = null;
    taskRun = {};
    defaultEpicSeeded = false;
    epicByNumber = new Map();
    nativeSubIssues = new Set();
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
        viewerCache.set(rp, r.viewer);
        loadError = r.error != null;
        loadAttempts = r.attempts ?? [];
        lightweight = r.lightweight === true;
        loading = false;
      })
      .catch(() => {
        // Mirror the success path's staleness guard: a rejection from a
        // previously-selected repo (or a superseded request) must not stamp a
        // sticky load-failed banner onto the data now showing.
        if (rp !== repoPath || issuesTicket !== issuesSeq) return;
        loadError = true;
        loadAttempts = [];
        loading = false;
      });
    const epicsTicket = ++epicsSeq;
    getEpics(rp)
      .then((r) => {
        if (rp !== repoPath || epicsTicket !== epicsSeq) return;
        epicByNumber = new Map(r.epics.map((s) => [s.parentIssueNumber, s]));
        nativeSubIssues = new Set(r.subIssues);
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

  // Manual retry from the load-failed state. Reuses softRefresh (the only re-fetch in
  // this component already guarded against out-of-order settles) and re-arms `loading`
  // so a repeated failure can stamp the banner again — softRefresh only reports a
  // failure while a load is outstanding, and deliberately keeps stale data otherwise.
  function retryIssues() {
    loading = true;
    loadError = false;
    loadAttempts = [];
    softRefresh(repoPath);
  }

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
            loadAttempts = r.attempts ?? [];
            loading = false;
          }
          return;
        }
        slug = r.slug;
        repoUrl = r.webUrl;
        issues = r.issues;
        viewer = r.viewer;
        viewerCache.set(rp, r.viewer);
        loadError = false;
        loadAttempts = [];
        lightweight = r.lightweight === true;
        // This result is now the newest state — display it even if the (superseded)
        // mount fetch never settled; otherwise fresh data hides behind the skeleton.
        loading = false;
      })
      .catch(() => {
        if (rp !== repoPath || issuesTicket !== issuesSeq) return;
        if (loading) {
          loadError = true;
          loadAttempts = [];
          loading = false;
        }
      });
    const epicsTicket = ++epicsSeq;
    getEpics(rp)
      .then((r) => {
        if (rp !== repoPath || epicsTicket !== epicsSeq) return;
        epicByNumber = new Map(r.epics.map((s) => [s.parentIssueNumber, s]));
        nativeSubIssues = new Set(r.subIssues);
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
    // WANTED record (expanded rows + the selected epic) the live store doesn't cover
    // (store-backed ones are refreshed by +page's resync re-pull; idle/pruned epics exist
    // only in `fetched`). Iterating the wanted set — not `fetched.keys()` — also re-seeds a
    // record the store PRUNED (completed epic) since it was wanted, which left it in neither.
    for (const num of [...fetched.keys()]) {
      if (!wantsRecord(num)) fetched.delete(num);
    }
    for (const num of recordNums) {
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
        if (rp !== repoPath || epicFetchSeq.get(num) !== ticket || !wantsRecord(num)) return;
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

  // Epic records the list/detail need: every expanded row (its child rows) plus the selected
  // epic (the detail's EpicPanel), which may be collapsed.
  const selection = $derived(
    resolveSelection(selectedKey, issues, epicParentNums, (n) => epicFor(n)?.children),
  );
  const selectedEpicNum = $derived(selection?.kind === "epic" ? selection.issue.number : null);
  const recordNums = $derived(
    selectedEpicNum != null && !expanded.has(selectedEpicNum)
      ? [...expanded, selectedEpicNum]
      : [...expanded],
  );
  function wantsRecord(num: number): boolean {
    return expanded.has(num) || selectedEpicNum === num;
  }

  // Sole owner of the one-shot fetch: any WANTED record (see recordNums) in NEITHER
  // source gets fetched into the cache. Covers the first expand (expandEpicRow just
  // records intent) AND the live store pruning a completed epic out from under an
  // already-open panel — without this the panel would flip to its loading state and
  // stick there until collapse/re-expand. Reactive on `expanded`, the `epics` prop
  // and `fetched`, so a successful fetch (or a prune) re-evaluates and settles; a
  // failed fetch stays absent until the next expanded/epics change retries it —
  // the same recovery the old expand-time one-shot had.
  $effect(() => {
    for (const num of recordNums) {
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

  // ── Selection + list keyboard (#2617) ───────────────────────────────────────────────────
  // The flat row model the list renders and ↑/↓ walks (issues-panel.ts → buildIssueRows).
  const rows = $derived(
    buildIssueRows(
      visibleIssues,
      epicParentNums,
      nativeSubIssues,
      expanded,
      (n) => epicFor(n)?.children,
    ),
  );
  let listEl = $state<HTMLElement>();

  /** Move the selection; a new entry starts with a clean task box. */
  function select(key: string | null) {
    if (key === selectedKey) return;
    selectedKey = key;
    taskRun = {};
  }

  function selectFromList(key: string) {
    select(key);
    // Keep ↑/↓ working after a click: the list (not the row) owns keyboard focus.
    if (!mobile) listEl?.focus({ preventScroll: true });
  }

  function startTask(issue: Issue) {
    onnewtask(issue, $state.snapshot(taskRun));
  }

  function onListKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = stepSelection(rows, selectedKey, e.key === "ArrowDown" ? 1 : -1);
      if (next == null) return;
      select(next);
      tick().then(() =>
        document.getElementById(`issue-opt-${next}`)?.scrollIntoView?.({ block: "nearest" }),
      );
    } else if (e.key === "ArrowRight") {
      const row = rows.find((r) => r.key === selectedKey);
      if (row?.kind !== "epic") return;
      e.preventDefault();
      expandEpicRow(row.issue.number);
    } else if (e.key === "a" || e.key === "A") {
      if (selection?.kind !== "single") return;
      e.preventDefault();
      startTask(selection.issue);
    }
  }

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
      untrack(() => select(epicKey(target)));
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

<div class="issues-panel" class:mobile>
  <div class="list-col">
    <div class="issues-header">
      {m.issuespanel_title()}<RepoLink {slug} webUrl={repoUrl} />
    </div>

    <div class="issues-list">
      {#if loading}
        <div class="muted">{m.common_loading()}</div>
      {:else if loadError}
        <!-- The failure is often transient (one exhausted gh budget), so offer the retry
             right here rather than asking the operator to wait. -->
        <div class="muted">
          {m.common_issues_load_failed()}
          <button type="button" class="retry-link" onclick={retryIssues}>{m.common_retry()}</button>
          <!-- Which gh transport gave up, and why — so a retry isn't a blind coin flip
               between waiting for a budget and fixing a login. -->
          <IssueLoadAttempts attempts={loadAttempts} />
        </div>
      {:else if lightweight}
        <!-- MUST precede the slug===null branch: LocalForge reports a null slug too, so
             that branch would otherwise swallow the deliberate lightweight state and
             report a missing git host the operator never configured away. -->
        <div class="muted">{m.common_issues_lightweight()}</div>
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
            showSubIssuesToggle={false}
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
             force-included navigated-to epic keeps it non-empty, so a "hidden by filter"
             message must not sit above the one epic row we deliberately show. -->
        {#if rows.length === 0}
          {#if allHiddenByAssignee}
            <div class="muted">{m.issues_filter_all_assigned_to_others()}</div>
          {:else if allHiddenByActive}
            <div class="muted">{m.issues_filter_all_in_progress()}</div>
          {:else if allHiddenByBlocked}
            <div class="muted">{m.issues_filter_all_blocked()}</div>
          {:else if authorLabelFiltered.length === 0}
            <!-- Structured author/label filters emptied it (even if a search term is also
                 present) — a generic filter miss, not the search-specific copy. -->
            <div class="muted">{m.issues_filter_no_match()}</div>
          {:else}
            <div class="muted">{m.issuespanel_no_match()}</div>
          {/if}
        {/if}
        <div
          bind:this={listEl}
          class="issue-options"
          role="listbox"
          tabindex="0"
          aria-label={m.issuespanel_title()}
          aria-activedescendant={selectedKey ? `issue-opt-${selectedKey}` : undefined}
          onkeydown={onListKey}
        >
          <IssueListRows
            {rows}
            {selectedKey}
            epicSummaries={epicByNumber}
            {epicFor}
            {issueActions}
            {oninject}
            onselect={selectFromList}
            ontoggle={toggleEpic}
          />
        </div>
      {/if}
    </div>
    {#if !mobile}
      <div class="shortcuts">{m.issuespanel_shortcuts()}</div>
    {/if}
  </div>

  {#if !mobile || selection}
    <div class="detail-col" class:overlay={mobile}>
      {#if mobile}
        <div class="detail-top">
          <button class="back-btn" type="button" onclick={() => select(null)}
            >‹ {m.issuedetail_back()}</button
          >
        </div>
      {/if}
      {#if selection}
        {#key selectedKey}
          <IssueDetail
            {repoPath}
            {selection}
            epicSummary={selection.kind === "epic"
              ? epicByNumber.get(selection.issue.number)
              : undefined}
            epic={selection.kind === "epic" ? epicFor(selection.issue.number) : undefined}
            {drain}
            {showAssignees}
            {viewer}
            {issueActions}
            {taskDefaults}
            bind:run={taskRun}
            onstart={startTask}
            {onquick}
          />
        {/key}
      {:else}
        <div class="detail-empty">{m.issuespanel_select_entry()}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* List | detail (#2617). The list column is ~456px, never more than 45% of a narrow
     Repos dialog, so the reading detail always keeps the larger share. */
  .issues-panel {
    position: relative;
    display: grid;
    grid-template-columns: min(456px, 45%) minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--color-inset);
    font-family: var(--font-mono);
    overflow: hidden;
  }
  .issues-panel.mobile {
    grid-template-columns: minmax(0, 1fr);
  }

  .list-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-right: 1px solid var(--color-line);
  }
  .mobile .list-col {
    border-right: 0;
  }

  .issues-header {
    overflow-wrap: anywhere;
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
    min-height: 0;
    overflow-y: auto;
    padding: 0 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
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

  /* The listbox: rows are options, focus stays here (aria-activedescendant). */
  .issue-options {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 6px;
  }
  .issue-options:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-line-bright);
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

  .shortcuts {
    flex-shrink: 0;
    padding: 5px 12px;
    border-top: 1px solid var(--color-line);
    color: var(--color-faint);
    font-size: var(--fs-micro);
    letter-spacing: 0.06em;
  }

  .detail-col {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    background: var(--color-bg);
  }
  /* Mobile second level: an opaque full-cover view swap over the list (the scrim-exempt
     .mobile-detail-overlay pattern), with a back bar on top. */
  .detail-col.overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: var(--color-inset);
  }
  .detail-top {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 10px;
    background: var(--color-head);
    border-bottom: 1px solid var(--color-line);
  }
  .back-btn {
    min-height: 40px;
    padding: 6px 12px;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: var(--fs-meta);
    letter-spacing: 0.08em;
    cursor: pointer;
    touch-action: manipulation;
  }
  .back-btn:hover {
    background: var(--color-hover);
  }

  .detail-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-faint);
    font-size: var(--fs-meta);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .muted {
    font-size: var(--fs-base);
    color: var(--color-faint);
    padding: 4px 0;
  }

  /* Text-link recipe (same as PrsPanel's toolbar link): a transparent button so it
     stays keyboard-reachable and announces as an action, styled as inline text. */
  .retry-link {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--color-amber);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    text-decoration: underline;
  }

  @media (max-width: 768px), (pointer: coarse) {
    .issue-filter {
      font-size: var(--fs-lg);
      min-height: 44px;
    }
    .filter-bar :global(.filter-chip) {
      min-height: 44px;
    }
    .issues-list,
    .detail-col {
      -webkit-overflow-scrolling: touch;
    }
  }
</style>
