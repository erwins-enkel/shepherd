<script lang="ts">
  import type { DrainStatus, Epic, Issue, PullRequest, Steer } from "$lib/types";
  import IssuesPanel from "../IssuesPanel.svelte";
  import PrsPanel from "../PrsPanel.svelte";
  import ActionsPanel from "../ActionsPanel.svelte";
  import ReadinessPanel from "../ReadinessPanel.svelte";
  import AutomationSettings from "../AutomationSettings.svelte";

  type Tab = "issues" | "prs" | "actions" | "readiness" | "automation";

  // The selected repo's detail panel for the active tab — shared by BacklogView's
  // desktop split and mobile overlay (#855). Only rendered for a non-null
  // selection, so `selectedPath` is a plain string here.
  let {
    activeTab,
    selectedPath,
    onissue,
    onquick = undefined,
    oninject = undefined,
    onpr,
    onlaunchtrain,
    onadopt,
    epics = undefined,
    inTrainPrs = new Set(),
    target = null,
    drain = undefined,
  }: {
    activeTab: Tab;
    selectedPath: string;
    onissue: (repoPath: string, issue: Issue) => void;
    onquick?: (repoPath: string, issue: Issue, action: Steer) => void;
    oninject?: (repoPath: string, issue: Issue, steer: Steer) => void;
    onpr: (repoPath: string, pr: PullRequest) => void;
    onlaunchtrain: (repoPath: string, prs: PullRequest[]) => void;
    onadopt: (repoPath: string, prompt: string) => void;
    epics?: Record<string, Epic>;
    inTrainPrs?: Set<string>;
    target?: { repoPath: string; issueNumber: number } | null;
    drain?: Record<string, DrainStatus>;
  } = $props();
</script>

{#if activeTab === "issues"}
  <IssuesPanel
    repoPath={selectedPath}
    onnewtask={(issue) => {
      onissue(selectedPath, issue);
    }}
    onquick={onquick ? (issue, action) => onquick(selectedPath, issue, action) : undefined}
    oninject={oninject ? (issue, steer) => oninject(selectedPath, issue, steer) : undefined}
    bodyPreview
    age
    {epics}
    drain={drain?.[selectedPath] ?? null}
    expandEpic={target && target.repoPath === selectedPath ? target.issueNumber : null}
  />
{:else if activeTab === "prs"}
  <PrsPanel
    repoPath={selectedPath}
    onreview={(pr) => onpr(selectedPath, pr)}
    {onlaunchtrain}
    {inTrainPrs}
    age
  />
{:else if activeTab === "actions"}
  <ActionsPanel repoPath={selectedPath} />
{:else if activeTab === "automation"}
  <div class="automation-scroll">
    <AutomationSettings
      repoPath={selectedPath}
      drain={drain?.[selectedPath] ?? null}
      showHeader={false}
    />
  </div>
{:else}
  <ReadinessPanel repoPath={selectedPath} onadopt={(rp, p) => onadopt(rp, p)} />
{/if}

<style>
  /* Automation tab owns its scroll: AutomationSettings is height-neutral and
     non-scrolling (so the in-task popover's own clamp stays the only scroller
     there), and both .detail-pane / .overlay-body are overflow:hidden — so this
     wrapper is the scroll region that keeps the full rows + roles section
     reachable. Mirrors ReadinessPanel's .scroll. */
  .automation-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
</style>
