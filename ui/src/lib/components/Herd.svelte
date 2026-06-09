<script lang="ts">
  import type { Session, GitState, SessionActivity } from "$lib/types";
  import UnitRow from "./UnitRow.svelte";
  import EmptyHerd from "./EmptyHerd.svelte";
  import { partitionSessions } from "./herd-partition";
  import { collectReadyPrs } from "./merge-train";
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
    onpreview = undefined,
    ondecommission,
    onclearmerged = undefined,
    onmergetrain = undefined,
    standardCommandUnset = false,
    onsettings = undefined,
    flow = false,
    filteredRepo = null,
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
    // a row's Preview badge was clicked → select the session + open its Viewport preview pane
    onpreview?: (id: string) => void;
    // when provided, rows gain left-swipe-to-decommission (mobile list)
    ondecommission?: (id: string) => void;
    // when provided, the merged group header gains a "clear all" action
    onclearmerged?: () => void;
    // when provided, the ready-to-merge group header gains a "merge train" action
    // (kicks off a new session that works through this group's PRs)
    onmergetrain?: () => void;
    // first-run empty state: quick-launch is invisible until the standard command
    // is set → surface a quiet nudge pointing at Settings.
    standardCommandUnset?: boolean;
    onsettings?: () => void;
    // when true, the session list renders at natural height (no internal scroll)
    // so the parent page can drive scrolling; default false preserves existing behavior
    flow?: boolean;
    // basename of an active repo filter; when set and the (already-filtered) session
    // list is empty, show a neutral "no agents for this repo" note instead of the
    // first-run EmptyHerd nudge. null = unfiltered.
    filteredRepo?: string | null;
  } = $props();

  // a critic post-PR review or a pre-execution plan-gate review currently in flight —
  // the reviewer is actively working the session, so it is NOT awaiting the operator.
  const inReview = (id: string) => reviews.isReviewing(id) || planGates.isReviewing(id);

  // sidebar list filter: "all" or "ready" (only sessions not actively working —
  // anything but a running agent: idle, blocked, done → awaiting the operator;
  // in-review sessions are excluded too, since a reviewer is actively working them)
  let filter = $state<"all" | "ready">("all");
  const shown = $derived(
    filter === "ready"
      ? sessions.filter((s) => s.status !== "running" && !inReview(s.id))
      : sessions,
  );
  // within the shown set, top→bottom by lifecycle stage: active rows first, then
  // PR-CI-running and critic-reviewing / plan-gate-reviewing in-flight groups, then
  // the parked ready-to-merge (green) and landed merged (blue) groups at the bottom.
  // reviews.reviewing and planGates.reviewing are both $state, so this re-derives on
  // `session:reviewing` and `session:plangate-reviewing` events respectively.
  // nowMs (the reactive clock tick) is threaded in so the Merging group re-partitions
  // as the per-session merge TTL elapses, matching the badge/pip which also use nowMs.
  const partition = $derived(partitionSessions(shown, git, inReview, nowMs));
  // ready-to-merge sessions that actually have an open PR — the merge-train link
  // only surfaces when there's something to run (fail-closed: no PR → no link).
  // In-review sessions are excluded so the link's count matches the launch action.
  const readyPrCount = $derived(collectReadyPrs(shown, git, inReview).length);

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

<div class="panel bracket">
  <div class="phead">
    <span class="micro">{m.herd_title()}</span>
    <div class="right filters">
      <button
        type="button"
        class="micro fbtn"
        class:active={filter === "all"}
        title={m.herd_all_title()}
        aria-pressed={filter === "all"}
        onclick={() => (filter = "all")}>{m.herd_all_hint()}</button
      >
      <button
        type="button"
        class="micro fbtn"
        class:active={filter === "ready"}
        title={m.herd_ready_title()}
        aria-pressed={filter === "ready"}
        onclick={() => (filter = "ready")}>{m.herd_ready_filter()}</button
      >
    </div>
  </div>
  <div class="units" class:flow>
    {#if sessions.length === 0}
      {#if filteredRepo}
        <div class="empty micro static">{m.herd_repo_filter_empty({ repo: filteredRepo })}</div>
      {:else}
        <EmptyHerd {onnew} {standardCommandUnset} {onsettings} />
      {/if}
    {:else if shown.length === 0}
      <div class="empty micro static">{m.herd_ready_empty()}</div>
    {:else}
      {#each partition.active as session (session.id)}
        <UnitRow
          {session}
          selected={session.id === selectedId}
          {nowMs}
          {onselect}
          git={git[session.id]}
          activity={activity[session.id]}
          previewPort={preview[session.id] ?? null}
          {onpreview}
          {ondecommission}
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
            {onpreview}
            {ondecommission}
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
            {onpreview}
            {ondecommission}
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
            {onpreview}
            {ondecommission}
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
            {onpreview}
            {ondecommission}
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
            {onpreview}
            {ondecommission}
          />
        {/each}
      {/if}
      {#if partition.ready.length > 0}
        <div class="ready-head micro">
          {m.herd_ready_group({ count: partition.ready.length })}
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
            {onpreview}
            {ondecommission}
          />
        {/each}
      {/if}
      {#if partition.merged.length > 0}
        <div class="merged-head micro">
          {m.herd_merged_group({ count: partition.merged.length })}
          {#if onclearmerged}
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
            {onpreview}
            {ondecommission}
          />
        {/each}
      {/if}
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

  .phead {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-muted);
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

  .units {
    overflow: auto;
    padding: 6px;
    flex: 1;
    min-height: 0;
    /* size context for UnitRow's container queries — lets rows adapt the
       designator to the actual sidebar width (compact vs desktop) */
    container: herd / inline-size;
  }

  /* flow mode: render at natural height for parent-page scrolling (mobile list) */
  .units.flow {
    overflow: visible;
    flex: none;
    min-height: auto;
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
