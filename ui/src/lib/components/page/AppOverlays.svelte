<script lang="ts">
  import type { BootstrapStepKind } from "#lib/components/bootstrap-checklist.js";
  import type { ComponentProps } from "svelte";
  import { displayStatus } from "#lib/display-status.js";
  import { repos } from "#lib/repos.svelte.js";
  import { capacitySuggestedProvider } from "#lib/provider-capacity.js";
  import { EMPTY_REPO_FILTER } from "#lib/components/queue-strip.js";
  import { resolveFilterPaths } from "#lib/components/backlog-view.js";
  import { getPlugins } from "#lib/api.js";
  import type { HerdStore } from "#lib/store.svelte.js";
  import type { SettingsSectionId } from "#lib/settings-search.js";
  import type {
    AgentProvider,
    BacklogPayload,
    DeployState,
    HerdrUpdateStatus,
    Issue,
    GitState,
    Leftover,
    PluginUpdatesStatus,
    PullRequest,
    SandboxProfile,
    Session,
    Settings as Settings_,
    StarPromptStatus,
    Steer,
    TaskRunDefaults,
    TaskRunSeed,
    UsageLimits,
  } from "#lib/types.js";
  import type { FeatureAnnouncement } from "#lib/feature-announcements.js";
  import type { KickoffChoice } from "#lib/components/NewProject.svelte";
  import type NewTaskComponent from "#lib/components/NewTask.svelte";
  import type { Command } from "#lib/command-registry.js";
  import type { HerdFilter } from "#lib/components/herd-partition.js";
  import DecomLeftovers from "#lib/components/page/DecomLeftovers.svelte";
  // Eager on purpose: Cmd/Ctrl+K opens it while xterm owns focus, and it takes focus on mount — a
  // lazy mount would leave keystrokes typed during the chunk fetch going into the agent's PTY.
  import CommandBar from "#lib/components/CommandBar.svelte";
  import StarPrompt from "#lib/components/StarPrompt.svelte";
  import LazyMount from "#lib/components/page/LazyMount.svelte";
  import {
    loadNewTask,
    loadSettings,
    loadUsage,
    loadCloneRepo,
    loadForkRepo,
    loadNewProject,
    loadBroadcastDialog,
    loadRetryDialog,
    loadAmendTaskDialog,
    loadDecommissionPrDialog,
    loadEpicDiagnoseEntry,
    loadClearMergedDialog,
    loadMergeTrainConfirmDialog,
    loadBacklogOverlay,
    loadUpdateModal,
    loadHerdrUpdateModal,
    loadCodexUpdateModal,
    loadPluginUpdatesModal,
    loadWhatsNew,
    loadFableArrival,
    loadOnboarding,
  } from "#lib/components/page/overlay-loaders.js";

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
    // system / announcement modals
    showUpdate,
    deploy,
    onupdateconfirm,
    onupdateclose,
    showHerdrUpdate,
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
    composePlain,
    composeBootstrap,
    usageLimits = null,
    holdLikely,
    onnewclose,
    onnewclone,
    onnewfork,
    onnewnewproject,
    showSettings,
    settingsTab,
    settingsMobileView = "list",
    focusPluginId = null,
    focusSteerId = null,
    focusWorkspace = null,
    showPairing = false,
    onsettingsclose,
    onsettingsherdrupdate,
    onsettingscodexupdate,
    onsettingspluginupdates,
    onsettingswhatsnew,
    onsettingsaskassistant,
    onsettingsopenusage,
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
    decomLeftovers,
    ondecomleftoverclose,
    ondecomleftoverconfirm,
    decommissionPr,
    ondecommissionprselect,
    ondecommissionprclose,
    showRetry,
    onretryclose,
    amendTarget,
    onamendclose,
    showEpicDiagnose,
    epicDiagnoseInitialRepo = undefined,
    onepicdiagnoseclose,
    clearMergedSessions,
    clearMergedLeftovers,
    clearMergedProbesUnavailable,
    clearMergedRepoFilter,
    onclearmergedclose,
    onclearmergedconfirm,
    showBacklog,
    backlog,
    epicTarget,
    inTrainPrs,
    onissue,
    onquick,
    oninject,
    onpr,
    onadopt,
    ondraftepic,
    onbootstrapstep,
    onlaunchtrain,
    onaddclone,
    onaddfork,
    onaddnewproject,
    backlogSelectPath,
    backlogRepoFilter = EMPTY_REPO_FILTER,
    onbacklogclose,
    onbacklogopensession,
    pendingTrain,
    ontrainclose,
    ontrainconfirm,
    onstarresolve,
  }: {
    store: HerdStore;
    settings: Settings_ | null;
    mobile: boolean;
    showUpdate: boolean;
    deploy: DeployState | null;
    onupdateconfirm: () => void;
    onupdateclose: () => void;
    showHerdrUpdate: boolean;
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
    onsubmit: ComponentProps<typeof NewTaskComponent>["onsubmit"];
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
    composePlain: boolean;
    composeBootstrap: boolean;
    usageLimits?: UsageLimits | null;
    holdLikely: boolean;
    onnewclose: () => void;
    onnewclone: () => void;
    onnewfork: () => void;
    onnewnewproject: () => void;
    showSettings: boolean;
    settingsTab: SettingsSectionId;
    /** Mobile entry route: deep links drill straight into settingsTab's detail
     *  page; a plain gear open shows the section list. */
    settingsMobileView?: "list" | "detail";
    focusPluginId?: string | null;
    focusSteerId?: string | null;
    focusWorkspace?: "repo-overrides" | null;
    showPairing?: boolean;
    onsettingsclose: () => void;
    onsettingsherdrupdate: () => void;
    onsettingscodexupdate: () => void;
    onsettingspluginupdates: () => void;
    onsettingswhatsnew: () => void;
    /** Settings → Diagnose "Ask the assistant" (#1446): close Settings and type the question. */
    onsettingsaskassistant?: (question: string) => void;
    /** Settings → Decision model "Usage → Spend" (#3071): close Settings and open Usage. */
    onsettingsopenusage?: () => void;
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
     *  `initialFilter` (see #lib/demo/showcase.ts). Absent on the real ⌘K path. */
    commandBarInitialFilter?: string;
    /** Leftover subprocesses the ⌘K Decommission probe turned up; [] when none (or not probing).
     *  Mirrors Viewport's own LeftoverDialog — the command-bar verb must reap like the button. */
    decomLeftovers: Leftover[];
    /** Dismissed without picking: decommission anyway, reaping nothing. */
    ondecomleftoverclose: () => void;
    /** Confirmed with the chosen leftovers to reap. */
    ondecomleftoverconfirm: (keys: string[]) => void;
    decommissionPr: { name: string; git: GitState } | null;
    ondecommissionprselect: (choice: "keep" | "close" | "merge") => void;
    ondecommissionprclose: () => void;
    showRetry: boolean;
    onretryclose: () => void;
    /** #2225: the session whose amend-task dialog is open, or null when closed. */
    amendTarget: Session | null;
    onamendclose: () => void;
    showEpicDiagnose: boolean;
    /** Repo the entry form's picker defaults to — the single in-focus repo, or undefined. */
    epicDiagnoseInitialRepo?: string | undefined;
    onepicdiagnoseclose: () => void;
    clearMergedSessions: Session[] | null;
    /** Leftover subprocess count per merged session id. */
    clearMergedLeftovers: Record<string, number>;
    /** The host can't detect leftovers at all, so `clearMergedLeftovers` is "unknown", not
     *  "zero" — the dialog cautions instead of implying the batch is clean (#1923). */
    clearMergedProbesUnavailable: boolean;
    /** The herd's repo filter: the dialog clears only what it shows unless told "all". */
    clearMergedRepoFilter: ReadonlySet<string>;
    onclearmergedclose: () => void;
    onclearmergedconfirm: (ids: string[]) => void;
    showBacklog: boolean;
    backlog: BacklogPayload | null;
    epicTarget: { repoPath: string; issueNumber: number } | null;
    inTrainPrs: Set<string>;
    onissue: (repoPath: string, issue: Issue, run?: TaskRunSeed) => void;
    onquick: (repoPath: string, issue: Issue, action: Steer) => void;
    oninject: (repoPath: string, issue: Issue, steer: Steer) => void;
    onpr: (repoPath: string, pr: PullRequest) => void;
    onadopt: (repoPath: string, prompt: string) => void;
    /** The Issues overview's "Draft epic" (#2638): New Task set to epic authoring. */
    ondraftepic: (repoPath: string) => void;
    /** The Backlog's bootstrap checklist (#3112): New Task set to the repo's next bootstrap step. */
    onbootstrapstep: (repoPath: string, kind: BootstrapStepKind) => void;
    onlaunchtrain: (repoPath: string, prs: PullRequest[]) => void;
    onaddclone: () => void;
    onaddfork: () => void;
    onaddnewproject: () => void;
    backlogSelectPath: string | null;
    /** The dashboard's repo filter (session real paths), resolved to backlog paths for the
     *  Repos dialog's entry. */
    backlogRepoFilter?: ReadonlySet<string>;
    onbacklogclose: () => void;
    /** Open a session from the Repos dialog's epic run area (#2620): close it, jump there. */
    onbacklogopensession: (sessionId: string) => void;
    pendingTrain: PendingTrain;
    ontrainclose: () => void;
    ontrainconfirm: () => void;
    onstarresolve: (s: StarPromptStatus) => void;
  } = $props();

  // Opening recovery must remain possible when the initial status request failed.
  const unknownHerdrUpdate: HerdrUpdateStatus = {
    current: null,
    latest: null,
    updateAvailable: false,
    notes: null,
    checkedAt: 0,
    phase: "idle",
    runtime: { state: "unknown", installedVersion: null, serverVersion: null },
  };

  // NewTask seed props pre-resolved here so their nullish-coalescing fallbacks live
  // in <script> rather than the overlay template (keeps this template's synthetic
  // complexity under the Tier-1 bar).
  const newTaskInitialRepo = $derived(composeRepoPath ?? repoFilter ?? undefined);
  // The dashboard filter as backlog paths: one repo opens the Repos dialog in it, several
  // narrow its repo grid. Kept apart from backlogSelectPath (an explicit entry).
  const backlogFilterPaths = $derived(resolveFilterPaths(backlogRepoFilter, repos.entries));
  const newTaskInitialBaseBranch = $derived(composeBaseBranch ?? undefined);
  const newTaskInitialIssue = $derived(composeIssue ?? undefined);
  const newTaskInitialPrompt = $derived(composePrompt ?? undefined);
  const newTaskInitialModel = $derived(composeModel ?? undefined);
  // Relaunch/edit-held carry the original session's effort into the composer's picker (parity with
  // composeModel → initialModel); undefined lets NewTask preselect from the repo/global default.
  const newTaskInitialEffort = $derived(composeEffort ?? undefined);
  // Only a plain open (nothing seeded: no repo, issue, prompt, model or attachment, not a
  // relaunch/edit) brings back a draft the operator dismissed moments ago.
  const newTaskRestoreDraft = $derived(
    !relaunchOriginal &&
      !editHeld &&
      composeRepoPath == null &&
      composeIssue == null &&
      composePrompt == null &&
      composeModel == null &&
      composeImages.length === 0,
  );
  // Bumped by "Discard & new task" to remount the composer blank.
  let newTaskGeneration = $state(0);
  const newTaskFableAvailable = $derived(settings?.fableAvailable ?? true);
  // Hoisted out of the template (branch-free markup): the global default-effort seed.
  const newTaskDefaultEffort = $derived(settings?.defaultEffort);
  const newTaskDefaultClaudeEffort = $derived(settings?.defaultClaudeEffort);
  const newTaskDefaultCodexEffort = $derived(settings?.defaultCodexEffort);
  const newTaskDefaultCodexModel = $derived(settings?.defaultCodexModel);
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
  // The Repos dialog's task box pre-fills from the same defaults the composer seeds with.
  const backlogTaskDefaults = $derived<TaskRunDefaults>({
    agentProvider: newTaskDefaultAgentProvider,
    model: settings?.defaultModel,
    codexModel: newTaskDefaultCodexModel,
    effort: newTaskDefaultEffort,
    claudeEffort: newTaskDefaultClaudeEffort,
    codexEffort: newTaskDefaultCodexEffort,
    fableAvailable: newTaskFableAvailable,
  });
  // An epic child's session in the Repos dialog (#2622): the live session + its PR state.
  // Read inside the dialog's deriveds, so it tracks the store's reactive fields.
  function backlogSessionInfo(id: string): { session: Session; git?: GitState } | null {
    const session = store.byId(id);
    return session ? { session, git: store.git[id] } : null;
  }

  // The live session working an issue (#2638): the Issues overview's "Running now".
  function backlogIssueSession(repoPath: string, issue: number): Session | null {
    return store.sessions.find((s) => s.repoPath === repoPath && s.issueNumber === issue) ?? null;
  }

  // The update window: alone it shows only while this Shepherd is behind; with machines connected
  // it stays open until closed, so a machine that just finished (and now reads up to date) keeps
  // its row.
  const updateOpen = $derived(
    showUpdate && ((store.update?.behind ?? 0) > 0 || store.machineUpdates.length > 0),
  );
</script>

{#if updateOpen}
  <LazyMount load={loadUpdateModal} onerror={onupdateclose}>
    {#snippet children(UpdateModal)}
      <UpdateModal
        update={store.update}
        machines={store.machineUpdates}
        updating={store.updating}
        {deploy}
        onconfirm={onupdateconfirm}
        onclose={onupdateclose}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showHerdrUpdate}
  <!-- displayStatus: the warning counts agents the herdr restart interrupts — a
       working-while-blocked agent is genuinely mid-turn, so it counts as working -->
  <LazyMount load={loadHerdrUpdateModal} onerror={onherdrupdateclose}>
    {#snippet children(HerdrUpdateModal)}
      <HerdrUpdateModal
        update={store.herdrUpdate ?? unknownHerdrUpdate}
        onstatus={(status) => store.setHerdrUpdate(status)}
        connectionEpoch={store.connectionEpoch}
        sessions={store.sessions
          .filter((s) => displayStatus(s, store.workingBlocked, store.backgroundBusy) === "running")
          .map((s) => ({ id: s.id, desig: s.desig, name: s.name }))}
        log={store.herdrUpdateLog}
        done={store.herdrUpdateDone}
        onconfirm={onherdrupdateconfirm}
        onclose={onherdrupdateclose}
        onjump={onherdrupdatejump}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showCodexUpdate && store.codexUpdate && (store.codexUpdate.updateAvailable || codexUpdating)}
  <!-- Narrowing doesn't reach into the snippet closure; pin the checked value. -->
  {@const codexUpdate = store.codexUpdate}
  <LazyMount load={loadCodexUpdateModal} onerror={oncodexupdateclose}>
    {#snippet children(CodexUpdateModal)}
      <CodexUpdateModal
        update={codexUpdate}
        log={store.codexUpdateLog}
        done={store.codexUpdateDone}
        onconfirm={oncodexupdateconfirm}
        onclose={oncodexupdateclose}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showPluginUpdates}
  <LazyMount load={loadPluginUpdatesModal} onerror={onpluginupdatesclose}>
    {#snippet children(PluginUpdatesModal)}
      <PluginUpdatesModal
        status={store.pluginUpdates}
        onclose={onpluginupdatesclose}
        onapplied={onpluginupdated}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showOnboarding}
  <!-- No onerror: ondismiss persists "seen", and this flag gates no shortcuts. -->
  <LazyMount load={loadOnboarding}>
    {#snippet children(Onboarding)}
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
    {/snippet}
  </LazyMount>
{/if}

{#if showWhatsNew}
  <LazyMount load={loadWhatsNew} onerror={onwhatsnewclose}>
    {#snippet children(WhatsNew)}
      <WhatsNew entries={whatsNewEntries} ondismiss={onwhatsnewdismiss} onclose={onwhatsnewclose} />
    {/snippet}
  </LazyMount>
{/if}

{#if showFableArrival}
  <!-- No onerror: onclose persists "seen", and this flag gates no shortcuts. -->
  <LazyMount load={loadFableArrival}>
    {#snippet children(FableArrival)}
      <FableArrival ontry={onfabletry} onclose={onfableclose} />
    {/snippet}
  </LazyMount>
{/if}

{#if showNew}
  <!-- Preselect: explicit backlog/PR context first, else the repo the herd is
       currently filtered to, else NewTask falls back to the most-recently-used repo. -->
  <div hidden={showHerdrUpdate} inert={showHerdrUpdate}>
    {#key newTaskGeneration}
      <LazyMount load={loadNewTask} onerror={onnewclose}>
        {#snippet children(NewTask)}
          <NewTask
            suspended={showHerdrUpdate}
            onherdrrepair={onsettingsherdrupdate}
            {onsubmit}
            spawnProgress={store.spawnProgress}
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
            initialPlain={composePlain}
            initialBootstrap={composeBootstrap}
            {usageLimits}
            defaultAgentProvider={newTaskDefaultAgentProvider}
            defaultModel={settings?.defaultModel}
            defaultCodexModel={newTaskDefaultCodexModel}
            defaultEffort={newTaskDefaultEffort}
            defaultClaudeEffort={newTaskDefaultClaudeEffort}
            defaultCodexEffort={newTaskDefaultCodexEffort}
            fableAvailable={newTaskFableAvailable}
            {holdLikely}
            onclose={onnewclose}
            onclone={onnewclone}
            onfork={onnewfork}
            onnewproject={onnewnewproject}
            restoreDraft={newTaskRestoreDraft}
            ondiscarddraft={() => newTaskGeneration++}
          />
        {/snippet}
      </LazyMount>
    {/key}
  </div>
{/if}

{#if showSettings}
  <LazyMount load={loadSettings} onerror={onsettingsclose}>
    {#snippet children(Settings)}
      <Settings
        {showPairing}
        initialTab={settingsTab}
        initialMobileView={settingsMobileView}
        connected={store.connected}
        remoteSessions={store.remoteSessions}
        initialDiagnostics={store.diagnostics?.checks ?? null}
        plugins={store.plugins}
        onpluginschanged={async () => store.setPlugins(await getPlugins())}
        {focusPluginId}
        {focusSteerId}
        {focusWorkspace}
        onclose={onsettingsclose}
        herdrUpdate={store.herdrUpdate}
        onherdrupdate={onsettingsherdrupdate}
        codexUpdate={store.codexUpdate}
        oncodexupdate={onsettingscodexupdate}
        pluginUpdates={store.pluginUpdates}
        onpluginupdates={onsettingspluginupdates}
        onpluginapplied={onpluginupdated}
        onwhatsnew={onsettingswhatsnew}
        onaskassistant={onsettingsaskassistant}
        onopenusage={onsettingsopenusage}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showUsage}
  <LazyMount load={loadUsage} onerror={onusageclose}>
    {#snippet children(Usage)}
      <Usage onclose={onusageclose} />
    {/snippet}
  </LazyMount>
{/if}

{#if showClone}
  <!-- Close whichever dialog launched Clone (NewTask or Settings) is already done
       before we get here; ondone reopens NewTask preselected on the fresh repo. -->
  <LazyMount load={loadCloneRepo} onerror={oncloneclose}>
    {#snippet children(CloneRepo)}
      <CloneRepo
        onclose={oncloneclose}
        ondone={onclonedone}
        repoRootDisplay={settings?.repoRootDisplay}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showFork}
  <!-- Same flow as CloneRepo: ondone reopens NewTask preselected on the forked repo. -->
  <LazyMount load={loadForkRepo} onerror={onforkclose}>
    {#snippet children(ForkRepo)}
      <ForkRepo
        onclose={onforkclose}
        ondone={onforkdone}
        repoRootDisplay={settings?.repoRootDisplay}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showNewProject}
  <!-- ondone auto-selects the new repo in NewTask + prefills the kickoff seed.
       A warning (partial success: local ok, GitHub failed) surfaces as a non-blocking
       info toast — the flow still proceeds to NewTask with the repo preselected. -->
  <LazyMount load={loadNewProject} onerror={onnewprojectclose}>
    {#snippet children(NewProject)}
      <NewProject
        repoRootDisplay={settings?.repoRootDisplay}
        onclose={onnewprojectclose}
        ondone={onnewprojectdone}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showBroadcast}
  <LazyMount load={loadBroadcastDialog} onerror={onbroadcastclose}>
    {#snippet children(BroadcastDialog)}
      <BroadcastDialog sessions={store.sessions} onclose={onbroadcastclose} />
    {/snippet}
  </LazyMount>
{/if}

{#if showCommandBar}
  <CommandBar
    sessions={store.sessions}
    workingBlocked={store.workingBlocked}
    backgroundBusy={store.backgroundBusy}
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

<DecomLeftovers
  leftovers={decomLeftovers}
  onclose={ondecomleftoverclose}
  onconfirm={ondecomleftoverconfirm}
/>

{#if decommissionPr}
  <LazyMount load={loadDecommissionPrDialog} onerror={ondecommissionprclose}>
    {#snippet children(DecommissionPrDialog)}
      <DecommissionPrDialog
        name={decommissionPr.name}
        git={decommissionPr.git}
        onselect={ondecommissionprselect}
        onclose={ondecommissionprclose}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showRetry}
  <LazyMount load={loadRetryDialog} onerror={onretryclose}>
    {#snippet children(RetryDialog)}
      <RetryDialog sessions={store.sessions} onclose={onretryclose} />
    {/snippet}
  </LazyMount>
{/if}

{#if amendTarget}
  <LazyMount load={loadAmendTaskDialog} onerror={onamendclose}>
    {#snippet children(AmendTaskDialog)}
      <AmendTaskDialog
        session={amendTarget}
        liveness={store.claudeAlive[amendTarget.id]}
        onclose={onamendclose}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showEpicDiagnose}
  <LazyMount load={loadEpicDiagnoseEntry} onerror={onepicdiagnoseclose}>
    {#snippet children(EpicDiagnoseEntry)}
      <EpicDiagnoseEntry initialRepo={epicDiagnoseInitialRepo} onclose={onepicdiagnoseclose} />
    {/snippet}
  </LazyMount>
{/if}

{#if clearMergedSessions}
  <LazyMount load={loadClearMergedDialog} onerror={onclearmergedclose}>
    {#snippet children(ClearMergedDialog)}
      <ClearMergedDialog
        sessions={clearMergedSessions}
        leftovers={clearMergedLeftovers}
        probesUnavailable={clearMergedProbesUnavailable}
        repoFilter={clearMergedRepoFilter}
        onclose={onclearmergedclose}
        onconfirm={onclearmergedconfirm}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if showBacklog}
  <LazyMount load={loadBacklogOverlay} onerror={onbacklogclose}>
    {#snippet children(BacklogOverlay)}
      <BacklogOverlay
        payload={backlog}
        {mobile}
        {onissue}
        {onquick}
        {oninject}
        {onpr}
        {onadopt}
        {onlaunchtrain}
        {onaddclone}
        {onaddfork}
        {onaddnewproject}
        selectPath={backlogSelectPath}
        filterPaths={backlogFilterPaths}
        onclose={onbacklogclose}
        onopensession={onbacklogopensession}
        sessionInfo={backlogSessionInfo}
        issueSession={backlogIssueSession}
        {ondraftepic}
        {onbootstrapstep}
        epics={store.epics}
        {inTrainPrs}
        target={epicTarget}
        drain={store.drain}
        taskDefaults={backlogTaskDefaults}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if pendingTrain}
  <LazyMount load={loadMergeTrainConfirmDialog} onerror={ontrainclose}>
    {#snippet children(MergeTrainConfirmDialog)}
      <MergeTrainConfirmDialog
        repoLabel={pendingTrain.repoLabel}
        items={pendingTrain.items}
        handpicked={pendingTrain.handpicked}
        otherRepoCount={pendingTrain.otherRepoCount}
        onclose={ontrainclose}
        onconfirm={ontrainconfirm}
      />
    {/snippet}
  </LazyMount>
{/if}

{#if store.starPrompt?.shouldPrompt}
  <StarPrompt onresolve={onstarresolve} />
{/if}
