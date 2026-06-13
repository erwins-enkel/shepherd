<script lang="ts">
  import type { Session, GitState, SessionActivity, Epic } from "$lib/types";
  import UnitRow from "./UnitRow.svelte";
  import EmptyHerd from "./EmptyHerd.svelte";
  import EpicGroupHeader from "./EpicGroupHeader.svelte";
  import { partitionSessions, shownSessions, type HerdFilter } from "./herd-partition";
  import { groupSessionsByEpic } from "./epic-grouping";
  import { collectReadyPrs } from "./merge-train";
  import { displayStatus } from "$lib/display-status";
  import { reviews, planGates } from "$lib/reviews.svelte";
  import { m } from "$lib/paraglide/messages";

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
    ondecommission,
    onrelaunch = undefined,
    onrelaunchElsewhere = undefined,
    onclearmerged = undefined,
    onmergetrain = undefined,
    issueActionsUnset = false,
    onsettings = undefined,
    flow = false,
    filteredRepo = null,
    repoFilter = null,
    onrepofilter = undefined,
    filter = $bindable("all"),
    statusFilter = null,
    onstatusfilter = undefined,
    workingBlocked = {},
    collapsible = false,
    oncollapse = undefined,
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
    onpreview?: (id: string) => void;
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
    // when provided, rows gain left-swipe-to-decommission (mobile list)
    ondecommission?: (id: string) => void;
    // when provided, each row's CardMenu gains a two-step armed Relaunch action
    onrelaunch?: (id: string) => void;
    // when provided, each row's CardMenu gains a one-click "Relaunch elsewhere" item
    onrelaunchElsewhere?: (id: string) => void;
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
    // full repoPath of the active repo filter — drives each row's inline-emoji
    // pressed state; threaded with onrepofilter so the emoji toggles the filter
    repoFilter?: string | null;
    onrepofilter?: (repoPath: string | null) => void;
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
    // when true, renders a collapse chevron at the far-right of the header —
    // only set on touch-primary wide devices where collapsing is meaningful
    collapsible?: boolean;
    // called when the collapse chevron is clicked; parent drives the actual
    // collapse so the button is purely a signal
    oncollapse?: () => void;
  } = $props();

  // a critic post-PR review or a pre-execution plan-gate review currently in flight —
  // the reviewer is actively working the session, so it is NOT awaiting the operator.
  const inReview = (id: string) => reviews.isReviewing(id) || planGates.isReviewing(id);

  // sidebar list filter (bindable prop): "all" or "ready" (only sessions not actively
  // working — anything but a running agent: idle, blocked, done → awaiting the operator;
  // in-review sessions are excluded too, since a reviewer is actively working them).
  // shownSessions is the shared single source of truth with herd-keynav's railOrder.
  // one filter at a time: an active page-level status filter short-circuits the
  // local all/ready filter ENTIRELY — a "ready" remnant would drop running sessions
  // and empty the list under statusFilter="running" (sessions already arrive filtered).
  const shown = $derived(
    statusFilter != null ? sessions : shownSessions(sessions, filter, inReview, workingBlocked),
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
  const grouped = $derived(groupSessionsByEpic(shown, epics, activeEpicKeys, git, inReview, nowMs));
  const partition = $derived(partitionSessions(grouped.rest, git, inReview, nowMs));
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
      grouped.groups.map((g) => [g.key, partitionSessions(g.sessions, git, inReview, nowMs)]),
    ),
  );
  // Per-group attention cues — reads the shared partition; the blocked count still scans
  // g.sessions directly via displayStatus (it's not a partition bucket).
  function cuesFor(g: { key: string; sessions: Session[] }): {
    ciFailed: number;
    ready: number;
    blocked: number;
  } {
    const p = groupParts.get(g.key);
    return {
      ciFailed: p?.ciFailed.length ?? 0,
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
</script>

<div class="herd-root" class:collapsible>
  <div class="panel bracket" class:flow>
    <div class="phead">
      <span class="micro">{m.herd_title()}</span>
      <div class="right filters">
        <button
          type="button"
          class="micro fbtn"
          class:active={statusFilter == null && filter === "all"}
          title={m.herd_all_title()}
          aria-pressed={statusFilter == null && filter === "all"}
          onclick={() => {
            filter = "all";
            onstatusfilter?.(null);
          }}>{m.herd_all_hint()}</button
        >
        <button
          type="button"
          class="micro fbtn"
          class:active={statusFilter == null && filter === "ready"}
          title={m.herd_ready_title()}
          aria-pressed={statusFilter == null && filter === "ready"}
          onclick={() => {
            filter = "ready";
            onstatusfilter?.(null);
          }}>{m.herd_ready_filter()}</button
        >
        {#if statusFilter != null}
          <!-- aria-label carries status + clear action; the visible "✕" glyph would
             otherwise be read aloud without conveying what the chip does -->
          <button
            type="button"
            class="micro fbtn active statchip"
            title={m.topbar_tally_clear_title()}
            aria-label={m.herd_status_chip_aria({ status: statusLabel })}
            aria-pressed="true"
            onclick={() => onstatusfilter?.(null)}>{statusLabel} ✕</button
          >
        {/if}
      </div>
    </div>
    <div class="units" class:flow>
      {#if sessions.length === 0}
        <!-- the status filter empties the list at PAGE level (herdSessions), so an
           empty status result lands HERE — it must outrank the repo note and the
           first-run EmptyHerd nudge, and name the active status so vanished
           done/parked sessions read as intentional -->
        {#if statusFilter != null && filteredRepo}
          <div class="empty micro static">
            {m.herd_status_repo_filter_empty({ status: statusLabel, repo: filteredRepo })}
          </div>
        {:else if statusFilter != null}
          <div class="empty micro static">
            {m.herd_status_filter_empty({ status: statusLabel })}
          </div>
        {:else if filteredRepo}
          <div class="empty micro static">{m.herd_repo_filter_empty({ repo: filteredRepo })}</div>
        {:else}
          <EmptyHerd {onnew} {issueActionsUnset} {onsettings} />
        {/if}
      {:else if shown.length === 0}
        <div class="empty micro static">{m.herd_ready_empty()}</div>
      {:else}
        {#each grouped.groups as g (g.key)}
          <EpicGroupHeader
            epic={g.epic}
            collapsed={collapsedKeys?.has(g.key) ?? false}
            cues={cuesFor(g)}
            ontoggle={() => oncollapsetoggle?.(g.key)}
            {onepic}
          />
          {#if !(collapsedKeys?.has(g.key) ?? false)}
            <div class="epic-children">
              {#each g.sessions as session (session.id)}
                <UnitRow
                  {session}
                  selected={session.id === selectedId}
                  {nowMs}
                  {onselect}
                  git={git[session.id]}
                  activity={activity[session.id]}
                  previewPort={preview[session.id] ?? null}
                  previewServeFailed={previewServe[session.id] === "failed"}
                  {onpreview}
                  {ondecommission}
                  {onrelaunch}
                  {onrelaunchElsewhere}
                  {repoFilter}
                  {onrepofilter}
                  {workingBlocked}
                />
              {/each}
            </div>
          {/if}
        {/each}
        {#each partition.active as session (session.id)}
          <UnitRow
            {session}
            selected={session.id === selectedId}
            {nowMs}
            {onselect}
            git={git[session.id]}
            activity={activity[session.id]}
            previewPort={preview[session.id] ?? null}
            previewServeFailed={previewServe[session.id] === "failed"}
            {onpreview}
            {ondecommission}
            {onrelaunch}
            {onrelaunchElsewhere}
            {repoFilter}
            {onrepofilter}
            {workingBlocked}
          />
        {/each}
        {#if partition.ciRunning.length > 0}
          <div class="ci-head micro">
            {m.herd_ci_running_group({ count: partition.ciRunning.length })}
          </div>
          {#each partition.ciRunning as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              previewPort={preview[session.id] ?? null}
              previewServeFailed={previewServe[session.id] === "failed"}
              {onpreview}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.ciFailed.length > 0}
          <div class="ci-failed-head micro">
            {m.herd_ci_failed_group({ count: partition.ciFailed.length })}
          </div>
          {#each partition.ciFailed as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              previewPort={preview[session.id] ?? null}
              previewServeFailed={previewServe[session.id] === "failed"}
              {onpreview}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.reviewerRunning.length > 0}
          <div class="reviewing-head micro">
            {m.herd_reviewer_running_group({ count: partition.reviewerRunning.length })}
          </div>
          {#each partition.reviewerRunning as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              previewPort={preview[session.id] ?? null}
              previewServeFailed={previewServe[session.id] === "failed"}
              {onpreview}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.waitingOnReviewer.length > 0}
          <div class="waiting-head micro">
            {reviewerWho
              ? m.herd_waiting_reviewer_group({
                  who: reviewerWho,
                  count: partition.waitingOnReviewer.length,
                })
              : m.herd_waiting_reviewer_group_multi({ count: partition.waitingOnReviewer.length })}
          </div>
          {#each partition.waitingOnReviewer as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.waitingOnMerger.length > 0}
          <div class="waiting-head micro">
            {mergerWho
              ? m.herd_waiting_merger_group({
                  who: mergerWho,
                  count: partition.waitingOnMerger.length,
                })
              : m.herd_waiting_merger_group_multi({ count: partition.waitingOnMerger.length })}
          </div>
          {#each partition.waitingOnMerger as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.draftAwaitingSignoff.length > 0}
          <div class="draft-head micro">
            {m.herd_draft_awaiting_signoff_group({ count: partition.draftAwaitingSignoff.length })}
          </div>
          {#each partition.draftAwaitingSignoff as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.awaitingMerge.length > 0}
          <div class="awaiting-head micro">
            {m.herd_awaiting_merge_group({ count: partition.awaitingMerge.length })}
          </div>
          {#each partition.awaitingMerge as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              previewPort={preview[session.id] ?? null}
              previewServeFailed={previewServe[session.id] === "failed"}
              {onpreview}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.ready.length + readyAbove > 0}
          <div class="ready-head micro">
            {#if partition.ready.length > 0}
              {m.herd_ready_group({ count: partition.ready.length })}
            {/if}
            {#if readyAbove > 0}
              <span class="above">{m.herd_in_epics_above({ count: readyAbove })}</span>
            {/if}
            {#if onmergetrain && readyPrCount > 0}
              <button
                type="button"
                class="merge-train micro"
                title={m.herd_merge_train_title()}
                onclick={onmergetrain}>{m.herd_merge_train_action()}</button
              >
            {/if}
          </div>
          {#each partition.ready as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              previewPort={preview[session.id] ?? null}
              previewServeFailed={previewServe[session.id] === "failed"}
              {onpreview}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.merging.length > 0}
          <div class="merging-head micro">
            {m.herd_merging_group({ count: partition.merging.length })}
          </div>
          {#each partition.merging as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              previewPort={preview[session.id] ?? null}
              previewServeFailed={previewServe[session.id] === "failed"}
              {onpreview}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
        {#if partition.merged.length + mergedAbove > 0}
          <div class="merged-head micro">
            {#if partition.merged.length > 0}
              {m.herd_merged_group({ count: partition.merged.length })}
            {/if}
            {#if mergedAbove > 0}
              <span class="above">{m.herd_in_epics_above({ count: mergedAbove })}</span>
            {/if}
            {#if onclearmerged && mergedCount > 0}
              <button
                type="button"
                class="clear-merged micro"
                title={m.herd_clear_merged_title()}
                onclick={onclearmerged}>{m.herd_clear_merged_action()}</button
              >
            {/if}
          </div>
          {#each partition.merged as session (session.id)}
            <UnitRow
              {session}
              selected={session.id === selectedId}
              {nowMs}
              {onselect}
              git={git[session.id]}
              activity={activity[session.id]}
              previewPort={preview[session.id] ?? null}
              previewServeFailed={previewServe[session.id] === "failed"}
              {onpreview}
              {ondecommission}
              {onrelaunch}
              {onrelaunchElsewhere}
              {repoFilter}
              {onrepofilter}
              {workingBlocked}
            />
          {/each}
        {/if}
      {/if}
    </div>
  </div>
  {#if collapsible}
    <button
      id="herd-collapse-btn"
      type="button"
      class="collapse-edge"
      title={m.herd_collapse()}
      aria-label={m.herd_collapse()}
      onclick={() => oncollapse?.()}>‹</button
    >
  {/if}
</div>

<style>
  /* display: contents keeps the non-collapsible (desktop/mobile) layout
     byte-for-byte identical — the .panel stays the laid-out grid/flow child.
     Only when collapsible (touch && !mobile) does it become a flex row holding
     the panel + the right-edge collapse tab. */
  .herd-root {
    display: contents;
  }
  .herd-root.collapsible {
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .herd-root.collapsible > .panel {
    flex: 1;
    min-width: 0;
  }

  .panel {
    position: relative;
    border: 1px solid var(--color-line);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
    min-height: 0;
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
  .phead .right {
    margin-left: auto;
  }
  .filters {
    display: flex;
    gap: 4px;
  }
  .fbtn {
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 2px 5px;
    color: var(--color-faint);
    transition: color 0.12s ease;
  }
  .fbtn:hover {
    color: var(--color-ink);
  }
  .fbtn.active {
    color: var(--color-amber);
  }
  .fbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* collapse trigger — a slim full-height tab on the panel's right edge, the
     mirror image of the reopen tab (+page.svelte .reopen-tab); both are the same
     44px width and appear on the same touch devices. Replaces the old in-header
     chevron, which wrapped to its own row when the filter group's auto-margin
     starved it of space. */
  .collapse-edge {
    flex: 0 0 44px;
    box-sizing: border-box;
    align-self: stretch;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-left: 0;
    color: var(--color-faint);
    font-size: var(--fs-lg);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: color 0.12s ease;
  }
  .collapse-edge:hover {
    color: var(--color-ink);
  }
  .collapse-edge:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* amber section headers for the in-flight stages (PR CI running, critic
     reviewing) — amber mirrors the CI-pending dot and the critic badge */
  .ci-head,
  .reviewing-head,
  .merging-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-amber);
    border-top: 1px solid color-mix(in srgb, var(--color-amber) 30%, var(--color-line));
  }

  /* red section header for an open PR whose CI failed — done but needs a look */
  .ci-failed-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-red);
    border-top: 1px solid color-mix(in srgb, var(--color-red) 30%, var(--color-line));
  }

  /* slate section header for a green-CI draft PR awaiting human sign-off —
     parked but NOT actionable (must never read as the green "Your turn" state) */
  .draft-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-slate);
    border-top: 1px solid color-mix(in srgb, var(--color-slate) 30%, var(--color-line));
  }

  /* green section headers for the "waiting for a human to merge" stages:
     auto-detected (open PR, CI green) and operator-parked "ready to merge" */
  .awaiting-head,
  .ready-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-green);
    border-top: 1px solid color-mix(in srgb, var(--color-green) 30%, var(--color-line));
  }

  /* slate section header for "waiting on someone else" (a foreign reviewer/merger):
     NOT the operator's turn, so it must read as parked, not actionable-green. */
  .waiting-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-slate);
    border-top: 1px solid color-mix(in srgb, var(--color-slate) 30%, var(--color-line));
  }

  /* blue section header for the landed "merged PR" group */
  .merged-head {
    display: flex;
    align-items: center;
    padding: 10px 8px 6px;
    margin-top: 6px;
    color: var(--color-blue);
    border-top: 1px solid color-mix(in srgb, var(--color-blue) 30%, var(--color-line));
  }
  /* right-aligned action in the ready-to-merge group header */
  .merge-train {
    margin-left: auto;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 0 2px;
    color: color-mix(in srgb, var(--color-green) 70%, var(--color-faint));
    transition: color 0.12s ease;
  }
  .merge-train:hover {
    color: var(--color-green);
  }
  .merge-train:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* right-aligned bulk action in the merged group header */
  .clear-merged {
    margin-left: auto;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    padding: 0 2px;
    color: color-mix(in srgb, var(--color-blue) 70%, var(--color-faint));
    transition: color 0.12s ease;
  }
  .clear-merged:hover {
    color: var(--color-blue);
  }
  .clear-merged:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* Child rows of an epic group sit lightly inset under their headline so the
     group reads as one unit. A hairline rail on the leading edge reinforces the
     nesting without a heavy indent. Token-based; no raw px color. */
  .epic-children {
    padding-left: 10px;
    margin-left: 4px;
    border-left: 1px solid color-mix(in srgb, var(--color-blue) 30%, var(--color-line));
  }

  /* "N in epics above" — a quiet annotation beside a section count when that
     stage's rows live in epic groups above the lifecycle list. */
  .above {
    color: var(--color-faint);
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

  .empty {
    width: 100%;
    padding: 24px 14px;
    text-align: center;
    color: var(--color-faint);
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
    transition: color 0.12s ease;
  }
  .empty:hover {
    color: var(--color-ink);
  }
  .empty.static {
    cursor: default;
  }
  .empty.static:hover {
    color: var(--color-faint);
  }
</style>
