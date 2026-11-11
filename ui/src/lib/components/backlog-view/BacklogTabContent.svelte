<script lang="ts">
  import type { BootstrapStepKind } from "#lib/components/bootstrap-checklist.js";
  import type {
    DrainStatus,
    Epic,
    GitState,
    Issue,
    PullRequest,
    Session,
    Steer,
    TaskRunDefaults,
    TaskRunSeed,
  } from "#lib/types.js";
  import IssuesPanel from "../IssuesPanel.svelte";
  import PrsPanel from "../PrsPanel.svelte";
  import ActionsPanel from "../ActionsPanel.svelte";
  import ReadinessPanel from "../ReadinessPanel.svelte";
  import RepoSettingsBody from "../repo-settings/RepoSettingsBody.svelte";
  import BootstrapChecklist from "../BootstrapChecklist.svelte";
  import { m } from "#lib/paraglide/messages.js";
  import { automationFocus } from "#lib/automation-focus.js";
  import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";

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
    mobile = false,
    taskDefaults = undefined,
    onopensession = undefined,
    onopenautomation = undefined,
    sessionInfo = undefined,
    issueSession = undefined,
    ondraftepic = undefined,
    onbootstrapstep = undefined,
    onopenreadiness = undefined,
  }: {
    activeTab: Tab;
    selectedPath: string;
    onissue: (repoPath: string, issue: Issue, run?: TaskRunSeed) => void;
    onquick?: (repoPath: string, issue: Issue, action: Steer) => void;
    oninject?: (repoPath: string, issue: Issue, steer: Steer) => void;
    onpr: (repoPath: string, pr: PullRequest) => void;
    onlaunchtrain: (repoPath: string, prs: PullRequest[]) => void;
    onadopt: (repoPath: string, prompt: string) => void;
    epics?: Record<string, Epic>;
    inTrainPrs?: Set<string>;
    target?: { repoPath: string; issueNumber: number } | null;
    drain?: Record<string, DrainStatus>;
    mobile?: boolean;
    taskDefaults?: TaskRunDefaults;
    onopensession?: (sessionId: string) => void;
    /** Switch to the Settings tab; a caller that means one section asks automationFocus first. */
    onopenautomation?: () => void;
    /** A session and its PR state from the store, by id — an epic child's session view. */
    sessionInfo?: (id: string) => { session: Session; git?: GitState } | null;
    /** The live session working an issue of a repo — the Issues overview's "Running now". */
    issueSession?: (repoPath: string, issue: number) => Session | null;
    /** Open the New Task composer set to draft an epic for a repo (Issues overview). */
    ondraftepic?: (repoPath: string) => void;
    /** The bootstrap checklist's start (#3112): New Task set to the repo's next bootstrap step. */
    onbootstrapstep?: (repoPath: string, kind: BootstrapStepKind, adjust: boolean) => void;
    /** Switch to the Readiness tab (the bootstrap exit's must-haves live there). */
    onopenreadiness?: () => void;
  } = $props();
</script>

<!-- #3112: an active-bootstrap repo shows where it stands and its next step above every tab. -->
<BootstrapChecklist repoPath={selectedPath} {onbootstrapstep} {onopensession} {onopenreadiness} />

{#if activeTab === "issues"}
  <IssuesPanel
    repoPath={selectedPath}
    onnewtask={(issue, run) => {
      onissue(selectedPath, issue, run);
    }}
    onquick={onquick ? (issue, action) => onquick(selectedPath, issue, action) : undefined}
    oninject={oninject ? (issue, steer) => oninject(selectedPath, issue, steer) : undefined}
    {epics}
    drain={drain?.[selectedPath] ?? null}
    expandEpic={target && target.repoPath === selectedPath ? target.issueNumber : null}
    {mobile}
    {taskDefaults}
    {onopensession}
    {onopenautomation}
    {sessionInfo}
    {issueSession}
    ondraftepic={ondraftepic ? () => ondraftepic(selectedPath) : undefined}
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
  <!-- The repo settings window's body (#3443), at the section a jump here asked for. -->
  <div class="settings">
    {#key selectedPath}
      <RepoSettingsBody
        variant="embedded"
        repoPath={selectedPath}
        section={automationFocus.section()}
        drain={drain?.[selectedPath] ?? null}
        globals={repoSettingsWindow.globals()}
        onsetupci={() => onadopt(selectedPath, m.automation_no_pr_ci_task_prompt())}
      />
    {/key}
  </div>
{:else}
  <ReadinessPanel repoPath={selectedPath} onadopt={(rp, p) => onadopt(rp, p)} />
{/if}

<style>
  /* The settings body scrolls itself (its section, or the whole body when narrow); both
     .detail-pane and .overlay-body are overflow:hidden flex columns, so this only hands it the
     height. */
  .settings {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
