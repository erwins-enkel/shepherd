<script lang="ts">
  import type {
    DrainStatus,
    Epic,
    EpicSummary,
    Issue,
    Steer,
    TaskRunDefaults,
    TaskRunSeed,
  } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { importEpic } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { assignedOthers, epicFlagForOthers, type IssueSelection } from "../issues-panel";
  import { epicRole, stateLabel } from "../epic-panel";
  import EpicPanel from "../EpicPanel.svelte";
  import EpicRunControl from "./EpicRunControl.svelte";
  import EpicDiagnosisModal from "../EpicDiagnosisModal.svelte";
  import MarkdownBody from "../MarkdownBody.svelte";
  import IssueDetailHead from "./IssueDetailHead.svelte";
  import IssueTaskBox from "./IssueTaskBox.svelte";

  // Reading detail of the backlog Issues tab (#2617) for the selected list entry:
  //  - single issue → head, the "Aufgabe" box, then the rendered description;
  //  - epic         → head (⋯ menu: Import / Diagnose), the sticky run area (#2620), the
  //                   EpicPanel's children, then the description;
  //  - epic child   → head + description (child views follow in a later issue).
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
    onopensession = undefined,
    onopenautomation = undefined,
  }: {
    repoPath: string;
    selection: IssueSelection;
    /** Summary of the selected epic (epic selections only). */
    epicSummary?: EpicSummary;
    /** Live/fetched record of the selected epic; undefined while it loads. */
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
    onopensession?: (sessionId: string) => void;
    onopenautomation?: () => void;
  } = $props();

  let showDiag = $state(false);

  const othersFlag = $derived(selection.kind === "epic" ? epicFlagForOthers(epicSummary) : null);
  const role = $derived(
    selection.kind === "epic" ? epicRole(drain?.runSummary, selection.issue.number) : null,
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

<article class="issue-detail" aria-label={head.title}>
  <IssueDetailHead {...head} {assign} {othersFlag} {menu} {role} />

  {#if selection.kind === "single"}
    <IssueTaskBox
      {repoPath}
      issue={selection.issue}
      defaults={taskDefaults}
      bind:run
      {issueActions}
      onstart={() => onstart(selection.issue)}
      onquick={onquick ? (a) => onquick(selection.issue, a) : undefined}
    />
  {:else if selection.kind === "epic"}
    <!-- A direct child of the article, so it stays pinned across the child list AND the
         description (a sticky box only sticks within its parent). -->
    {#if epic}
      <EpicRunControl
        {repoPath}
        parent={selection.issue.number}
        {epic}
        {drain}
        {othersFlag}
        {titleFor}
        {onopensession}
        {onopenautomation}
      />
    {/if}
    <div class="epic-host" data-epic-panel>
      {#if epic}
        <EpicPanel
          {repoPath}
          parent={selection.issue.number}
          {epic}
          runSummary={drain?.runSummary ?? null}
          headActions={false}
        />
      {:else}
        <div class="muted">{m.common_loading()}</div>
      {/if}
    </div>
  {/if}

  <MarkdownBody source={selection.kind === "child" ? selection.child.body : selection.issue.body} />
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
