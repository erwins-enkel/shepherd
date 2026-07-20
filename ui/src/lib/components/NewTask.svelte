<script lang="ts">
  import { onMount, tick } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import {
    listRepos,
    listBranches,
    pickBaseBranch,
    branchStatus,
    initEmptyCommit,
    getCommands,
    getEpics,
    uploadFile,
    isPreviewBlocked,
    syncFork,
  } from "$lib/api";
  import { toasts } from "$lib/toasts.svelte";
  import { handleImagePaste } from "$lib/clipboard";
  import {
    type Issue,
    type IssueRef,
    type AgentProvider,
    type ProviderTokenConstraint,
    type RepoEntry,
    type SandboxProfile,
    type SlashCommand,
    type Steer,
    MODELS_BY_PROVIDER,
  } from "$lib/types";
  import {
    matchSlashTrigger,
    filterCommands,
    applyCommandPick,
    applyMentionPick,
    commandInvocation,
    commandInvocationName,
    commandProviders,
  } from "$lib/slash";
  import { matchIssueTrigger } from "$lib/issue-trigger";
  import RepoSelect from "./RepoSelect.svelte";
  import PromptSources from "./PromptSources.svelte";
  import SlashCommandMenu from "./SlashCommandMenu.svelte";
  import IssueSearchMenu from "./IssueSearchMenu.svelte";
  import MicButton from "./MicButton.svelte";
  import BaseRepairNotice from "./new-task/BaseRepairNotice.svelte";
  import AttachmentChip from "./new-task/AttachmentChip.svelte";
  import RunSettingsGroups from "./new-task/RunSettingsGroups.svelte";
  import MobileEngineSheet from "./new-task/MobileEngineSheet.svelte";
  import FirstTaskAutomationConfirm from "./FirstTaskAutomationConfirm.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { repoConfig } from "$lib/reviews.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { m } from "$lib/paraglide/messages";
  import { viewerCache } from "$lib/viewer-cache.svelte";
  import { assignedOthers } from "./issues-panel";
  import { recentRepos } from "$lib/recentRepos";
  import { projectIcons } from "$lib/projectIcons.svelte";
  import { modelOptionLabel } from "$lib/model-guidance";
  import { deriveReadiness } from "./new-task/readiness";
  import {
    preselectModel,
    preselectEffort,
    reseedRunConfig,
    normalizeRunConfig,
    modelForManualProviderChange,
  } from "./new-task/run-config";
  import { IssueData } from "./new-task/issue-data.svelte";
  import type { UsageLimits } from "$lib/types";

  type TaskAttachment = {
    path: string;
    name: string;
    previewFile?: File;
  };

  let {
    onsubmit,
    onclose,
    onclone,
    onfork,
    onnewproject,
    initialPrompt,
    initialRepoPath,
    initialIssue,
    initialModel,
    initialEffort,
    defaultAgentProvider = "claude",
    defaultModel,
    defaultCodexModel,
    defaultEffort,
    relaunch = false,
    editHeld = false,
    initialBaseBranch,
    relaunchIssueNumber,
    initialImages,
    initialAgentProvider,
    initialPlanGate,
    initialAutopilot,
    initialSandboxProfile,
    initialResearch = false,
    initialEpicAuthoring = false,
    usageLimits = null,
    holdLikely = false,
    fableAvailable = true,
  }: {
    onsubmit: (input: {
      repoPath: string;
      baseBranch: string;
      prompt: string;
      agentProvider?: AgentProvider;
      model: string | null;
      effort: string | null;
      images: string[];
      attachmentNames?: string[];
      issueRef?: IssueRef;
      launchUiState?: {
        researchChecked: boolean;
        planGateChecked: boolean;
        autopilotChecked: boolean;
        epicAuthoringChecked?: boolean;
      };
      planGateEnabled: boolean | null;
      autopilotEnabled: boolean | null;
      sandboxProfile?: SandboxProfile;
      research: boolean;
      epicAuthoring: boolean;
      force?: boolean;
    }) => Promise<void> | void;
    onclose?: () => void;
    onclone?: () => void;
    onfork?: () => void;
    onnewproject?: () => void;
    initialPrompt?: string;
    initialRepoPath?: string;
    initialIssue?: Issue;
    initialModel?: string;
    initialEffort?: string;
    defaultAgentProvider?: AgentProvider;
    defaultModel?: string;
    defaultCodexModel?: string;
    defaultEffort?: string;
    relaunch?: boolean;
    editHeld?: boolean;
    initialBaseBranch?: string;
    relaunchIssueNumber?: number | null;
    initialImages?: { path: string; name: string }[];
    initialAgentProvider?: AgentProvider;
    /** Seed the per-task plan-gate override (editing a held task). A concrete boolean
     *  pins it (explicit override); null/undefined leaves it inheriting the repo default. */
    initialPlanGate?: boolean | null;
    initialAutopilot?: boolean | null;
    initialSandboxProfile?: SandboxProfile | null;
    initialResearch?: boolean;
    initialEpicAuthoring?: boolean;
    usageLimits?: UsageLimits | null;
    holdLikely?: boolean;
    fableAvailable?: boolean;
  } = $props();

  /** Short editable seed so the user only adds deltas; the body rides out-of-band. */
  function issueTemplate(issue: Issue): string {
    return m.newtask_issue_prompt_template({ number: issue.number, title: issue.title });
  }

  // intentional one-time seed; NewTask remounts per open
  // svelte-ignore state_referenced_locally
  let prompt = $state(initialPrompt ?? (initialIssue ? issueTemplate(initialIssue) : ""));
  // The attached issue: its body is sent separately, NOT dumped into the prompt.
  // svelte-ignore state_referenced_locally
  let issueRef = $state<Issue | null>(initialIssue ?? null);
  // The repoPath in effect when issueRef was attached. Guards BOTH the "assigned to X"
  // notice (#1694) AND the activeIssue predicate below: an in-dialog repo switch doesn't
  // clear the attachment, and Issue carries no repoPath, so without this a repo-A issue
  // would satisfy readiness / ride the payload for a repo-B submission.
  // svelte-ignore state_referenced_locally
  let attachedRepoPath = $state<string | null>(initialIssue ? (initialRepoPath ?? "") : null);
  // intentional one-time seed; NewTask remounts per open
  // svelte-ignore state_referenced_locally
  let repoPath = $state(initialRepoPath ?? "");
  // seeds once from initialBaseBranch; later branch loads / repo switches drive it
  // (see the seededBase one-shot below) — intentionally captures the initial value
  // svelte-ignore state_referenced_locally
  let baseBranch = $state(initialBaseBranch ?? "main");
  // One-shot: keep the seeded base on the initial repo's first branch load, then
  // let the repo's current branch win on every subsequent load / repo switch.
  // svelte-ignore state_referenced_locally
  let seededBase = $state(initialBaseBranch != null);
  // Seeds once from the overlay-resolved default CLI. The overlay may route a fresh
  // task to a ready alternate provider when the configured default would hit a
  // usage hold; explicit relaunch/edit-held seeds still win and preserve the task.
  // svelte-ignore state_referenced_locally
  let agentProvider = $state<AgentProvider>(initialAgentProvider ?? defaultAgentProvider);

  // Model/effort preselect + reseed + validity correction all live HERE (run-config.ts),
  // never in the conditionally-mounted settings component — a mobile session that never
  // opens the engine sheet still submits normalized values.
  // reads initialModel/fableAvailable once to compute the picker's seed; intentionally
  // non-reactive — a one-shot value, not tracked
  // svelte-ignore state_referenced_locally
  const safeInitial = initialModel === "fable" && !fableAvailable ? "default" : initialModel;
  // seeds the model picker once; the reseed $effect below re-derives it from the
  // repo/global default until the user picks one (modelTouched)
  // svelte-ignore state_referenced_locally
  let model = $state(
    safeInitial ??
      preselectModel(
        agentProvider === "codex" ? (defaultCodexModel ?? "gpt-5.5") : defaultModel,
        agentProvider,
        fableAvailable,
      ),
  );
  let modelTouched = $state(false);

  // svelte-ignore state_referenced_locally
  let effort = $state(preselectEffort(initialEffort ?? defaultEffort));
  let effortTouched = $state(false);
  // Relaunch + edit-held reuse this composer with a distinct title.
  const heading = $derived(
    editHeld
      ? m.newtask_edit_held_title()
      : relaunch
        ? m.newtask_relaunch_title()
        : m.newtask_title(),
  );
  // Plan gate: defaults to the selected repo's stored flag until the user toggles
  // it. `planGateTouched` pins a manual choice so switching repos doesn't clobber it.
  // svelte-ignore state_referenced_locally
  let planGate = $state(initialPlanGate ?? false);
  // svelte-ignore state_referenced_locally
  let planGateTouched = $state(initialPlanGate != null);
  // Autopilot override: same seed-from-repo-default pattern.
  // svelte-ignore state_referenced_locally
  let autopilot = $state(initialAutopilot ?? false);
  // svelte-ignore state_referenced_locally
  let autopilotTouched = $state(initialAutopilot != null);
  // Research task kind: web research → report PR or issue; mutually exclusive w/ plan-gate.
  // svelte-ignore state_referenced_locally
  let research = $state(initialResearch);
  // Epic-authoring task kind (issue #1507): guided shaping → EPIC draft.
  // svelte-ignore state_referenced_locally
  let epicAuthoring = $state(initialEpicAuthoring);
  // Per-spawn sandbox override; "default" → omit (inherit the repo's configured profile).
  // svelte-ignore state_referenced_locally
  let sandboxProfile = $state<"default" | SandboxProfile>(initialSandboxProfile ?? "default");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  // re-invokes whichever action last failed (upload or create) from an inline Retry
  let retry = $state<(() => void) | null>(null);
  // True while the first-task confirm step is shown (unconfirmed repo intercept)
  let confirmStep = $state(false);
  // Carries the `force` flag across the confirm step so confirming a first-task repo
  // replays the original intent, not a downgraded force=false.
  let pendingForce = $state(false);

  function reason(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message.trim() : "";
    return msg || fallback;
  }
  let repos = $state<RepoEntry[]>([]);
  // Day count the server computed recentAgentCount over; drives the picker's label.
  let recentRepoWindowDays = $state(0);
  const selectedRepo = $derived(repos.find((r) => r.path === repoPath));
  const selectedRepoName = $derived(selectedRepo?.name ?? "");
  // ONE repo-aware seeded-issue predicate: feeds readiness, the submit guard, the
  // template materialization, and the issueRef payload — they can never disagree.
  const activeIssue = $derived(issueRef && repoPath === attachedRepoPath ? issueRef : null);
  // Non-viewer assignees of the attached issue, for the soft "you can still start"
  // notice (#1694). Fail-closed via viewer-cache.
  const attachedOthers = $derived(
    activeIssue ? assignedOthers(activeIssue, viewerCache.get(repoPath)) : [],
  );
  let branches = $state<string[]>([]);
  // The base selected by pickBaseBranch need not be a LOCAL branch — surface it as an
  // option so the dropdown's shown value matches the base actually submitted.
  let baseOptions = $derived(branches.includes(baseBranch) ? branches : [baseBranch, ...branches]);
  let upstream = $state<{
    behind: number;
    ahead: number;
    diverged: boolean;
    hasUpstream: boolean;
    localExists: boolean;
  } | null>(null);
  let upstreamLoading = $state(false);
  let repairingBase = $state(false);
  let branchStatusGeneration = 0;
  const baseMissing = $derived(
    upstream != null && branches.length === 0 && !upstream.localExists && !upstream.hasUpstream,
  );
  // intentional one-time seed; NewTask remounts per open
  // svelte-ignore state_referenced_locally
  let images = $state<TaskAttachment[]>(initialImages ? [...initialImages] : []);
  let dragging = $state(false);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement>();
  let promptInput = $state<HTMLTextAreaElement>();
  let repoSelect: RepoSelect | undefined = $state();
  let mic: MicButton | undefined = $state();
  let isMac = $state(false);
  // Coarse pointer = touch-primary device: hide keyboard-combo hints it can't fulfil.
  const coarse = new MediaQuery("(pointer: coarse)");
  // Layout breakpoint — drives the SINGLE mounted instance of RunSettingsGroups
  // (desktop rail vs. mobile engine sheet) and the mobile-only chrome.
  const mobile = new MediaQuery("(max-width: 768px)");
  // Single active-sheet invariant: at most one mobile sheet is open, by construction.
  let activeSheet = $state<"engine" | "context" | null>(null);
  let contextSheetEl = $state<HTMLElement | null>(null);
  // Leaving mobile while a sheet is open: the rail takes over; close the sheet.
  $effect(() => {
    if (!mobile.current && activeSheet !== null) activeSheet = null;
  });

  // ── inline slash-command autocomplete (reuses the /api/commands index) ──
  let allCommands = $state<SlashCommand[]>([]);
  let slashOpen = $state(false);
  let slashQuery = $state("");
  let slashTrigger = $state<"/" | "$" | "@">("/");
  let slashIndex = $state(0);
  const commandProvider = $derived(
    slashOpen ? (slashTrigger === "/" ? "claude" : "codex") : agentProvider,
  );
  const slashMatches = $derived(
    slashOpen ? filterCommands(allCommands, slashQuery, commandProvider) : [],
  );
  let providerTokenConstraints = $state<ProviderTokenConstraint[]>([]);
  const activeProviderConstraint = $derived(providerTokenConstraints[0] ?? null);

  // ── inline `#` issue search (issue-trigger.ts; distinct state from the command menu;
  //    same allowIssues = !relaunch restriction as the issue panel) ──
  let issueSearchOpen = $state(false);
  let issueQuery = $state("");
  let issueIndex = $state(0);
  const issueData = new IssueData();
  $effect(() => {
    issueData.load(repoPath);
  });
  const issueMatches = $derived.by(() => {
    if (!issueSearchOpen) return [];
    const q = issueQuery.trim().toLowerCase();
    const list = q
      ? issueData.issues.filter(
          (i) => String(i.number).startsWith(q) || i.title.toLowerCase().includes(q),
        )
      : issueData.issues;
    return list.slice(0, 20);
  });

  /** Default to the most-recently-used repo; fall back to the first in the list. */
  function defaultRepoPath(list: RepoEntry[]): string {
    let best: RepoEntry | undefined;
    for (const r of list) {
      if (r.lastUsedAt != null && (best?.lastUsedAt == null || r.lastUsedAt > best.lastUsedAt)) {
        best = r;
      }
    }
    return best?.path ?? list[0]?.path ?? "";
  }

  /** Map a `syncfork_failed_*` code to its toast message (default = generic). */
  function syncForkMsg(code: string): string {
    switch (code) {
      case "syncfork_failed_diverged":
        return m.syncfork_toast_diverged();
      case "syncfork_failed_auth":
        return m.syncfork_toast_auth();
      case "syncfork_failed_gh_missing":
        return m.syncfork_toast_gh_missing();
      default:
        return m.syncfork_toast_generic();
    }
  }

  /** Sync a fork row with its upstream. Awaited by RepoSelect so the row shows a
   *  busy state; result is surfaced as a toast. */
  async function handleSync(repo: RepoEntry) {
    try {
      await syncFork(repo.path);
      toasts.info(m.syncfork_toast_done({ name: repo.name }));
    } catch (e) {
      const code = e instanceof Error ? e.message : "syncfork_failed_generic";
      toasts.info(syncForkMsg(code), { alert: true });
    }
  }

  onMount(() => {
    isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
    listRepos()
      .then(({ repos: r, recentWindowDays }) => {
        repos = r;
        recentRepoWindowDays = recentWindowDays;
        // Prefer the most-recently-used NON-hidden repo; if every repo is hidden,
        // fall back to the full list so repoPath is never left empty.
        if (!repoPath && r.length > 0)
          repoPath = defaultRepoPath(r.filter((repo) => !repo.hidden)) || r[0]!.path;
      })
      .catch(() => {});
    // Focus the prompt so the user can type immediately when the dialog opens.
    promptInput?.focus();
    promptInput?.setSelectionRange(prompt.length, prompt.length);
    autogrow(); // size to a seeded initialPrompt on open
    // Paste anywhere in the modal (the textarea need not be focused first).
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // load branches for the selected repo; reset base to the repo's current branch
  $effect(() => {
    const rp = repoPath;
    if (!rp) {
      branches = [];
      return;
    }
    listBranches(rp)
      .then((b) => {
        if (rp !== repoPath) return;
        branches = b.branches;
        // Preserve a relaunch-seeded base on the initial repo's first load;
        // once consumed (or on any other repo) prefer the repo's default branch.
        if (seededBase && rp === initialRepoPath) {
          seededBase = false;
        } else {
          baseBranch = pickBaseBranch(b);
        }
      })
      .catch(() => {
        branches = [];
      });
  });

  // Fetch upstream status for the selected base branch; debounced 300 ms with a
  // stale-request guard.
  $effect(() => {
    const rp = repoPath,
      b = baseBranch;
    const generation = branchStatusGeneration;
    upstream = null;
    if (!rp || !b) {
      upstreamLoading = false;
      return;
    }
    upstreamLoading = true;
    let cancelled = false;
    const t = setTimeout(() => {
      branchStatus(rp, b)
        .then((s) => {
          if (
            !cancelled &&
            generation === branchStatusGeneration &&
            rp === repoPath &&
            b === baseBranch
          ) {
            upstream = s;
            upstreamLoading = false;
          }
        })
        .catch(() => {
          if (
            !cancelled &&
            generation === branchStatusGeneration &&
            rp === repoPath &&
            b === baseBranch
          ) {
            upstream = null;
            upstreamLoading = false;
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  });

  // Seed the plan-gate toggle from the selected repo's stored default.
  $effect(() => {
    if (repoPath) repoConfig.ensure(repoPath);
  });
  const planGateDefault = $derived(repoPath ? repoConfig.isPlanGateEnabled(repoPath) : false);
  const planGateLoading = $derived(
    !!repoPath && !planGateTouched && !repoConfig.isConfigSettled(repoPath),
  );
  $effect(() => {
    // mirror the repo default until the user makes a manual choice
    if (!planGateTouched) planGate = planGateDefault;
  });

  // Same seed-from-repo-default pattern for the autopilot override.
  const autopilotDefault = $derived(repoPath ? repoConfig.isAutopilotEnabled(repoPath) : false);
  const autopilotLoading = $derived(
    !!repoPath && !autopilotTouched && !repoConfig.isConfigSettled(repoPath),
  );
  $effect(() => {
    if (!autopilotTouched) autopilot = autopilotDefault;
  });

  // Research and epic-authoring are non-code modes: both disable the plan-gate/autopilot
  // toggles and the autonomous sandbox.
  const modeLocked = $derived(research || epicAuthoring);
  const mode = $derived<"code" | "research" | "epic">(
    research ? "research" : epicAuthoring ? "epic" : "code",
  );
  /** Mode segmented control: exact checkbox-parity semantics — selecting a non-code mode
   *  forces the guards off and PINS them touched (so a later repo switch doesn't re-seed);
   *  returning to Code deliberately does NOT restore them (parity with unchecking). */
  function setMode(next: "code" | "research" | "epic") {
    if (next === mode) return;
    research = next === "research";
    epicAuthoring = next === "epic";
    if (next !== "code") {
      planGate = false;
      planGateTouched = true;
      autopilot = false;
      autopilotTouched = true;
      if (sandboxProfile === "autonomous") sandboxProfile = "default";
    }
  }

  /** Effective model SETTING for a provider: repo override (when valid for it) → global. */
  function modelSettingFor(provider: AgentProvider): string {
    const override = repoPath ? repoConfig.defaultModelFor(repoPath) : "inherit";
    const setting =
      provider === "codex" ? (defaultCodexModel ?? "gpt-5.5") : (defaultModel ?? "auto");
    return override !== "inherit" &&
      (override === "auto" ||
        override === "default" ||
        MODELS_BY_PROVIDER[provider].includes(override))
      ? override
      : setting;
  }
  const effectiveModelSetting = $derived(modelSettingFor(agentProvider));
  const providerDefaultModel = $derived(
    preselectModel(effectiveModelSetting, agentProvider, fableAvailable),
  );

  const repoEffortOverride = $derived(repoPath ? repoConfig.defaultEffortFor(repoPath) : "inherit");
  const effectiveEffortSetting = $derived(
    repoEffortOverride !== "inherit" ? repoEffortOverride : (defaultEffort ?? "default"),
  );

  // Untouched-reseed: repo/provider change re-derives model+effort until pinned.
  $effect(() => {
    const seeded = reseedRunConfig({
      provider: agentProvider,
      modelTouched,
      effortTouched,
      hasInitialModel: initialModel != null,
      hasInitialEffort: initialEffort != null,
      effectiveModelSetting,
      effectiveEffortSetting,
      fableAvailable,
    });
    if (seeded.model !== undefined && seeded.model !== model) model = seeded.model;
    if (seeded.effort !== undefined && seeded.effort !== effort) effort = seeded.effort;
  });

  // Validity correction, applied always (touched or not): constraint-forced provider
  // flips, unavailable-model snaps, unsupported-effort snaps.
  $effect(() => {
    const norm = normalizeRunConfig({
      provider: agentProvider,
      model,
      effort,
      fableAvailable,
      constraint: activeProviderConstraint,
      claudeModelSetting: modelSettingFor("claude"),
      codexModelSetting: modelSettingFor("codex"),
    });
    if (norm.provider !== agentProvider) agentProvider = norm.provider;
    if (norm.model !== model) model = norm.model;
    if (norm.effort !== effort) effort = norm.effort;
  });

  /** Manual CLI-select change — today's semantics preserved: the model resets to the new
   *  provider's default unconditionally (touched or not). */
  function providerChanged(p: AgentProvider) {
    agentProvider = p;
    model = modelForManualProviderChange(p, modelSettingFor(p), fableAvailable);
  }

  // (re)load the slash-command list when the target repo changes.
  $effect(() => {
    const rp = repoPath;
    const provider = commandProvider;
    if (!rp) {
      allCommands = [];
      return;
    }
    getCommands(rp, { provider })
      .then((r) => {
        if (rp === repoPath && provider === commandProvider) allCommands = r.commands;
      })
      .catch(() => {
        if (rp === repoPath && provider === commandProvider) allCommands = [];
      });
  });

  // Epic-parent tracking issues for the selected repo (issue picker shows them disabled).
  let epicParents = $state<Set<number>>(new Set());
  let nativeSubIssues = $state<Set<number>>(new Set());
  let epicsLoaded = $state(false);
  $effect(() => {
    const rp = repoPath;
    if (!rp) {
      epicParents = new Set();
      nativeSubIssues = new Set();
      epicsLoaded = false;
      return;
    }
    getEpics(rp)
      .then((r) => {
        if (rp !== repoPath) return;
        epicParents = new Set(r.epics.map((s) => s.parentIssueNumber));
        nativeSubIssues = new Set(r.subIssues);
        epicsLoaded = true;
      })
      .catch(() => {
        if (rp !== repoPath) return;
        epicParents = new Set();
        nativeSubIssues = new Set();
        epicsLoaded = false;
      });
  });

  // ── readiness: the footer line + CTA disabled-state + submit guard all derive from
  //    this single presentation-layer model (new-task/readiness.ts) ──
  const readiness = $derived(
    deriveReadiness({
      promptEmpty: !prompt.trim(),
      issueSeeded: activeIssue != null,
      repoResolved: !!repoPath.trim(),
      baseMissing,
      repairing: repairingBase,
      submitting,
      upstreamLoading,
      upstream: upstream ? { diverged: upstream.diverged, behind: upstream.behind } : null,
      holdLikely,
      provider: agentProvider,
    }),
  );
  const showDualCta = $derived(readiness.advisories.includes("hold_likely"));

  function blockerCopy(blocker: NonNullable<typeof readiness.blocker>): string {
    switch (blocker) {
      case "empty_prompt":
        return m.newtask_readiness_empty_prompt();
      case "no_repo":
        return m.newtask_readiness_no_repo();
      case "base_missing":
        return m.newtask_readiness_base_missing();
      case "repairing":
        return m.newtask_readiness_repairing();
      case "submitting":
        return m.newtask_spawning();
    }
  }

  async function addFiles(files: FileList | File[]) {
    const uploads = Array.from(files);
    if (uploads.length === 0) return;
    uploading = true;
    error = null;
    retry = null;
    try {
      for (const f of uploads) {
        const path = await uploadFile(f);
        images.push({
          path,
          name: f.name,
          ...(f.type.startsWith("image/") ? { previewFile: f } : {}),
        });
      }
    } catch (err) {
      if (isPreviewBlocked(err)) {
        error = (err as Error).message;
      } else {
        error = m.newtask_upload_failed({ reason: reason(err, m.newtask_upload_unknown_reason()) });
        retry = () => addFiles(uploads);
      }
    } finally {
      uploading = false;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }

  // Cmd/Ctrl+V of a screenshot: upload any image on the clipboard.
  function onPaste(e: ClipboardEvent) {
    handleImagePaste(e, addFiles);
  }

  function removeUpload(path: string) {
    images = images.filter((i) => i.path !== path);
  }

  // Attach an issue by reference: keep the body off the prompt (it rides out-of-band
  // to the agent), seed an editable template only when the user hasn't typed anything.
  function pickIssue(issue: Issue) {
    issueRef = issue;
    attachedRepoPath = repoPath;
    if (!prompt.trim()) {
      prompt = issueTemplate(issue);
      queueMicrotask(autogrow);
    }
  }

  // Inject an issue-scoped steer from PromptSources' per-row context menu.
  function injectSteer(issue: Issue, steer: Steer) {
    issueRef = issue;
    attachedRepoPath = repoPath;
    const t = steer.text;
    prompt = prompt.trim() ? `${prompt}\n${t}` : t;
    queueMicrotask(() => {
      autogrow();
      promptInput?.focus();
      promptInput?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  // Grow the prompt with its content (capped by CSS max-height, then it scrolls).
  function autogrow() {
    if (!promptInput) return;
    promptInput.style.height = "auto";
    promptInput.style.height = `${promptInput.scrollHeight}px`;
  }

  // Open/refresh the slash menu OR the issue-search menu from the caret position.
  // A token starts with exactly one of `/ $ @ #`, so the two menus are mutually
  // exclusive by construction; `#` obeys the panel's allowIssues = !relaunch rule.
  function refreshTriggers() {
    const caret = promptInput?.selectionStart ?? prompt.length;
    const trigger = matchSlashTrigger(prompt, caret);
    if (trigger) {
      slashOpen = true;
      slashQuery = trigger.query;
      slashTrigger = trigger.trigger;
      slashIndex = 0;
      issueSearchOpen = false;
      return;
    }
    slashOpen = false;
    const issueTrig = !relaunch ? matchIssueTrigger(prompt, caret) : null;
    if (issueTrig) {
      issueSearchOpen = true;
      issueQuery = issueTrig.query;
      issueIndex = 0;
    } else {
      issueSearchOpen = false;
    }
  }

  function onPromptInput() {
    autogrow();
    pruneProviderConstraints(prompt);
    refreshTriggers();
  }

  function pruneProviderConstraints(text: string) {
    providerTokenConstraints = providerTokenConstraints.filter((c) => text.includes(c.token));
  }

  function providerForPick(cmd: SlashCommand, trigger: "/" | "$" | "@"): AgentProvider {
    const providers = commandProviders(cmd);
    if ((trigger === "$" || trigger === "@") && providers.includes("codex")) return "codex";
    if (trigger === "/" && providers.includes("claude")) return "claude";
    return providers[0] ?? agentProvider;
  }

  // Replace the typed `/query` token with the chosen command and hoist it to the front.
  function pickCommand(cmd: SlashCommand) {
    const caret = promptInput?.selectionStart ?? prompt.length;
    const trigger = matchSlashTrigger(prompt, caret);
    const start = trigger?.start ?? 0;
    const providers = commandProviders(cmd);
    const pickedProvider = providerForPick(cmd, trigger?.trigger ?? "/");
    agentProvider = pickedProvider;
    const token = commandInvocation(cmd, pickedProvider);
    const next =
      pickedProvider === "codex"
        ? applyMentionPick(prompt, start, caret, commandInvocationName(cmd))
        : applyCommandPick(prompt, start, caret, commandInvocationName(cmd));
    prompt = next.value;
    providerTokenConstraints =
      providers.length === 1
        ? [
            {
              id: cmd.id ?? `${pickedProvider}:${cmd.name}`,
              commandId: cmd.id,
              token,
              providers,
              label: cmd.displayName ?? cmd.name,
            },
          ]
        : [];
    slashOpen = false;
    queueMicrotask(() => {
      autogrow();
      promptInput?.focus();
      promptInput?.setSelectionRange(next.caret, next.caret);
    });
  }

  function pickCommandFromSource(cmd: SlashCommand) {
    const providers = commandProviders(cmd);
    const provider = providers.includes(agentProvider)
      ? agentProvider
      : (providers[0] ?? agentProvider);
    agentProvider = provider;
    const token = commandInvocation(cmd, provider);
    prompt = `${token} `;
    providerTokenConstraints =
      providers.length === 1
        ? [
            {
              id: cmd.id ?? `${provider}:${cmd.name}`,
              commandId: cmd.id,
              token,
              providers,
              label: cmd.displayName ?? cmd.name,
            },
          ]
        : [];
    queueMicrotask(() => {
      autogrow();
      promptInput?.focus();
      promptInput?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  // Pick from the inline `#` search: remove the typed token, then attach via the same
  // pickIssue path the panel uses (seeds the template when the prompt goes empty).
  function pickIssueFromSearch(issue: Issue) {
    const caret = promptInput?.selectionStart ?? prompt.length;
    const trig = matchIssueTrigger(prompt, caret);
    if (trig) prompt = prompt.slice(0, trig.start) + prompt.slice(caret);
    issueSearchOpen = false;
    pickIssue(issue);
    queueMicrotask(() => {
      autogrow();
      promptInput?.focus();
      promptInput?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  // While a menu is open it captures the navigation keys; plain Enter inserts a newline.
  // (⌘/Ctrl+Enter submits at the FORM level — see onFormKeydown — so it works from
  // anywhere in the modal, per the design.)
  function onPromptKeydown(e: KeyboardEvent) {
    const menuOpen = slashOpen ? slashMatches.length > 0 : issueSearchOpen;
    if ((slashOpen || issueSearchOpen) && menuOpen) {
      const len = slashOpen ? slashMatches.length : issueMatches.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (slashOpen) slashIndex = (slashIndex + 1) % len;
        else issueIndex = len === 0 ? 0 : (issueIndex + 1) % len;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (slashOpen) slashIndex = (slashIndex - 1 + len) % len;
        else issueIndex = len === 0 ? 0 : (issueIndex - 1 + len) % len;
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (slashOpen) {
          e.preventDefault();
          pickCommand(slashMatches[slashIndex]!);
        } else if (issueMatches.length > 0) {
          const pickTarget = issueMatches[issueIndex];
          if (pickTarget && !epicParents.has(pickTarget.number)) {
            e.preventDefault();
            pickIssueFromSearch(pickTarget);
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        slashOpen = false;
        issueSearchOpen = false;
      }
    } else if ((slashOpen || issueSearchOpen) && e.key === "Escape") {
      e.preventDefault();
      slashOpen = false;
      issueSearchOpen = false;
    }
  }

  function selectRepo(path: string) {
    repoPath = path;
    queueMicrotask(() => promptInput?.focus());
  }

  function cycleRepo(dir: 1 | -1) {
    // Cycle only the non-hidden subset so Alt+[/] can never surface a hidden repo.
    const list = repos.filter((r) => !r.hidden);
    const n = list.length;
    if (n === 0) return;
    const cur = list.findIndex((r) => r.path === repoPath);
    if (cur === -1) {
      repoPath = list[dir === 1 ? 0 : n - 1]!.path;
      return;
    }
    repoPath = list[(cur + dir + n) % n]!.path;
  }

  /** ⌥R: on desktop the RepoSelect panel opens directly; on mobile RepoSelect lives
   *  inside the context sheet, so the shortcut opens the sheet (closing the engine
   *  sheet per the single-sheet invariant) and then the panel once mounted. */
  async function openRepoPicker() {
    if (mobile.current) {
      activeSheet = "context";
      await tick();
    }
    repoSelect?.openPanel();
  }

  // Form-level keydown: ⌘/Ctrl+↵ submits from anywhere in the modal (handoff rule),
  // then the Alt-tier repo switchers (keyed on physical e.code, mirrors +page.svelte).
  function onFormKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit(e);
      return;
    }
    if (e.repeat || e.isComposing) return;
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    switch (e.code) {
      case "BracketLeft":
        cycleRepo(-1);
        break;
      case "BracketRight":
        cycleRepo(1);
        break;
      case "Digit1":
      case "Digit2":
      case "Digit3": {
        // Filter hidden BEFORE recentRepos' top-N slice so the digit index matches the
        // picker's pinned recents group exactly.
        const target = recentRepos(repos.filter((r) => !r.hidden))[Number(e.code.slice(5)) - 1];
        if (target) repoPath = target.path;
        break; // still swallow the chord below
      }
      case "KeyR":
        void openRepoPicker();
        break;
      default:
        return; // not ours — let it through untouched
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // Per-task automation flags at submit: send the user's manual choice, or null to
  // inherit the repo default.
  function automationFlag(touched: boolean, value: boolean): boolean | null {
    return touched ? value : null;
  }

  function planGateFlag(touched: boolean, value: boolean): boolean | null {
    return touched ? value : null;
  }

  async function doSpawn(force = false) {
    submitting = true;
    error = null;
    retry = null;
    // The one predicate: an empty prompt is only submittable with an active (same-repo)
    // issue, and then materializes as the issue template so the server contract holds.
    const typed = prompt.trim();
    const finalPrompt = typed || (activeIssue ? issueTemplate(activeIssue) : "");
    pruneProviderConstraints(finalPrompt);
    const incompatible = providerTokenConstraints.find(
      (c) => finalPrompt.includes(c.token) && !c.providers.includes(agentProvider),
    );
    if (incompatible) {
      submitting = false;
      error = m.newtask_provider_constraint_error({
        command: incompatible.label,
        provider:
          incompatible.providers[0] === "codex"
            ? m.agent_provider_codex()
            : m.agent_provider_claude(),
      });
      return;
    }
    try {
      await onsubmit({
        repoPath: repoPath.trim(),
        baseBranch: baseBranch.trim() || "main",
        prompt: finalPrompt,
        agentProvider,
        model: model !== "default" ? model : null,
        effort: effort !== "default" ? effort : null,
        images: images.map((i) => i.path),
        attachmentNames: images.map((i) => i.name),
        issueRef: activeIssue
          ? {
              number: activeIssue.number,
              url: activeIssue.url,
              title: activeIssue.title,
              body: activeIssue.body,
            }
          : undefined,
        launchUiState: {
          researchChecked: research,
          planGateChecked: planGate,
          autopilotChecked: autopilot,
          epicAuthoringChecked: epicAuthoring,
        },
        planGateEnabled: planGateFlag(planGateTouched, planGate),
        autopilotEnabled: automationFlag(autopilotTouched, autopilot),
        sandboxProfile: sandboxProfile === "default" ? undefined : sandboxProfile,
        research,
        epicAuthoring,
        force: force || undefined,
      });
    } catch (err) {
      if (isPreviewBlocked(err)) {
        error = (err as Error).message;
      } else if (editHeld) {
        error = reason(err, m.newtask_edit_held_failed());
        retry = () => doSpawn(force);
      } else if (relaunch) {
        error = reason(err, m.relaunch_failed());
        retry = () => doSpawn(force);
      } else {
        error = m.newtask_create_failed({ reason: reason(err, m.newtask_submit()) });
        retry = () => doSpawn(force);
      }
    } finally {
      // Clear submitting on every path (matters for the error path: the dialog stays
      // open showing the error and the buttons must re-enable for a retry).
      submitting = false;
    }
  }

  async function repairInitialCommit() {
    if (!repoPath.trim() || repairingBase) return;
    repairingBase = true;
    branchStatusGeneration += 1;
    error = null;
    retry = null;
    const repo = repoPath.trim();
    const branch = baseBranch.trim() || "main";
    try {
      const repaired = await initEmptyCommit(repo, branch);
      baseBranch = repaired.branch;
      upstream = { behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: true };
      const b = await listBranches(repo).catch(() => null);
      if (repo !== repoPath.trim()) return;
      if (b) branches = b.branches;
      const s = await branchStatus(repo, repaired.branch).catch(() => null);
      if (s && repo === repoPath.trim() && repaired.branch === baseBranch) upstream = s;
    } catch (err) {
      error = m.newtask_init_commit_failed({
        reason: reason(err, m.newtask_init_commit_unknown_reason()),
      });
      retry = repairInitialCommit;
    } finally {
      repairingBase = false;
      upstreamLoading = false;
    }
  }

  async function submit(e: Event, force = false) {
    e.preventDefault();
    // Single guard: the same readiness model that drives the footer + CTA. Known
    // pre-existing race (unchanged by this redesign): a second activation during the
    // awaited repoConfig.ensure() below can pass this guard before doSpawn sets
    // `submitting` — see the PR body's "Known pre-existing races" note.
    if (!readiness.canSubmit) return;
    // A mid-recording submit sends the prompt as it stands: stop the mic and discard
    // the clip so nothing is uploaded while (or after) the task spawns.
    mic?.teardown();
    const repo = repoPath.trim();
    // Settle the repo config BEFORE reading confirm/rowExists (see repoConfig.ensure).
    const configLoaded = await repoConfig.ensure(repo);
    // Editing a held task isn't a create — skip the brand-new-repo automation-confirm
    // interstitial; just persist the edit.
    if (
      !editHeld &&
      agentProvider === "claude" &&
      configLoaded &&
      !repoConfig.isAutomationConfirmed(repo)
    ) {
      // Brand-new repo (no row) → seed the raised default posture (plan-gate ON).
      if (!repoConfig.automationRowExists(repo)) await repoConfig.seedNewRepoDefaults(repo);
      pendingForce = force; // replay the original force intent after confirmation
      confirmStep = true;
      return;
    }
    await doSpawn(force);
  }

  async function confirmAndSpawn() {
    if (submitting) return;
    submitting = true;
    error = null;
    const repo = repoPath.trim();
    try {
      await repoConfig.confirmAutomation(repo);
    } catch (err) {
      error = m.newtask_create_failed({ reason: reason(err, m.newtask_submit()) });
      submitting = false; // re-enable so the user can retry
      return; // stay on the step; do NOT spawn if the confirm PUT failed
    }
    confirmStep = false;
    await doSpawn(pendingForce); // replay the force captured when the step opened
  }

  /** Compact model display for the mobile engine summary row. */
  const modelSummary = $derived(
    model === "default" ? m.newtask_model_default() : modelOptionLabel(agentProvider, model),
  );
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) {
      confirmStep = false;
      onclose?.();
    }
  }}
>
  <!-- The modal card is a <form> so the prompt submits natively; role="dialog"
       on it is valid ARIA. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
  <form
    class="card bracket"
    class:dragging
    role="dialog"
    aria-modal="true"
    aria-label={heading}
    use:dialog={{
      onclose: () => {
        confirmStep = false;
        onclose?.();
      },
    }}
    onsubmit={submit}
    onkeydown={onFormKeydown}
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={(e) => {
      if (e.target === e.currentTarget) dragging = false;
    }}
    ondrop={onDrop}
  >
    <div class="chead">
      <span class="chead-title">{heading}</span>
      {#if mobile.current}
        <!-- Combined repo·branch chip: one control naming both payload-critical values;
             opens the context sheet where each is independently editable. -->
        <button
          type="button"
          class="ctx-chip"
          aria-haspopup="dialog"
          aria-expanded={activeSheet === "context"}
          aria-label={m.newtask_context_chip_aria({
            repo: selectedRepoName || m.reposelect_placeholder(),
            branch: baseBranch,
          })}
          onclick={() => (activeSheet = "context")}
        >
          <span aria-hidden="true">{projectIcons.iconFor(repoPath) ?? "▣"}</span>
          <b>{selectedRepoName || m.reposelect_placeholder()}</b>
          <span class="ctx-branch">· {baseBranch}</span>
          <span class="chev" aria-hidden="true">▾</span>
        </button>
      {/if}
      <button
        type="button"
        class="x"
        onclick={() => {
          confirmStep = false;
          onclose?.();
        }}
        aria-label={m.common_close()}>✕</button
      >
    </div>

    <FirstTaskAutomationConfirm
      active={confirmStep}
      repoPath={repoPath.trim()}
      {submitting}
      {error}
      onconfirm={confirmAndSpawn}
      oncancel={() => {
        confirmStep = false;
        error = null;
      }}
    />
    <div class="composer" class:hidden={confirmStep}>
      <div class="cbody">
        <div class="left">
          {#if !mobile.current}
            <!-- Context chips row: repo (existing RepoSelect, chip-styled) from branch. -->
            <div class="ctx-row" use:coachTarget={"nt-repo"}>
              <div class="repo-chip">
                <RepoSelect
                  bind:this={repoSelect}
                  {repos}
                  windowDays={recentRepoWindowDays}
                  value={repoPath}
                  onchange={selectRepo}
                  {onclone}
                  {onfork}
                  {onnewproject}
                  onsync={handleSync}
                  onescape={() => promptInput?.focus()}
                  hideHidden
                />
              </div>
              <span class="ctx-from">{m.newtask_chip_from()}</span>
              <span class="branch-chip">
                {#if branches.length > 0}
                  <select
                    id="nt-base"
                    aria-label={m.newtask_branch_label()}
                    bind:value={baseBranch}
                  >
                    {#each baseOptions as b (b)}
                      <option value={b}>{b}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    id="nt-base"
                    aria-label={m.newtask_branch_label()}
                    bind:value={baseBranch}
                    placeholder={m.newtask_branch_placeholder()}
                  />
                {/if}
                <span class="chev" aria-hidden="true">▾</span>
              </span>
              {#if !coarse.current}
                <span class="ctx-hint">
                  {m.newtask_repo_shortcuts_hint({ mod: isMac ? "⌥" : "Alt+" })}
                </span>
              {/if}
            </div>
          {/if}

          {#if upstreamLoading}
            <span class="nt-upstream">{m.newtask_upstream_checking()}</span>
          {:else if upstream?.diverged}
            <span class="nt-upstream nt-upstream-warn">
              {m.newtask_upstream_diverged({
                behind: upstream.behind,
                ahead: upstream.ahead,
                base: baseBranch,
              })}
            </span>
          {:else if upstream && upstream.behind > 0}
            <span class="nt-upstream">{m.newtask_upstream_behind({ count: upstream.behind })}</span>
          {:else if baseMissing}
            <BaseRepairNotice repairing={repairingBase} onrepair={repairInitialCommit} />
          {/if}

          {#if relaunch}
            <div class="relaunch-note">
              <span>{m.newtask_relaunch_note()}</span>
              {#if relaunchIssueNumber != null && repoPath !== initialRepoPath}
                <span>{m.newtask_relaunch_issue_drop_note({ number: relaunchIssueNumber })}</span>
              {/if}
            </div>
          {/if}

          <!-- Prompt hero: the single visual hero — the only field with a bright border. -->
          <div class="prompt-block">
            {#if !mobile.current}
              <div class="prompt-label-row">
                <label class="prompt-label" for="nt-prompt">{m.newtask_prompt_label()}</label>
                <span class="syntax-hint">
                  {coarse.current ? m.newtask_syntax_hint_touch() : m.newtask_syntax_hint()}
                </span>
              </div>
            {/if}
            <div class="hero">
              <div class="prompt-wrap">
                <textarea
                  id="nt-prompt"
                  bind:this={promptInput}
                  bind:value={prompt}
                  data-1p-ignore
                  rows="3"
                  aria-label={m.newtask_prompt_label()}
                  placeholder={m.newtask_prompt_placeholder()}
                  oninput={onPromptInput}
                  onkeydown={onPromptKeydown}
                  onblur={() => {
                    slashOpen = false;
                    issueSearchOpen = false;
                  }}></textarea>
                {#if slashOpen}
                  <SlashCommandMenu
                    commands={slashMatches}
                    activeIndex={slashIndex}
                    provider={commandProvider}
                    onpick={pickCommand}
                    onhover={(i) => (slashIndex = i)}
                  />
                {:else if issueSearchOpen}
                  <IssueSearchMenu
                    issues={issueMatches}
                    activeIndex={issueIndex}
                    {epicParents}
                    onpick={pickIssueFromSearch}
                    onhover={(i) => (issueIndex = i)}
                  />
                {/if}
              </div>
              <!-- In-field toolbar: attach, dictate, attachment chips, char counter. -->
              <div class="toolbar">
                <button
                  type="button"
                  class="tool-btn"
                  aria-label={m.newtask_attach_aria()}
                  title={coarse.current
                    ? m.newtask_drop_hint()
                    : m.newtask_drop_hint_keyboard({ shortcut: isMac ? "⌘V" : "Ctrl+V" })}
                  onclick={() => fileInput?.click()}
                  disabled={uploading}
                >
                  {#if uploading}…{:else}↥{/if}
                </button>
                <MicButton
                  bind:this={mic}
                  inline
                  getText={() => prompt}
                  setText={(t) => (prompt = t)}
                  onTextRendered={autogrow}
                />
                {#each images as img (img.path)}
                  <AttachmentChip
                    name={img.name}
                    previewFile={img.previewFile}
                    coarse={coarse.current}
                    onremove={() => removeUpload(img.path)}
                  />
                {/each}
                <span class="char-count">
                  {#if mobile.current}
                    {m.newtask_syntax_hint_touch()}
                  {:else}
                    {m.newtask_char_count({ count: prompt.length })}
                  {/if}
                </span>
              </div>
            </div>
            {#if relaunch}
              <span class="field-note">{m.newtask_relaunch_image_note()}</span>
            {/if}
          </div>
          <input
            bind:this={fileInput}
            type="file"
            multiple
            hidden
            onchange={(e) => {
              const t = e.currentTarget;
              if (t.files) addFiles(t.files);
              t.value = "";
            }}
          />

          {#if issueRef && !relaunch}
            <div class="issue-ref">
              <span class="issue-ref-label">{m.newtask_issue_attached_label()}</span>
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external GitHub URL -->
              <a class="issue-ref-link" href={issueRef.url} target="_blank" rel="noopener"
                >#{issueRef.number} {issueRef.title}</a
              >
              <button
                type="button"
                class="issue-ref-x"
                onclick={() => {
                  issueRef = null;
                  attachedRepoPath = null;
                }}
                aria-label={m.newtask_issue_remove_aria()}>✕</button
              >
            </div>
            {#if attachedOthers.length > 0}
              <p class="issue-assigned-notice">
                <span class="glyph" aria-hidden="true">⚠</span>{m.issuerow_assigned_notice({
                  who: attachedOthers.join(", "),
                })}
              </p>
            {/if}
          {/if}

          {#if mobile.current}
            <!-- Mobile: Mode segments + the engine summary row (opens the sheet). -->
            {@render modeSeg()}
            <button
              type="button"
              class="engine-summary"
              aria-haspopup="dialog"
              aria-expanded={activeSheet === "engine"}
              onclick={() => (activeSheet = "engine")}
            >
              <span class="es-label">{m.newtask_group_engine()}</span>
              <span class="es-value">
                {agentProvider === "codex" ? m.agent_provider_codex() : m.agent_provider_claude()}
                · {modelSummary} ·
                <span class="es-gate" class:on={planGate}
                  >{planGate ? m.newtask_gate_on() : m.newtask_gate_off()}</span
                >
              </span>
              <span class="chev" aria-hidden="true">▾</span>
            </button>
          {/if}

          {#if repoPath && !mobile.current}
            <PromptSources
              {repoPath}
              {issueData}
              {epicParents}
              {nativeSubIssues}
              {epicsLoaded}
              {agentProvider}
              allowIssues={!relaunch}
              onpick={(p) => {
                prompt = p;
                queueMicrotask(() => {
                  autogrow();
                  promptInput?.focus();
                  promptInput?.setSelectionRange(prompt.length, prompt.length);
                });
              }}
              onpickcommand={pickCommandFromSource}
              onpickissue={pickIssue}
              onpicksteer={injectSteer}
            />
          {/if}

          {#if error}
            <div class="err" role="alert">
              <span>{error}</span>
              {#if retry}
                <button type="button" class="retry" onclick={() => retry?.()}
                  >{m.common_retry()}</button
                >
              {/if}
            </div>
          {/if}
        </div>

        {#if !mobile.current}
          <div class="rail">
            <span class="group-label">{m.newtask_group_mode()}</span>
            {@render modeSeg()}
            <div class="rule"></div>
            <RunSettingsGroups
              {agentProvider}
              {model}
              {effort}
              {sandboxProfile}
              {planGate}
              {autopilot}
              {modeLocked}
              {planGateLoading}
              {autopilotLoading}
              {planGateDefault}
              {autopilotDefault}
              {usageLimits}
              {holdLikely}
              {fableAvailable}
              providerConstraint={activeProviderConstraint}
              {research}
              onProviderChange={providerChanged}
              onModelChange={(v) => {
                model = v;
                modelTouched = true;
              }}
              onEffortChange={(v) => {
                effort = v;
                effortTouched = true;
              }}
              onSandboxChange={(v) => (sandboxProfile = v)}
              onPlanGateChange={(v) => {
                planGate = v;
                planGateTouched = true;
              }}
              onAutopilotChange={(v) => {
                autopilot = v;
                autopilotTouched = true;
              }}
            />
          </div>
        {/if}
      </div>

      <!-- Footer: readiness line + always-visible CTA. -->
      <div class="cfoot">
        <span class="readiness">
          {#if readiness.blocker}
            <span class="r-blocked" aria-hidden="true">·</span>
            {blockerCopy(readiness.blocker)}
          {:else}
            <span class="r-ok" aria-hidden="true">✓</span>
            {m.newtask_readiness_ready()} ·
            {m.newtask_readiness_branches({ base: baseBranch })}
          {/if}
        </span>
        {#if showDualCta}
          <div class="run-dual">
            <button
              class="run run-hold"
              type="button"
              disabled={!readiness.canSubmit}
              onclick={(e) => submit(e, false)}
            >
              <span>{submitting ? m.newtask_spawning() : m.newtask_hold_for_reset()}</span>
            </button>
            <button
              class="run run-anyway"
              type="button"
              disabled={!readiness.canSubmit}
              onclick={(e) => submit(e, true)}
            >
              <span>{m.newtask_submit_anyway()}</span>
            </button>
          </div>
        {:else}
          <button
            class="run"
            type="submit"
            disabled={!readiness.canSubmit}
            title={coarse.current ? undefined : isMac ? "⌘ + Enter" : "Ctrl + Enter"}
          >
            <span
              >{editHeld
                ? submitting
                  ? m.newtask_edit_held_saving()
                  : m.newtask_edit_held_submit()
                : submitting
                  ? m.newtask_spawning()
                  : selectedRepoName && !mobile.current
                    ? m.newtask_submit_in_repo({ repo: selectedRepoName })
                    : m.newtask_submit()}</span
            >
            {#if !submitting && !coarse.current}
              <kbd class="kbd">{isMac ? "⌘↵" : "Ctrl+↵"}</kbd>
            {/if}
          </button>
        {/if}
      </div>
    </div>

    {#if mobile.current && activeSheet === "engine"}
      <MobileEngineSheet
        label={m.newtask_engine_sheet_title()}
        title={m.newtask_engine_sheet_title()}
        onclose={() => (activeSheet = null)}
      >
        {@render modeLockedNote()}
        <RunSettingsGroups
          {agentProvider}
          {model}
          {effort}
          {sandboxProfile}
          {planGate}
          {autopilot}
          {modeLocked}
          {planGateLoading}
          {autopilotLoading}
          {planGateDefault}
          {autopilotDefault}
          {usageLimits}
          {holdLikely}
          {fableAvailable}
          providerConstraint={activeProviderConstraint}
          {research}
          onProviderChange={providerChanged}
          onModelChange={(v) => {
            model = v;
            modelTouched = true;
          }}
          onEffortChange={(v) => {
            effort = v;
            effortTouched = true;
          }}
          onSandboxChange={(v) => (sandboxProfile = v)}
          onPlanGateChange={(v) => {
            planGate = v;
            planGateTouched = true;
          }}
          onAutopilotChange={(v) => {
            autopilot = v;
            autopilotTouched = true;
          }}
        />
      </MobileEngineSheet>
    {:else if mobile.current && activeSheet === "context"}
      <MobileEngineSheet
        label={m.newtask_context_sheet_title()}
        title={m.newtask_context_sheet_title()}
        onclose={() => (activeSheet = null)}
      >
        <div class="ctx-sheet" bind:this={contextSheetEl}>
          <span class="field-label">{m.newtask_repo_label()}</span>
          <RepoSelect
            bind:this={repoSelect}
            {repos}
            windowDays={recentRepoWindowDays}
            value={repoPath}
            onchange={selectRepo}
            {onclone}
            {onfork}
            {onnewproject}
            onsync={handleSync}
            onescape={() => {
              // Keep focus INSIDE the sheet's trap: land it on the RepoSelect trigger
              // (desktop refocuses the prompt instead — that would escape this trap).
              contextSheetEl?.querySelector<HTMLElement>(".rs-trigger")?.focus();
            }}
            hideHidden
          />
          <span class="field-label">{m.newtask_branch_label()}</span>
          {#if branches.length > 0}
            <select
              class="ctx-branch-select"
              aria-label={m.newtask_branch_label()}
              bind:value={baseBranch}
            >
              {#each baseOptions as b (b)}
                <option value={b}>{b}</option>
              {/each}
            </select>
          {:else}
            <input
              class="ctx-branch-select"
              aria-label={m.newtask_branch_label()}
              bind:value={baseBranch}
              placeholder={m.newtask_branch_placeholder()}
            />
          {/if}
        </div>
      </MobileEngineSheet>
    {/if}
  </form>
</div>

{#snippet modeSeg()}
  <div class="seg-row" role="group" aria-label={m.newtask_group_mode()}>
    <button
      type="button"
      class="seg-btn"
      class:seg-active={mode === "code"}
      aria-pressed={mode === "code"}
      onclick={() => setMode("code")}>{m.newtask_mode_code()}</button
    >
    <button
      type="button"
      class="seg-btn"
      class:seg-active={mode === "research"}
      aria-pressed={mode === "research"}
      title={m.newtask_research_hint()}
      onclick={() => setMode("research")}>{m.newtask_mode_research()}</button
    >
    <button
      type="button"
      class="seg-btn"
      class:seg-active={mode === "epic"}
      aria-pressed={mode === "epic"}
      title={m.newtask_epic_authoring_hint()}
      onclick={() => setMode("epic")}>{m.newtask_mode_epic()}</button
    >
  </div>
{/snippet}

{#snippet modeLockedNote()}
  {#if modeLocked}
    <span class="sr-only"
      >{research ? m.newtask_research_locked_aria() : m.newtask_epic_authoring_locked_aria()}</span
    >
  {/if}
{/snippet}

<style>
  /* Boxless wrapper for the compose body — display:contents passes flex layout
     straight through to children so the card's column layout is undisturbed. */
  .composer {
    display: contents;
  }
  .composer.hidden {
    display: none;
  }
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--color-scrim);
    display: flex;
    /* Scroll (not center-clip) when the card outgrows the viewport. Centering is
       done by the card's `margin: auto` so an over-tall card can still scroll. */
    overflow-y: auto;
    padding: 24px;
    box-sizing: border-box;
    z-index: 20;
  }
  .card {
    position: relative;
    margin: auto;
    width: min(880px, 92vw);
    max-height: 92vh;
    box-sizing: border-box;
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    display: flex;
    flex-direction: column;
  }
  .bracket::before,
  .bracket::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
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

  /* ── header ── */
  .chead {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--color-line);
  }
  .chead-title {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .x:hover {
    color: var(--color-ink);
  }

  /* ── body: two columns separated by a hairline; each column owns its scroll ── */
  .cbody {
    display: grid;
    grid-template-columns: 1fr 300px;
    min-height: 0;
    flex: 1;
  }
  .left {
    min-width: 0;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border-right: 1px solid var(--color-line);
    overflow-y: auto;
  }
  /* Never compress content to fit — the column scrolls instead (worst-case fixtures). */
  .left > :global(*) {
    flex-shrink: 0;
  }
  .rail {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    background: var(--color-panel-2);
    overflow-y: auto;
  }
  .group-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-faint);
    padding-bottom: 6px;
  }
  .rule {
    flex-shrink: 0;
    height: 1px;
    background: var(--color-line);
    margin: 14px 0 12px;
  }

  /* ── context chips row ── */
  .ctx-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  /* Chip-style the existing RepoSelect trigger without touching its internals. */
  .repo-chip {
    position: relative;
    flex-shrink: 0;
    min-width: 0;
  }
  .repo-chip :global(.rs-root) {
    width: auto;
  }
  .repo-chip :global(.rs-trigger) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: auto;
    max-width: 34ch;
    border: 1px solid var(--color-line);
    background: var(--color-panel-2);
    border-radius: 2px;
    padding: 4px 10px;
    font-size: var(--fs-meta);
    color: var(--color-ink-bright);
  }
  .repo-chip :global(.rs-trigger b) {
    font-weight: 600;
    max-width: 22ch;
    flex-shrink: 1;
  }
  .repo-chip :global(.rs-trigger .dim) {
    display: none;
  }
  .repo-chip :global(.rs-panel) {
    min-width: 320px;
  }
  .ctx-from {
    flex-shrink: 0;
    font-size: var(--fs-meta);
    color: var(--color-faint);
  }
  .branch-chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-width: 0;
  }
  .branch-chip select,
  .branch-chip input {
    appearance: none;
    max-width: 22ch;
    border: 1px solid var(--color-line);
    background: var(--color-panel-2);
    border-radius: 2px;
    padding: 4px 22px 4px 10px;
    font: inherit;
    font-size: var(--fs-meta);
    color: var(--color-ink);
    cursor: pointer;
  }
  .branch-chip select:focus,
  .branch-chip input:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .branch-chip .chev {
    position: absolute;
    right: 8px;
    pointer-events: none;
  }
  .chev {
    color: var(--color-muted);
    font-size: var(--fs-micro);
  }
  .ctx-hint {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nt-upstream {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .nt-upstream-warn {
    color: var(--status-warn);
  }

  /* ── prompt hero ── */
  .prompt-block {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-height: 0;
  }
  .prompt-label-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .prompt-label {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .syntax-hint {
    margin-left: auto;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The hero is ONE bordered object — the only field with the bright border. */
  .hero {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    background: var(--color-inset);
  }
  .prompt-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
  }
  textarea {
    background: transparent;
    border: 0;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    line-height: 1.5;
    padding: 10px;
    min-height: 132px;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    max-height: 40vh;
    overflow-y: auto;
  }
  textarea::placeholder {
    color: var(--color-faint);
  }
  textarea:focus {
    outline: none;
  }
  /* Focus brightens the hero border (no outer glow ring). */
  .hero:focus-within {
    border-color: var(--color-ink);
  }
  .toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--color-line);
  }
  .tool-btn {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font: inherit;
    cursor: pointer;
  }
  .tool-btn:hover {
    background: var(--color-hover);
    border-color: var(--color-line-bright);
  }
  .tool-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .tool-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }
  /* Inline mic (MicButton's inline variant) matches the tool-btn footprint. */
  .toolbar :global(.micbtn-anchor.inline) {
    position: static;
    height: auto;
  }
  .toolbar :global(.micbtn.inline) {
    position: static;
    width: 28px;
    height: 28px;
    border-color: var(--color-line);
    background: transparent;
    color: var(--color-muted);
  }
  .toolbar :global(.micbtn.inline svg) {
    width: 14px;
    height: 14px;
  }
  .char-count {
    margin-left: auto;
    flex-shrink: 0;
    font-size: var(--fs-micro);
    color: var(--color-faint);
    font-variant-numeric: tabular-nums;
  }

  .field-note {
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .field-label {
    font-size: var(--fs-micro);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .retry {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-amber);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 3px 8px;
    cursor: pointer;
  }
  .retry:hover {
    border-color: var(--color-amber);
  }

  /* ── mode segmented control (design-system seg recipe; amber active text) ── */
  .seg-row {
    display: flex;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    overflow: hidden;
  }
  .seg-btn {
    flex: 1;
    min-width: 0;
    border: 0;
    border-right: 1px solid var(--color-line);
    background: none;
    font-family: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    padding: 6px 2px;
    color: var(--color-muted);
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .seg-btn:last-child {
    border-right: 0;
  }
  .seg-btn:hover {
    color: var(--color-ink);
  }
  .seg-btn.seg-active {
    color: var(--color-amber);
    background: var(--color-sel);
  }
  .seg-btn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--color-amber);
  }

  /* ── footer ── */
  .cfoot {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid var(--color-line);
    background: var(--color-head);
  }
  .readiness {
    min-width: 0;
    font-size: var(--fs-meta);
    color: var(--color-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .readiness .r-ok {
    color: var(--color-green);
  }
  .readiness .r-blocked {
    color: var(--color-faint);
  }
  .run {
    margin-left: auto;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 18px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: var(--fs-meta);
    cursor: pointer;
    box-shadow: inset 0 0 18px -10px var(--color-amber);
  }
  .run span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    color: var(--color-faint);
    border-color: var(--color-line);
    box-shadow: none;
  }
  .run-dual {
    margin-left: auto;
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  .run-dual .run {
    margin-left: 0;
    flex-shrink: 1;
  }
  .run-anyway {
    border-color: var(--color-line-bright);
    color: var(--color-ink);
    box-shadow: none;
  }
  .run-anyway:not(:disabled):hover {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .kbd {
    flex-shrink: 0;
    font: inherit;
    font-size: var(--fs-micro);
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--color-amber);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    padding: 1px 5px;
    opacity: 0.75;
  }

  .card.dragging {
    border-color: var(--color-amber);
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }

  .relaunch-note {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    font-size: var(--fs-meta);
    color: var(--color-muted);
  }
  .issue-ref {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    font-size: var(--fs-meta);
  }
  .issue-assigned-notice {
    margin: -6px 0 0;
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-size: var(--fs-micro);
    color: color-mix(in oklab, var(--color-warn) 80%, var(--color-muted));
  }
  .issue-assigned-notice .glyph {
    flex-shrink: 0;
  }
  .issue-ref-label {
    flex-shrink: 0;
    font-size: var(--fs-micro);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--color-faint);
  }
  .issue-ref-link {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-amber);
    text-decoration: none;
  }
  .issue-ref-link:hover {
    text-decoration: underline;
  }
  .issue-ref-x {
    flex-shrink: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* ── mobile: full-height sheet, fixed header/footer, single middle scroller ── */
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      padding: 0;
    }
    .card {
      width: 100%;
      max-width: none;
      max-height: none;
      height: 100dvh;
      margin: 0;
      border: 0;
    }
    .bracket::before,
    .bracket::after {
      display: none;
    }
    .chead {
      min-height: 44px;
      box-sizing: border-box;
      padding: 8px 6px 8px 16px;
    }
    .chead-title {
      display: none;
    }
    .ctx-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 80vw;
      border: 1px solid var(--color-line);
      background: var(--color-panel-2);
      border-radius: 2px;
      padding: 6px 10px;
      font: inherit;
      font-size: var(--fs-base);
      color: var(--color-ink-bright);
      cursor: pointer;
    }
    .ctx-chip b {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ctx-chip .ctx-branch {
      color: var(--color-faint);
      font-size: var(--fs-meta);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .x {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      font-size: var(--fs-lg);
    }
    .cbody {
      display: flex;
      min-height: 0;
      flex: 1;
    }
    .left {
      flex: 1;
      border-right: 0;
      padding: 12px 16px;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    /* Hero fills the remaining height; 16px text prevents iOS zoom. */
    .prompt-block {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .hero {
      flex: 1;
      min-height: 180px;
    }
    .prompt-wrap {
      flex: 1;
      min-height: 0;
    }
    textarea {
      /* Full-height hero: the wrap flexes, the textarea fills it. 16px comes from
         the global iOS no-zoom guard in app.css; restated for the geometry tests. */
      height: 100%;
      min-height: 120px;
      max-height: none;
      font-size: var(--fs-lg);
      line-height: 1.45;
      -webkit-overflow-scrolling: touch;
    }
    .toolbar {
      padding: 8px;
    }
    .tool-btn {
      width: 44px;
      height: 44px;
    }
    .toolbar :global(.micbtn.inline) {
      width: 44px;
      height: 44px;
    }
    .toolbar :global(.micbtn.inline svg) {
      width: var(--icon-btn-glyph);
      height: var(--icon-btn-glyph);
    }
    .char-count {
      font-size: var(--fs-meta);
    }
    .seg-btn {
      min-height: 44px;
      font-size: var(--fs-meta);
      letter-spacing: 0.1em;
    }
    .engine-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      box-sizing: border-box;
      padding: 12px;
      border: 1px solid var(--color-line);
      border-radius: 2px;
      background: var(--color-panel-2);
      font: inherit;
      cursor: pointer;
      text-align: left;
    }
    .es-label {
      flex-shrink: 0;
      font-size: var(--fs-micro);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .es-value {
      min-width: 0;
      font-size: var(--fs-meta);
      color: var(--color-ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .es-gate {
      color: var(--color-faint);
    }
    .es-gate.on {
      color: var(--color-amber);
    }
    .engine-summary .chev {
      margin-left: auto;
    }
    .cfoot {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 10px 16px calc(10px + env(safe-area-inset-bottom));
    }
    .readiness {
      white-space: normal;
    }
    .run,
    .run-dual .run {
      margin-left: 0;
      min-height: 44px;
      width: 100%;
      font-size: var(--fs-meta);
    }
    .run-dual {
      margin-left: 0;
      flex-direction: column;
    }
    .ctx-sheet {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ctx-sheet .ctx-branch-select {
      background: var(--color-inset);
      border: 1px solid var(--color-line);
      color: var(--color-ink-bright);
      font: inherit;
      font-size: var(--fs-lg);
      padding: 8px 10px;
      border-radius: 2px;
      min-height: 44px;
      width: 100%;
      box-sizing: border-box;
    }
  }
</style>
