import type { SandboxProfile } from "./sandbox";
import type { VisualBlock } from "./visual-blocks";
import type { ManualStep } from "./manual-steps";

export type HerdrState = "idle" | "working" | "blocked" | "done" | "unknown";
export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";
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
  /** Full-auto merge opt-in: true/false override, or null to inherit the repo default. */
  autoMergeEnabled: boolean | null;
  /** Consecutive auto-rebase attempts the merge train has spent on this session
   *  (runaway guard; reset on operator reply). */
  autoMergeRebaseCount: number;
  /** The head SHA the merge train last steered a rebase for; null when none outstanding.
   *  Guards against re-steering / re-bumping while a rebase for the same head is in flight. */
  autoMergeRebaseHead: string | null;
  /** True when this session was auto-spawned by the drain queue. */
  auto: boolean;
  /** Backlog issue number this session was spawned for; null for manual/non-issue sessions. */
  issueNumber: number | null;
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

export interface CreateSessionInput {
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
 * explicit `null` for `model`/`planGateEnabled`) replaces it. Lets a caller relaunch
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
 *  with no mapping layer. Each 1M variant sits next to its 200K base. */
const CLAUDE_MODELS = ["fable", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"] as const;

/** Back-compat alias used throughout the existing Claude default-model settings. */
export const MODELS = CLAUDE_MODELS;

/** Reasoning-effort tiers exposed in the picker, ordered least→most effort. The value space is
 *  the Claude `--effort` domain (verified against the pinned `claude` CLI). Codex's narrower
 *  domain (`minimal|low|medium|high`) is handled by clamping at argv-build; `minimal` (below
 *  `low`, Codex-only) is not exposed here. `"default"` (settings) / `null` (session) = no flag. */
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

// ── plugin update check (informational only) ────────────────────────────────
/** Per-plugin update state. `no-source` = no way to check (no declared
 *  repository and not a git checkout); `incompatible` = a newer version exists
 *  but its apiVersion would be rejected at load; `error` = the check itself
 *  failed for this plugin (bad manifest version, unreachable remote, …). */
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
 *  baked English at write time). Only `error` verdicts carry a code today ("no-verdict"); every
 *  other summary is the reviewer's own operator-language text, passed through verbatim. */
export type PlanSummaryCode = "no-verdict";

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
  // this verdict as active rework (REWORK RUNNING / review banner / rundown rework signal). Reset to
  // false on any new verdict (buildGate) and on resume(). Absent ⇒ false.
  dismissed?: boolean;
  updatedAt: number;
}

// ── critic-on-PR review verdict ─────────────────────────────────────────────
export type ReviewDecision = "changes_requested" | "commented" | "error";

export interface ReviewVerdict {
  sessionId: string;
  headSha: string; // PR head this verdict applies to
  patchId: string; // git patch-id of `git diff base...HEAD`; dedups re-reviews across rebases (a pure rebase keeps it stable, so the head can change without re-reviewing). '' = unknown (always reviews)
  decision: ReviewDecision;
  summary: string; // <=100 char one-liner for the badge tooltip
  body: string; // full markdown findings (seeds the steer-back)
  findings: string[]; // discrete actionable items; [] = nothing to address (loop terminates)
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

// ── herd rundown (cross-session attention digest, keyed by calendar day) ──────
export type HerdDigestState = "generating" | "ready" | "failed";

/** One actionable line in a rundown section. `sessionId`/`pr` let the UI deep-link. */
export interface RundownItem {
  label: string;
  sessionId?: string;
  pr?: number;
}

/** A Tier-1 "land this epic" item in the rundown (#1045). Unlike RundownItem these are NOT
 *  LLM-authored — the server injects them deterministically from the landing-ready completed-epic
 *  set (open landing PR that is CLEAN + CI-green + mergeable per #1039's computeLandingReady), so
 *  they can never be dropped or hallucinated. `repo`/`parent` deep-link to the IntegratedEpicsBand
 *  row + its Land CTA. `stranded` flags an open+ready landing that has sat unlanded past the Rec D
 *  threshold (urgency emphasis only — it does not gate inclusion).
 *  `pausedReason` — when present, the auto-rebase pass is paused (not ready to merge, needs
 *  operator action): 'cap' = rebase cap exhausted; 'conflict' = genuine conflict; 'driver' = merge
 *  driver unavailable on the server. Absent on landing-ready (non-paused) items. (#1071) */
export interface RundownEpicItem {
  repo: string;
  parent: number;
  title: string;
  landingPr: number | null;
  stranded: boolean;
  /** Present when the auto-rebase pass is paused and operator action is needed (#1071). */
  pausedReason?: "cap" | "conflict" | "driver";
  /** When true, the landing PR's CI is failing (terminal `checks:"failure"`, and NOT
   *  behind/conflicting — those are the rebase pass's `pausedReason`). A distinct Tier-1 attention
   *  item: not "ready", not "paused", not "repairing". */
  ciFailing?: boolean;
  /** When true, a genuinely-live landingRepair session is already fixing this landing's CI —
   *  non-actionable, so it is NOT `ciFailing` (that item is the backstop for a stuck/finished
   *  session). A distinct Tier-1 attention item: not "ready", not "paused", not "ciFailing". */
  repairing?: boolean;
}

/** The LLM-authored verdict the rundown spawn writes to `.shepherd-rundown.json`. */
export interface RundownVerdict {
  overnight: string;
  decisions: RundownItem[];
  ciRework: RundownItem[];
  train: string;
  focusNext: RundownItem[];
}

/** A synthesized cross-session attention digest for one calendar day (the stored +
 *  wire shape). Mirrors the recap lifecycle (generating → ready/failed). The verdict
 *  fields (overnight/decisions/ciRework/train/focusNext) are empty until `ready`.
 *  `attentionFingerprint` snapshots the per-session signal set at generation time so a
 *  later task can decide whether the herd has drifted enough to regenerate. */
export interface HerdDigest {
  dayKey: string; // "YYYY-MM-DD" of the operator's local day this digest covers
  state: HerdDigestState;
  overnight: string;
  decisions: RundownItem[];
  ciRework: RundownItem[];
  train: string;
  focusNext: RundownItem[];
  /** Tier-1 "land this epic" items (#1045). Server ground truth, NOT from the LLM verdict — set
   *  at spawn time and kept live intraday by reconcileEpics() (see HerdDigestService). */
  epicsToLand: RundownEpicItem[];
  attentionFingerprint: Record<string, string[]>; // sessionId → sorted signal codes
  spawnSessionId: string; // claude --session-id of the rundown spawn (usage + pane resolve)
  cwd: string; // tmpdir cwd of the spawn (verdict file read + pane reap)
  model: string | null;
  spawnedAt: number;
  generatedAt: number | null; // set when finalized (ready/failed)
  updatedAt: number;
  /** Route-computed at GET time (count of attention-bearing sessions whose signal set
   *  changed since this digest was generated); NOT stored. */
  staleCount?: number;
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

/** Append-only, archive-decoupled record of one spawned satellite LLM session and its token total.
 *  Keyed by the *reviewer* session id (NOT the task) and
 *  deliberately carries no FK to `sessions`, so it outlives task archive + prune —
 *  letting post-hoc cost reports attribute reviewer token burn the task row can't. */
export interface ReviewerSpawnRow {
  reviewerSessionId: string;
  taskSessionId: string;
  kind: "review" | "plan_gate" | "recap" | "rundown" | "doc_agent" | "classifier";
  worktreePath: string;
  reviewerProvider: AgentProvider | null;
  model: string | null;
  reviewerEffort: string | null;
  providerThreadId: string | null;
  spawnedAt: number;
  completedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
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
  input: CreateSessionInput;
  createdAt: number;
  /** Hold reason: `'usage'` = usage-gate hold; `'capacity'` = plugin-refused (no account). */
  reason: "usage" | "capacity";
}

// ── per-session usage snapshot ────────────────────────────────────────────────

/** SQLite row type for session_usage (model maps stored as JSON TEXT). */
export interface SessionUsageRow {
  sessionId: string;
  desig: string;
  name: string;
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
  rawByModel: string; // JSON: Record<string, number>
  createdAt: number;
  archivedAt: number;
  snapshotAt: number;
}

/** Public snapshot of per-session authoring spend, captured at archive time. */
export interface SessionUsageSnapshot {
  sessionId: string;
  desig: string;
  name: string;
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
  rawByModel: Record<string, number>; // raw tokens per model id
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
  rawByModel: Record<string, number>; // raw tokens per model
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
  rawByModel: Record<string, number>;
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
// buckets like rundown/doc_agent/standalone-critic) — see buildUsageBreakdown.
export interface UsageKindUnits {
  kind: string; // "review" | "plan_gate" | "recap" | "rundown" | "doc_agent" | "classifier" — data, not translated
  units: number; // weighted units for that kind, in range
  count: number; // number of completed passes of that kind, in range
}

export type UsageRole =
  "coding" | "classifier" | "review" | "plan_gate" | "recap" | "rundown" | "doc_agent";
export type UsageByRole = Partial<Record<UsageRole, Record<string, number>>>;

export interface UsageModelBreakdown {
  totalTokens: number;
  byModel: Record<string, number>;
  byRole: UsageByRole;
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
  models: {
    claude: UsageModelBreakdown;
    codex: UsageModelBreakdown;
  };
  repos: UsageRepoBreakdown[];
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
// Mirrors UsageModelBreakdown:
export const USAGE_MODEL_BREAKDOWN_KEYS = ["totalTokens", "byModel", "byRole"] as const;
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
  "models",
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
 *  derived (see explainHold in rundown-core.ts). UI localizes via m.hold_<code>(params);
 *  server (push + rundown prompt) via renderHold() in hold.ts. */
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
