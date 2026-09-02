import type { SandboxProfile } from "./sandbox";
import type { VisualBlock } from "./visual-blocks";
import type { ManualStep } from "./manual-steps";
import type { PromptBlockMeasure } from "./prompt-budget";

export type HerdrState = "idle" | "working" | "blocked" | "done" | "unknown";
export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";
/** Coarse liveness of a session's agent process, folded onto the `session:claude-alive` channel.
 *  `alive` = a live agent backs the pane. `husk` = the agent process is gone (a bare shell) but NOT
 *  a daemon-restart strand (e.g. a normal Codex between-turns exit at its own pane). `stranded` = a
 *  herdr-restored husk (the daemon restarted and re-created the pane; the agent needs reviving). */
export type LivenessState = "alive" | "husk" | "stranded";
export type SessionArchiveReason = "operator" | "merged" | "drain" | "relaunch";
export const AGENT_PROVIDERS = ["claude", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** Role a session plays in a comparison experiment: a `variant` is one of the same-prompt
 *  runs on a different model/CLI; the `comparison` session is the read-only agent that
 *  evaluates the variants' results. Sessions with no experiment carry `null`. */
export type ExperimentRole = "variant" | "comparison";

export interface Session {
  id: string;
  desig: string; // "TASK-07"
  name: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  branch: string | null; // null when cwd fallback
  worktreePath: string;
  isolated: boolean;
  herdrSession: string;
  herdrAgentId: string; // herdr terminal_id (attach target)
  claudeSessionId: string; // pinned via `claude --session-id`; "" for pre-feature sessions
  /** Provider-native session id for non-Claude providers — the Codex rollout UUID resumed via
   *  `codex resume <id>`. Best-effort cached (poller-seeded, refreshed on restore); "" / absent when
   *  unknown / not a Codex session. Optional like `agentProvider` so pre-existing rows + fixtures
   *  need no change. Provider-neutral field owned by #1175; #1087/#1160 consume it. */
  providerSessionId?: string;
  agentProvider?: AgentProvider;

  model: string | null; // selected CLI --model alias; null = provider default (no flag)
  effort: string | null; // reasoning-effort tier; null = provider default (no effort flag)
  readyToMerge: boolean; // manually-toggled "parked / done" flag; orthogonal to status
  /** Epoch ms when a launched merge train marked this PR-session as in-flight;
   *  null when not in a train. Transient: cleared on merge/close, train archive,
   *  or the TTL sweep. */
  mergingSince: number | null;
  /** Id of the merge-train session that owns this mark (clears the whole set when
   *  that session is archived). Null when not merging. */
  mergingTrainId: string | null;
  /** PR numbers selected by the merge train for this TRAIN session; null on non-train sessions. */
  mergeTrainPrs: number[] | null;
  /** The open-PR number observed when a PARTICIPANT session is marked "merging"; null otherwise. */
  mergingPrNumber: number | null;
  /** Autopilot opt-in: true/false override, or null to inherit the repo default. */
  autopilotEnabled: boolean | null;
  /** Count of auto-steers autopilot has spent on this session (runaway guard; reset on PR-open / operator reply). */
  autopilotStepCount: number;
  /** True when autopilot handed control back for a genuine question / step-cap. */
  autopilotPaused: boolean;
  /** True when autopilot judged the task done with a non-PR deliverable (research / issue
   *  creation / one-off answer) — a clean terminal "completed", distinct from a pause. */
  autopilotComplete: boolean;
  /** The classifier's 1–2 sentence hand-back summary — what the agent is waiting for (paused)
   *  or what it delivered (complete); null in neither state. */
  autopilotQuestion: string | null;
  /** Count of empty-completion re-prompts autopilot has spent on this session (gate runaway guard;
   *  reset on PR-open / operator reply, alongside autopilotStepCount). */
  completionRepromptCount: number;
  /** Plan-gate opt-in: true/false override, or null to inherit the repo default. */
  planGateEnabled: boolean | null;
  /** Plan-gate phase: "planning" (grill+review) → "executing" (gate passed); null = gate off. */
  planPhase: "planning" | "executing" | null;
  /** True for a research-kind task: web research → report PR or GitHub issue; never code-PR-steered. */
  research: boolean;
  /** True for an epic-authoring task: attended guided shaping → a reviewable EPIC draft; the agent
   *  writes no GitHub issues (the approve route materializes them). Suppresses the same directives as
   *  `research`. */
  epicAuthoring: boolean;
  /** True for an epic-landing-PR repair session: pushes directly to the epic integration branch and
   *  never opens a PR. */
  landingRepair: boolean;
  /** True for a clean-terminal session: a bare operator shell in the repo's MAIN checkout
   *  (pane-direct — no herdr agent, no worktree, no prompt). Fenced out of every agent-input
   *  and agent-lifecycle flow; its pane target lives in terminalTabId/terminalPaneId.
   *  OPTIONAL (like autoMergeRebaseSteeredAt above) so existing Session fixtures stay valid —
   *  absent and false are equivalent; the store always hydrates a real boolean. */
  terminal?: boolean;
  /** herdr tab hosting the clean-terminal shell; null/absent on non-terminal sessions.
   *  Decommission closes this tab directly (there is no agent to resolve it from). */
  terminalTabId?: string | null;
  /** herdr pane running the clean-terminal shell — the socket-transport attach target
   *  (`terminal session control <pane>`); null/absent on non-terminal sessions. */
  terminalPaneId?: string | null;
  /** Full-auto merge opt-in: true/false override, or null to inherit the repo default. */
  autoMergeEnabled: boolean | null;
  /** Consecutive auto-rebase attempts the merge train has spent on this session
   *  (runaway guard; reset on operator reply). */
  autoMergeRebaseCount: number;
  /** The head SHA the merge train last steered a rebase for; null when none outstanding.
   *  Guards against re-steering / re-bumping while a rebase for the same head is in flight. */
  autoMergeRebaseHead: string | null;
  /** Epoch ms of the last conflict-path rebase steer; null/absent when never steered.
   *  Drives the expiring dedup (automerge-core) and the CI-fix stand-down's ownership window.
   *  OPTIONAL so existing Session fixtures stay valid — absent and null are equivalent
   *  ("never steered" → dedup treated as expired), so every read uses `!= null`. */
  autoMergeRebaseSteeredAt?: number | null;
  /** True when this session was auto-spawned by the drain queue. */
  auto: boolean;
  /** Backlog issue number this session was spawned for; null for manual/non-issue sessions. */
  issueNumber: number | null;
  /** The epic PARENT issue number this session was spawned as a child of — the persisted answer to
   *  "is this an epic child?", stamped at spawn and never updated. Null/absent on every non-epic
   *  session AND on legacy rows written before the field existed, so the shared predicate
   *  ({@link isEpicChild}) falls back to the base-branch-name test for those. Read it through that
   *  predicate, never directly: a raw `epicParent != null` check would answer "no" for a legacy
   *  in-flight epic child. OPTIONAL (like `autoMergeRebaseSteeredAt`) so existing Session fixtures
   *  stay valid — absent and null are equivalent; the store always hydrates a real number|null. */
  epicParent?: number | null;
  /** Sandbox profile actually applied at spawn; null for legacy rows spawned before the feature. */
  sandboxApplied: SandboxProfile | null;
  /** True when a sandboxed profile was requested but no backend was available → ran unconfined. */
  sandboxDegraded: boolean;
  /** True when the egress firewall was actually applied at spawn (autonomous + backend present). */
  egressApplied: boolean;
  /** Autonomous requested but egress backend absent → ran FS-confined with open network. */
  egressDegraded: boolean;
  status: SessionStatus;
  lastState: HerdrState;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** How this session was completed; null for active and pre-feature archived rows. */
  archiveReason?: SessionArchiveReason | null;
  /** Reason the session halted mid-run; null when not halted. */
  haltReason: "usage_limit" | "completed" | "operator" | "error" | null;
  /** Epoch ms when haltReason was set; null when not halted. */
  haltedAt: number | null;
  /** Manual operator steps detected in this session's PR body (#1059); [] when none/undetected. */
  manualSteps: ManualStep[];
  /** Epoch ms the operator acknowledged the manual steps; null until acknowledged. Written by P2. */
  manualStepsAckedAt: number | null;
  /** Comparison-experiment group id this session belongs to; null = not part of an experiment.
   *  All variants of one task + their comparison session share this id. */
  experimentId: string | null;
  /** This session's role within its experiment; null when not in one. */
  experimentRole: ExperimentRole | null;
  /** terminalId of the pane Shepherd itself last spawned on the OWNING account (advances only
   *  on a verified spawn — see persistSpawnIdentity); null for a session with no verified spawn
   *  yet. Poller/reconcile-immune marker used to detect a herdr-restored pane. */
  spawnTerminalId: string | null;
  /** The owning account's CLAUDE_CONFIG_DIR (folded plugin credentialDir) as of the last verified
   *  spawn; null for the default / no-plugin / api-key session. Sticky: never overwritten to null
   *  once set (see persistSpawnIdentity) — a failed/wrong re-derivation can't silently self-clear
   *  onto the default account. */
  spawnAccountDir: string | null;
  /** Launch-time display metadata for the task-id tooltip. Null/absent for legacy rows. */
  launchMetadata?: SessionLaunchMetadata | null;
}

/**
 * One manual operator step frozen into the durable post-merge materialization (#1061, epic #1056
 * P3): a {@link ManualStep} captured at merge plus a per-step `doneAt`. P2's ack is set-level (no
 * per-step done flag), so this is where ticking-off lives.
 */
export interface PostMergeStep {
  id: string;
  text: string;
  postMerge: boolean;
  /** Epoch ms the operator ticked this step done; null while still owed. */
  doneAt: number | null;
}

/**
 * Durable post-merge materialization of a merged session's outstanding manual operator steps
 * (#1061, epic #1056 P3). One row per merged session, kept in its own table that is DELIBERATELY
 * excluded from the archived-session prune cascade, so owed steps survive both teardown and the
 * prune window. Display fields are denormalized so the Owed panel still renders fully after the
 * underlying `sessions` row is pruned.
 */
export interface PostMergeSteps {
  sessionId: string;
  desig: string;
  repoPath: string;
  prNumber: number | null;
  prTitle: string;
  steps: PostMergeStep[];
  /** Tracking issue opened on merge when the repo opt-in is on; null otherwise. */
  trackingIssueUrl: string | null;
  trackingIssueNumber: number | null;
  createdAt: number;
  updatedAt: number;
  /** Stamped when every step is done OR the operator dismisses; null = still owed. */
  clearedAt: number | null;
}

/**
 * A GitHub/Gitea issue attached to a task by reference. The body rides along
 * out-of-band into the agent's prompt argv (like uploaded files) so it never counts
 * against the 8000-char human-prompt guard.
 */
export interface IssueRef {
  number: number;
  url: string;
  title: string;
  body: string;
}

export interface LaunchUiState {
  researchChecked: boolean;
  planGateChecked: boolean;
  autopilotChecked: boolean;
  /** "Create EPIC from research" toggle state at submit time; absent on legacy rows. */
  epicAuthoringChecked?: boolean;
}

export interface LaunchAttachmentMetadata {
  submittedName: string;
  launchedName: string | null;
  dropped: boolean;
  /** Internal join key for carried relaunch uploads. Never displayed to users. */
  storedName?: string | null;
}

export interface SessionLaunchMetadata {
  sourceKind: "user" | "generated";
  prompt: string;
  issue: { number: number; title: string; url: string } | null;
  attachments: LaunchAttachmentMetadata[];
  branch: { baseBranch: string; workBranch: string | null; sharedCheckout: boolean };
  uiState: LaunchUiState | null;
  submittedChoices: {
    planGateOverride: boolean | null;
    autopilotOverride: boolean | null;
    sandboxProfile: SandboxProfile | null;
    model: string | null;
    effort: string | null;
  };
  resolvedLaunch: {
    research: boolean;
    planGateOptIn: boolean;
    autopilotOptIn: boolean;
    storedModel: string | null;
    effort: string | null;
    sandboxApplied: SandboxProfile | null;
    sandboxDegraded: boolean;
    egressApplied: boolean;
    egressDegraded: boolean;
  };
  agent: { provider: AgentProvider; model: string | null; effort: string | null };
}

/**
 * Create input is a DISCRIMINATED UNION on `terminal` (issue: clean-terminal-in-main-repo).
 * The terminal arm deliberately has NO `prompt`/`baseBranch` members — a clean terminal is a
 * bare shell in the repo's main checkout, so those fields cannot even be referenced in its
 * create path (compile-time fence). The standard arm is byte-for-byte the pre-union shape;
 * existing constructors satisfy it unchanged.
 */
export type CreateSessionInput = StandardCreateInput | TerminalCreateInput;

/** A clean-terminal create: bare operator shell, pane-direct, main checkout. Nothing else. */
export interface TerminalCreateInput {
  terminal: true;
  repoPath: string;
}

export interface StandardCreateInput {
  /** Discriminant: absent/false = a normal agent session. */
  terminal?: false;
  repoPath: string;
  baseBranch: string;
  prompt: string;
  agentProvider?: AgentProvider;
  model: string | null; // null = provider default (no --model flag)
  effort?: string | null; // reasoning effort tier; null/absent = provider default (no effort flag)
  images: string[]; // absolute paths to staged attachments (may be empty)
  attachmentNames?: string[]; // display-only names, index-aligned with images
  issueRef?: IssueRef; // optional attached issue; body appended out-of-band
  launchUiState?: LaunchUiState; // visible New Task checkbox state at submit time
  /** True when this session is auto-spawned by the drain queue (default false). The
   *  persisted `issueNumber` is NOT an input here — the service derives it from
   *  `issueRef.number`, so an attached issue is mapped for drain dedupe automatically. */
  auto?: boolean;
  /** Per-task plan-gate override; absent → inherit repo default. */
  planGateEnabled?: boolean | null;
  /** Per-task autopilot override; absent/null → inherit repo default. */
  autopilotEnabled?: boolean | null;
  /** Per-spawn sandbox profile override; absent → inherit repo default. */
  sandboxProfile?: SandboxProfile | null;
  /** Epic PARENT issue number for an epic-child spawn; absent/null otherwise. Set ONLY by the
   *  drain's epic path (and only when the child actually got the integration branch as its base) —
   *  no HTTP route passes it, they all build this input field-by-field. Persisted verbatim as
   *  `Session.epicParent`. */
  epicParent?: number | null;
  /** Research task kind; absent → false. */
  research?: boolean;
  /** Epic-authoring task kind; absent → false. Attended guided shaping → EPIC draft, no code PR. */
  epicAuthoring?: boolean;
  /** Epic-landing-PR repair task kind; absent → false. */
  landingRepair?: boolean;
  /** PR numbers selected for this TRAIN session; absent → null. */
  mergeTrainPrs?: number[];
}

/**
 * Optional override bag applied over the original session on relaunch. Every field is
 * optional: an ABSENT field keeps the original's value, a PRESENT one (including an
 * explicit `null` for model, plan-gate, or Autopilot) replaces it. Lets a caller relaunch
 * into a different repo (`repoPath`) while carrying prompt/model/base-branch/uploads
 * forward; `images` are appended to the original's carried-over uploads. A bare relaunch
 * sends no body → no overrides → byte-for-byte the original quick-relaunch.
 */
export interface RelaunchOverrides {
  repoPath?: string;
  baseBranch?: string;
  prompt?: string;
  /** Agent CLI override; absent → keep the original's provider. Drives "restart with a
   *  different model/CLI" (variant + replace). When it changes the provider, `relaunch`
   *  resets a now-incompatible carried model to the provider default. */
  agentProvider?: AgentProvider;
  model?: string | null;
  /** Reasoning-effort override; absent → keep original, present (incl. `null`) → replace.
   *  When `agentProvider` changes, `relaunch` re-clamps a now-incompatible effort. */
  effort?: string | null;
  planGateEnabled?: boolean | null;
  /** Per-task Autopilot override; null → inherit the destination repo default. */
  autopilotEnabled?: boolean | null;
  images?: string[];
  attachmentNames?: string[];
  launchUiState?: LaunchUiState;
  /** Research task kind override; absent → keep original. */
  research?: boolean;
  /** Epic-authoring task kind override; absent → keep original. */
  epicAuthoring?: boolean;
  /** Epic-landing-PR repair task kind override; absent → keep original. */
  landingRepair?: boolean;
}

/** Selectable Claude model aliases; absent/"default" means no --model flag.
 *  Ordered most- to least-powerful so the picker leads with the top tier.
 *  The "[1m]" suffix is a valid `--model` value that enables Claude Code's
 *  1M-context-window beta (verified: it adds the context-1m beta header,
 *  whereas the bare alias does not); it passes straight through to --model
 *  with no mapping layer. Each 1M variant sits next to its 200K base.
 *
 *  Two KINDS of entry live here, and the difference is the point:
 *    - FLOATING aliases ("fable"/"opus"/"sonnet"/"haiku") resolve to whatever the
 *      installed CLI calls the latest model of that tier — `--model opus` reaches
 *      the API as `claude-opus-5` today, `--model fable` as `claude-fable-5-1`.
 *    - PINNED full model names ("claude-opus-5", "claude-fable-5-1") lock the exact
 *      version, so a future Opus or Fable release can't silently change a task's
 *      model. The short form `opus-5` is NOT a valid CLI value (it errors) — only
 *      the full name is.
 *  Both forms were probed against the pinned CLI: `claude-opus-5[1m]` sends wire
 *  model `claude-opus-5` with a beta set byte-identical to `opus[1m]`'s, i.e. it
 *  really does carry `context-1m-2025-08-07`. */
const CLAUDE_MODELS = [
  "fable",
  "claude-fable-5-1",
  "opus",
  "opus[1m]",
  "claude-opus-5",
  "claude-opus-5[1m]",
  "sonnet",
  "sonnet[1m]",
  "haiku",
] as const;

/** Back-compat alias used throughout the existing Claude default-model settings. */
export const MODELS = CLAUDE_MODELS;

/** Reasoning-effort tiers exposed in the picker, ordered least→most effort. The value space is
 *  the Claude `--effort` domain (verified against the pinned `claude` CLI). Codex accepts through
 *  `xhigh` across its available curated models; `max` is hidden and clamped at argv-build, while
 *  `minimal` (below `low`) is not exposed. `"default"` (settings) / `null` (session) = no flag. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Curated Codex CLI model aliases shown in the task dialog. The server accepts any safe Codex
 *  model alias because the installed Codex CLI may learn new names before Shepherd does. */
export const CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
  "gpt-5-codex",
  "gpt-5.1",
  "gpt-5",
  "o3",
] as const;

/** A safe Codex `--model` alias: the installed Codex CLI may learn new names before the curated
 *  CODEX_MODELS list does, so any conservative identifier is accepted. Single source of truth
 *  shared by the spawn-side check (service.ts) and the request validator (validate.ts). */
export const CODEX_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** The model alias list for each agent provider — the single source of truth the per-role
 *  environment picker (UI) and the server-side validation both read, so adding a provider or a
 *  model in one place flows everywhere. Keyed by AgentProvider. */
export const MODELS_BY_PROVIDER: Record<AgentProvider, readonly string[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
};
export interface Steer {
  id: string;
  label: string;
  text: string;
  /** Optional emoji shown on the chip/button; lets tight layouts collapse to icon-only. */
  emoji?: string;
  /** Surface as a chip in the session steer bar. */
  inSteerBar: boolean;
  /** Surface as a quick-action button on backlog issues (spawns a session with this prompt + the issue). */
  onIssues: boolean;
  /** Allowlist of repo NAMES this steer is bound to (the dir name listRepos enumerates
   *  under repoRoot). Empty/absent = universal (shows on every repo). */
  repos?: string[];
  /** Optional provider allowlist. Empty/absent = universal. */
  agentProviders?: AgentProvider[];
}

// ── git diff review panel ──────────────────────────────────────────────────
export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  content: string; // line text WITHOUT the leading +/-/space marker
  oldNo?: number; // 1-based line number on the old side (absent for adds)
  newNo?: number; // 1-based line number on the new side (absent for dels)
}

export interface DiffHunk {
  header: string; // the raw "@@ -a,b +c,d @@ …" line
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string; // new path ("/dev/null" side resolved away)
  oldPath?: string; // set only when renamed
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated?: boolean; // hunks dropped because the file exceeded the line cap
  hunks: DiffHunk[]; // empty when binary or truncated
  patch?: string; // raw git patch block for this file; session-endpoint only, omitted for binary/truncated
}

export interface DiffResult {
  base: string; // logical base branch, e.g. "main"
  baseRef: string; // ref actually diffed against, e.g. "origin/main" or "main"
  head: string | null; // session branch; null for non-isolated sessions
  fetchFailed: boolean; // true when `git fetch` failed and we fell back to local base
  truncated: boolean; // true when any file was truncated
  files: DiffFile[];
}

// ── herdr version update check (informational only) ─────────────────────────
export interface HerdrUpdateStatus {
  /** installed herdr version (from `herdr --version`); null if unknown */
  current: string | null;
  /** latest published version from herdr.dev; null on error */
  latest: string | null;
  /** true when latest > current; never true on error */
  updateAvailable: boolean;
  /** true when `latest` is a herdr version Shepherd does NOT support (newer than the supported
   *  ceiling, so agent spawning would fail). The in-app updater refuses to install it and the modal
   *  warns instead of offering the upgrade; operators must stay on a supported release. */
  latestUnsupported?: boolean;
  /** true when the INSTALLED herdr is one Shepherd cannot drive (stranded on 0.7.5+,
   *  #1898). The modal offers the in-app downgrade and the diagnostics hint becomes
   *  actionable. */
  currentUnsupported?: boolean;
  /** The version the in-app downgrade installs (the supported ceiling) when
   *  `currentUnsupported`; null otherwise. Derived server-side from
   *  HERDR_LAST_SUPPORTED_VERSION so the UI never hardcodes a version. */
  downgradeTarget?: string | null;
  /** true when the INSTALLED herdr has the sandboxed-agent idle-status regression (it uses the
   *  external-registration spawn path, 0.7.5+) AND this operator runs sandboxed sessions — so a
   *  resting sandboxed agent reads `working` (herdr issue #1716). NON-blocking: the modal shows an
   *  advisory + an optional downgrade to a regression-free version. Trusted sessions are unaffected,
   *  so it never sets for a trusted-only operator. */
  sandboxIdleRegressed?: boolean;
  /** The version the two-path advisory downgrades to (the last version with full sandboxed status
   *  fidelity, HERDR_LAST_FULL_SANDBOX_STATUS_VERSION) when `sandboxIdleRegressed`; null otherwise.
   *  Distinct from `downgradeTarget` (the supported ceiling) — this one steps BELOW it to escape the
   *  regression. */
  sandboxDowngradeTarget?: string | null;
  /** release notes (markdown-ish) for the latest version; null on error/none */
  notes: string | null;
  checkedAt: number;
  /** set when the check itself failed (binary missing / network); badge stays hidden */
  error?: string;
}

// ── codex CLI version update check (informational only) ─────────────────────
/** Same shape as {@link HerdrUpdateStatus}: the installed @openai/codex version
 *  vs the latest published on npm. `notes` is always null (the npm registry
 *  carries no changelog); kept for symmetry with the herdr/update modals. */
export interface CodexUpdateStatus {
  /** installed codex version (from `codex --version`); null if unknown */
  current: string | null;
  /** latest published version on npm; null on error */
  latest: string | null;
  /** true when latest > current; never true on error */
  updateAvailable: boolean;
  /** kept for shape-symmetry with HerdrUpdateStatus; always null for codex */
  notes: string | null;
  checkedAt: number;
  /** set when the check itself failed (binary missing / network); badge stays hidden */
  error?: string;
}

export interface CodexReleaseNote {
  version: string;
  body: string;
}

export interface CodexReleaseNotesResult {
  current: string | null;
  latest: string | null;
  notes: CodexReleaseNote[];
  complete: boolean;
}

// ── plugin update check (informational only) ────────────────────────────────
/** Per-plugin update state. `no-source` = nothing to compare against (not a git
 *  checkout and no declared repository, or a declared repository that publishes no
 *  version tags with no local checkout to fall back on); `incompatible` = a newer
 *  version exists but its apiVersion would be rejected at load; `error` = the check
 *  itself failed for this plugin (bad manifest version, unreachable remote, …). */
export type PluginUpdateState =
  "up-to-date" | "update-available" | "incompatible" | "no-source" | "error";

/** One installed plugin's update status. */
export interface PluginUpdateInfo {
  id: string;
  name: string;
  /** installed version from the folder's plugin.json */
  currentVersion: string;
  /** resolved latest version (upstream manifest, or highest remote tag); null when unknown */
  latestVersion: string | null;
  /** how the check resolved a source: declared `repository`, local `git` checkout, or `none` */
  source: "repository" | "git" | "none";
  state: PluginUpdateState;
  /** short human-readable reason for a no-source/incompatible/error state */
  detail?: string;
  /** How many commits the local git checkout is behind its upstream. Set ONLY when that
   *  drift is what makes this an update — i.e. the upstream shipped commits without
   *  bumping `version`, so `latestVersion === currentVersion`. A version-bump update
   *  leaves it unset, so the UI can pick the version wording over the commit wording. */
  behindCommits?: number;
}

/** Snapshot of every installed plugin's update state (informational; no apply). */
export interface PluginUpdatesStatus {
  plugins: PluginUpdateInfo[];
  /** true when at least one plugin is `update-available`; drives the badge */
  updateAvailable: boolean;
  checkedAt: number;
}

// ── environment-readiness diagnostics (issue #623) ──────────────────────────
/** State of a single dependency probe. `error` = the hard gate (missing /
 *  unauthenticated / unreachable); `warning` = advisory (e.g. below the version
 *  floor, or tailscale serve not configured); `optional` = not required because
 *  an equivalent alternative is healthy; `ok` = healthy. */
export type DiagnosticState = "ok" | "optional" | "warning" | "error";

/** One probe result. `hintKey` is a UI message-key STRING (e.g.
 *  "diagnostics_hint_herdr_missing") the client resolves through `m.*` — NEVER
 *  raw stdout, tokens, absolute paths, or account identity. */
export interface DiagnosticCheck {
  id: string;
  state: DiagnosticState;
  hintKey: string;
  /** A non-secret public install command (e.g. "curl -fsSL https://bun.sh/install | bash")
   *  the operator can one-click-run via POST /api/diagnostics/fix. Set ONLY on non-ok,
   *  auto-fixable checks (autoFixCommandFor resolved) — never on `ok` checks and never on
   *  guidance-only ones (tailscale). Still no stdout/tokens/paths/identity ever cross here. */
  remediation?: string;
  /** A path-free UI message-key naming a SERVER-SIDE code fix (e.g.
   *  "diagnostics_fix_action_claude_trust"), dispatched by `hintKey` in
   *  `DiagnosticsService.fix()`. Used when the fix needs a dynamic path that
   *  payload-purity bans from `remediation` (claude folder-trust seed). Mutually
   *  exclusive with `remediation`. Still a message key only — no path ever crosses. */
  fixActionKey?: string;
  /** Non-secret params for a `fixActionKey` code fix: interpolated into the confirm-modal message AND
   *  consumed server-side by `fix()` to apply exactly what was reviewed. Carries only host facts —
   *  unit names + RAM/CPU-derived limit strings (e.g. `{units:"shepherd.service herdr.service",
   *  memoryHigh:"27G", cpuQuota:"700%"}`, host_capacity #1839). NEVER tokens, absolute paths, or
   *  identity. `undefined` for param-less code fixes (claude folder-trust). */
  fixActionParams?: Record<string, string>;
  /** Non-secret params interpolated into the ROW's own `hintKey` message — the hint-side analogue
   *  of `fixActionParams` (claude_install #2052: two version triples, or a size + a build count).
   *  Same purity boundary: host facts only, never a token, absolute path, or identity. `undefined`
   *  for every param-less hint, which simply ignores the extra argument. */
  hintParams?: Record<string, string>;
}

/** The full diagnostics payload returned by GET /api/diagnostics and pushed on
 *  the `diagnostics:status` WS event. `overall` is worst-of across `checks`. */
export interface DiagnosticsSnapshot {
  checks: DiagnosticCheck[];
  generatedAt: number;
  overall: DiagnosticState;
}

// ── pre-execution plan gate ──────────────────────────────────────────────────
export type PlanDecision = "approved" | "changes_requested" | "error";

/** Sentinel for a server-authored plan-gate summary that must render per-locale in the UI (not
 *  baked English at write time). Only `error` verdicts carry one; every other summary is the
 *  reviewer's own operator-language text, passed through verbatim.
 *   - `no-verdict`       the reviewer ran but no usable verdict came back
 *   - `membrane-launch`  the reviewer NEVER RAN: its agent binary does not start inside the bwrap
 *                        membrane on this host, so the spawn was refused (issue #2111) */
export type PlanSummaryCode = "no-verdict" | "membrane-launch";

/** Resolved coding environment for one in-flight reviewer job. `provider` can be null only for
 *  legacy/restart-adopted runs whose durable spawn row predates provider persistence. */
export interface ReviewerEnv {
  provider: AgentProvider | null;
  model: string | null;
  effort: string | null;
}

/** Which transient-agent spawn a {@link SpawnNotice} describes. */
export type SpawnNoticeKind = "plan" | "review";

/** `clamped` — the spawn RAN, but its prompt was truncated to fit the OS argv budget, so the
 *  verdict was formed on less than the whole input. `failed` — the spawn was refused and never
 *  ran, so there is no verdict at all. */
export type SpawnNoticeSeverity = "clamped" | "failed";

/** Why a spawn was refused. `plan-unreviewable` is the deliberate one: fitting the budget would
 *  have left too little of the plan to review, and the issue's rule is that shipping a review
 *  without the plan is worse than refusing. */
export type SpawnNoticeReason = "over-budget" | "plan-unreviewable";

/** #1944: display-only sidecar for a transient-agent spawn that was clamped or refused. Never a
 *  gating row — see the `spawn_notices` table comment in src/store.ts for why a synthetic verdict
 *  in `plan_gates`/`reviews` would destroy in-flight findings. */
export interface SpawnNotice {
  sessionId: string;
  kind: SpawnNoticeKind;
  severity: SpawnNoticeSeverity;
  reason?: SpawnNoticeReason | null;
  /** Operator-facing detail: which blocks were clamped and by how much, or the overage. */
  detail: string;
  /** How many refusal steers the plan gate has spent — bounded by MAX_REFUSAL_STEERS. */
  steers: number;
  /** Suppression key for a deterministic FAILURE (planHash at the gate, headSha at the review);
   *  null for a `clamped` notice, which never suppresses anything. */
  inputKey?: string | null;
  updatedAt: number;
}

export interface PlanGate {
  sessionId: string;
  planHash: string; // sha256 of the reviewed plan text; dedups re-reviews of an unchanged plan on the auto-path (the manual force path bypasses that dedupe)
  decision: PlanDecision;
  summary: string; // <=100 char one-liner for the badge tooltip
  // Sentinel code for a server-authored summary (currently only `error` → "no-verdict"), rendered
  // per-locale in the UI instead of baking English into the row. When set, `summary` is "" and the
  // UI ignores it; absent (legacy/normal rows) → render `summary` verbatim. See src/plan-gate.ts.
  summaryCode?: PlanSummaryCode | null;
  body: string; // full markdown reviewer write-up
  findings: string[]; // discrete actionable items; [] = nothing to address
  round: number; // adversarial rounds spent on the current plan streak (0 = reset)
  cap: number; // the round cap this run used — surfaced so the UI badge need not mirror it
  approved: boolean; // load-bearing gate flag: execution allowed only when true
  plan: string; // snapshot of the reviewed plan text (surfaced in the UI panel)
  /** Resolved Plan Gate reviewer environment for the run that produced this verdict.
   *  Optional/null for legacy rows and restart-adopted reviews whose reviewer_spawns row predates
   *  provider/effort persistence. */
  reviewerProvider?: AgentProvider | null;
  reviewerModel?: string | null;
  reviewerEffort?: string | null;
  blocks?: VisualBlock[]; // optional typed visual plan blocks (model-authored, no diff-join); absent → flat markdown
  // Answered question-form questions, keyed `${blockId} ${questionId}` (#1332). Durable so the
  // "unanswered plan question" attention signal survives reconnect/restart. Reset to [] by
  // buildGate on every new planHash; the answer route appends resolved keys. A question whose
  // key is absent here is still pending (see planQuestionsUnanswered). Optional (like `blocks`):
  // absent ⇒ treated as [] by every consumer.
  answeredQuestionKeys?: string[];
  // cap-th steer just delivered while at/over the cap → the FINAL plan-rework round is in flight
  // (agent actively revising). Distinguishes the genuine final round from a post-cap re-review /
  // takeover (both leave round === cap); planStallStatus reads it. Absent ⇒ false. See src/plan-status.ts.
  finalRoundPending?: boolean;
  // Operator dismissed / took over this stalled rework. Display + attention consumers stop counting
  // this verdict as active rework (REWORK RUNNING / review banner / critic-rework signal). Reset to
  // false on any new verdict (buildGate) and on resume(). Absent ⇒ false.
  dismissed?: boolean;
  updatedAt: number;
}

// ── critic-on-PR review verdict ─────────────────────────────────────────────
export type ReviewDecision = "changes_requested" | "commented" | "error";

/** #2165 — how much a critic finding binds the author. `important` is the ONLY severity that
 *  reaches {@link ReviewVerdict.findings}, and therefore the only one that advances the streak,
 *  is auto-addressed, is re-raised, and blocks the merge train. `nit` is non-blocking: it is
 *  recorded, rendered into the posted review body, and never steered. */
export type FindingSeverity = "important" | "nit";

/** #2165 — the named review pass a finding came out of (the playbook's taxonomy). Classification
 *  only: nothing gates on it. `compliance` covers repo policy / house rules / catalog parity;
 *  `scope` covers "does not satisfy the task" and explicit-boundary violations. */
export type FindingPass = "bug" | "security" | "compliance" | "scope";

/** #2165 — one critic finding as the verdict declares it. `text` keeps the existing
 *  `<path>: <finding>` convention the scope backstop and the Diff tab parse, so severity is
 *  additive to it, never a replacement for it. */
export interface CriticFinding {
  text: string;
  severity: FindingSeverity;
  pass: FindingPass;
}

/** Why a critic run produced no usable verdict. A SERVER-authored reason, so it travels as a
 *  sentinel code and is rendered per-locale in the UI (same contract as `PlanSummaryCode`) rather
 *  than baking English into the row. Only `error` verdicts carry one.
 *   - `blocked`      the pane was wedged on an interactive prompt it could never answer
 *   - `timeout`      still had no verdict file when the hard deadline fired
 *   - `exited`       the spawn ended without writing a verdict file
 *   - `unparseable`  a verdict file was written but is not parseable even after jsonrepair
 *  `membrane-launch` is the odd one out: the critic never ran at all, because its agent binary does
 *  not start inside the bwrap membrane on this host and the spawn was refused (issue #2111). */
export type ReviewSummaryCode =
  | "no-verdict-blocked"
  | "no-verdict-timeout"
  | "no-verdict-exited"
  | "no-verdict-unparseable"
  | "membrane-launch";

export interface ReviewVerdict {
  sessionId: string;
  headSha: string; // PR head this verdict applies to
  patchId: string; // git patch-id of `git diff base...HEAD`; dedups re-reviews across rebases (a pure rebase keeps it stable, so the head can change without re-reviewing). '' = unknown (always reviews)
  decision: ReviewDecision;
  summary: string; // <=100 char one-liner for the badge tooltip; "" when summaryCode is set
  // Sentinel code for a server-authored summary (only `error` verdicts carry one), rendered
  // per-locale in the UI instead of baking English into the row. When set, `summary` is "" and the
  // UI ignores it; absent (legacy rows / real verdicts) → render `summary` verbatim. Mirrors
  // PlanGate.summaryCode. See src/review.ts noVerdictCause().
  summaryCode?: ReviewSummaryCode | null;
  body: string; // full markdown findings (seeds the steer-back)
  // BLOCKING findings only (#2165): the texts of every `important` entry, and nothing else. Every
  // consumer of this field gates on it — streak, auto-address, re-raise, merge train, drain,
  // autopilot, signoff — so a `nit` must never appear here. The split happens once, in
  // buildVerdictCore; `findingsMeta` below carries the full declared list.
  findings: string[]; // discrete actionable items; [] = nothing to address (loop terminates)
  /** #2165 — the machine-readable record of what the critic declared this round: every finding
   *  that survived the scope backstop, `important` and (capped) `nit` alike, with its pass.
   *  `findings` above is exactly `findingsMeta.filter(f => f.severity === "important").map(text)`.
   *  Absent ⇒ treated as [] by every consumer; a row persisted before this field existed hydrates
   *  with its findings synthesized as `important`/`bug` (see SessionStore.hydrateReview). */
  findingsMeta?: CriticFinding[];
  addressRound: number; // auto-address steers spent on the current findings streak (0 = clean/reset)
  addressCap: number; // the streak cap this run used — surfaced so the UI badge math need not mirror it
  streakReviews: number; // critic reviews finalized during the current outstanding-findings streak (0 = clean/reset); bounds review spawns at 2*cap, independent of addressRound
  reviewedPatchIds: string[]; // patch-ids reviewed during the current streak (cleared on a clean verdict, preserved across an error); a re-appeared id within the streak is skipped (churn/revert dedup)
  errorRound: number; // consecutive critic error/timeout verdicts (separate no-progress counter; 0 on any real verdict)
  finalRoundPending: boolean; // cap-th steer just delivered, no re-review yet → dimmed FINAL badge
  finalRoundTimeoutMs: number; // live abandonment timeout; surfaced so the UI never hardcodes it
  seenNoteIds: string[]; // ids of author notes already fed to the critic, so each is injected only once
  url?: string; // posted PR-review URL, when the host returns one
  spawnAborted?: boolean; // true ⇒ this row records a pre-spawn onSpawn abort (critic never ran — e.g. no usable account), surfaced for the badge but EXEMPT from the same-head dedup so the auto path re-attempts once the blocker clears. Cleared (omitted) on every real verdict.
  // Operator dismissed / took over this stalled critic rework (clearStallState). Display + attention
  // consumers stop counting it as active rework and attachReviewPush skips it. Reset to false on any
  // new verdict (buildVerdict) and on forceReview. Absent ⇒ false.
  dismissed?: boolean;
  /** Non-blocking plan-drift measurement for this round (#2155); null when no plan was shown to the
   *  critic, the run errored, or the answer was unrecognized. Advisory ONLY — nothing in the review
   *  loop reads it. The durable copy for metrics lives on `reviewer_spawns` (this row dies at
   *  archive); this one backs the live review popover. */
  planDrift?: PlanDrift | null;
  /** The critic's one-line note on the biggest departure, <=140 chars; null when it reported none. */
  planDriftNote?: string | null;
  updatedAt: number;
}

// ── standalone repo-level PR review dedup record ────────────────────────────
/** Dedup state for a standalone (session-less) per-repo PR review. Keyed by (repoPath, prNumber). */
export interface PrReview {
  repoPath: string;
  prNumber: number;
  headSha: string;
  /** git patch-id of `git diff base...HEAD`; '' until the first real verdict. */
  patchId: string;
  /** Outcome of the last review pass; '' until the first real verdict. */
  decision: ReviewDecision | "";
  /** patch-ids reviewed during the current streak (churn/revert dedup set); cleared on a clean verdict. */
  reviewedPatchIds: string[];
  updatedAt: number;
}

// ── reviewer spawn cost-attribution record ──────────────────────────────────
// ── session recap ────────────────────────────────────────────────────────────
export type RecapState = "generating" | "ready" | "failed" | "empty";
export type RecapVerdict = "ready" | "parked" | "needs_attention";

/** A recap `failed` because Shepherd distrusted an empty diff (see classifyEmptyDiff). Stored as a
 *  sentinel code (+ params) so the headline/body render per-locale in the UI instead of baking
 *  English at write time. */
export type RecapSkipCode =
  "metadata-mismatch" | "base-refresh-failed" | "ancestry-check-failed" | "empty-diff-contradicted";

/** Kind of landed-work evidence a recap-skip references. Declared explicitly (NOT
 *  `LandedWorkEvidence["kind"]`, which lives in src/recap.ts and isn't importable from ui/) so the
 *  UI mirror in ui/src/lib/types.ts stays in lockstep. Kept in sync with LandedWorkEvidence.kind. */
export type RecapEvidenceKind = "merged_pr" | "review" | "existing_recap";

/** Interpolation params for a recap-skip's localized headline/body. All optional — each code uses
 *  the subset it needs. Identifiers (branch/baseRef) pass through verbatim; the evidence clause is
 *  the typed kind (+ optional PR number), localized in the UI, never the authored English summary. */
export interface RecapSkipParams {
  branch?: string; // metadata-mismatch: the session row's branch
  current?: string; // metadata-mismatch: the branch the archived worktree was actually on
  evidenceKind?: RecapEvidenceKind; // base-refresh-failed / ancestry-check-failed / empty-diff-contradicted
  evidencePr?: number; // merged_pr evidence: PR number when known (absent → "merged PR" with no #N)
  baseRef?: string; // ancestry-check-failed / empty-diff-contradicted: the resolved base ref
}

/** A recap-skip reason: the sentinel code plus its interpolation params. Persisted as one JSON
 *  column so a failed recap's card renders per-locale. */
export interface RecapSkip {
  code: RecapSkipCode;
  params: RecapSkipParams;
}

export type RecapFailureCode =
  | "auth-unavailable"
  | "source-unavailable"
  | "launch-failed"
  | "timed-out"
  | "no-result"
  | "invalid-result";

/** A technical recap failure rendered with localized guidance plus optional redacted details. */
export interface RecapFailure {
  code: RecapFailureCode;
  provider: AgentProvider;
  model: string | null;
  detail?: string;
}

export type RecapDiffState = "none" | "present" | "landed";

/** A per-session LLM recap. One row per session, keyed by the HEAD it summarizes
 *  (head-keyed dedupe: a new head re-generates). `state` distinguishes in-flight /
 *  done / failed / no-changes. verdict/headline/body/openItems are empty until ready. */
export interface Recap {
  sessionId: string;
  state: RecapState;
  headSha: string; // the git HEAD this recap summarizes; "" for empty/in-flight w/o head
  base: string; // base branch this recap diffed against (the PR's real base when resolvable); "" for legacy rows. Half of the (headSha, base) dedup key.
  verdict: RecapVerdict | null;
  headline: string; // <=100 chars; "" until ready. Empty on a coded skip (see `skip`) — the UI renders the localized headline from the code.
  body: string; // markdown; "" until ready. Empty on a coded skip — the UI renders the localized body from the code+params.
  // Sentinel code + params for a `failed` skip whose card renders per-locale (see classifyEmptyDiff).
  // When set, headline/body are "" and the UI derives them from this; absent (legacy failed rows,
  // or genuine spawn failures) → render the stored headline/body verbatim. See src/recap.ts.
  skip?: RecapSkip | null;
  failure?: RecapFailure | null;
  /** Explicit diff classification; null/absent for recaps created before this metadata existed. */
  diffState?: RecapDiffState | null;
  openItems: string[]; // [] until ready
  changedFiles: string[]; // files changed in the session (captured at gen time; survives worktree teardown)
  spawnSessionId: string; // claude --session-id of the recap spawn (usage + pane resolve)
  cwd: string; // tmpdir cwd of the spawn (verdict file read + pane reap)
  model: string | null;
  spawnedAt: number;
  generatedAt: number | null; // set when finalized (ready/failed/empty)
  updatedAt: number;
  blocks?: VisualBlock[]; // optional typed visual blocks; absent → render flat markdown body (back-compat)
  pendingDiff?: DiffFile[]; // SERVER-ONLY transient carrier: populated ONLY by generatingRecaps() for
  // finalize's diff-join; never serialized to the client, never set via putRecap
}

// ── doc-agent run history ────────────────────────────────────────────────────
/** Outcome of a completed doc-agent run, surfaced in the UI run history. */
export type DocAgentOutcome = "pr" | "observe" | "nochange" | "error";

/** One completed doc-agent run, stored newest-first in the KV under
 *  `docagent:runs:<repoPath>` (capped at 10). */
export interface DocAgentRun {
  /** epoch ms when the run finalized */
  at: number;
  /** PR url when a doc-update PR was opened; null otherwise */
  url: string | null;
  outcome: DocAgentOutcome;
}

/** Append-only, archive-decoupled record of one spawned critic/plan-gate reviewer
 *  session and its token total. Keyed by the *reviewer* session id (NOT the task) and
 *  deliberately carries no FK to `sessions`, so it outlives task archive + prune —
 *  letting post-hoc cost reports attribute reviewer token burn the task row can't. */
export interface ReviewerSpawnRow {
  reviewerSessionId: string;
  taskSessionId: string;
  /** `rundown` is READ-ONLY history: the Herd Rundown was removed and nothing writes that
   *  kind any more, but its past rows carry real token spend the usage breakdown attributes. */
  kind: "review" | "plan_gate" | "recap" | "rundown" | "doc_agent" | "maintain";
  worktreePath: string;
  reviewerProvider: AgentProvider | null;
  model: string | null;
  reviewerEffort: string | null;
  spawnedAt: number;
  completedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  /** Codex-native rollout id, backfilled once the spawn's rollout resolves; NULL until then and for
   *  every claude spawn (issue #1816). Enables exact, restart-durable rollout resolution. */
  providerSessionId: string | null;
  /** What this reviewer run concluded, stamped once at finalize (#2151 R1). NULL for a legacy row
   *  and for a spawn that never finalized (crashed / orphaned) — delivery metrics EXCLUDE those
   *  rather than counting them as rework rounds, which a raw spawn tally would. */
  outcome: ReviewerSpawnOutcome | null;
  /** Non-blocking plan-fidelity measurement for a `review` spawn that was shown an approved plan
   *  (#2155). NULL for every other kind, for a plan-less review, and for an errored run. Lives here
   *  — not only on `reviews` — because `archive()` drops the review row, and the delivery metrics
   *  read exclusively archive-decoupled tables. */
  planDrift: PlanDrift | null;
}

/** Terminal state of one reviewer run. `review` kinds resolve to clean/changes_requested/error;
 *  `plan_gate` kinds to approved/rework/error. The other spawn kinds (recap, doc_agent, maintain,
 *  and the retired rundown) are never stamped — they have no verdict a delivery metric reads. */
export type ReviewerSpawnOutcome = "clean" | "changes_requested" | "approved" | "rework" | "error";

/** How far a merged diff departed from the APPROVED PLAN the critic was shown (#2155). Reported by
 *  the critic as pure MEASUREMENT: it never becomes a finding, never moves a decision, and never
 *  touches the rework loop. NULL means "not measured" — no plan was shown, the run errored, or the
 *  critic answered with something unrecognized. */
export type PlanDrift = "none" | "minor" | "major";

// ── delivery metrics (#2151 R1) ─────────────────────────────────────────────

/** A terminal CI rollup — the two `ChecksState` values that mean "CI finished". `pending`
 *  and `none` are excluded on purpose: neither is a conclusion, and a GitHub repo with zero
 *  workflows sits at a permanent `none`, which must never read as a green push. */
export type CiConclusion = "success" | "failure";

/** One task session's durable delivery timestamps. Archive-decoupled with no FK to `sessions`
 *  (like {@link ReviewerSpawnRow}): `pruneArchivedSessions` hard-deletes sessions at 30 days and
 *  `archive()` deletes the session's git cache outright, so without this row a merged task's PR
 *  timestamps are unrecoverable. Display fields are denormalized for the same reason.
 *
 *  Forward-only: rows exist only for sessions that ran after this shipped. */
export interface DeliveryFact {
  sessionId: string;
  repoPath: string;
  desig: string;
  issueNumber: number | null;
  prNumber: number | null;
  /** The session's own createdAt — the lead-time origin, denormalized so it survives the prune. */
  createdAt: number;
  /** ms epoch the PR was opened, per the forge (`GitState.createdAt`); null when never observed. */
  prOpenedAt: number | null;
  /** ms epoch this session's merge was SETTLED (teardown archived it, or the poller observed the
   *  merge) — NOT the forge's merge timestamp. A server down at merge time stamps late. */
  mergedAt: number | null;
  /** Head commit the retained CI conclusion belongs to; null until one is observed (#2159). */
  firstCiHeadSha: string | null;
  /** The FIRST terminal CI rollup Shepherd observed for this session, frozen at the first write
   *  (`COALESCE` in `upsertDeliveryFact`) so a re-poll, a re-run, or a later push can never
   *  overwrite it. null = never observed.
   *
   *  Read it as "the first CI conclusion Shepherd SAW", not "the first push's CI": a session can
   *  push several times before its PR opens, the server can be down across the first run, and a
   *  head superseded before its rollup went terminal never stamps at all — in each case the first
   *  head observed is a later one. The bias is disclosed on the tile (which carries its sample
   *  size) rather than hidden. */
  firstCiConclusion: CiConclusion | null;
  updatedAt: number;
}

/** A metric with its sample size. `value` is null when nothing qualified — rendered as an em dash,
 *  never as a zero, so an unmeasured window can't be misread as a perfect (or terrible) one. */
export interface DeliverySample {
  value: number | null;
  /** How many tasks the value was computed over. */
  n: number;
}

/** The delivery indicators for one scope (a repo, or the global total) over the window. */
export interface DeliveryStats {
  /** Tasks whose merge settled inside the window. */
  mergedTasks: number;
  /** Share (0..1) of reviewed merged tasks that needed exactly one clean review round. */
  firstPassRate: DeliverySample;
  /** Merged tasks with no outcome-bearing review spawn — excluded from `firstPassRate`'s
   *  denominator, surfaced so the exclusion is visible rather than silent. */
  unreviewed: number;
  /** Median / mean review rounds per merged task (error spawns excluded). */
  reworkCyclesMedian: DeliverySample;
  reworkCyclesMean: DeliverySample;
  /** Review spawns in the window that ended in `error` — critic runs that produced no verdict. */
  criticErrors: number;
  /** Median plan-gate rounds over merged tasks that had a gate. */
  planRoundsMedian: DeliverySample;
  /** Share (0..1) of gated merged tasks that needed more than one plan round. */
  planReworkRate: DeliverySample;
  /** Share (0..1) of drift-measured merged tasks whose final review reported `minor` or `major`
   *  (#2155). Denominator = tasks carrying a drift value at all, i.e. the critic was shown an
   *  approved plan and answered; a task with no measurement is excluded, never counted as `none`. */
  planDriftRate: DeliverySample;
  /** Of those, how many reported `major`. */
  planDriftMajor: number;
  /** Median ms from PR open to the first critic spawn. */
  timeToFirstReviewMs: DeliverySample;
  /** Median ms from session creation to merge settle. */
  leadTimeMs: DeliverySample;
  /** Share (0..1) of merged tasks whose first observed CI conclusion was `success` (#2159).
   *  Denominator = tasks carrying a conclusion at all; a task whose CI was never observed terminal
   *  (or whose repo has no CI) is excluded, never counted as a pass. See
   *  {@link DeliveryFact.firstCiConclusion} for what "first" can and cannot promise. */
  firstPushGreenRate: DeliverySample;
}

/** Per-repo delivery row. `repo` is the basename shown in the UI; `repoPath` is the key. */
export interface DeliveryRepoRow extends DeliveryStats {
  repoPath: string;
  repo: string;
}

/** One merged task, newest-merged first — the evidence behind the aggregates. */
export interface DeliveryTaskRow {
  sessionId: string;
  desig: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  reviewRounds: number;
  planRounds: number;
  firstPass: boolean | null; // null = no outcome-bearing review spawn
  timeToFirstReviewMs: number | null;
  leadTimeMs: number | null;
  mergedAt: number;
}

/** One day of the trend line. `dayKey` is a UTC `YYYY-MM-DD`. */
export interface DeliveryBucket {
  dayKey: string;
  mergedTasks: number;
  firstPassRate: number | null;
  leadTimeMedianMs: number | null;
}

/** Repeat-incident tally: in-window `signals` grouped by kind. */
export interface DeliveryIncidentRow {
  kind: SignalKind;
  occurrences: number;
  /** Distinct sessions the kind fired for — separates one thrashing task from a systemic class. */
  sessions: number;
}

/** GET /api/usage/delivery payload. Mirror of the contract in ui/src/lib/types.ts — keep in sync. */
export interface DeliveryMetrics {
  range: UsageRange;
  generatedAt: number;
  /** Window start (ms epoch); 0 for range `all`. */
  since: number;
  /** Earliest instrumented session, or null when nothing is recorded yet. Delivery instrumentation
   *  is forward-only, so the UI needs this to say "measuring since X" rather than imply a drought. */
  measuringSince: number | null;
  totals: DeliveryStats;
  repos: DeliveryRepoRow[];
  incidents: DeliveryIncidentRow[];
  trend: DeliveryBucket[];
  tasks: DeliveryTaskRow[];
}

// ── maintain loop (#2157) ────────────────────────────────────────────────────

/** The bands evaluated over Shepherd's OWN health data (#2151 R5). `dead_code_drift` (#2171) is
 *  the only one carrying a pre-approved Tier-3 fix class. */
export type BandId =
  "critic_error_rate" | "incident_spike" | "first_pass_collapse" | "dead_code_drift";

/** 0 = clear (or below the band's minimum sample), 1 = log, 2 = diagnose, 3 = open a PR for the
 *  band's pre-approved fix class (#2171).
 *
 *  Tier 3 is NOT a fourth threshold: a reading that crosses its band's tier-2 threshold is
 *  PROMOTED to 3 when — and only when — that band's config declares a `tier3` fix class. A band
 *  with a mechanical remediation escalates to the PR path instead of the diagnosis path; the
 *  ladder stays monotonic and no band gains a rung it can never reach. */
export type MaintainTier = 0 | 1 | 2 | 3;

/** One band evaluated once. `key` is the stable identity a run and a cooldown are keyed by:
 *  `critic_error_rate`, `incident_spike:<signal kind>`, `first_pass_collapse:<repoPath>`. */
export interface BandReading {
  key: string;
  bandId: BandId;
  /** Set for repo-scoped bands (`first_pass_collapse`); null for the global ones. */
  repoPath: string | null;
  /** What the row is about within its band: the signal kind for `incident_spike`, the repo
   *  basename for `first_pass_collapse` (the UI labels the row from it), null for the global
   *  `critic_error_rate`. Mirror of the client contract in ui/src/lib/types.ts. */
  subject: string | null;
  tier: MaintainTier;
  /** The measured quantity. A rate in 0..1 for the two rate bands, an occurrence count for
   *  `incident_spike`, an auto-fixable-finding count for `dead_code_drift`. */
  value: number;
  /** Sample size behind `value` — review spawns, merged tasks, or distinct sessions. A band below
   *  its minimum sample reports tier 0 and is shown as such rather than as "clear". Count bands
   *  (`dead_code_drift`) have no separate denominator and report `sampleN === value`. */
  sampleN: number;
  /** True when `sampleN` fell under the band's minimum, i.e. `tier` is 0 for want of data rather
   *  than because the metric is healthy. */
  belowMinSample: boolean;
  evaluatedAt: number;
}

/** Terminal state of a maintain run. `filed` = a Tier-2 diagnosis became an issue; `opened` = a
 *  Tier-3 fix became a PR (#2171). `skipped` covers a run the server deliberately did not publish
 *  — act/pr off, or nothing left to fix — which is the expected observe-mode outcome. */
export type MaintainOutcome = "filed" | "opened" | "skipped" | "error";

/** One maintain run — a Tier-2 diagnosis spawn or a Tier-3 fix. Append-only: this is both the
 *  audit trail and — critically — the cooldown anchor, so a row is written for EVERY run including
 *  the ones that publish nothing. */
export interface MaintainRun {
  id: string;
  bandKey: string;
  bandId: BandId;
  tier: MaintainTier;
  value: number;
  worktreePath: string;
  /** Herdr pane name for a Tier-2 diagnosis. Empty for a Tier-3 fix — it spawns no agent. */
  agentName: string;
  /** Transient-spawn id for a Tier-2 diagnosis, and its `reviewer_spawns` cost-ledger key. Empty
   *  for a Tier-3 fix, which has no spawn and therefore no cost row. */
  spawnSessionId: string;
  spawnedAt: number;
  completedAt: number | null;
  outcome: MaintainOutcome | null;
  /** The published artifact: the issue number for a `filed` run, the PR number for an `opened`
   *  one. Both live here — a GitHub PR *is* an issue — and `outcome` says which it is. */
  issueNumber: number | null;
  issueUrl: string | null;
}

/** The `maintain` block riding the GET /api/usage/delivery payload. Mirror of the contract in
 *  ui/src/lib/types.ts — keep in sync. */
export interface MaintainBlock {
  /** SHEPHERD_MAINTAIN_LOOP — evaluation, logging and the diagnosis spawn are armed. */
  enabled: boolean;
  /** SHEPHERD_MAINTAIN_ACT — a drafted issue is actually filed. Meaningless without `enabled`. */
  act: boolean;
  /** SHEPHERD_MAINTAIN_PR — a Tier-3 fix actually opens a PR (#2171). Deliberately INDEPENDENT of
   *  `act`: arming issue-filing must never implicitly arm PR-opening. Meaningless without
   *  `enabled`. */
  pr: boolean;
  readings: BandReading[];
  recentRuns: MaintainRun[];
}

// ── autopilot mode ──────────────────────────────────────────────────────────
export type AutopilotKind = "gate" | "question" | "finished" | "complete" | "unknown";

export interface AutopilotVerdict {
  kind: AutopilotKind;
  /** 1–2 sentence plain-English description of what the agent is waiting for (or, for
   *  "complete", what it delivered). */
  summary: string;
}

// ── agent-authored build queue ───────────────────────────────────────────────
export type BuildStepStatus = "pending" | "active" | "done" | "skipped";

/** One ordered step in a session's agent-authored build queue. */
export interface BuildStep {
  id: string;
  title: string;
  detail: string;
  status: BuildStepStatus;
  position: number; // 0-based order
}

/** A session's full build queue plus its human-curation-gate flag. */
export interface BuildQueue {
  sessionId: string;
  steps: BuildStep[];
  approved: boolean;
  /** How `approved` was set: "auto" = autopilot pre-approval at spawn, "operator" = a human
   *  clicked Approve & run. Absent for an unapproved queue or a legacy row written before this
   *  field existed (renders as plain "approved"). */
  approvalKind?: "auto" | "operator";
}

/** Input shape for replacing a queue. A present `id` is kept VERBATIM as the step's id
 *  (scoped per session), so an agent can own a stable id that survives a re-PUT; a present
 *  `id` matching an existing step also preserves that step's status (unless `status` is given).
 *  When `id` is OMITTED, the server reuses the existing step's id only when the step at the same
 *  position has the same title (position+title carry-over); otherwise it mints a fresh UUID.
 *  Either way a brand-new step defaults to "pending". */
export interface BuildStepInput {
  id?: string;
  title: string;
  detail?: string;
  status?: BuildStepStatus;
}

// ── epic authoring draft ──────────────────────────────────────────────────────

/** One child issue in an epic draft, before any GitHub write. `key` is an agent-assigned
 *  stable temp id (e.g. "c1") used for DAG edges (`blockedBy`) before real issue numbers
 *  exist; the server resolves it to a real number at materialize time. */
export interface EpicDraftChild {
  key: string;
  title: string;
  body: string;
  acceptanceCriteria: string[];
  /** keys of sibling children this child is blocked by (dependency edges). */
  blockedBy: string[];
}

/** The parent (tracking) issue of an epic draft. `body` carries NO epic-dag fence — the
 *  server appends it with real issue numbers at materialize time (authoring-contract ordering). */
export interface EpicDraftParent {
  title: string;
  body: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
}

/** The content an agent PUTs to author/replace an epic draft (no server-owned lifecycle fields). */
export interface EpicDraftContent {
  parent: EpicDraftParent;
  children: EpicDraftChild[];
}

/** Server-owned materialize lifecycle. `materializing` means a materialize is running in THIS
 *  process right now (→ concurrent approve 409s); every exit path (success/error/crash) routes
 *  back to `approved` or `draft`, so it never strands. See src/epic-author.ts + the approve route. */
export type EpicDraftStatus = "draft" | "materializing" | "approved";

/** A session's full epic draft: the authored content plus the server-owned materialize state.
 *  Persisted per session; the hard gate is that GitHub issues are created only by the approve
 *  route's server-side materializer, never by the shaping agent. */
export interface EpicDraft extends EpicDraftContent {
  sessionId: string;
  status: EpicDraftStatus;
  /** key → real issue number, persisted as each child issue is created (partial-failure resume). */
  materializedChildren: Record<string, number>;
  parentNumber: number | null;
  parentUrl: string | null;
}

// ── live preview state ────────────────────────────────────────────────────────

/**
 * Payload for the `session:preview` WebSocket event.
 * Carries only the assigned preview port (or null when no preview is active).
 * The UI builds the full URL from `window.location` + this port so the URL
 * auto-adapts to Tailscale vs. local-dev access modes.
 *
 * NOTE: this is live-derived ephemeral state — NOT persisted to the DB.
 */
export interface SessionPreviewEvent {
  id: string;
  previewPort: number | null;
}

/**
 * Live preview state for one session — the per-session entry in the preview
 * snapshot map (parallel to the activity snapshot). Never persisted.
 */
export interface SessionPreviewState {
  previewPort: number | null;
  /** Tailscale serve registration status for this slot; absent when not managed
   *  (auto disabled / tailscale absent) or no mapping yet. "failed" → degraded. */
  serve?: "ok" | "failed";
}

/** Emitted by TailscaleServeService when a slot's `tailscale serve` mapping
 *  settles. Distinct from SessionPreviewEvent to avoid a register/emit feedback
 *  loop. serve: "ok"|"failed" after register, null after release. */
export interface SessionPreviewServeEvent {
  id: string;
  serve: "ok" | "failed" | null;
}

// ── learnings flywheel ────────────────────────────────────────────────────────
export type SignalKind =
  | "reply"
  | "critic"
  | "block"
  | "stall"
  | "egress_drop"
  | "backup_stale"
  | "injection_detected"
  | "untrusted_author";

export interface Signal {
  id: string;
  repoPath: string;
  sessionId: string | null;
  kind: SignalKind;
  payload: string;
  ts: number;
}

export type LearningStatus = "proposed" | "active" | "promoted" | "dismissed" | "retired";

/** One resolved evidence signal behind a proposed rule, for the drawer's
 *  "where did this come from" view. `id` is the signal id (stable render key);
 *  `desig` is the source session's designation (e.g. "TASK-07"), or null when
 *  the session row is gone; `excerpt` is a short single-line preview of the
 *  captured payload. */
export interface EvidenceItem {
  id: string;
  kind: SignalKind;
  desig: string | null;
  excerpt: string;
  ts: number;
}

export interface Learning {
  id: string;
  repoPath: string;
  rule: string;
  rationale: string;
  evidence: string[]; // signal ids the distiller cited
  status: LearningStatus;
  evidenceCount: number;
  // Per-kind breakdown of the cited signals (so the drawer can show *where* the
  // evidence came from — corrections, review findings, blocks, stalls — not just
  // a bare count). Resolved from `evidence` against the signals table; only
  // attached to the pending-learnings payload, absent (undefined) elsewhere.
  // Pruned/unknown signal ids are simply omitted, so counts may sum below
  // evidenceCount.
  evidenceKinds?: Partial<Record<SignalKind, number>>;
  // The resolved evidence signals themselves (kind + source session + excerpt),
  // newest first. Same provenance, expandable in the drawer. Only on the pending
  // payload; pruned signals drop out.
  evidenceDetail?: EvidenceItem[];
  ineffectiveCount: number;
  helpfulCount: number;
  injectedCount: number;
  lastUsedAt: number | null;
  retiredAt: number | null;
  retiredReason: string | null;
  /** Optional glob patterns scoping where this rule applies (repo-relative, e.g.
   *  "src/" + star-star or "ui/" + star-star + "/*.svelte"). Empty = an "Always-rule"
   *  injected for every task; non-empty = injected only when the session's target files
   *  match a glob (Phase 3, #842). Distiller-inferred from path-like signal text, or
   *  operator-set. */
  scopeGlobs: string[];
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
  /** URL of the CLAUDE.md promote PR, set when status becomes `promoted`. */
  promotedPrUrl: string | null;
  /** When this rule was soft-retired by being consolidated into another rule
   *  (Phase 4 merge), the id of the surviving rule it was merged into — the retained
   *  citation. Null otherwise. Cleared on restore; only meaningful while the rule is
   *  `retired` with `retiredReason === "merged"`. */
  mergedIntoId: string | null;
  /** When the rule was auto-promoted proposed→active as a trial (trialLearning).
   *  Null for manually-approved active rules and all non-trial states. */
  trialedAt: number | null;
  /** Presence marker (#945): set when an auto-trial is reverted back to `proposed`
   *  (`revertTrial(id,"proposed")`). While non-null the auto-trial gate (`shouldTrial`)
   *  suppresses re-trial, so a reverted strong proposal doesn't bounce straight back to an
   *  active trial off its frozen diversity counters. Cleared by `accrueProposedEvidence` on
   *  genuinely fresh evidence (recurrence re-trials it). The timestamp value is provenance
   *  only — never compared to `now` — so the block lifts only via recurrence or normal expiry. */
  reTrialBlockedAt: number | null;
  /** Count of distinct signal kinds in the durable evidenceKindsSeen set. */
  distinctKinds: number;
  /** Count of distinct non-null session ids in the durable evidenceSessionsSeen set. */
  distinctSessions: number;
}

/** Phase 4 background merge-suggestion (off the hot path, operator-applied).
 *  `intra` = a near-duplicate group within one repo, one-click consolidated into a
 *  surviving rule. `cross` = a rule that recurs across many repos, surfaced as a
 *  promote-to-global suggestion (display-only for now). */
export type MergeSuggestionKind = "intra" | "cross";
export type MergeSuggestionStatus = "pending" | "applied" | "dismissed";

/** A member rule of a merge suggestion, hydrated for display (API payload only). */
export interface MergeSuggestionMember {
  id: string;
  repoPath: string;
  rule: string;
  status: LearningStatus;
}

export interface MergeSuggestion {
  id: string;
  kind: MergeSuggestionKind;
  /** Owning repo for `intra`; null for `cross` (spans repos). */
  repoPath: string | null;
  /** Survivor rule id for `intra`; null for `cross`. */
  targetId: string | null;
  /** Member rule ids: for `intra` the non-survivor sources to retire; for `cross`
   *  the recurring rules across repos. */
  sourceIds: string[];
  /** Proposed consolidated rule text (`intra`) / canonical recurring text (`cross`). */
  mergedRule: string;
  mergedRationale: string;
  /** For `cross`: the repos the rule recurs in. Null for `intra`. */
  repoPaths: string[] | null;
  /** Stable dedupe key derived from the sorted member rule ids ONLY (never text). */
  signature: string;
  status: MergeSuggestionStatus;
  createdAt: number;
  /** Hydrated member rules (survivor + sources), for the drawer. API payload only. */
  members?: MergeSuggestionMember[];
}

/** A manually-submitted task held in the queue pending usage headroom. */
export interface HeldTask {
  id: string;
  repoPath: string;
  /** The original CreateSessionInput, replayed through service.create() when released. */
  input: StandardCreateInput;
  createdAt: number;
  /** Hold reason: `'usage'` = usage-gate hold; `'capacity'` = plugin-refused (no account). */
  reason: "usage" | "capacity";
}

// ── per-session usage snapshot ────────────────────────────────────────────────

/** SQLite row type for session_usage (byModel stored as JSON TEXT). */
export interface SessionUsageRow {
  sessionId: string;
  desig: string;
  name: string;
  /** Provenance: the pinned claude session id the snapshot was taken from ('' on legacy
   *  pre-provenance rows). Guards the archived-usage read against serving a stale row
   *  after a restore → replace → re-archive cycle (the replacement gets a new id, and a
   *  Codex replacement never snapshots at all). */
  claudeSessionId: string;
  repoPath: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  weightedUnits: number;
  cacheReadUnits: number;
  messageCount: number;
  byModel: string; // JSON: Record<string, number>
  createdAt: number;
  archivedAt: number;
  snapshotAt: number;
}

/** Public snapshot of per-session authoring spend, captured at archive time. */
export interface SessionUsageSnapshot {
  sessionId: string;
  desig: string;
  name: string;
  /** Provenance guard (see SessionUsageRow.claudeSessionId); optional so legacy fixtures
   *  and pre-migration rows (which read back as '') need no change. */
  claudeSessionId?: string;
  repoPath: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  weightedUnits: number;
  cacheReadUnits: number;
  messageCount: number;
  byModel: Record<string, number>; // weighted units per model id
  createdAt: number;
  archivedAt: number;
  snapshotAt: number;
}

/** One UTC-hour bucket of a session's spend, persisted in session_usage_bucket. */
export interface SessionUsageBucket {
  sessionId: string;
  bucketStart: number; // ms epoch, floorHour(ts); 0 = timeless bucket
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  weightedUnits: number;
  cacheReadUnits: number;
  byModel: Record<string, number>; // weighted units per model
}

/** Per-session windowed sum returned by sumSessionUsageBucketsSince. */
export interface WindowedBucketSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  weightedUnits: number;
  cacheReadUnits: number;
  byModel: Record<string, number>;
}

// Mirror of the UsageBreakdown contract in ui/src/lib/types.ts — keep in sync.
export type UsageRange = "24h" | "7d" | "30d" | "all";

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageTaskBreakdown {
  sessionId: string;
  desig: string;
  name: string;
  model: string;
  authoringUnits: number;
  satelliteUnits: number;
  dollars: number | null; // absolute USD spend (= weighted units); null unless api-key auth mode
  tokens: UsageTokens;
  byModel: Record<string, number>; // weighted units per model id
}

export interface UsageRepoBreakdown {
  repoPath: string;
  repoName: string;
  authoringUnits: number;
  satelliteUnits: number;
  dollars: number | null; // absolute USD spend; null unless api-key auth mode (subscription mode shows no dollars)
  tasks: UsageTaskBreakdown[];
}

// One satellite-pass kind's global, spawn-timestamp-filtered tally. Independent of the
// per-task `satelliteUnits` attribution (different filter axis + includes unattributed
// buckets like doc_agent/standalone-critic) — see buildUsageBreakdown.
export interface UsageKindUnits {
  kind: string; // "review" | "plan_gate" | "recap" | "doc_agent" | "maintain" (+ historical "rundown") — data, not translated
  units: number; // weighted units for that kind, in range
  count: number; // number of completed passes of that kind, in range
}

export interface UsageBreakdown {
  range: UsageRange;
  generatedAt: number;
  totalUnits: number;
  authoringUnits: number;
  satelliteUnits: number;
  cacheReadUnits: number;
  generationUnits: number;
  satelliteByKind: UsageKindUnits[]; // global per-kind satellite tally, sorted desc by units
  dollars: number | null; // absolute USD spend; null unless api-key auth mode (subscription mode shows no dollars)
  repos: UsageRepoBreakdown[];
}

// ── Spawn-prompt budget (issue #1999) ────────────────────────────────────────
// Mirror of the PromptBudgetRecord contract in ui/src/lib/types.ts — keep in sync.

/** How the assembled directive payload reaches the agent. Claude takes it on
 *  `--append-system-prompt`; Codex has no such flag, so the SAME payload rides inline on the prompt
 *  wrapped in `<shepherd-directives>`. Recorded per spawn so the meter isn't misread as the literal
 *  Codex argv. */
export type PromptBudgetDelivery = "append-system-prompt" | "inline-prompt";

/** One spawn's recorded prompt breakdown, joined with its session for display. Written once per
 *  spawn at `composeDirectives`; upserted by sessionId, so a relaunch replaces rather than
 *  accumulates. `blocks` are in emission order — the UI sorts for display. */
export interface PromptBudgetRecord {
  sessionId: string;
  desig: string;
  repoPath: string;
  agentProvider: AgentProvider;
  /** True for an unattended (drain / auto) spawn — the acceptance criterion names both. */
  auto: boolean;
  delivery: PromptBudgetDelivery;
  totalChars: number;
  totalBytes: number;
  /** ESTIMATE, not a tokenizer measurement — see CHARS_PER_TOKEN in src/prompt-budget.ts. */
  totalTokens: number;
  blocks: PromptBlockMeasure[];
  createdAt: number;
}

// One hour of weighted-unit consumption — mirror of UsageTimelineHour in ui/src/lib/types.ts.
export interface UsageTimelineHour {
  hourStart: number; // ms epoch, floored to the hour (UTC boundary); never 0 (timeless rows excluded)
  units: number; // weighted units consumed in that hour (authoring + live + satellite)
}

// GET /api/usage/timeline response — mirror of UsageTimeline in ui/src/lib/types.ts.
// `hours` is ASC by hourStart, non-empty hours only; totalUnits/peakHourUnits span the full range.
export interface UsageTimeline {
  range: UsageRange;
  generatedAt: number;
  hours: UsageTimelineHour[];
  totalUnits: number;
  peakHourUnits: number;
}

// Runtime key-lists — drift sentinels (TS types vanish at runtime).
// Mirrors UsageTokens:
export const USAGE_TOKENS_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
// Mirrors UsageTaskBreakdown:
export const USAGE_TASK_KEYS = [
  "sessionId",
  "desig",
  "name",
  "model",
  "authoringUnits",
  "satelliteUnits",
  "dollars",
  "tokens",
  "byModel",
] as const;
// Mirrors UsageRepoBreakdown:
export const USAGE_REPO_KEYS = [
  "repoPath",
  "repoName",
  "authoringUnits",
  "satelliteUnits",
  "dollars",
  "tasks",
] as const;
// Mirrors UsageKindUnits:
export const USAGE_KIND_UNITS_KEYS = ["kind", "units", "count"] as const;
// Mirrors UsageBreakdown:
export const USAGE_BREAKDOWN_KEYS = [
  "range",
  "generatedAt",
  "totalUnits",
  "authoringUnits",
  "satelliteUnits",
  "cacheReadUnits",
  "generationUnits",
  "satelliteByKind",
  "dollars",
  "repos",
] as const;
// Mirrors UsageTimelineHour:
export const USAGE_TIMELINE_HOUR_KEYS = ["hourStart", "units"] as const;
// Mirrors UsageTimeline:
export const USAGE_TIMELINE_KEYS = [
  "range",
  "generatedAt",
  "hours",
  "totalUnits",
  "peakHourUnits",
] as const;

// ── per-session hold reason ("Why parked?") ──────────────────────────────────
/** Closed set of reasons a session is parked/blocked/gate-held. One per session,
 *  derived (see explainHold in attention-core.ts). UI localizes via m.hold_<code>(params);
 *  server (push) via renderHold() in hold.ts. */
export type HoldCode =
  | "halted-error"
  | "halted-usage"
  | "autopilot-paused"
  | "blocked-menu"
  | "blocked-yes-no"
  | "blocked-awaiting-input"
  | "blocked-stall"
  | "blocked-generic"
  | "quota-rework"
  | "quota-review"
  | "quota-error"
  | "quota-plan"
  | "plan-rework"
  | "plan-question"
  | "critic-rework"
  | "ci-red"
  | "pr-conflict"
  | "awaiting-merge"
  | "train-error"
  | "stalled"
  | "recap-attention"
  | "merging"
  | "merge-rebasing"
  | "ready-merge"
  | "manual-steps";

/** Display params interpolated into the localized hold line. All optional; each code
 *  uses the subset it needs. `question` is verbatim agent text (not translated). */
export interface HoldParams {
  round?: number; // plan-rework: current adversarial round
  cap?: number; // plan-rework: round cap
  findings?: number; // critic-rework: open finding count
  resetAt?: number; // halted-usage: epoch ms the usage window resets
  pr?: number; // ci-red/awaiting-merge/train-error/merging/ready-merge
  rebaseCount?: number; // merge-rebasing: auto-rebase attempts
  question?: string; // autopilot-paused: the agent's hand-back question (verbatim)
  steps?: number; // manual-steps: count of un-acked non-POST-MERGE manual operator steps
}

export interface HoldReason {
  code: HoldCode;
  params?: HoldParams;
}
