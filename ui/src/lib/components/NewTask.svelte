<script lang="ts">
  import { onMount } from "svelte";
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
  import { promoDefaultModel } from "$lib/fable-promo";
  import {
    matchSlashTrigger,
    filterCommands,
    applyCommandPick,
    applyMentionPick,
    commandInvocation,
    commandInvocationName,
    commandProviders,
  } from "$lib/slash";
  import RepoSelect from "./RepoSelect.svelte";
  import PromptSources from "./PromptSources.svelte";
  import SlashCommandMenu from "./SlashCommandMenu.svelte";
  import MicButton from "./MicButton.svelte";
  import BaseRepairNotice from "./new-task/BaseRepairNotice.svelte";
  import AttachmentChip from "./new-task/AttachmentChip.svelte";
  import NewTaskRunSettings from "./new-task/NewTaskRunSettings.svelte";
  import FirstTaskAutomationConfirm from "./FirstTaskAutomationConfirm.svelte";
  import { dialog } from "$lib/a11yDialog";
  import { repoConfig } from "$lib/reviews.svelte";
  import { coachTarget } from "$lib/actions/coachTarget.svelte";
  import { m } from "$lib/paraglide/messages";
  import { recentRepos } from "$lib/recentRepos";
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

  // Picker preselect precedence: explicit initialModel (e.g. the "Try Fable" CTA) wins;
  // else the selected repo's default-model override; else the operator's global default
  // if it's an explicit model; else the fresh client promo (configured "auto", or
  // settings not yet loaded). NewTask remounts per open, so the promo cutoff is honored
  // fresh each open. `modelTouched` pins a manual pick so switching repos / a late repo
  // config load doesn't clobber it.
  function preselectModel(configured: string | undefined, provider: AgentProvider): string {
    const pick =
      configured && configured !== "auto"
        ? configured
        : provider === "claude"
          ? promoDefaultModel()
          : "default";
    return pick === "fable" && !fableAvailable ? "default" : pick;
  }
  // reads initialModel/fableAvailable once to compute the picker's seed (see preselectModel
  // above); intentionally non-reactive — a one-shot value, not tracked
  // svelte-ignore state_referenced_locally
  const safeInitial = initialModel === "fable" && !fableAvailable ? "default" : initialModel;
  // seeds the model picker once; the $effect below re-derives it from the repo/global default
  // until the user picks one (modelTouched) — initial-value capture is intended here
  // svelte-ignore state_referenced_locally
  let model = $state(
    safeInitial ??
      preselectModel(
        agentProvider === "codex" ? (defaultCodexModel ?? "gpt-5.5") : defaultModel,
        agentProvider,
      ),
  );
  let modelTouched = $state(false);

  // Effort picker preselect: a settings SETTING ("default" | <tier>) maps to a picker value; the
  // repo override → global default is resolved by the $effect below. "default"/"inherit"/absent →
  // "default" (no flag). `effortTouched` pins a manual pick across repo/config changes.
  function preselectEffort(setting: string | undefined): string {
    return setting && setting !== "default" && setting !== "inherit" ? setting : "default";
  }
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
  // A seeded concrete value (editing a held task with an explicit override) pre-pins it;
  // a null seed (inherit) leaves it deriving from the repo default.
  // svelte-ignore state_referenced_locally
  let planGate = $state(initialPlanGate ?? false);
  // svelte-ignore state_referenced_locally
  let planGateTouched = $state(initialPlanGate != null);
  // Autopilot override: defaults to the selected repo's stored flag until the user
  // toggles it. `autopilotTouched` pins a manual choice so switching repos doesn't
  // clobber it. Lets a single task opt out of "drive autonomously to a PR" — e.g. to
  // discuss/iterate and approve each step yourself — without changing the repo default.
  // svelte-ignore state_referenced_locally
  let autopilot = $state(initialAutopilot ?? false);
  // svelte-ignore state_referenced_locally
  let autopilotTouched = $state(initialAutopilot != null);
  // Research task kind: web research → report PR or issue; mutually exclusive w/ plan-gate.
  // svelte-ignore state_referenced_locally
  let research = $state(initialResearch);
  // Epic-authoring task kind (issue #1507): guided shaping → EPIC draft; mutually exclusive w/ research.
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
  // Carries the `force` flag (e.g. "Submit anyway" past a usage hold) across the confirm
  // step so confirming a first-task repo replays the original intent, not a downgraded force=false.
  let pendingForce = $state(false);

  function reason(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message.trim() : "";
    return msg || fallback;
  }
  let repos = $state<RepoEntry[]>([]);
  // Day count the server computed recentAgentCount over; drives the picker's label.
  // 0 until listRepos() resolves — the recents group (and its label) only render
  // once repo data has loaded, which sets this from the server in the same step,
  // so the sentinel is never shown and there's no duplicated window literal.
  let recentRepoWindowDays = $state(0);
  // Echoed on the submit button so the destination repo is visible at commit time.
  const selectedRepoName = $derived(repos.find((r) => r.path === repoPath)?.name ?? "");
  let branches = $state<string[]>([]);
  // The base selected by pickBaseBranch (the repo default / origin/HEAD) need not be a
  // LOCAL branch — a fresh clone may have `dev` only as `origin/dev`. Surface it as an
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
  // Coarse pointer = touch-primary device with no hardware Ctrl/⌘/⌥ keys: hide
  // keyboard-combo hints it can't fulfil (submit shortcut badge + repo shortcuts).
  const coarse = new MediaQuery("(pointer: coarse)");

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
        // Prefer the most-recently-used NON-hidden repo so the picker never opens
        // pre-selected on a hidden repo; if every repo is hidden, fall back to the full
        // list so repoPath is never left empty.
        if (!repoPath && r.length > 0)
          repoPath = defaultRepoPath(r.filter((repo) => !repo.hidden)) || r[0]!.path;
      })
      .catch(() => {});
    // Focus the prompt so the user can type immediately when the dialog opens.
    // Move the caret to the end so a seeded initialPrompt stays editable inline.
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
  // stale-request guard so in-flight requests from a previous (repo, branch) pair
  // are silently dropped.
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

  // Seed the plan-gate checkbox from the selected repo's stored default. ensure()
  // fetches+caches the repo config; the derived default below tracks the cached
  // flag and re-seeds the checkbox on repo change unless the user has toggled it.
  $effect(() => {
    if (repoPath) repoConfig.ensure(repoPath);
  });
  const planGateDefault = $derived(repoPath ? repoConfig.isPlanGateEnabled(repoPath) : false);
  // While the repo's config fetch is still in flight (and the user hasn't toggled),
  // the checkbox would read "off" even for a gate-ON repo. Disable + hint until it
  // settles; a failed fetch still settles, so the box never wedges disabled.
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

  // Plan-gate is available for Codex (TASK-413): the gate directive rides inline on the Codex
  // spawn prompt, and the detection/review/release loop is CLI-agnostic. The checkbox is live for
  // both providers (see NewTaskRunSettings) and the choice flows through planGateFlag. Autopilot is
  // likewise available for isolated Codex sessions (#1140) via automationFlag.

  // Effective default model = repo override (if not "inherit") → global default → promo.
  // Re-seeds the picker when the repo config loads / the repo changes, unless an explicit
  // initialModel (CTA) pinned it or the user already picked a model by hand.
  const repoModelOverride = $derived(repoPath ? repoConfig.defaultModelFor(repoPath) : "inherit");
  const providerModelSetting = $derived(
    agentProvider === "codex" ? (defaultCodexModel ?? "gpt-5.5") : (defaultModel ?? "auto"),
  );
  const effectiveModelSetting = $derived(
    repoModelOverride !== "inherit" &&
      (repoModelOverride === "auto" ||
        repoModelOverride === "default" ||
        MODELS_BY_PROVIDER[agentProvider].includes(repoModelOverride))
      ? repoModelOverride
      : providerModelSetting,
  );
  const providerDefaultModel = $derived(preselectModel(effectiveModelSetting, agentProvider));
  $effect(() => {
    if (initialModel == null && !modelTouched) model = providerDefaultModel;
  });

  // Effort mirrors the model re-seed: repo override (unless "inherit") → global default effort.
  const repoEffortOverride = $derived(repoPath ? repoConfig.defaultEffortFor(repoPath) : "inherit");
  const effectiveEffortSetting = $derived(
    repoEffortOverride !== "inherit" ? repoEffortOverride : (defaultEffort ?? "default"),
  );
  $effect(() => {
    if (initialEffort == null && !effortTouched) effort = preselectEffort(effectiveEffortSetting);
  });

  // (re)load the slash-command list when the target repo changes — a repo's own
  // .claude/commands + .claude/skills layer on top of the global/user/plugin ones.
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

  // Epic-parent tracking issues for the selected repo. The issue picker shows them
  // disabled (picking one as a manual task collides with the Epic Runner — epics
  // launch via the epic panel's Start control instead).
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

  // Cmd/Ctrl+V of a screenshot: upload any image on the clipboard. A plain-text
  // paste carries no image item, so handleImagePaste leaves it alone.
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
    if (!prompt.trim()) {
      prompt = issueTemplate(issue);
      queueMicrotask(autogrow);
    }
  }

  // Inject an issue-scoped steer from PromptSources' per-row context menu: attach the
  // issue and APPEND the steer's text to the prompt. This matches the backlog
  // quick-launch payload but does NOT spawn — the dialog stays open for review/edit.
  // On an empty prompt we set it to the steer text alone (no `#N title` template,
  // unlike pickIssue): the steer text IS the intended prompt and the issue rides
  // out-of-band via issueRef, so a title line would be redundant.
  function injectSteer(issue: Issue, steer: Steer) {
    issueRef = issue;
    const t = steer.text;
    prompt = prompt.trim() ? `${prompt}\n${t}` : t;
    queueMicrotask(() => {
      autogrow();
      promptInput?.focus();
      promptInput?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  // Grow the prompt with its content (capped by CSS max-height, then it scrolls).
  // iOS Safari has no usable resize handle, so auto-grow is how the field gets bigger.
  function autogrow() {
    if (!promptInput) return;
    promptInput.style.height = "auto";
    promptInput.style.height = `${promptInput.scrollHeight}px`;
  }

  // Open/refresh the slash menu from the caret position, or close it when the text
  // before the caret is no longer a leading `/token`.
  function refreshSlash() {
    const caret = promptInput?.selectionStart ?? prompt.length;
    const trigger = matchSlashTrigger(prompt, caret);
    if (trigger) {
      slashOpen = true;
      slashQuery = trigger.query;
      slashTrigger = trigger.trigger;
      slashIndex = 0;
    } else {
      slashOpen = false;
    }
  }

  function onPromptInput() {
    autogrow();
    pruneProviderConstraints(prompt);
    refreshSlash();
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

  // Replace the typed `/query` token with the chosen command and hoist it to the
  // front of the prompt — Claude only runs a *leading* slash command, so a command
  // typed mid-text becomes the leading command with the surrounding text as its
  // argument. Caret lands past `/name ` so the user can type arguments straight away.
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

  // Cmd/Ctrl+Enter submits (plain Enter inserts a newline). While the slash menu is
  // open it captures the navigation keys so arrows/Enter/Tab drive the picker.
  function onPromptKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit(e);
      return;
    }
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashIndex = (slashIndex + 1) % slashMatches.length;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length;
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCommand(slashMatches[slashIndex]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        slashOpen = false;
      }
    } else if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      slashOpen = false;
    }
  }

  function selectRepo(path: string) {
    repoPath = path;
    queueMicrotask(() => promptInput?.focus());
  }

  function cycleRepo(dir: 1 | -1) {
    // Cycle only the non-hidden subset so Alt+[/] can never surface a hidden repo in the
    // trigger label. If the current repo is hidden (cur === -1) we enter the visible subset.
    const list = repos.filter((r) => !r.hidden);
    const n = list.length;
    if (n === 0) return;
    const cur = list.findIndex((r) => r.path === repoPath);
    // Current repo hidden (cur === -1): enter the visible subset at its boundary — the
    // first repo on a forward step, the last on a backward step — so neither end is skipped.
    if (cur === -1) {
      repoPath = list[dir === 1 ? 0 : n - 1]!.path;
      return;
    }
    repoPath = list[(cur + dir + n) % n]!.path;
  }

  // Alt-tier repo switchers, keyed on physical e.code so they work on any layout
  // (DE brackets need AltGr; macOS Option+key types glyphs) and while the prompt
  // textarea holds focus — keydown bubbles from the textarea to the dialog <form>.
  // Mirrors +page.svelte's handleAltCombo guard. Matched combos are swallowed
  // (preventDefault + stopPropagation) so no browser default fires and no glyph is
  // inserted into the prompt; the global Alt tier is already dormant while a modal
  // is open (anyOverlayOpen), so stopPropagation is belt-and-suspenders.
  function onRepoShortcut(e: KeyboardEvent) {
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
        // picker's pinned recents group exactly (shared single source of truth).
        const target = recentRepos(repos.filter((r) => !r.hidden))[Number(e.code.slice(5)) - 1];
        if (target) repoPath = target.path; // out of range → no selection change
        break; // still swallow the chord below
      }
      case "KeyR":
        repoSelect?.openPanel();
        break;
      default:
        return; // not ours — let it through untouched
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // Per-task autopilot flag at submit: send the user's manual choice, or null to inherit
  // the repo default — for both providers. Codex autopilot is best-effort/Alpha and the
  // server stands it down for non-isolated sessions (see AutopilotBadge for the surfacing).
  function automationFlag(touched: boolean, value: boolean): boolean | null {
    return touched ? value : null;
  }

  // Plan-gate now flows for both providers (TASK-413): Codex receives the gate directive inline
  // on its spawn prompt (Codex has no --append-system-prompt), and the detection/review/release
  // machinery is CLI-agnostic. A manual choice rides; otherwise null inherits the repo default.
  function planGateFlag(touched: boolean, value: boolean): boolean | null {
    return touched ? value : null;
  }

  async function doSpawn(force = false) {
    submitting = true;
    error = null;
    retry = null;
    const finalPrompt = prompt.trim();
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
        issueRef: issueRef
          ? {
              number: issueRef.number,
              url: issueRef.url,
              title: issueRef.title,
              body: issueRef.body,
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
        // The page maps relaunch ApiError codes to localized messages before
        // throwing; render that verbatim, falling back to a generic relaunch error.
        error = reason(err, m.relaunch_failed());
        retry = () => doSpawn(force);
      } else {
        error = m.newtask_create_failed({ reason: reason(err, m.newtask_submit()) });
        retry = () => doSpawn(force);
      }
    } finally {
      // Clear submitting on every path. This only matters for the error path, where the
      // dialog stays open showing the error and the buttons must re-enable for a retry;
      // the success and held paths both close the dialog page-side, so it's harmless there.
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
    if (!prompt.trim() || !repoPath.trim() || submitting || repairingBase || baseMissing) return;
    // A mid-recording submit sends the prompt as it stands: stop the mic and discard the
    // clip so nothing is uploaded while (or after) the task spawns. Closing the dialog is
    // covered by MicButton's own unmount teardown.
    mic?.teardown();
    const repo = repoPath.trim();
    // Settle the repo config BEFORE reading confirm/rowExists — an in-flight fetch reads both falsy,
    // which would spuriously show the step for a confirmed repo AND fail the !rowExists seed guard,
    // clobbering an existing repo's plan-gate. ensure() is idempotent + populates the maps before it
    // resolves. (Same settledness concern the inline plan-gate box handles via isConfigSettled.)
    // Only act on confirmed/rowExists when the fetch SUCCEEDED. On a transient GET failure
    // ensure() leaves those maps unset (both read falsy), which would misdetect an existing
    // confirmed repo as new — showing a spurious confirm step AND seeding planGateEnabled:true
    // over a deliberate planGate=off. On failure we can't know the repo's state, so degrade to
    // the prior behavior (spawn directly); the gate re-fires next task once the fetch lands.
    const configLoaded = await repoConfig.ensure(repo);
    // Editing a held task isn't a create — skip the brand-new-repo automation-confirm
    // interstitial (and its default-seeding side effects); just persist the edit.
    if (
      !editHeld &&
      agentProvider === "claude" &&
      configLoaded &&
      !repoConfig.isAutomationConfirmed(repo)
    ) {
      // Brand-new repo (no row) → seed the raised default posture (plan-gate ON) so the embedded
      // settings show it. Guarded by !automationRowExists so we never clobber an existing repo's toggles.
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
    // doSpawn sets submitting=true at entry and resets it in its finally; since we
    // already set it true above, doSpawn must NOT bail on the guard — it sets it
    // unconditionally at entry so there is no double-true problem.
    await doSpawn(pendingForce); // replay the force captured when the step opened
  }
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
       on it is valid ARIA (a dialog whose content is a form). Svelte's
       non-interactive→interactive-role heuristic flags <form>, so silence just
       that one rule here. -->
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
    onkeydown={onRepoShortcut}
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
      <span class="micro heading">{heading}</span>
      <!-- Phone-only: the REPO label rides up into the head row so it shares the
           44px line with the ✕ instead of leaving an empty band above it. Hidden
           on desktop, where the stacked label in .repo-field shows instead. -->
      <label class="micro chead-repo" for="nt-repo">{m.newtask_repo_label()}</label>
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
      <div class="repo-field" use:coachTarget={"nt-repo"}>
        <label class="micro" for="nt-repo">{m.newtask_repo_label()}</label>
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

      {#if !coarse.current}
        <span class="hint repo-shortcuts-hint">
          {m.newtask_repo_shortcuts_hint({ mod: isMac ? "⌥" : "Alt+" })}
        </span>
      {/if}

      {#if relaunch}
        <div class="relaunch-note">
          <span>{m.newtask_relaunch_note()}</span>
          {#if relaunchIssueNumber != null && repoPath !== initialRepoPath}
            <span>{m.newtask_relaunch_issue_drop_note({ number: relaunchIssueNumber })}</span>
          {/if}
        </div>
      {/if}

      <label class="micro" for="nt-prompt">{m.newtask_prompt_label()}</label>
      <div class="prompt-wrap">
        <textarea
          id="nt-prompt"
          bind:this={promptInput}
          bind:value={prompt}
          data-1p-ignore
          rows="3"
          placeholder={m.newtask_prompt_placeholder()}
          oninput={onPromptInput}
          onkeydown={onPromptKeydown}
          onblur={() => (slashOpen = false)}
          required></textarea>
        <!-- Dictation mic (Web Speech / voice-whisper plugin): floats in the textarea's
             bottom-right corner via its own zero-height anchor, writes the live preview and
             final transcript into `prompt`. Hidden when neither engine is available. -->
        <MicButton
          bind:this={mic}
          getText={() => prompt}
          setText={(t) => (prompt = t)}
          onTextRendered={autogrow}
        />
        {#if slashOpen}
          <SlashCommandMenu
            commands={slashMatches}
            activeIndex={slashIndex}
            provider={commandProvider}
            onpick={pickCommand}
            onhover={(i) => (slashIndex = i)}
          />
        {/if}
      </div>
      <div class="attach-row">
        <button
          type="button"
          class="attach"
          onclick={() => fileInput?.click()}
          disabled={uploading}
        >
          {uploading ? m.newtask_uploading() : m.newtask_attach_image()}
        </button>
        <span class="hint">
          {coarse.current
            ? m.newtask_drop_hint()
            : m.newtask_drop_hint_keyboard({ shortcut: isMac ? "⌘V" : "Ctrl+V" })}
        </span>
      </div>
      {#if relaunch}
        <span class="hint attach-relaunch-note">{m.newtask_relaunch_image_note()}</span>
      {/if}
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
      {#if images.length > 0}
        <div class="chips">
          {#each images as img (img.path)}
            <AttachmentChip
              name={img.name}
              previewFile={img.previewFile}
              coarse={coarse.current}
              onremove={() => removeUpload(img.path)}
            />
          {/each}
        </div>
      {/if}

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
            onclick={() => (issueRef = null)}
            aria-label={m.newtask_issue_remove_aria()}>✕</button
          >
        </div>
      {/if}

      {#if repoPath}
        <PromptSources
          {repoPath}
          {epicParents}
          {nativeSubIssues}
          {epicsLoaded}
          {agentProvider}
          allowIssues={!relaunch}
          onpick={(p) => {
            prompt = p;
            // resize, then land focus + caret at the end so a seeded command like
            // "/merge-train " is immediately editable for args
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

      <label class="micro" for="nt-base">{m.newtask_branch_label()}</label>
      {#if branches.length > 0}
        <select id="nt-base" bind:value={baseBranch}>
          {#each baseOptions as b (b)}
            <option value={b}>{b}</option>
          {/each}
        </select>
      {:else}
        <input id="nt-base" bind:value={baseBranch} placeholder={m.newtask_branch_placeholder()} />
      {/if}
      {#if upstreamLoading}
        <span class="nt-upstream micro">{m.newtask_upstream_checking()}</span>
      {:else if upstream?.diverged}
        <span class="nt-upstream micro nt-upstream-warn">
          {m.newtask_upstream_diverged({
            behind: upstream.behind,
            ahead: upstream.ahead,
            base: baseBranch,
          })}
        </span>
      {:else if upstream && upstream.behind > 0}
        <span class="nt-upstream micro"
          >{m.newtask_upstream_behind({ count: upstream.behind })}</span
        >
      {:else if baseMissing}
        <BaseRepairNotice repairing={repairingBase} onrepair={repairInitialCommit} />
      {/if}

      <NewTaskRunSettings
        bind:planGate
        bind:research
        bind:epicAuthoring
        bind:autopilot
        bind:agentProvider
        bind:model
        bind:effort
        bind:sandboxProfile
        {holdLikely}
        onPlanGateTouched={() => (planGateTouched = true)}
        onAutopilotTouched={() => (autopilotTouched = true)}
        onModelTouched={() => (modelTouched = true)}
        onEffortTouched={() => (effortTouched = true)}
        {planGateLoading}
        {autopilotLoading}
        {autopilotDefault}
        {repoPath}
        {usageLimits}
        {relaunch}
        {fableAvailable}
        {providerDefaultModel}
        providerConstraint={activeProviderConstraint}
      />

      {#if error}
        <div class="err" role="alert">
          <span>{error}</span>
          {#if retry}
            <button type="button" class="retry" onclick={() => retry?.()}>{m.common_retry()}</button
            >
          {/if}
        </div>
      {/if}

      {#if holdLikely && agentProvider === "claude"}
        <div class="run-dual">
          <button
            class="run run-hold"
            type="button"
            disabled={submitting || repairingBase || baseMissing}
            onclick={(e) => submit(e, false)}
          >
            <span>{submitting ? m.newtask_spawning() : m.newtask_hold_for_reset()}</span>
          </button>
          <button
            class="run run-anyway"
            type="button"
            disabled={submitting || repairingBase || baseMissing}
            onclick={(e) => submit(e, true)}
          >
            <span>{m.newtask_submit_anyway()}</span>
          </button>
        </div>
      {:else}
        <button
          class="run"
          type="submit"
          disabled={submitting || repairingBase || baseMissing}
          title={coarse.current ? undefined : isMac ? "⌘ + Enter" : "Ctrl + Enter"}
        >
          <span
            >{editHeld
              ? submitting
                ? m.newtask_edit_held_saving()
                : m.newtask_edit_held_submit()
              : submitting
                ? m.newtask_spawning()
                : selectedRepoName
                  ? m.newtask_submit_in_repo({ repo: selectedRepoName })
                  : m.newtask_submit()}</span
          >
          {#if !submitting && !coarse.current}
            <kbd class="kbd">{isMac ? "⌘↵" : "Ctrl+↵"}</kbd>
          {/if}
        </button>
      {/if}
    </div>
  </form>
</div>

<style>
  /* Boxless wrapper for the compose body — display:contents passes flex layout
     straight through to children so the card's column gap is undisturbed. */
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
    /* Scroll (not center-clip) when the card outgrows the viewport, so a long
       auto-grown prompt can never push the Run button out of reach. Centering
       is done by the card's `margin: auto` rather than align/justify-center:
       auto margins center when there's room yet still let an over-tall card
       scroll, sidestepping the flexbox "can't scroll to the top" bug. */
    overflow-y: auto;
    padding: 24px;
    box-sizing: border-box;
    z-index: 20;
  }
  .card {
    position: relative;
    margin: auto;
    width: min(760px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .repo-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
  .chead {
    display: flex;
    align-items: center;
    margin-bottom: 8px;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  /* Phone-only label; the desktop head carries the "New Task" title instead. */
  .chead-repo {
    display: none;
  }
  .micro {
    font-size: var(--fs-meta);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-top: 6px;
  }
  .nt-upstream {
    display: block;
    margin-top: 4px;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--fs-micro);
    color: var(--color-muted);
  }
  .nt-upstream-warn {
    /* Warn (caution) — the diverged base is a heads-up: not an error (red) and not running (amber); more honest than informational blue for "task will start from local". */
    color: var(--status-warn);
  }
  .prompt-wrap {
    position: relative;
  }
  /* Reserve the mic's corner only while it is rendered (no engine → no dead padding),
     so typed text never runs under the floating mic button. */
  .prompt-wrap:has(:global(.micbtn-anchor)) textarea {
    padding-right: 58px;
  }
  textarea,
  input,
  select {
    background: var(--color-inset);
    border: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font: inherit;
    font-size: var(--fs-base);
    padding: 8px 10px;
    border-radius: 2px;
    width: 100%;
    box-sizing: border-box;
  }
  textarea {
    /* JS auto-grows the height with content; cap it here and then scroll,
       so a long prompt never pushes the rest of the form off-screen.
       No native resize handle — iOS Safari doesn't render it reliably. */
    resize: none;
    max-height: 50vh;
    overflow-y: auto;
  }
  select {
    appearance: none;
    cursor: pointer;
  }
  textarea:focus,
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--color-line-bright);
  }
  .err {
    color: var(--color-red);
    font-size: var(--fs-meta);
    margin-top: 6px;
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
  .run {
    margin-top: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
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
  /* Dual-submit row shown when a hold is likely */
  .run-dual {
    margin-top: 12px;
    display: flex;
    gap: 8px;
  }
  .run-dual .run {
    margin-top: 0;
    flex: 1;
  }
  /* "Hold for reset" is the primary (amber, full glow) */
  .run-hold {
    flex: 2 !important;
  }
  /* "Submit anyway" is the secondary (muted, no glow) */
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

  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
      /* Full-bleed sheet: drop the desktop breathing-room padding so the
         100dvh card fills the screen edge-to-edge. */
      padding: 0;
    }
    .card {
      width: 100%;
      max-width: none;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
      animation: sheet-up 0.18s ease-out;
    }
    /* 16px no-zoom font-size for textarea/input/select comes from the global
       iOS guard in app.css */
    input,
    select,
    .run {
      min-height: 44px;
    }
    /* Compact head on phones: the "New Task" title is redundant once the sheet
       is open (the placeholder makes the intent obvious), so drop it — but don't
       leave the 44px head row empty with the ✕ stranded over a band of dead
       space. Promote the REPO label into the row so REPO (left, a touch larger)
       and the close ✕ (right) share one line, with the repo dropdown directly
       below. The prompt label is likewise redundant against its placeholder. */
    .chead {
      margin-bottom: 6px;
      min-height: 44px;
    }
    .chead .heading {
      display: none;
    }
    .chead-repo {
      display: block;
      margin-top: 0;
      font-size: var(--fs-base);
    }
    .repo-field > .micro {
      display: none;
    }
    .x {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      margin-right: -10px; /* nudge the glyph toward the sheet edge */
      font-size: var(--fs-lg);
    }
    label[for="nt-prompt"] {
      display: none;
    }
    textarea {
      /* Inset like every other field (REPO/BRANCH/MODEL) so the border stays
         within the viewport. The earlier full-bleed breakout (negative margin +
         calc width) pushed the border past the edge and left the ✕ visually
         detached. Comfortable starting size; auto-grow takes it up to 40dvh,
         then scrolls. */
      min-height: 120px;
      max-height: 40dvh;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
  }

  @keyframes sheet-up {
    from {
      transform: translateY(12px);
      opacity: 0.6;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
  .card.dragging {
    border-color: var(--color-amber);
    box-shadow: inset 0 0 30px -16px var(--color-amber);
  }
  .attach-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }
  .attach {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink);
    font: inherit;
    font-size: var(--fs-meta);
    letter-spacing: 0.06em;
    padding: 6px 10px;
    border-radius: 2px;
    cursor: pointer;
  }
  .attach:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .hint {
    font-size: var(--fs-meta);
    line-height: 1.35;
    color: var(--color-muted);
  }
  .attach-row .hint {
    flex: 1 1 18ch;
    min-width: 0;
  }
  .repo-shortcuts-hint {
    display: block;
    margin-top: 4px;
  }
  /* keyboard-only affordance — irrelevant on the phone sheet (mobile-declutter) */
  @media (max-width: 768px) {
    .repo-shortcuts-hint {
      display: none;
    }
  }
  .attach-relaunch-note {
    display: block;
    margin-top: 4px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .relaunch-note {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 6px;
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
    margin-top: 6px;
    padding: 6px 8px;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    background: var(--color-inset);
    font-size: var(--fs-meta);
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
  @media (max-width: 768px) {
    .attach {
      min-height: 44px;
    }
  }
</style>
