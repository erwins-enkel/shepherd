<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { displayStatus } from "$lib/display-status";
  import { learnings } from "$lib/learnings.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { capacitySuggestedProvider } from "$lib/provider-capacity";
  import { basename } from "$lib/components/learnings-drawer";
  import {
    approveLearning,
    dismissLearning,
    distillRepo,
    promoteLearning,
    optimizeLearning,
    optimizeRepoFlagged,
    restoreLearning,
    revertTrialLearning,
    setLearningScope,
    markRetiredSeen,
    applyMergeSuggestion,
    dismissMergeSuggestion,
    promoteGlobalLearning,
    mergeSuggestNow,
    getPlugins,
  } from "$lib/api";
  import type { HerdStore } from "$lib/store.svelte";
  import type {
    AgentProvider,
    BacklogPayload,
    DeployState,
    Issue,
    PluginUpdatesStatus,
    PullRequest,
    SandboxProfile,
    Session,
    Settings as Settings_,
    StarPromptStatus,
    Steer,
    UsageLimits,
  } from "$lib/types";
  import type { FeatureAnnouncement } from "$lib/feature-announcements";
  import LearningsDrawer from "$lib/components/LearningsDrawer.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import Usage from "$lib/components/Usage.svelte";
  import CloneRepo from "$lib/components/CloneRepo.svelte";
  import ForkRepo from "$lib/components/ForkRepo.svelte";
  import NewProject from "$lib/components/NewProject.svelte";
  import type { KickoffChoice } from "$lib/components/NewProject.svelte";
  import BroadcastDialog from "$lib/components/BroadcastDialog.svelte";
  import CommandBar from "$lib/components/CommandBar.svelte";
  import type { Command } from "$lib/command-registry";
  import type { HerdFilter } from "$lib/components/herd-partition";
  import RetryDialog from "$lib/components/RetryDialog.svelte";
  import ClearMergedDialog from "$lib/components/ClearMergedDialog.svelte";
  import MergeTrainConfirmDialog from "$lib/components/MergeTrainConfirmDialog.svelte";
  import BacklogOverlay from "$lib/components/BacklogOverlay.svelte";
  import UpdateModal from "$lib/components/UpdateModal.svelte";
  import HerdrUpdateModal from "$lib/components/HerdrUpdateModal.svelte";
  import CodexUpdateModal from "$lib/components/CodexUpdateModal.svelte";
  import PluginUpdatesModal from "$lib/components/PluginUpdatesModal.svelte";
  import StarPrompt from "$lib/components/StarPrompt.svelte";
  import WhatsNew from "$lib/components/WhatsNew.svelte";
  import FableArrival from "$lib/components/FableArrival.svelte";
  import Onboarding from "$lib/components/Onboarding.svelte";

  type PendingTrain = {
    repoLabel: string;
    items: { number: number; title: string }[];
    handpicked: boolean;
    otherRepoCount: number;
    run: () => Promise<void>;
  } | null;

  let {
    store,
    settings,
    mobile,
    // in-shell drawers
    showLearnings,
    learningsRepo,
    onlearningsclose,
    // system / announcement modals
    showUpdate,
    deploy,
    onupdateconfirm,
    onupdateclose,
    showHerdrUpdate,
    herdrUpdating,
    onherdrupdateconfirm,
    onherdrupdateclose,
    onherdrupdatejump,
    showCodexUpdate,
    codexUpdating,
    oncodexupdateconfirm,
    oncodexupdateclose,
    showPluginUpdates,
    onpluginupdatesclose,
    onpluginupdated,
    showOnboarding,
    onboardingBlocking = false,
    diagnosticsLoadFailed,
    ononboardingretry,
    ononboardingdismiss,
    ononboardingpicked,
    showWhatsNew,
    whatsNewEntries,
    onwhatsnewdismiss,
    onwhatsnewclose,
    showFableArrival,
    onfabletry,
    onfableclose,
    // compose flow
    showNew,
    onsubmit,
    relaunchOriginal,
    editHeld,
    composeRepoPath,
    repoFilter,
    composeBaseBranch,
    composeIssue,
    relaunchIssueNumber,
    composeImages,
    composePrompt,
    composeModel,
    composeEffort,
    composeAgentProvider,
    composePlanGate,
    composeAutopilot,
    composeSandbox,
    composeResearch,
    composeEpicAuthoring,
    usageLimits = null,
    holdLikely,
    onnewclose,
    onnewclone,
    onnewfork,
    onnewnewproject,
    showSettings,
    settingsTab,
    focusPluginId = null,
    focusSteerId = null,
    onsettingsclose,
    onsettingsherdrupdate,
    onsettingscodexupdate,
    onsettingspluginupdates,
    onsettingswhatsnew,
    showUsage,
    onusageclose,
    showClone,
    oncloneclose,
    onclonedone,
    showFork,
    onforkclose,
    onforkdone,
    showNewProject,
    onnewprojectclose,
    onnewprojectdone,
    // session-action dialogs
    showBroadcast,
    onbroadcastclose,
    showCommandBar,
    commandBarCommands,
    oncommandbarclose,
    oncommandbarsession,
    oncommandbarrepo,
    oncommandbarfilterrepo,
    oncommandbarlens,
    commandBarInitialFilter = undefined,
    showRetry,
    onretryclose,
    clearMergedSessions,
    clearMergedLeftovers,
    onclearmergedclose,
    onclearmergedconfirm,
    showBacklog,
    backlog,
    epicTarget,
    inTrainPrs,
    onissue,
    onquick,
    onpr,
    onadopt,
    onlaunchtrain,
    onaddclone,
    onaddfork,
    onaddnewproject,
    backlogSelectPath,
    onbacklogclose,
    pendingTrain,
    ontrainclose,
    ontrainconfirm,
    onstarresolve,
  }: {
    store: HerdStore;
    settings: Settings_ | null;
    mobile: boolean;
    showLearnings: boolean;
    learningsRepo: string | null;
    onlearningsclose: () => void;
    showUpdate: boolean;
    deploy: DeployState | null;
    onupdateconfirm: () => void;
    onupdateclose: () => void;
    showHerdrUpdate: boolean;
    herdrUpdating: boolean;
    onherdrupdateconfirm: () => void;
    onherdrupdateclose: () => void;
    onherdrupdatejump: (id: string) => void;
    showCodexUpdate: boolean;
    codexUpdating: boolean;
    oncodexupdateconfirm: () => void;
    oncodexupdateclose: () => void;
    showPluginUpdates: boolean;
    onpluginupdatesclose: () => void;
    /** After an in-place plugin update: push the recomputed snapshot so the badge +
     *  loaded-plugins list refresh. */
    onpluginupdated: (status: PluginUpdatesStatus) => void;
    showOnboarding: boolean;
    /** True on a genuine server-reported first run (`settings.firstRunPending`) — forces the
     *  Onboarding surface into its required-pick, non-dismissible mode. */
    onboardingBlocking?: boolean;
    diagnosticsLoadFailed: boolean;
    ononboardingretry: () => void;
    ononboardingdismiss: () => void;
    /** Fires once the operator's folder pick persists in blocking mode, so the parent can clear
     *  the gate (`showOnboarding = false`). */
    ononboardingpicked: (root: string) => void;
    showWhatsNew: boolean;
    whatsNewEntries: FeatureAnnouncement[];
    onwhatsnewdismiss: () => void;
    onwhatsnewclose: () => void;
    showFableArrival: boolean;
    onfabletry: () => void;
    onfableclose: () => void;
    showNew: boolean;
    onsubmit: ComponentProps<typeof NewTask>["onsubmit"];
    relaunchOriginal: boolean;
    editHeld: boolean;
    composeRepoPath: string | null;
    repoFilter: string | null;
    composeBaseBranch: string | null;
    composeIssue: Issue | null;
    relaunchIssueNumber: number | null;
    composeImages: { path: string; name: string }[];
    composePrompt: string | null;
    composeModel: string | null;
    composeEffort: string | null;
    composeAgentProvider: AgentProvider | null;
    composePlanGate: boolean | null;
    composeAutopilot: boolean | null;
    composeSandbox: SandboxProfile | null;
    composeResearch: boolean;
    composeEpicAuthoring: boolean;
    usageLimits?: UsageLimits | null;
    holdLikely: boolean;
    onnewclose: () => void;
    onnewclone: () => void;
    onnewfork: () => void;
    onnewnewproject: () => void;
    showSettings: boolean;
    settingsTab: "workspace" | "session" | "device" | "diagnose" | "plugins";
    focusPluginId?: string | null;
    focusSteerId?: string | null;
    onsettingsclose: () => void;
    onsettingsherdrupdate: () => void;
    onsettingscodexupdate: () => void;
    onsettingspluginupdates: () => void;
    onsettingswhatsnew: () => void;
    showUsage: boolean;
    onusageclose: () => void;
    showClone: boolean;
    oncloneclose: () => void;
    onclonedone: (entry: { path: string }) => void;
    showFork: boolean;
    onforkclose: () => void;
    onforkdone: (entry: { path: string }) => void;
    showNewProject: boolean;
    onnewprojectclose: () => void;
    onnewprojectdone: (
      entry: { path: string; warning?: string },
      kickoff: KickoffChoice,
      idea: string,
    ) => void;
    showBroadcast: boolean;
    onbroadcastclose: () => void;
    showCommandBar: boolean;
    commandBarCommands: Command[];
    oncommandbarclose: () => void;
    oncommandbarsession: (id: string) => void;
    oncommandbarrepo: (path: string) => void;
    oncommandbarfilterrepo: (path: string) => void;
    oncommandbarlens: (lens: HerdFilter) => void;
    /** Demo-only scripted-showcase seed, forwarded verbatim to CommandBar's
     *  `initialFilter` (see $lib/demo/showcase.ts). Absent on the real ⌘K path. */
    commandBarInitialFilter?: string;
    showRetry: boolean;
    onretryclose: () => void;
    clearMergedSessions: Session[] | null;
    clearMergedLeftovers: number;
    onclearmergedclose: () => void;
    onclearmergedconfirm: () => void;
    showBacklog: boolean;
    backlog: BacklogPayload | null;
    epicTarget: { repoPath: string; issueNumber: number } | null;
    inTrainPrs: Set<string>;
    onissue: (repoPath: string, issue: Issue) => void;
    onquick: (repoPath: string, issue: Issue, action: Steer) => void;
    onpr: (repoPath: string, pr: PullRequest) => void;
    onadopt: (repoPath: string, prompt: string) => void;
    onlaunchtrain: (repoPath: string, prs: PullRequest[]) => void;
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
    backlogSelectPath: string | null;
    onbacklogclose: () => void;
    pendingTrain: PendingTrain;
    ontrainclose: () => void;
    ontrainconfirm: () => void;
    onstarresolve: (s: StarPromptStatus) => void;
  } = $props();

  // NewTask seed props pre-resolved here so their nullish-coalescing fallbacks live
  // in <script> rather than the overlay template (keeps this template's synthetic
  // complexity under the Tier-1 bar).
  const newTaskInitialRepo = $derived(composeRepoPath ?? repoFilter ?? undefined);
  const newTaskInitialBaseBranch = $derived(composeBaseBranch ?? undefined);
  const newTaskInitialIssue = $derived(composeIssue ?? undefined);
  const newTaskInitialPrompt = $derived(composePrompt ?? undefined);
  const newTaskInitialModel = $derived(composeModel ?? undefined);
  // Relaunch/edit-held carry the original session's effort into the composer's picker (parity with
  // composeModel → initialModel); undefined lets NewTask preselect from the repo/global default.
  const newTaskInitialEffort = $derived(composeEffort ?? undefined);
  const newTaskFableAvailable = $derived(settings?.fableAvailable ?? true);
  // Hoisted out of the template (branch-free markup): the global default-effort seed.
  const newTaskDefaultEffort = $derived(settings?.defaultEffort);
  // Onboarding folder-picker inputs, hoisted out of the template so the markup stays branch-free.
  const onboardingRepoRoot = $derived(settings?.repoRoot ?? null);
  const onboardingRepoRootDisplay = $derived(settings?.repoRootDisplay ?? null);
  const onboardingSettingsLoaded = $derived(settings !== null);
  const newTaskHeldProviders = $derived(new Set<AgentProvider>(holdLikely ? ["claude"] : []));
  const newTaskDefaultAgentProvider = $derived(
    capacitySuggestedProvider(
      settings?.defaultAgentProvider ?? "claude",
      store.diagnostics,
      newTaskHeldProviders,
    ),
  );
</script>

{#if showLearnings}
  <LearningsDrawer
    items={learnings.items}
    injectable={learnings.injectable}
    mergeSuggestions={learnings.mergeSuggestions}
    focusRepo={learningsRepo}
    onapprove={(id, rule) =>
      approveLearning(id, rule)
        .then(() => learnings.load())
        .catch(() => {})}
    ondismiss={(id) =>
      dismissLearning(id)
        .then(() => learnings.load())
        .catch(() => {})}
    ondistill={(repoPath) =>
      distillRepo(repoPath)
        .then(() => toasts.info(m.learnings_distill_started({ repo: basename(repoPath) })))
        .catch(() => {})}
    onpromote={(id) =>
      promoteLearning(id)
        .then(() => {
          toasts.info(m.learnings_promote_started());
          return learnings.load();
        })
        .catch(() => toasts.info(m.learnings_promote_failed()))}
    onoptimize={(id) =>
      optimizeLearning(id)
        .then(() => toasts.info(m.learnings_optimize_started()))
        .catch(() => toasts.info(m.learnings_optimize_failed()))}
    onoptimizeall={(repoPath) =>
      optimizeRepoFlagged(repoPath)
        .then(() => toasts.info(m.learnings_optimize_started()))
        .catch(() => toasts.info(m.learnings_optimize_failed()))}
    onrestore={(id) =>
      restoreLearning(id)
        .then(() => learnings.load())
        .catch(() => toasts.info(m.learnings_restore_failed()))}
    onreverttrial={(id, target) =>
      revertTrialLearning(id, target)
        .then(() => learnings.load())
        .catch(() => toasts.info(m.learnings_revert_failed(), { key: "learnings-revert" }))}
    onscope={(id, globs) =>
      setLearningScope(id, globs)
        .then(() => learnings.load())
        .catch(() => toasts.info(m.learnings_scope_failed()))}
    onseenretired={(repoPath) =>
      markRetiredSeen(repoPath)
        .then(() => learnings.load())
        .catch(() => {})}
    onmerge={(suggestionId) =>
      applyMergeSuggestion(suggestionId)
        .then(() => {
          toasts.info(m.learnings_merge_applied());
          return learnings.load();
        })
        .catch(() => toasts.info(m.learnings_merge_failed()))}
    ondismissmerge={(suggestionId) =>
      dismissMergeSuggestion(suggestionId)
        .then(() => learnings.load())
        .catch(() => {})}
    onpromoteglobal={(suggestionId) =>
      promoteGlobalLearning(suggestionId)
        .then(() => {
          toasts.info(m.learnings_recur_promote_done());
          return learnings.load();
        })
        .catch(() => toasts.info(m.learnings_recur_promote_failed()))}
    onmergenow={(repoPath) =>
      mergeSuggestNow(repoPath)
        .then(() => toasts.info(m.learnings_merge_now_started({ repo: basename(repoPath) })))
        .catch(() => {})}
    onclose={onlearningsclose}
  />
{/if}

{#if showUpdate && store.update && store.update.behind > 0}
  <UpdateModal
    update={store.update}
    updating={store.updating}
    {deploy}
    onconfirm={onupdateconfirm}
    onclose={onupdateclose}
  />
{/if}

{#if showHerdrUpdate && store.herdrUpdate && (store.herdrUpdate.updateAvailable || herdrUpdating)}
  <!-- displayStatus: the warning counts agents the herdr restart interrupts — a
       working-while-blocked agent is genuinely mid-turn, so it counts as working -->
  <HerdrUpdateModal
    update={store.herdrUpdate}
    sessions={store.sessions
      .filter((s) => displayStatus(s, store.workingBlocked) === "running")
      .map((s) => ({ id: s.id, desig: s.desig, name: s.name }))}
    log={store.herdrUpdateLog}
    done={store.herdrUpdateDone}
    onconfirm={onherdrupdateconfirm}
    onclose={onherdrupdateclose}
    onjump={onherdrupdatejump}
  />
{/if}

{#if showCodexUpdate && store.codexUpdate && (store.codexUpdate.updateAvailable || codexUpdating)}
  <CodexUpdateModal
    update={store.codexUpdate}
    log={store.codexUpdateLog}
    done={store.codexUpdateDone}
    onconfirm={oncodexupdateconfirm}
    onclose={oncodexupdateclose}
  />
{/if}

{#if showPluginUpdates}
  <PluginUpdatesModal
    status={store.pluginUpdates}
    onclose={onpluginupdatesclose}
    onapplied={onpluginupdated}
  />
{/if}

{#if showOnboarding}
  <Onboarding
    checks={store.diagnostics?.checks ?? null}
    failed={diagnosticsLoadFailed}
    onretry={ononboardingretry}
    ondismiss={ononboardingdismiss}
    blocking={onboardingBlocking}
    repoRoot={onboardingRepoRoot}
    repoRootDisplay={onboardingRepoRootDisplay}
    settingsLoaded={onboardingSettingsLoaded}
    onpicked={ononboardingpicked}
  />
{/if}

{#if showWhatsNew}
  <WhatsNew entries={whatsNewEntries} ondismiss={onwhatsnewdismiss} onclose={onwhatsnewclose} />
{/if}

{#if showFableArrival}
  <FableArrival ontry={onfabletry} onclose={onfableclose} />
{/if}

{#if showNew}
  <!-- Preselect: explicit backlog/PR context first, else the repo the herd is
       currently filtered to, else NewTask falls back to the most-recently-used repo. -->
  <NewTask
    {onsubmit}
    relaunch={relaunchOriginal}
    {editHeld}
    initialRepoPath={newTaskInitialRepo}
    initialBaseBranch={newTaskInitialBaseBranch}
    initialIssue={newTaskInitialIssue}
    {relaunchIssueNumber}
    initialImages={composeImages}
    initialPrompt={newTaskInitialPrompt}
    initialModel={newTaskInitialModel}
    initialEffort={newTaskInitialEffort}
    initialAgentProvider={composeAgentProvider ?? undefined}
    initialPlanGate={composePlanGate}
    initialAutopilot={composeAutopilot}
    initialSandboxProfile={composeSandbox}
    initialResearch={composeResearch}
    initialEpicAuthoring={composeEpicAuthoring}
    {usageLimits}
    defaultAgentProvider={newTaskDefaultAgentProvider}
    defaultModel={settings?.defaultModel}
    defaultEffort={newTaskDefaultEffort}
    fableAvailable={newTaskFableAvailable}
    {holdLikely}
    onclose={onnewclose}
    onclone={onnewclone}
    onfork={onnewfork}
    onnewproject={onnewnewproject}
  />
{/if}

{#if showSettings}
  <Settings
    initialTab={settingsTab}
    initialDiagnostics={store.diagnostics?.checks ?? null}
    plugins={store.plugins}
    onpluginschanged={async () => store.setPlugins(await getPlugins())}
    {focusPluginId}
    {focusSteerId}
    onclose={onsettingsclose}
    herdrUpdate={store.herdrUpdate}
    onherdrupdate={onsettingsherdrupdate}
    codexUpdate={store.codexUpdate}
    oncodexupdate={onsettingscodexupdate}
    pluginUpdates={store.pluginUpdates}
    onpluginupdates={onsettingspluginupdates}
    onpluginapplied={onpluginupdated}
    onwhatsnew={onsettingswhatsnew}
  />
{/if}

{#if showUsage}
  <Usage onclose={onusageclose} />
{/if}

{#if showClone}
  <!-- Close whichever dialog launched Clone (NewTask or Settings) is already done
       before we get here; ondone reopens NewTask preselected on the fresh repo. -->
  <CloneRepo
    onclose={oncloneclose}
    ondone={onclonedone}
    repoRootDisplay={settings?.repoRootDisplay}
  />
{/if}

{#if showFork}
  <!-- Same flow as CloneRepo: ondone reopens NewTask preselected on the forked repo. -->
  <ForkRepo onclose={onforkclose} ondone={onforkdone} repoRootDisplay={settings?.repoRootDisplay} />
{/if}

{#if showNewProject}
  <!-- ondone auto-selects the new repo in NewTask + prefills the kickoff seed.
       A warning (partial success: local ok, GitHub failed) surfaces as a non-blocking
       info toast — the flow still proceeds to NewTask with the repo preselected. -->
  <NewProject
    repoRootDisplay={settings?.repoRootDisplay}
    onclose={onnewprojectclose}
    ondone={onnewprojectdone}
  />
{/if}

{#if showBroadcast}
  <BroadcastDialog sessions={store.sessions} onclose={onbroadcastclose} />
{/if}

{#if showCommandBar}
  <CommandBar
    sessions={store.sessions}
    workingBlocked={store.workingBlocked}
    blocks={store.blocks}
    commands={commandBarCommands}
    onselectsession={oncommandbarsession}
    onselectrepo={oncommandbarrepo}
    onfilterrepo={oncommandbarfilterrepo}
    onselectlens={oncommandbarlens}
    onclose={oncommandbarclose}
    initialFilter={commandBarInitialFilter}
  />
{/if}

{#if showRetry}
  <RetryDialog sessions={store.sessions} onclose={onretryclose} />
{/if}

{#if clearMergedSessions}
  <ClearMergedDialog
    sessions={clearMergedSessions}
    leftovers={clearMergedLeftovers}
    onclose={onclearmergedclose}
    onconfirm={onclearmergedconfirm}
  />
{/if}

{#if showBacklog}
  <BacklogOverlay
    payload={backlog}
    {mobile}
    {onissue}
    {onquick}
    {onpr}
    {onadopt}
    {onlaunchtrain}
    {onaddclone}
    {onaddfork}
    {onaddnewproject}
    selectPath={backlogSelectPath}
    onclose={onbacklogclose}
    epics={store.epics}
    {inTrainPrs}
    target={epicTarget}
    drain={store.drain}
  />
{/if}

{#if pendingTrain}
  <MergeTrainConfirmDialog
    repoLabel={pendingTrain.repoLabel}
    items={pendingTrain.items}
    handpicked={pendingTrain.handpicked}
    otherRepoCount={pendingTrain.otherRepoCount}
    onclose={ontrainclose}
    onconfirm={ontrainconfirm}
  />
{/if}

{#if store.starPrompt?.shouldPrompt}
  <StarPrompt onresolve={onstarresolve} />
{/if}
