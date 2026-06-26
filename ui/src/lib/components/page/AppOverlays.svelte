<script lang="ts">
  import type { ComponentProps } from "svelte";
  import { m } from "$lib/paraglide/messages";
  import { displayStatus } from "$lib/display-status";
  import { learnings } from "$lib/learnings.svelte";
  import { toasts } from "$lib/toasts.svelte";
  import { basename } from "$lib/components/learnings-drawer";
  import {
    replySession,
    dismissStall,
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
  } from "$lib/api";
  import type { HerdStore } from "$lib/store.svelte";
  import type { BlockedEntry } from "$lib/triage";
  import type {
    BacklogPayload,
    DeployState,
    Issue,
    PullRequest,
    Session,
    Settings as Settings_,
    StarPromptStatus,
    Steer,
  } from "$lib/types";
  import type { FeatureAnnouncement } from "$lib/feature-announcements";
  import TriageDrawer from "$lib/components/TriageDrawer.svelte";
  import LearningsDrawer from "$lib/components/LearningsDrawer.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import Usage from "$lib/components/Usage.svelte";
  import CloneRepo from "$lib/components/CloneRepo.svelte";
  import ForkRepo from "$lib/components/ForkRepo.svelte";
  import NewProject from "$lib/components/NewProject.svelte";
  import type { KickoffChoice } from "$lib/components/NewProject.svelte";
  import BroadcastDialog from "$lib/components/BroadcastDialog.svelte";
  import RetryDialog from "$lib/components/RetryDialog.svelte";
  import ClearMergedDialog from "$lib/components/ClearMergedDialog.svelte";
  import MergeTrainConfirmDialog from "$lib/components/MergeTrainConfirmDialog.svelte";
  import BacklogOverlay from "$lib/components/BacklogOverlay.svelte";
  import UpdateModal from "$lib/components/UpdateModal.svelte";
  import HerdrUpdateModal from "$lib/components/HerdrUpdateModal.svelte";
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
    showTriage,
    blockedEntries,
    nowMs,
    ontriageopen,
    ontriageclose,
    onresumequota,
    ontakeoverquota,
    onabandonquota,
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
    showOnboarding,
    diagnosticsLoadFailed,
    ononboardingretry,
    ononboardingdismiss,
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
    composeRepoPath,
    repoFilter,
    composeBaseBranch,
    composeIssue,
    relaunchIssueNumber,
    composeImages,
    composePrompt,
    composeModel,
    holdLikely,
    onnewclose,
    onnewclone,
    onnewfork,
    onnewnewproject,
    showSettings,
    settingsTab,
    onsettingsclose,
    onsettingsherdrupdate,
    onsettingsclone,
    onsettingsfork,
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
    onbacklogclose,
    pendingTrain,
    ontrainclose,
    ontrainconfirm,
    onstarresolve,
  }: {
    store: HerdStore;
    settings: Settings_ | null;
    mobile: boolean;
    showTriage: boolean;
    blockedEntries: BlockedEntry[];
    nowMs: number;
    ontriageopen: (id: string) => void;
    ontriageclose: () => void;
    onresumequota: (id: string) => void;
    ontakeoverquota: (id: string) => void;
    onabandonquota: (id: string) => void;
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
    showOnboarding: boolean;
    diagnosticsLoadFailed: boolean;
    ononboardingretry: () => void;
    ononboardingdismiss: () => void;
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
    composeRepoPath: string | null;
    repoFilter: string | null;
    composeBaseBranch: string | null;
    composeIssue: Issue | null;
    relaunchIssueNumber: number | null;
    composeImages: { path: string; name: string }[];
    composePrompt: string | null;
    composeModel: string | null;
    holdLikely: boolean;
    onnewclose: () => void;
    onnewclone: () => void;
    onnewfork: () => void;
    onnewnewproject: () => void;
    showSettings: boolean;
    settingsTab: "workspace" | "session" | "device" | "diagnose";
    onsettingsclose: () => void;
    onsettingsherdrupdate: () => void;
    onsettingsclone: () => void;
    onsettingsfork: () => void;
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
  const newTaskFableAvailable = $derived(settings?.fableAvailable ?? true);
</script>

{#if showTriage}
  <TriageDrawer
    entries={blockedEntries}
    {nowMs}
    onreply={(id, text) => replySession(id, text).catch(() => {})}
    ondismiss={(id) => dismissStall(id).catch(() => {})}
    onopen={ontriageopen}
    onclose={ontriageclose}
    onresume={onresumequota}
    ontakeover={ontakeoverquota}
    onabandon={onabandonquota}
  />
{/if}

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

{#if showOnboarding}
  <Onboarding
    checks={store.diagnostics?.checks ?? null}
    failed={diagnosticsLoadFailed}
    onretry={ononboardingretry}
    ondismiss={ononboardingdismiss}
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
    initialRepoPath={newTaskInitialRepo}
    initialBaseBranch={newTaskInitialBaseBranch}
    initialIssue={newTaskInitialIssue}
    {relaunchIssueNumber}
    initialImages={composeImages}
    initialPrompt={newTaskInitialPrompt}
    initialModel={newTaskInitialModel}
    defaultAgentProvider={settings?.defaultAgentProvider}
    defaultModel={settings?.defaultModel}
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
    onclose={onsettingsclose}
    herdrUpdate={store.herdrUpdate}
    onherdrupdate={onsettingsherdrupdate}
    onclone={onsettingsclone}
    onfork={onsettingsfork}
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
