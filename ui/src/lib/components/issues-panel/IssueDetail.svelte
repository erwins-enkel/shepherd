<script lang="ts">
  import type {
    DrainStatus,
    Epic,
    EpicSummary,
    GitState,
    Issue,
    Session,
    Steer,
    TaskRunDefaults,
    TaskRunSeed,
  } from "#lib/types.js";
  import { m } from "#lib/paraglide/messages.js";
  import { importEpic } from "#lib/api.js";
  import { toasts } from "#lib/toasts.svelte.js";
  import { assignedOthers, epicFlagForOthers, type IssueSelection } from "../issues-panel";
  import { epicRole, queuePosition, stateLabel } from "../epic-panel";
  import EpicPanel from "../EpicPanel.svelte";
  import EpicRunControl from "./EpicRunControl.svelte";
  import EpicChildRun from "./EpicChildRun.svelte";
  import EpicFlowGraph from "./EpicFlowGraph.svelte";
  import EpicTimingDetail from "./EpicTimingDetail.svelte";
  import EpicDiagnosisModal from "../EpicDiagnosisModal.svelte";
  import MarkdownBody from "../MarkdownBody.svelte";
  import IssueDetailHead from "./IssueDetailHead.svelte";
  import IssueTaskBox from "./IssueTaskBox.svelte";

  // Reading detail of the backlog Issues tab (#2617) for the selected list entry:
  //  - single issue → head, the "Aufgabe" box, then the rendered description;
  //  - epic         → head (⋯ menu: Import / Diagnose), the sticky run area (#2620), its time
  //                   (#2939), the flow graph (#2621), the EpicPanel's children, then the
  //                   description;
  //  - epic child   → head (← Epic #n), its run area (#2622: standing / session / merged),
  //                   then the description.
  // Wide enough (WIDE_FROM), a single issue and an epic use the width (#2950): text on the left
  // (the description, ≤ 760px), controls on the right (Aufgabe / Abarbeitung + time, 300–340px);
  // an epic's flow graph spans the full row above them. Narrower, everything stacks in the order
  // listed above. The width is measured, not queried (`container-type` would re-anchor the
  // `position: fixed` menus and dialogs inside EpicRunControl to the container).
  let {
    repoPath,
    selection,
    epicSummary = undefined,
    epic = undefined,
    drain = null,
    showAssignees = false,
    viewer = null,
    issueActions,
    taskDefaults = undefined,
    // Consumed only via `bind:run` on IssueTaskBox below, which fallow's prop-usage analyzer
    // doesn't see (same false positive as BacklogView's `flow`).
    // fallow-ignore-next-line unused-component-props
    run = $bindable({}),
    onstart,
    onquick = undefined,
    titleFor,
    epicSummaryFor = undefined,
    onopensession = undefined,
    onopenautomation = undefined,
    onselectchild = undefined,
    onselectepic = undefined,
    onstartchild = undefined,
    sessionInfo = undefined,
    issueSession = undefined,
  }: {
    repoPath: string;
    selection: IssueSelection;
    /** Summary of the selected epic (epic selections only). */
    epicSummary?: EpicSummary;
    /** Live/fetched record of the selected epic — or of a selected child's epic; undefined
     *  while it loads. */
    epic?: Epic;
    drain?: DrainStatus | null;
    showAssignees?: boolean;
    viewer?: string | null;
    issueActions: Steer[];
    taskDefaults?: TaskRunDefaults;
    run?: TaskRunSeed;
    onstart: (issue: Issue) => void;
    onquick?: (issue: Issue, action: Steer) => void;
    /** Issue title by number (loaded epic children, open issues) for the run area's steps. */
    titleFor: (issue: number) => string | null;
    /** Any epic's list entry by number — the leading epic a stopped one waits for. */
    epicSummaryFor?: (parent: number) => EpicSummary | undefined;
    onopensession?: (sessionId: string) => void;
    onopenautomation?: () => void;
    /** Select an epic child in the list (a click on the flow graph). */
    onselectchild?: (parent: number, child: number) => void;
    /** Select an epic in the list (a child's "← Epic #n"). */
    onselectepic?: (parent: number) => void;
    /** Open the New Task dialog for an epic child outside the epic's order. */
    onstartchild?: (parent: number, child: number) => void;
    /** A session and its PR state from the store, by id; null when unknown. */
    sessionInfo?: (id: string) => { session: Session; git?: GitState } | null;
    /** The live session working an issue of this repo, by issue number. */
    issueSession?: (issue: number) => Session | null;
  } = $props();

  let showDiag = $state(false);

  /** The reading view's width from which text and controls sit side by side. */
  const WIDE_FROM = 760;
  let viewWidth = $state(0);
  const wide = $derived(viewWidth >= WIDE_FROM && selection.kind !== "child");

  // The epic's clocks tick each second while it can still move: until it landed. A landed one
  // still reads the current time once per record, for its dates.
  let nowMs = $state(Date.now());
  const ticking = $derived(
    selection.kind === "epic" && epic?.timing != null && epic.timing.landedAt == null,
  );
  $effect(() => {
    void epic;
    nowMs = Date.now();
    if (!ticking) return;
    const timer = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  /** A flow-graph node click selects that child of the shown epic in the list (#2621). */
  function selectFlowChild(child: number) {
    if (selection.kind === "epic") onselectchild?.(selection.issue.number, child);
  }

  const live = $derived(
    selection.kind === "child" && selection.child.sessionId
      ? (sessionInfo?.(selection.child.sessionId) ?? null)
      : null,
  );

  const othersFlag = $derived(selection.kind === "epic" ? epicFlagForOthers(epicSummary) : null);
  const role = $derived(
    selection.kind === "epic" ? epicRole(drain?.runSummary, selection.issue.number) : null,
  );
  const position = $derived(
    selection.kind === "epic" ? queuePosition(drain?.runSummary, selection.issue.number) : null,
  );
  // Plain-issue assignee pill (#1694) — same rule as the former list row: only while the
  // "mine & unassigned" filter isn't hiding others' issues, and never on an epic.
  const assign = $derived.by(() => {
    if (selection.kind !== "single" || !showAssignees) return null;
    const issue = selection.issue;
    const who = viewer == null ? (issue.assignees ?? []) : assignedOthers(issue, viewer);
    return who.length ? { who, framed: viewer != null } : null;
  });

  const head = $derived.by(() => {
    if (selection.kind === "child") {
      const c = selection.child;
      return {
        tag: m.issuedetail_epic_of({ parent: selection.parent }),
        number: c.number,
        title: c.title,
        url: c.url,
        labels: [stateLabel(c.state)],
        back: onselectepic
          ? { parent: selection.parent, onclick: () => onselectepic(selection.parent) }
          : null,
      };
    }
    const i = selection.issue;
    return {
      tag: selection.kind === "epic" ? m.issuedetail_epic_tag() : null,
      number: i.number,
      title: i.title,
      url: i.url,
      labels: i.labels,
      labelColors: i.labelColors,
      author: i.author,
      createdAt: i.createdAt,
      blockedBy: selection.kind === "single" ? (i.blockedBy ?? []) : [],
    };
  });

  const menu = $derived(
    selection.kind === "epic"
      ? {
          canImport: (epic?.source ?? epicSummary?.source) === "markdown",
          onimport: () => {
            const parent = head.number;
            importEpic(repoPath, parent).catch(() =>
              toasts.info(m.epic_import_failed(), { alert: true, key: "epic-import-fail" }),
            );
          },
          ondiagnose: () => (showDiag = true),
        }
      : null,
  );
</script>

<article class="issue-detail" aria-label={head.title} bind:clientWidth={viewWidth}>
  <IssueDetailHead {...head} {assign} {othersFlag} {menu} {role} {position} />

  <div class="detail-body" class:wide class:has-flow={selection.kind === "epic" && epic}>
    {#if selection.kind === "single"}
      <div class="aside">
        <IssueTaskBox
          {repoPath}
          issue={selection.issue}
          session={issueSession?.(selection.issue.number) ?? null}
          defaults={taskDefaults}
          bind:run
          {issueActions}
          onstart={() => onstart(selection.issue)}
          onquick={onquick ? (a) => onquick(selection.issue, a) : undefined}
          {onopensession}
        />
      </div>
    {:else if selection.kind === "epic" && epic}
      <!-- The run area stays pinned (sticky) across the child list AND the description: a sticky
           box only sticks within its parent, so this wrapper is the full height of the row
           (wide) or dissolves into the body (stacked). -->
      <div class="aside">
        <EpicRunControl
          {repoPath}
          parent={selection.issue.number}
          {epic}
          {drain}
          {othersFlag}
          {titleFor}
          {epicSummaryFor}
          {onselectepic}
          {onopensession}
          {onopenautomation}
        />
        <EpicTimingDetail {epic} {nowMs} slots={drain?.max ?? null} {onopenautomation} />
      </div>
      <div class="flow-row">
        <EpicFlowGraph {epic} {sessionInfo} onselect={selectFlowChild} />
      </div>
    {/if}

    <div class="main">
      {#if selection.kind === "epic"}
        <div class="epic-host" data-epic-panel>
          {#if epic}
            <EpicPanel
              {repoPath}
              parent={selection.issue.number}
              {epic}
              runSummary={drain?.runSummary ?? null}
              headActions={false}
              {nowMs}
            />
          {:else}
            <div class="muted">{m.common_loading()}</div>
          {/if}
        </div>
      {:else if selection.kind === "child" && epic}
        {@const parent = selection.parent}
        {@const child = selection.child}
        <EpicChildRun
          {child}
          {epic}
          {drain}
          {live}
          {titleFor}
          onstartanyway={onstartchild ? () => onstartchild(parent, child.number) : undefined}
          onselectepic={onselectepic ? () => onselectepic(parent) : undefined}
          onselectchild={onselectchild ? (n) => onselectchild(parent, n) : undefined}
          {onopensession}
        />
      {/if}

      <MarkdownBody
        source={selection.kind === "child" ? selection.child.body : selection.issue.body}
      />
    </div>
  </div>
</article>

{#if showDiag}
  <EpicDiagnosisModal {repoPath} parent={head.number} onclose={() => (showDiag = false)} />
{/if}

<style>
  .issue-detail {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
    padding: 14px 18px 24px;
  }

  .detail-body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  /* Stacked: the wrapper dissolves, so its boxes are items of the body column. */
  .aside {
    display: contents;
  }

  /* Wide: text left (≤ 760px), controls right (300–340px); the third track soaks up the rest, so
     the flow graph's full-row span is the whole reading width. */
  .detail-body.wide {
    display: grid;
    grid-template-columns: minmax(0, 760px) minmax(300px, 340px) minmax(0, 1fr);
    align-items: start;
    gap: 14px 0;
  }
  .wide .main {
    grid-column: 1;
    grid-row: 1;
    padding-right: 24px;
  }
  .wide .aside {
    display: flex;
    flex-direction: column;
    gap: 14px;
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
  }
  .wide.has-flow .flow-row {
    grid-column: 1 / -1;
    grid-row: 1;
  }
  .wide.has-flow .main,
  .wide.has-flow .aside {
    grid-row: 2;
  }
  /* The run area pins beside the description: its wrapper is as tall as the row. */
  .wide.has-flow .aside {
    align-self: stretch;
  }

  /* EpicPanel draws its own panel ground; the host adds the hairline frame. */
  .epic-host {
    border: 1px solid color-mix(in srgb, var(--status-running) 25%, var(--color-line));
    border-radius: 2px;
  }

  .muted {
    padding: 8px 10px;
    color: var(--color-faint);
    font-size: var(--fs-base);
  }
</style>
