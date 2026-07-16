<script lang="ts">
  import type {
    Session,
    GitState,
    SessionActivity,
    Epic,
    CompletedEpic,
    HoldReason,
    OwedFocusSnapshot,
    AgentProvider,
    LivenessState,
  } from "$lib/types";
  import type { HerdStore } from "$lib/store.svelte";
  import type { BlockState } from "$lib/triage";
  import HerdGroup from "./herd/HerdGroup.svelte";
  import type { HerdRowCtx } from "./herd/HerdGroup.svelte";
  import HerdLensStrip from "./herd/HerdLensStrip.svelte";
  import HerdSegRow from "./herd/HerdSegRow.svelte";
  import HerdEpicGroups from "./herd/HerdEpicGroups.svelte";
  import HerdExperimentGroups from "./herd/HerdExperimentGroups.svelte";
  import HerdDoneList from "./herd/HerdDoneList.svelte";
  import HerdEmptyState from "./herd/HerdEmptyState.svelte";
  import IntegratedEpicsBand from "./IntegratedEpicsBand.svelte";
  import RundownPanel from "./RundownPanel.svelte";
  import PostMergeStepsPanel from "./PostMergeStepsPanel.svelte";
  import UpNextPanel from "./UpNextPanel.svelte";
  import {
    partitionSessions,
    shownSessions,
    GROUP_KEY_BY_STAGE,
    type HerdFilter,
  } from "./herd-partition";
  import { groupSessionsByEpic } from "./epic-grouping";
  import { groupSessionsByExperiment } from "./experiment-grouping";
  import { collectReadyPrs } from "./merge-train";
  import { displayStatus } from "$lib/display-status";
  import { isReworkRunning as isReworkRunningSession } from "./rework-running";
  import { reviews, planGates } from "$lib/reviews.svelte";
  import { m } from "$lib/paraglide/messages";
  import { postMergeSteps, owedRecordsForRepo } from "$lib/post-merge-steps.svelte";
  import { EMPTY_REPO_FILTER } from "./queue-strip";

  let {
    sessions,
    selectedId,
    nowMs,
    onselect,
    onnew,
    git,
    activity,
    preview = {},
    previewServe = {},
    onpreview = undefined,
    epics = {},
    onepic = undefined,
    activeEpicKeys = new Set(),
    collapsedKeys = new Set(),
    oncollapsetoggle = undefined,
    onrenderedepicgroups = undefined,
    ondecommission,
    onrelaunch = undefined,
    onrelaunchElsewhere = undefined,
    onvariant = undefined,
    onreplace = undefined,
    oncompare = undefined,
    onclearmerged = undefined,
    onmergetrain = undefined,
    issueActionsUnset = false,
    onsettings = undefined,
    flow = false,
    filteredRepo = null,
    repoFilter = EMPTY_REPO_FILTER,
    onrepofilter = undefined,
    onrename = undefined,
    filter = $bindable("all"),
    statusFilter = null,
    onstatusfilter = undefined,
    workingBlocked = {},
    liveness = {},
    blocks = {},
    holds = {},
    collapsible = false,
    oncollapse = undefined,
    collapsedStageKeys = new Set(),
    onstagecollapsetoggle = undefined,
    touch = false,
    completedEpics = [],
    ondismissepic = undefined,
    onlandepic = undefined,
    doneList = [],
    doneSelectedId = null,
    ondoneselect = undefined,
    onrundownitem = undefined,
    onrundownepic = undefined,
    focusEpic = null,
    onackmigrationsepic = undefined,
    onackmanualsteps = undefined,
    onshowowed = undefined,
    owedFocusId = null,
    owedFocusSnapshot = null,
    owedFocusNonce = 0,
    owedFocusHandledNonce = 0,
    onfocusresolved = undefined,
    onbacklog = undefined,
    upNextLaunch = null,
  }: {
    sessions: Session[];
    selectedId: string | null;
    nowMs: number;
    onselect: (id: string) => void;
    onnew: () => void;
    git: Record<string, GitState>;
    activity: Record<string, SessionActivity>;
    // live sessionId → preview-listener port; a non-null entry surfaces the row's Preview badge
    preview?: Record<string, number | null>;
    // live sessionId → tailscale-serve registration status; "failed" surfaces degraded badge
    previewServe?: Record<string, "ok" | "failed">;
    // a row's Preview badge was clicked → select the session + open its Viewport preview pane
    onpreview?: (id: string, target?: "inline" | "tab") => void;
    // live epics map (store.epics, keyed `${repoPath}#${parentIssueNumber}`) — threaded
    // into each row so an epic-seeded session can badge with WS-live counts
    epics?: Record<string, Epic>;
    // an epic group header's badge was clicked → open the backlog
    onepic?: (repoPath: string, issueNumber: number) => void;
    // keys (`${repoPath}#${parentIssueNumber}`) of currently-active epics — only these
    // group their child sessions under an epic headline; others stay in the lifecycle list
    activeEpicKeys?: Set<string>;
    // epic group keys the user has collapsed — collapsed groups hide their child rows
    // (page-owned state, shared with the keyboard-nav rail so render and nav agree)
    collapsedKeys?: Set<string>;
    // toggles a group's collapse — the page owns the actual collapsedKeys mutation
    oncollapsetoggle?: (key: string) => void;
    // reports the exact epic-group order this component renders; the page owns
    // collapse-state normalization, but Herd owns the final filtered/grouped order.
    onrenderedepicgroups?: (keys: string[]) => void;
    // when provided, rows gain left-swipe-to-decommission (mobile list)
    ondecommission?: (id: string) => void;
    // when provided, each row's CardMenu gains a Rename action
    onrename?: (id: string) => void;
    // when provided, each row's CardMenu gains a two-step armed Relaunch action
    onrelaunch?: (id: string) => void;
    // when provided, each row's CardMenu gains a one-click "Relaunch elsewhere" item
    onrelaunchElsewhere?: (id: string) => void;
    // when provided, each row's CardMenu gains "Start as variant…" / "Continue with…" items
    onvariant?: (id: string, anchor: { x: number; y: number }) => void;
    onreplace?: (id: string, anchor: { x: number; y: number }) => void;
    // when provided, each experiment group header gains a "Compare" action
    oncompare?: (experimentId: string, anchor: { x: number; y: number }) => void;
    // when provided, the merged group header gains a "clear all" action
    onclearmerged?: () => void;
    // when provided, the ready-to-merge group header gains a "merge train" action
    // (kicks off a new session that works through this group's PRs)
    onmergetrain?: () => void;
    // first-run empty state: quick-launch is invisible until the standard command
    // is set → surface a quiet nudge pointing at Settings.
    issueActionsUnset?: boolean;
    onsettings?: () => void;
    // when true, the session list renders at natural height (no internal scroll)
    // so the parent page can drive scrolling; default false preserves existing behavior
    flow?: boolean;
    // basename of an active repo filter; when set and the (already-filtered) session
    // list is empty, show a neutral "no agents for this repo" note instead of the
    // first-run EmptyHerd nudge. null = unfiltered.
    filteredRepo?: string | null;
    // selected repo paths (empty = all) — drives each row's inline-emoji pressed state;
    // threaded with onrepofilter so the emoji sets the filter
    repoFilter?: ReadonlySet<string>;
    onrepofilter?: (repoPath: string, additive: boolean) => void;
    // the all/ready list filter — bindable so the page-level keyboard navigation
    // can mirror exactly what the rail shows (herd-keynav's railOrder takes it)
    filter?: HerdFilter;
    // page-level status filter (TopBar tallies). Sessions already arrive filtered;
    // the prop only drives the head chip, the empty-state copy, and short-circuits
    // the local all/ready filter (one filter at a time).
    statusFilter?: "running" | "idle" | "blocked" | null;
    onstatusfilter?: (status: "running" | "idle" | "blocked" | null) => void;
    // working-while-blocked display flags (store map) — threaded into the rows'
    // displayStatus and the "ready" filter so flagged sessions read as working
    workingBlocked?: Record<string, boolean>;
    // per-session agent liveness (store.claudeAlive) — drives the distinct stranded card framing (#1630)
    liveness?: Record<string, LivenessState>;
    // live quota blocks map (store.blocks); only "quota"-shape entries surface a badge
    blocks?: Record<string, BlockState>;
    // live hold reasons map (store.holds); surfaced as a muted subline on each held card
    holds?: Record<string, HoldReason>;
    // when true, renders a collapse arrow at the trailing end of the filters bar —
    // only set on touch-primary wide devices where collapsing is meaningful
    collapsible?: boolean;
    // called when the collapse arrow is clicked; parent drives the actual
    // collapse so the button is purely a signal
    oncollapse?: () => void;
    // desktop lifecycle-group collapse (page-owned, GROUP_KEY_BY_STAGE keys — shared with
    // the keyboard-nav rail so render and nav agree). Only read when !flow; the phone
    // layout keeps its own internal accordion.
    collapsedStageKeys?: ReadonlySet<string>;
    // toggles a lifecycle group's desktop collapse; without it the desktop headers stay
    // plain non-interactive text (no no-op disclosure buttons)
    onstagecollapsetoggle?: (key: string) => void;
    // coarse-pointer/touch input (page's `(pointer: coarse)` MediaQuery, same signal as
    // Viewport's `touch`) — keeps 44px touch targets on touch-wide desktop layouts
    touch?: boolean;
    // fully-integrated epics for this repo scope — rendered as the bottom
    // "integrated epics" band (self-hides when empty)
    completedEpics?: CompletedEpic[];
    // dismiss a completed epic from the band; page owns the optimistic remove + reconcile
    ondismissepic?: (repoPath: string, parent: number) => void;
    // merge the landing PR for a completed epic (#1039); server emits epic:completed on success
    onlandepic?: (repoPath: string, parent: number) => void;
    // Done lens: the archived ("done") sessions to list when filter === "done" (newest
    // first; the endpoint already orders them). These are NOT live sessions — they live in
    // the page's lazy doneSessions store, distinct from `sessions`.
    doneList?: Session[];
    // the picked done row (resolved against doneList, not the live `sessions`/selectedId)
    doneSelectedId?: string | null;
    // a done row was picked → page selects it + shows its DoneRecapPanel in the main area
    ondoneselect?: (id: string) => void;
    // a Rundown digest item with a sessionId was clicked → page leaves the Rundown lens
    // and selects that live session (deep-link). Same mechanism a rail click uses.
    onrundownitem?: (id: string) => void;
    // a Rundown epics-to-land item was clicked (#1045) → page leaves the Rundown lens and focuses
    // that epic's row in the IntegratedEpicsBand (deep-link to its Land CTA), NOT a direct land.
    onrundownepic?: (repo: string, parent: number) => void;
    // when set, the IntegratedEpicsBand auto-expands + scrolls/opens this epic's row (#1045).
    focusEpic?: { repo: string; parent: number } | null;
    // acknowledge a completed epic's landing-PR migrations (#645); also clears the row
    onackmigrationsepic?: (repoPath: string, parent: number) => void;
    // acknowledge a session's manual operator steps (#1060); clears its auto-merge gate
    onackmanualsteps?: (id: string) => void;
    // manual-steps chip -> Owed lens (#1275)
    onshowowed?: (id: string) => void;
    // Owed-lens focus (#1275): threaded straight through to PostMergeStepsPanel (not a row prop —
    // the panel isn't a row) so a manual-steps chip click can scroll-to + highlight its target card.
    owedFocusId?: string | null;
    owedFocusSnapshot?: OwedFocusSnapshot | null;
    owedFocusNonce?: number;
    owedFocusHandledNonce?: number;
    onfocusresolved?: (nonce: number) => void;
    // open the Backlog overlay (Up Next empty-state link → page owns showBacklog)
    onbacklog?: () => void;
    // Up Next start needs capacity-aware launch context. Keep it bundled so Herd does not become
    // a passthrough bag of diagnostics/settings props.
    upNextLaunch?: {
      store: Pick<HerdStore, "diagnostics" | "usageLimits">;
      defaultAgentProvider: AgentProvider;
      fableAvailable: boolean;
      upnextSkipCliPicker: boolean;
      usageHoldEnabled: boolean;
      usageHoldPct: number;
      nowMs: number;
    } | null;
  } = $props();

  // Outstanding owed records (#1257) — drives the OWED lens count badge. Scoped to the active repo
  // chip filter (#owed) so the badge reflects the filtered list, matching the rest of the repo-scoped
  // herd view. Shares owedRecordsForRepo with PostMergeStepsPanel so count and list can't drift. The
  // container reads the shared store; HerdLensStrip stays a pure prop-driven component. Loaded in
  // +page.svelte (desktop eager load); 0 until then, which simply hides the badge.
  const owedCount = $derived(owedRecordsForRepo(postMergeSteps.records, repoFilter).length);

  // a critic post-PR review or a pre-execution plan-gate review currently in flight —
  // the reviewer is actively working the session, so it is NOT awaiting the operator.
  const inReview = (id: string) => reviews.isReviewing(id) || planGates.isReviewing(id);
  const isReworkRunning = (session: Session) =>
    isReworkRunningSession(
      session,
      { planGate: planGates.map[session.id], review: reviews.map[session.id] },
      workingBlocked,
      nowMs,
    );

  // Derives the quota block kind for a session if its block has shape "quota"; null otherwise.
  const quotaKindFor = (id: string) => {
    const b = blocks[id];
    return b?.reason.shape === "quota" ? (b.reason.quotaKind ?? null) : null;
  };

  // Returns the hold reason for a session, or undefined if none.
  const holdFor = (id: string): HoldReason | undefined => holds[id];

  // sidebar list filter (bindable prop): "all" or "ready" (only sessions not actively
  // working — anything but a running agent: idle, blocked, done → awaiting the operator;
  // in-review sessions are excluded too, since a reviewer is actively working them).
  // shownSessions is the shared single source of truth with herd-keynav's railOrder.
  // one filter at a time: an active page-level status filter short-circuits the
  // local all/ready filter ENTIRELY — a "ready" remnant would drop running sessions
  // and empty the list under statusFilter="running" (sessions already arrive filtered).
  const shown = $derived(
    statusFilter != null
      ? sessions
      : shownSessions(sessions, filter, inReview, workingBlocked, git, nowMs),
  );
  // label for the status chip + filtered empty states (only read when set)
  const statusLabel = $derived(
    statusFilter === "running"
      ? m.topbar_working_label()
      : statusFilter === "idle"
        ? m.topbar_idle_label()
        : m.topbar_blocked_label(),
  );
  // within the shown set, top→bottom by lifecycle stage: active rows first, then
  // PR-CI-running and critic-reviewing / plan-gate-reviewing in-flight groups, then
  // the parked ready-to-merge (green) and landed merged (blue) groups at the bottom.
  // reviews.reviewing and planGates.reviewing are both $state, so this re-derives on
  // `session:reviewing` and `session:plangate-reviewing` events respectively.
  // nowMs (the reactive clock tick) is threaded in so the Merging group re-partitions
  // as the per-session merge TTL elapses, matching the badge/pip which also use nowMs.
  // Active epics gather their child sessions under one headline at the top; only the
  // REST (non-grouped) sessions flow into the lifecycle partition below. `shown` stays
  // the FULL filtered set so the global action counts (merge-train/clear-merged) still
  // see grouped rows.
  // Comparison experiments are grouped FIRST so an experiment's ORIGINAL session — which keeps its
  // issue link (only the spawned variants drop it) — is claimed by its experiment group instead of
  // being pulled into its epic, which would strand the remaining variant(s) (a lone variant won't
  // form a group). Epic grouping then runs over the remainder; a session is never double-grouped.
  const experimentGrouped = $derived(groupSessionsByExperiment(shown));
  const grouped = $derived(
    groupSessionsByEpic(
      experimentGrouped.rest,
      epics,
      activeEpicKeys,
      git,
      inReview,
      isReworkRunning,
      nowMs,
    ),
  );
  const partition = $derived(
    partitionSessions(grouped.rest, git, inReview, isReworkRunning, nowMs),
  );
  // ready-to-merge sessions that actually have an open PR — the merge-train link
  // only surfaces when there's something to run (fail-closed: no PR → no link).
  // In-review sessions are excluded so the link's count matches the launch action.
  // Global (over `shown`, not `rest`) so grouped epic-child PRs still arm the action.
  const readyPrCount = $derived(collectReadyPrs(shown, git, inReview).length);

  // ONE partition per epic group, keyed by group key — the cue chips, the grouped
  // ready/merged tallies, and the "in epics above" annotation all read from it, so we
  // partition each small group exactly once. Re-derives on the same inputs the per-group
  // partition depends on (grouped, git, inReview, nowMs).
  const groupParts = $derived(
    new Map(
      grouped.groups.map((g) => [
        g.key,
        partitionSessions(g.sessions, git, inReview, isReworkRunning, nowMs),
      ]),
    ),
  );
  let lastRenderedEpicGroupSig = "";
  $effect(() => {
    const keys = grouped.groups.map((g) => g.key);
    const sig = keys.join("\u0000");
    if (sig === lastRenderedEpicGroupSig) return;
    lastRenderedEpicGroupSig = sig;
    onrenderedepicgroups?.(keys);
  });
  // Per-group attention cues — reads the shared partition; the blocked count still scans
  // g.sessions directly via displayStatus (it's not a partition bucket).
  function cuesFor(g: { key: string; sessions: Session[] }): {
    ciFailed: number;
    needsRework: number;
    branchProtectionBlocked: number;
    ready: number;
    blocked: number;
  } {
    const p = groupParts.get(g.key);
    return {
      ciFailed: p?.ciFailed.length ?? 0,
      needsRework: p?.needsRework.length ?? 0,
      branchProtectionBlocked: p?.branchProtectionBlocked.length ?? 0,
      ready: p?.ready.length ?? 0,
      blocked: g.sessions.filter((s) => displayStatus(s, workingBlocked) === "blocked").length,
    };
  }
  // ready/merged rows that live in epic groups above the lifecycle list — used both to
  // gate the ready/merged section headers (which must render even when their only rows
  // are grouped) and to drive the "N in epics above" annotation.
  const readyAbove = $derived([...groupParts.values()].reduce((n, p) => n + p.ready.length, 0));
  const mergedAbove = $derived([...groupParts.values()].reduce((n, p) => n + p.merged.length, 0));
  // global merged count (rest + grouped) — drives clear-merged enablement
  const mergedCount = $derived(partition.merged.length + mergedAbove);

  // Phone-only lifecycle accordion. The stable key makes "Your turn" the default
  // without coupling the open state to the groups' live ordering. null closes all
  // named lifecycle groups; unheaded active rows remain visible. Desktop uses the
  // page-owned collapsedStageKeys set instead (independent per-group collapse).
  let mobileOpenPartitionKey = $state<string | null>(GROUP_KEY_BY_STAGE.awaitingMerge);
  function toggleMobilePartitionGroup(key: string) {
    mobileOpenPartitionKey = mobileOpenPartitionKey === key ? null : key;
  }

  // The waiting-on-* group headers name the responsible person when the whole
  // group shares one (the common case: one repo, one merger). The herd can span
  // repos, so a mixed group falls back to a name-less header.
  function uniqueWho(list: Session[]): string | null {
    let who: string | null = null;
    for (const s of list) {
      const w = git[s.id]?.handoffWho;
      if (!w) continue;
      if (who === null) who = w;
      else if (who !== w) return null; // mixed repos → no single name in the header
    }
    return who;
  }
  const reviewerWho = $derived(uniqueWho(partition.waitingOnReviewer));
  const mergerWho = $derived(uniqueWho(partition.waitingOnMerger));

  // Shared row-context bundle — passed to HerdGroup (and later HerdEpicGroups) so the
  // parent builds it once and each group reads from it. All fields wire straight from
  // the parent's props/derivations.
  const rowCtx = $derived<HerdRowCtx>({
    selectedId,
    nowMs,
    onselect,
    git,
    activity,
    preview,
    previewServe,
    onpreview,
    ondecommission,
    onrename,
    onrelaunch,
    onrelaunchElsewhere,
    onvariant,
    onreplace,
    repoFilter,
    onrepofilter,
    workingBlocked,
    liveness,
    quotaKindFor,
    holdFor,
    onackmanualsteps,
    onshowowed,
  });

  // Lifecycle groups in display order — each entry maps to a <HerdGroup> render.
  // Using a $derived array keeps the who↔multi switch and above-counts reactive.
  type PartitionGroupEntry = {
    key: string;
    sessions: Session[];
    headClass?: string | null;
    countLabel?: string | null;
    aboveLabel?: string | null;
    action?: { class: string; title: string; label: string; onclick: () => void } | null;
    withPreview?: boolean;
  };
  const partitionGroups = $derived<PartitionGroupEntry[]>(
    [
      partition.active.length > 0 && {
        key: GROUP_KEY_BY_STAGE.active,
        sessions: partition.active,
        headClass: null,
        withPreview: true,
      },
      partition.ciRunning.length > 0 && {
        key: GROUP_KEY_BY_STAGE.ciRunning,
        sessions: partition.ciRunning,
        headClass: "ci-head",
        countLabel: m.herd_ci_running_group({ count: partition.ciRunning.length }),
        withPreview: true,
      },
      partition.ciFailed.length > 0 && {
        key: GROUP_KEY_BY_STAGE.ciFailed,
        sessions: partition.ciFailed,
        headClass: "ci-failed-head",
        countLabel: m.herd_ci_failed_group({ count: partition.ciFailed.length }),
        withPreview: true,
      },
      partition.reviewerRunning.length > 0 && {
        key: GROUP_KEY_BY_STAGE.reviewerRunning,
        sessions: partition.reviewerRunning,
        headClass: "reviewing-head",
        countLabel: m.herd_reviewer_running_group({ count: partition.reviewerRunning.length }),
        withPreview: true,
      },
      partition.reworkRunning.length > 0 && {
        key: GROUP_KEY_BY_STAGE.reworkRunning,
        sessions: partition.reworkRunning,
        headClass: "rework-head",
        countLabel: m.herd_rework_running_group({ count: partition.reworkRunning.length }),
        withPreview: true,
      },
      partition.needsRework.length > 0 && {
        key: GROUP_KEY_BY_STAGE.needsRework,
        sessions: partition.needsRework,
        headClass: "needs-rework-head",
        countLabel: m.herd_changes_requested_group({ count: partition.needsRework.length }),
        withPreview: true,
      },
      partition.branchProtectionBlocked.length > 0 && {
        key: GROUP_KEY_BY_STAGE.branchProtectionBlocked,
        sessions: partition.branchProtectionBlocked,
        headClass: "branch-blocked-head",
        countLabel: m.herd_merge_blocked_group({
          count: partition.branchProtectionBlocked.length,
        }),
        withPreview: true,
      },
      partition.waitingOnReviewer.length > 0 && {
        key: GROUP_KEY_BY_STAGE.waitingOnReviewer,
        sessions: partition.waitingOnReviewer,
        headClass: "waiting-head",
        countLabel: reviewerWho
          ? m.herd_waiting_reviewer_group({
              who: reviewerWho,
              count: partition.waitingOnReviewer.length,
            })
          : m.herd_waiting_reviewer_group_multi({ count: partition.waitingOnReviewer.length }),
        withPreview: false,
      },
      partition.waitingOnMerger.length > 0 && {
        key: GROUP_KEY_BY_STAGE.waitingOnMerger,
        sessions: partition.waitingOnMerger,
        headClass: "waiting-head",
        countLabel: mergerWho
          ? m.herd_waiting_merger_group({ who: mergerWho, count: partition.waitingOnMerger.length })
          : m.herd_waiting_merger_group_multi({ count: partition.waitingOnMerger.length }),
        withPreview: false,
      },
      partition.draftAwaitingSignoff.length > 0 && {
        key: GROUP_KEY_BY_STAGE.draftAwaitingSignoff,
        sessions: partition.draftAwaitingSignoff,
        headClass: "draft-head",
        countLabel: m.herd_draft_awaiting_signoff_group({
          count: partition.draftAwaitingSignoff.length,
        }),
        withPreview: false,
      },
      partition.awaitingMerge.length > 0 && {
        key: GROUP_KEY_BY_STAGE.awaitingMerge,
        sessions: partition.awaitingMerge,
        headClass: "awaiting-head",
        countLabel: m.herd_awaiting_merge_group({ count: partition.awaitingMerge.length }),
        withPreview: true,
      },
      partition.ready.length + readyAbove > 0 && {
        key: GROUP_KEY_BY_STAGE.ready,
        sessions: partition.ready,
        headClass: "ready-head",
        countLabel:
          partition.ready.length > 0 ? m.herd_ready_group({ count: partition.ready.length }) : null,
        aboveLabel: readyAbove > 0 ? m.herd_in_epics_above({ count: readyAbove }) : null,
        action:
          onmergetrain && readyPrCount > 0
            ? {
                class: "merge-train",
                title: m.herd_merge_train_title(),
                label: m.herd_merge_train_action(),
                onclick: onmergetrain,
              }
            : null,
        withPreview: true,
      },
      partition.merging.length > 0 && {
        key: GROUP_KEY_BY_STAGE.merging,
        sessions: partition.merging,
        headClass: "merging-head",
        countLabel: m.herd_merging_group({ count: partition.merging.length }),
        withPreview: true,
      },
      partition.merged.length + mergedAbove > 0 && {
        key: GROUP_KEY_BY_STAGE.merged,
        sessions: partition.merged,
        headClass: "merged-head",
        countLabel:
          partition.merged.length > 0
            ? m.herd_merged_group({ count: partition.merged.length })
            : null,
        aboveLabel: mergedAbove > 0 ? m.herd_in_epics_above({ count: mergedAbove }) : null,
        action:
          onclearmerged && mergedCount > 0
            ? {
                class: "clear-merged",
                title: m.herd_clear_merged_title(),
                label: m.herd_clear_merged_action(),
                onclick: onclearmerged,
              }
            : null,
        withPreview: true,
      },
    ].filter(Boolean) as PartitionGroupEntry[],
  );

  // Per-stage explainer content for the group-header "i" tooltips (issue: self-explanatory
  // Herd). Keyed via GROUP_KEY_BY_STAGE (the same source partitionGroups renders under) so
  // the record can't drift from the group keys; the message accessors stay explicit because
  // Paraglide accessors can't contain hyphens (mirroring the `herd_*_group` label names).
  // A `$derived` so copy re-resolves on locale change; the aria-label reuses the shared
  // `newtask_info_aria` ("Explain: {topic}"). The headerless `active` group never renders
  // a tooltip, but is included so the map is the single source for every stage.
  const groupHelp = $derived<Record<string, { text: string; label: string }>>({
    [GROUP_KEY_BY_STAGE.active]: {
      text: m.herd_help_active(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_active() }),
    },
    [GROUP_KEY_BY_STAGE.ciRunning]: {
      text: m.herd_help_ci_running(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_ci_running() }),
    },
    [GROUP_KEY_BY_STAGE.ciFailed]: {
      text: m.herd_help_ci_failed(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_ci_failed() }),
    },
    [GROUP_KEY_BY_STAGE.reviewerRunning]: {
      text: m.herd_help_reviewing(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_reviewing() }),
    },
    [GROUP_KEY_BY_STAGE.reworkRunning]: {
      text: m.herd_help_rework(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_rework() }),
    },
    [GROUP_KEY_BY_STAGE.waitingOnReviewer]: {
      text: m.herd_help_waiting_reviewer(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_waiting_reviewer() }),
    },
    [GROUP_KEY_BY_STAGE.waitingOnMerger]: {
      text: m.herd_help_waiting_merger(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_waiting_merger() }),
    },
    [GROUP_KEY_BY_STAGE.draftAwaitingSignoff]: {
      text: m.herd_help_draft_signoff(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_draft_signoff() }),
    },
    [GROUP_KEY_BY_STAGE.awaitingMerge]: {
      text: m.herd_help_your_turn(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_your_turn() }),
    },
    [GROUP_KEY_BY_STAGE.ready]: {
      text: m.herd_help_ready(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_ready() }),
    },
    [GROUP_KEY_BY_STAGE.merging]: {
      text: m.herd_help_merging(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_merging() }),
    },
    [GROUP_KEY_BY_STAGE.merged]: {
      text: m.herd_help_merged(),
      label: m.newtask_info_aria({ topic: m.herd_stage_name_merged() }),
    },
  });
</script>

<div class="panel bracket" class:flow>
  {#if flow}
    <!-- mobile flow: the .phead title is hidden by CSS; the seg row is the control -->
    <div class="phead"><span class="micro">{m.herd_title()}</span></div>
    <HerdSegRow bind:filter {statusFilter} {onstatusfilter} />
  {:else}
    <!-- desktop / touch-wide: the icon-over-label lens strip IS the panel header
         (no separate "The Herd" title row) -->
    <HerdLensStrip
      bind:filter
      {statusFilter}
      {statusLabel}
      {collapsible}
      {owedCount}
      {onstatusfilter}
      {oncollapse}
    />
  {/if}
  <div class="units" class:flow>
    {#if filter === "next"}
      <!-- Up Next lens (#1169): cross-repo ranked queue of un-started work, no session list. -->
      <UpNextPanel {onbacklog} {repoFilter} {filteredRepo} launchContext={upNextLaunch} />
    {:else if filter === "rundown"}
      <!-- Rundown lens: the daily Herd Rundown digest panel, no session list. -->
      <RundownPanel onitemselect={onrundownitem} onepicland={onrundownepic} />
    {:else if filter === "owed"}
      <!-- Owed lens: durable post-merge manual steps still owed, across merged sessions (#1061).
         Panel-only (no session list), persists beyond the Done lens's 48h window. -->
      <PostMergeStepsPanel
        {repoFilter}
        {filteredRepo}
        focusSessionId={owedFocusId}
        focusSnapshot={owedFocusSnapshot}
        focusNonce={owedFocusNonce}
        focusHandledNonce={owedFocusHandledNonce}
        {onfocusresolved}
      />
    {:else if filter === "done"}
      <!-- Done lens: archived sessions from the page's lazy doneSessions store (NOT the
         live `sessions` list). Read-only rows; clicking opens the DoneRecapPanel. -->
      <HerdDoneList {doneList} {doneSelectedId} {ondoneselect} {nowMs} />
    {:else if sessions.length === 0}
      <!-- the status filter empties the list at PAGE level (herdSessions), so an
         empty status result lands HERE — it must outrank the repo note and the
         first-run EmptyHerd nudge, and name the active status so vanished
         done/parked sessions read as intentional -->
      <HerdEmptyState
        mode="sessions"
        {statusFilter}
        {statusLabel}
        {filteredRepo}
        {issueActionsUnset}
        {onnew}
        {onsettings}
      />
    {:else if shown.length === 0}
      <HerdEmptyState
        mode="shown"
        {statusFilter}
        {statusLabel}
        {filteredRepo}
        {issueActionsUnset}
        {onnew}
        {onsettings}
      />
    {:else}
      <HerdEpicGroups
        groups={grouped.groups}
        {collapsedKeys}
        {cuesFor}
        {onepic}
        {oncollapsetoggle}
        ctx={rowCtx}
      />
      <HerdExperimentGroups groups={experimentGrouped.groups} {oncompare} ctx={rowCtx} />
      {#each partitionGroups as grp (grp.key)}
        <!-- flow: phone accordion (internal state). Desktop: independent per-group
             collapse via the page-owned collapsedStageKeys — but only when the page
             wired onstagecollapsetoggle; without it the header must stay plain text,
             never a no-op disclosure button. touchTarget keys 44px targets to input
             modality: the phone layout always, wide layouts only on coarse pointers. -->
        <HerdGroup
          ctx={rowCtx}
          {...grp}
          help={groupHelp[grp.key] ?? null}
          collapsible={!!grp.headClass &&
            grp.sessions.length > 0 &&
            (flow || !!onstagecollapsetoggle)}
          expanded={flow ? mobileOpenPartitionKey === grp.key : !collapsedStageKeys.has(grp.key)}
          ontoggle={() =>
            flow ? toggleMobilePartitionGroup(grp.key) : onstagecollapsetoggle?.(grp.key)}
          touchTarget={flow || touch}
        />
      {/each}
    {/if}
    {#if filter !== "done" && filter !== "rundown" && filter !== "owed"}
      <IntegratedEpicsBand
        epics={completedEpics}
        ondismiss={ondismissepic ?? (() => {})}
        onackmigrations={onackmigrationsepic ?? (() => {})}
        onland={onlandepic ?? (() => {})}
        {focusEpic}
        {nowMs}
      />
    {/if}
  </div>
</div>

<style>
  .panel {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid var(--color-line-bright);
  }
  .bracket::before {
    top: -1px;
    left: -1px;
    border-right: 0;
    border-bottom: 0;
  }
  .bracket::after {
    bottom: -1px;
    right: -1px;
    border-left: 0;
    border-top: 0;
  }

  /* flow mode (mobile list): full-bleed panel — the side borders + corner
     brackets cost two vertical lines plus gutters on a narrow phone, so drop
     them and stretch into the shell's base edge padding (--mobile-shell-pad,
     shared with .shell.mobile in +page.svelte; with a larger safe-area inset
     the shell keeps the remainder). Top/bottom hairlines stay as section
     rules. */
  .panel.flow {
    border-inline: 0;
    margin-inline: calc(-1 * var(--mobile-shell-pad));
  }
  .panel.flow.bracket::before,
  .panel.flow.bracket::after {
    display: none;
  }
  /* The .phead title row only renders in flow (mobile); desktop/touch-wide use the lens
     strip as the header with no title. Hide the "THE HERD" span so the .phead collapses to
     a hairline above the seg-row. (herd_title is still referenced here, so the key stays.) */
  .panel.flow .phead > .micro {
    display: none;
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-muted);
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .units {
    overflow: auto;
    padding: 6px;
    flex: 1;
    min-height: 0;
    /* size context for UnitRow's container queries — lets rows adapt the
       designator to the actual sidebar width (compact vs desktop) */
    container: herd / inline-size;
  }

  /* flow mode: render at natural height for parent-page scrolling (mobile list);
     no horizontal gutter — the full-bleed panel has no side borders to clear,
     and the rows' own padding keeps text off the screen edge */
  .units.flow {
    overflow: visible;
    flex: none;
    min-height: auto;
    padding-inline: 0;
  }

  /* flow mode: rows are full-bleed, so the selected card's side borders would
     draw two vertical lines hugging the screen edges (the panel itself already
     dropped its own for the same reason) — keep only the top/bottom hairlines,
     and drop the corner bracket that hangs off the right border with them. */
  .units.flow :global(.unit.sel) {
    border-inline-color: transparent;
  }
  .units.flow :global(.unit.sel::after) {
    display: none;
  }
</style>
