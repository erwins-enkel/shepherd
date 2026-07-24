export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";
export const AGENT_PROVIDERS = ["claude", "codex"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** Role a session plays in a comparison experiment (see server `ExperimentRole`). */
export type ExperimentRole = "variant" | "comparison";

export type BuildStepStatus = "pending" | "active" | "done" | "skipped";

export interface BuildStep {
  id: string;
  title: string;
  detail?: string;
  status: BuildStepStatus;
  position: number;
}

export interface BuildQueue {
  sessionId: string;
  steps: BuildStep[];
  approved: boolean;
  /** "auto" = autopilot pre-approval at spawn; "operator" = a human clicked Approve & run.
   *  Absent for an unapproved queue or a legacy row → renders as plain "approved". */
  approvalKind?: "auto" | "operator";
}

// ── epic authoring draft (issue #1507) ──────────────────────────────────────────

/** One child issue in an epic draft, before any GitHub write. `key` is an agent-assigned temp id
 *  used for dependency (`blockedBy`) edges before real issue numbers exist. */
export interface EpicDraftChild {
  key: string;
  title: string;
  body: string;
  acceptanceCriteria: string[];
  blockedBy: string[];
}

export interface EpicDraftParent {
  title: string;
  body: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
}

export type EpicDraftStatus = "draft" | "materializing" | "approved";

/** A session's epic draft: the reviewable EPIC structure the operator approves before any GitHub
 *  write. `materializedChildren`/`parentNumber` are populated by the server-side materializer. */
export interface EpicDraft {
  sessionId: string;
  parent: EpicDraftParent;
  children: EpicDraftChild[];
  status: EpicDraftStatus;
  materializedChildren: Record<string, number>;
  parentNumber: number | null;
  parentUrl: string | null;
}

export interface RepoEntry {
  name: string;
  path: string;
  display: string;
  /** Most-recent session createdAt for this repo; undefined if never used. */
  lastUsedAt?: number;
  /** Count of sessions (agents) run on this repo within the recent window; undefined if none. */
  recentAgentCount?: number;
  /** True when the repo is a fork (origin = fork, upstream = original) — the repo
   *  picker shows a "Sync fork" action on these. Absent/false ⇒ not a fork. */
  isFork?: boolean;
  /** True when the repo is flagged hidden (RepoConfig.hidden). The New Task picker
   *  hides these by default but reveals them on name search. Absent/false ⇒ visible. */
  hidden?: boolean;
  /** realpathSync(path) — the form session.repoPath (safeRepoDir) carries; falls back
   *  to `path` when realpath fails. Lets the client resolve a realpath'd session repo
   *  and a raw backlog repo to the same entry. */
  realPath: string;
}

export interface Settings {
  repoRoot: string;
  repoRootDisplay: string;
  /** True on a genuine server-detected first run: the onboarding surface must block until the
   *  operator picks a repo root (see `Onboarding.svelte`'s `blocking` prop). Flips false once a
   *  root is persisted. */
  firstRunPending: boolean;
  remoteControlAtStartup: boolean;
  /** Daily sweep that prunes old archived sessions; kill switch (default on). */
  sessionHousekeepingEnabled: boolean;
  /** Raw configured default-model setting (auto|default|<alias>); the New Task
   *  picker resolves `auto` via the client promo. */
  defaultModel: string;
  /** Global default-effort setting ("default"|<tier>); "default" emits no effort flag. */
  defaultEffort: string;
  /** Language spawned agents use to talk to the operator ("en" | "de"). Independent of the
   *  interface language — set only from the Settings page. */
  operatorLanguage: string;
  /** Per-role ENVIRONMENT settings for the helper agents Shepherd spawns: a CLI pair per role.
   *  `<role>Cli` ∈ "inherit" | "claude" | "codex" ("inherit" follows `defaultAgentProvider` +
   *  `defaultModel`); `<role>Model` ∈ "default" | <alias for that CLI>. The Settings UI shows each
   *  role's effective resolved CLI · model alongside its two pickers. */
  criticCli: string;
  criticModel: string;
  criticEffort: string;
  plannerCli: string;
  plannerModel: string;
  plannerEffort: string;
  recapCli: string;
  recapModel: string;
  recapEffort: string;
  docAgentCli: string;
  docAgentModel: string;
  docAgentEffort: string;
  namerCli: string;
  namerModel: string;
  namerEffort: string;
  autopilotCli: string;
  autopilotModel: string;
  autopilotEffort: string;
  /** Default interactive agent provider for newly spawned task sessions. */
  defaultAgentProvider?: AgentProvider;
  /** When true, Up Next quick-start launches with the default coding CLI without opening the
   *  "Choose coding CLI" picker, even when more than one CLI is ready. */
  upnextSkipCliPicker: boolean;
  /** How spawned agents authenticate: "subscription" (OAuth) | "api-key". */
  authMode: string;
  /** Whether an Anthropic API key is configured. The key itself is NEVER sent. */
  hasApiKey: boolean;
  /** Max PR-critic auto-address rounds before escalating to a human (global). */
  prReviewCyclesCap: number;
  /** Display-only: lower bound for prReviewCyclesCap (drives the stepper's min). */
  prReviewCyclesMin: number;
  /** Display-only: upper bound for prReviewCyclesCap (drives the stepper's max). */
  prReviewCyclesMax: number;
  /** Max plan-gate revise rounds before escalating to a human (global). */
  planReviewCyclesCap: number;
  /** Display-only: lower bound for planReviewCyclesCap (drives the stepper's min). */
  planReviewCyclesMin: number;
  /** Display-only: upper bound for planReviewCyclesCap (drives the stepper's max). */
  planReviewCyclesMax: number;
  /** Account-wide extra-credit (paid overage) spend ceiling; drain pauses above it.
   *  0 = pause on ANY extra-credit spend. */
  extraCreditsDrainCeiling: number;
  /** Display-only: archived sessions older than this many days are pruned. */
  sessionRetentionDays: number;
  /** Display-only: newest archived sessions kept regardless of age. */
  sessionRetentionKeep: number;
  /** The agent node's own tailnet hostname; the UI builds preview iframe URLs from it
   *  when the HUD is fronted on a different host than the node. Null when tailscale is
   *  absent → fall back to the operator's own connection host. */
  previewHost: string | null;
  /** Whether usage-aware task holding is enabled (new tasks paused when usage is high). */
  usageHoldEnabled: boolean;
  /** Usage percentage at or above which new tasks are held (0–100); also the threshold
   *  below which the usage-halt retry trigger becomes available. */
  usageHoldPct: number;
  /** Whether held tasks auto-start once usage drops below the threshold. When false, held
   *  tasks stay queued until the operator starts (or discards) each one manually. */
  usageHoldAutoRelease: boolean;
  /** Whether usage-aware model downgrade is enabled: at/above usageDowngradePct, every spawn
   *  (main + role agents) runs on usageDowngradeModel instead of its configured model. */
  usageDowngradeEnabled: boolean;
  /** Usage percentage at or above which spawns downgrade to usageDowngradeModel (0–100).
   *  Meant to sit BELOW usageHoldPct: downgrade first, then hold. */
  usageDowngradePct: number;
  /** Model spawns downgrade to when usage is high — a default-model setting ("auto"|"default"|<alias>). */
  usageDowngradeModel: string;
  /** Whether Fable is globally available; when false, Fable selections run on Opus (1M context). */
  fableAvailable: boolean;
  /** Opt the main session into Claude Code's fullscreen renderer (research preview). */
  tuiFullscreen: boolean;
  /** Disable Claude Code mouse capture for the main session. */
  tuiDisableMouse: boolean;
  /** Global reduced-notifications mode: when on, only the ready-after-5s push (+ usage/credit alerts) is sent. */
  reducedPushMode: boolean;
  /** Anonymous usage-telemetry consent. "unset" until the operator answers the first-run prompt. */
  telemetryConsent: "unset" | "granted" | "denied";
  /** True when telemetry can run (App-Key configured AND DO_NOT_TRACK unset) — gates the prompt + toggle. */
  telemetryAvailable: boolean;
  /** Whether the PR-gated doc agent feature is enabled. */
  docAgentEnabled: boolean;
  /** Whether the doc agent runs in observe-only mode (no PR opened). */
  docAgentAct: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  display: string;
  parent: string | null;
  entries: DirEntry[];
}

/** One entry in a session scratchpad listing (#1164). `path` is relative to the scratchpad root. */
export interface ScratchEntry {
  name: string;
  type: "file" | "dir";
  path: string;
  /** Creation date in epoch ms — birth time when the filesystem records it, else modified-time
   *  fallback. Omitted when the server's stat failed (the entry is still surfaced). */
  createdMs?: number;
  /** true when this entry is a symlink resolving outside the root (worktree view only);
   *  rendered as a disabled, non-navigable row. */
  linkOutside?: boolean;
}

/** A directory listing within a session's scratchpad subtree (#1164). Paths are relative to the
 *  scratchpad root ("" = root); `parent` is null at the root. */
export interface ScratchListing {
  path: string;
  parent: string | null;
  entries: ScratchEntry[];
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  /** Label name → hex color (`#rrggbb`) from the forge, when available. Additive/optional;
   *  `labels` stays authoritative. Absent/partial ⇒ neutral chip fallback. */
  labelColors?: Record<string, string>;
  createdAt: number;
  /** GitHub/Gitea logins assigned to the issue (empty when unassigned). Drives the
   *  "mine & unassigned" filter (#824). */
  assignees: string[];
  /** Login of the issue's author, when the forge supplies it (GitHub always; Gitea via
   *  `user.login`). Absent on hosts/paths that don't fetch it. Surfaced as the "by {login}"
   *  row text and drives the author filter. */
  author?: string;
  /** Numbers of the issue's still-OPEN blockers (GitHub issue dependencies), attached by
   *  /api/issues. Absent/empty ⇒ not blocked. Drives the "blocked on #N" badge. */
  blockedBy?: number[];
}

/** Subset of an Issue attached to a task by reference (body rides out-of-band). */
export interface IssueRef {
  number: number;
  url: string;
  title: string;
  body: string;
}
/** An installed slash command (skill or command file) surfaced in the New Task
 *  "Commands" tab; picking one seeds the prompt with `/<name> `. */
export type SlashCommandScope = "project" | "user" | "plugin" | "builtin";
export interface SlashCommand {
  id?: string;
  name: string;
  displayName?: string;
  description: string;
  scope: SlashCommandScope;
  kind?: "skill" | "command" | "plugin";
  invocationName?: string;
  sourceNamespace?: string;
  sourcePath?: string;
  providers?: AgentProvider[];
  invocations?: Partial<Record<AgentProvider, string>>;
  /** Front-matter `argument-hint` (e.g. "<ticket>"), shown dimmed after the name. */
  argumentHint?: string;
}

export interface ProviderTokenConstraint {
  id: string;
  commandId?: string;
  token: string;
  providers: AgentProvider[];
  label: string;
}

export type BlockShape = "menu" | "yes-no" | "awaiting-input" | "stall" | "quota";
export interface BlockOption {
  label: string;
  send: string;
}
export interface BlockReason {
  shape: BlockShape;
  options: BlockOption[];
  tail: string[];
  /** Discriminator for quota blocks: which sub-kind of quota exhaustion triggered this. */
  quotaKind?: "rework" | "review" | "error" | "plan";
  /** Full OAuth authorization URL an awaiting-input block is waiting on the operator to
   *  open (MCP auth flows, e.g. Notion/Vercel), sourced from the JSONL transcript rather
   *  than the word-wrapped terminal. Drives the "open in browser" affordance. */
  authUrl?: string;
}

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

export type ForgeKind = "github" | "gitea" | "local";
export type MergeMethod = "merge" | "squash" | "rebase";
export type ChecksState = "none" | "pending" | "success" | "failure";
/** GitHub's mergeStateStatus (mirrors server `MergeStateStatus`); absent for Gitea. */
export type MergeStateStatus =
  "behind" | "blocked" | "clean" | "dirty" | "draft" | "has_hooks" | "unknown" | "unstable";

export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  title?: string;
  /** ms epoch the PR was opened; undefined when there is no PR (or a cached
   *  payload predates the field). Drives the TimePopover's "open for X" line. */
  createdAt?: number;
  mergeable?: boolean | null;
  checks: ChecksState;
  /** Names of the checks currently in flight (the `pending` subset of the rollup),
   *  e.g. `["verify / test"]`. Populated only on the GitHub path; absent on the
   *  REST fallback / Gitea and absent (not `[]`) when nothing runs. Drives the
   *  terminal CI-running banner. Order isn't stable — compare as a set. */
  runningChecks?: string[];
  /** GitHub's precise merge-state signal; absent for Gitea (mirrors server PrStatus). */
  mergeStateStatus?: MergeStateStatus;
  deployConfigured: boolean;
  headSha?: string;
  latestReview?: {
    state: "approved" | "changes_requested" | "commented";
    author: string;
    submittedAt: number;
  };
  /** Latest terminal human review state per reviewer, critic reviews excluded. */
  reviewerStates?: Record<
    string,
    { state: "approved" | "changes_requested" | "commented"; latestAt: number | null }
  >;
  /** true = PR is a draft / not ready-for-review. Absent ⇒ treat as false. */
  isDraft?: boolean;
}

/** Which kind of PR this is — drives the PRs tab type tag (mirrors server `PrKind`). */
export type PrKind = "regular" | "dependabot" | "release";

/** An open PR row in the backlog PRs tab (mirrors server `PullRequest`). */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  /** Which kind of PR this is — drives the PRs tab type tag. Computed via classifyPr. */
  kind: PrKind;
  createdAt: number;
  isDraft: boolean;
  /** null = host still computing mergeability. */
  mergeable: boolean | null;
  checks: ChecksState;
  /** Per-check breakdown of the head commit, expanded from the rollup dot. */
  jobs: WorkflowJob[];
  latestReview?: {
    state: "approved" | "changes_requested" | "commented";
    author: string;
    submittedAt: number;
  };
  /** The PR's base (target) branch, populated ONLY when it is NOT the repo's
   *  default branch (e.g. an epic/stacked branch); `undefined` for the common
   *  default-targeting PR. This is intentionally NOT the raw base ref — do not
   *  rely on it to read a PR's actual target; it exists solely to surface
   *  non-default (stacked) PRs in the backlog PRs tab. */
  nonDefaultBase?: string;
  /** True when a GitHub Actions workflow run on this PR's head is awaiting manual
   *  approval to run (the fork/outside-contributor & Actions-bot `action_required`
   *  flavor; deployment-environment `waiting` gates are not detected). Drives the
   *  PRs-tab "needs approval" chip. Display-only. Absent ⇒ false. */
  awaitingWorkflowApproval?: boolean;
}

/** Result of fast-forwarding a repo's local default-branch checkout after a merge
 *  (mirrors server `PullResult` from `src/pull.ts`). On failure `reason` distinguishes
 *  benign non-fast-forwardable local states (`wrong_branch`/`dirty`/`diverged`) from a
 *  genuine `error`. */
export type PullResult =
  | { ok: true; branch: string; updated: boolean; sha: string }
  | { ok: false; reason: "wrong_branch" | "dirty" | "diverged" | "error"; branch?: string };

/** One job within a workflow run (mirrors server `WorkflowJob`). */
export interface WorkflowJob {
  name: string;
  state: ChecksState;
  url?: string;
}

/** Latest run of one workflow on the default branch (mirrors server `WorkflowRun`). */
export interface WorkflowRun {
  /** Host run id — the handle re-run / cancel act on. */
  runId: number;
  /** Workflow's stable id (server `workflowDatabaseId`); used to fetch history. */
  workflowId: number;
  workflowName: string;
  runUrl: string;
  headSha: string;
  createdAt: number;
  state: ChecksState;
  jobs: WorkflowJob[];
}

// ── pre-execution plan gate ─────────────────────────────────────────────────
export type PlanDecision = "approved" | "changes_requested" | "error";
/** Sentinel for a server-authored plan-gate summary rendered per-locale in the UI (mirrors server
 *  `PlanSummaryCode`). Only `error` verdicts carry one today. */
export type PlanSummaryCode = "no-verdict";
/** A plan-gate verdict (mirrors server `PlanGate`), keyed client-side by session id. */
export interface PlanGate {
  sessionId: string;
  planHash: string; // sha256 of the reviewed plan; dedups re-reviews of an unchanged plan
  decision: PlanDecision;
  summary: string; // <=100 char one-liner for the badge tooltip; "" when summaryCode is set
  // Sentinel code for a server-authored summary (error → "no-verdict"), rendered per-locale; when
  // set, `summary` is "" and the UI renders from the code. Absent → render `summary` verbatim.
  summaryCode?: PlanSummaryCode | null;
  body: string; // full markdown reviewer write-up
  findings: string[]; // discrete actionable items; [] = nothing to address
  round: number; // adversarial rounds spent on the current plan streak (0 = reset)
  cap: number; // the round cap this run used — the badge reads it instead of mirroring
  approved: boolean; // load-bearing gate flag: execution allowed only when true
  plan: string; // snapshot of the reviewed plan text (surfaced in the UI panel)
  /** Resolved Plan Gate reviewer environment. Null/absent when unavailable for legacy or
   *  restart-adopted reviews. */
  reviewerProvider?: AgentProvider | null;
  reviewerModel?: string | null;
  reviewerEffort?: string | null;
  blocks?: VisualBlock[]; // optional typed visual plan blocks (model-authored); absent → flat markdown
  // Answered question-form questions, keyed `${blockId} ${questionId}` (#1332). Mirrors the
  // server field; absent ⇒ treated as []. Drives the "unanswered plan question" amber tab
  // signal via planQuestionsUnanswered in tab-signal.svelte.ts.
  answeredQuestionKeys?: string[];
  // The cap-th plan-rework steer just landed → the FINAL round is in flight (agent revising).
  // planStallStatus (plan-status.ts) reads it to keep the genuine final round in REWORK RUNNING.
  // Absent ⇒ false.
  finalRoundPending?: boolean;
  // Operator dismissed / took over this stalled rework; the rework classification skips it.
  // Absent ⇒ false.
  dismissed?: boolean;
  updatedAt: number;
}

/** The plan reviewer's resolved CLI + model + effort for the currently in-flight run. Carried on
 *  the `session:plangate-reviewing` start signal (and the `/api/plan-gates/inflight` bootstrap) so
 *  the UI can show which coding CLI/model is doing the review before a gate — and thus its
 *  `reviewer*` fields — exists (notably the first review). `provider: null` for legacy /
 *  restart-adopted reviews whose CLI couldn't be resolved. */
export type ReviewerEnv = {
  provider: AgentProvider | null;
  model: string | null;
  effort: string | null;
};

// ── visual recap blocks ──────────────────────────────────────────────────────
// mirrors server VisualBlock union (Phase 1: rich-text + callout; file-tree + diff; Phase 2: code + more)
export type CalloutTone = "info" | "decision" | "risk" | "warning" | "success";
export type FileTreeChange = "added" | "modified" | "removed" | "renamed";
export interface FileTreeEntry {
  path: string;
  change: FileTreeChange;
  note?: string;
}
export interface DiffAnnotation {
  label?: string;
  note: string;
}
export type VisualBlock =
  | { type: "rich-text"; id: string; markdown: string }
  | { type: "callout"; id: string; tone: CalloutTone; markdown: string }
  | { type: "file-tree"; id: string; title?: string; entries: FileTreeEntry[] }
  | {
      type: "diff";
      id: string;
      path: string;
      summary: string;
      annotations?: DiffAnnotation[];
      file?: DiffFile;
    }
  | {
      type: "code";
      id: string;
      filename: string;
      /** Server-populated from DiffFile — never from LLM input. */
      code?: string;
      truncated?: boolean;
    }
  | {
      type: "annotated-code";
      id: string;
      filename: string;
      /** Prose-only annotations — no line anchors (decision #4). */
      annotations?: DiffAnnotation[];
      /** Server-populated from DiffFile — never from LLM input. */
      code?: string;
      truncated?: boolean;
    }
  | {
      type: "data-model";
      id: string;
      /** Server-forced to true — never trusted from LLM input. */
      inferred?: boolean;
      entities: {
        id: string;
        name: string;
        fields: {
          name: string;
          type: string;
          pk?: boolean;
          fk?: string;
          nullable?: boolean;
          change?: FileTreeChange;
          was?: string;
        }[];
      }[];
      relations?: { from: string; to: string; kind: string }[];
    }
  | {
      type: "api-endpoint";
      id: string;
      method: string;
      path: string;
      summary?: string;
      change?: string;
      deprecated?: boolean;
      /** Server-forced to true — never trusted from LLM input. */
      inferred?: boolean;
      params?: { name: string; in: string; type: string; required?: boolean; note?: string }[];
      responses?: { status: number; description?: string; example?: string }[];
    }
  | { type: "table"; id: string; columns: string[]; rows: string[][] }
  | {
      type: "checklist";
      id: string;
      items: { id: string; label: string; note?: string; checked?: boolean }[];
    }
  | { type: "mermaid"; id: string; source: string; caption?: string; inferred?: boolean }
  | {
      type: "wireframe";
      id: string;
      surface: "browser" | "desktop" | "mobile" | "popover" | "panel";
      html: string;
      caption?: string;
    }
  | {
      type: "question-form";
      id: string;
      questions: {
        id: string;
        prompt: string;
        kind: "single" | "multi" | "freeform";
        options?: string[];
      }[];
    };

/** A single operator answer to a plan question-form question, keyed by (blockId, questionId).
 *  `optionIndices` is for single (one) / multi (zero+); `text` is for freeform. Mirrors the
 *  server's RawAnswer (#803). */
export interface RawAnswer {
  blockId: string;
  questionId: string;
  optionIndices?: number[];
  text?: string;
}

// ── session recap ────────────────────────────────────────────────────────────
// mirrors server Recap / RecapState / RecapVerdict
export type RecapState = "generating" | "ready" | "failed" | "empty";
export type RecapVerdict = "ready" | "parked" | "needs_attention";
/** Mirrors server RecapSkipCode/RecapEvidenceKind/RecapSkipParams/RecapSkip — declared explicitly
 *  here (the server's `LandedWorkEvidence` isn't importable from ui/). Kept in lockstep. */
export type RecapSkipCode =
  "metadata-mismatch" | "base-refresh-failed" | "ancestry-check-failed" | "empty-diff-contradicted";
export type RecapEvidenceKind = "merged_pr" | "review" | "existing_recap";
export interface RecapSkipParams {
  branch?: string;
  current?: string;
  evidenceKind?: RecapEvidenceKind;
  evidencePr?: number;
  baseRef?: string;
}
export interface RecapSkip {
  code: RecapSkipCode;
  params: RecapSkipParams;
}
export interface Recap {
  sessionId: string;
  state: RecapState;
  headSha: string;
  verdict: RecapVerdict | null;
  headline: string; // "" on a coded skip — render the localized headline from `skip`
  body: string; // "" on a coded skip — render the localized body from `skip`
  // Sentinel code + params for a `failed` skip rendered per-locale; absent → render headline/body verbatim.
  skip?: RecapSkip | null;
  openItems: string[];
  changedFiles: string[];
  spawnSessionId: string;
  cwd: string;
  model: string | null;
  spawnedAt: number;
  generatedAt: number | null;
  updatedAt: number;
  blocks?: VisualBlock[]; // arrives over session:recap WS payload; optional for back-compat
}

// mirrors server HerdDigest / RundownItem / HerdDigestState
export type HerdDigestState = "generating" | "ready" | "failed";
export interface RundownItem {
  label: string;
  sessionId?: string;
  pr?: number;
}
// Tier-1 "land this epic" item (#1045) — server ground truth; repo/parent deep-link to the band.
// pausedReason: present when auto-rebase is paused; 'cap'|'conflict'|'driver' (#1071).
export interface RundownEpicItem {
  repo: string;
  parent: number;
  title: string;
  landingPr: number | null;
  stranded: boolean;
  /** Present when the auto-rebase pass is paused and operator action is needed (#1071). */
  pausedReason?: "cap" | "conflict" | "driver";
  /** The landing PR's CI is terminally failing and needs operator attention (mirrors server
   *  RundownEpicItem.ciFailing). Not set while a repair session is live — see `repairing`. */
  ciFailing?: boolean;
  /** Non-actionable: a capped auto-repair agent session is live, driving this landing's CI back
   *  to green (mirrors server RundownEpicItem.repairing). Mutually exclusive with `ciFailing`. */
  repairing?: boolean;
}
export interface HerdDigest {
  dayKey: string;
  state: HerdDigestState;
  overnight: string;
  decisions: RundownItem[];
  ciRework: RundownItem[];
  train: string;
  focusNext: RundownItem[];
  epicsToLand: RundownEpicItem[];
  attentionFingerprint: Record<string, string[]>;
  spawnSessionId: string;
  cwd: string;
  model: string | null;
  spawnedAt: number;
  generatedAt: number | null;
  updatedAt: number;
  /** Route-computed at GET time; NOT stored. */
  staleCount?: number;
}

export type ReviewDecision = "changes_requested" | "commented" | "error";
export interface ReviewVerdict {
  sessionId: string;
  headSha: string;
  decision: ReviewDecision;
  summary: string;
  body: string;
  findings: string[]; // discrete actionable items; [] = nothing to address
  addressRound: number; // auto-address steers spent on the current findings streak
  addressCap: number; // server's streak cap for this run — the badge reads it instead of mirroring
  finalRoundPending: boolean; // cap-th steer just delivered, no re-review yet → dimmed FINAL badge
  finalRoundTimeoutMs: number; // live abandonment timeout (ms); UI escalates FINAL→STALLED after this
  // Operator dismissed / took over this stalled critic rework; the rework classification skips it.
  // Absent ⇒ false.
  dismissed?: boolean;
  url?: string;
  updatedAt: number;
}
/** The per-repo sandbox confinement profile. trusted = no sandbox (default);
 *  standard = filesystem/process membrane (interactive-only, unrestricted network);
 *  autonomous = same membrane + network-egress allowlist (Anthropic + forge),
 *  required for auto/drain sessions. */
export type SandboxProfile = "trusted" | "standard" | "autonomous";

export interface RepoConfig {
  criticEnabled: boolean;
  /** Standalone repo-level PR critic: review EVERY open CI-green PR, not just session PRs (default off). */
  criticAllPrs: boolean;
  autoAddressEnabled: boolean;
  learningsEnabled: boolean;
  autopilotEnabled: boolean;
  autoDrainEnabled: boolean;
  autoMergeEnabled: boolean;
  buildQueueEnabled: boolean;
  /** Pre-execution plan gate: grill + adversarial plan review before execution (default off). */
  planGateEnabled: boolean;
  /** Open new PRs as drafts; mutually exclusive with autoMergeEnabled (default false). */
  draftMode: boolean;
  /** Who may promote a draft PR to ready-for-review (default "human"). */
  signoffAuthority: "human" | "critic" | "either";
  /** Per-repo sandbox confinement profile (default "trusted" = no sandbox). */
  sandboxProfile: SandboxProfile;
  /** Per-repo default-model override; "inherit" (default) defers to the global default. */
  defaultModel: string;
  /** Per-repo default-effort override; "inherit" (default) defers to the global default. */
  defaultEffort: string;
  maxAuto: number;
  autoLabel: string;
  usageCeilingPct: number;
  /** Whether this repo uses a forge (GitHub/Gitea) or lightweight local-only mode. */
  repoMode: "forge" | "lightweight";
  /** When a rule starts failing, rewrite it once automatically before auto-retirement eligibility. */
  autoOptimizeFlagged: boolean;
  /** On a session PR merge, open a GitHub tracking issue listing the manual operator steps (#1061).
   *  Default off — outbound write gated behind explicit per-repo opt-in. */
  manualStepsIssueEnabled: boolean;
  /** Opens the epic's landing PR early as a draft during drain so each child merge re-runs
   *  landing CI against main (#1664). Default off — opt-in. */
  preWarmEpicLandingCi: boolean;
  /** Hidden from the Backlog repos panel (list-only declutter; sessions/drain unaffected). Default off. */
  hidden: boolean;
  /** Local, non-replicated preview start script path stored by Shepherd. */
  previewStartScript?: string | null;
  /** Command captured when Shepherd generated the local preview start script. */
  previewStartCommand?: string | null;
  /** What clicking a live Preview chip does by default for this repo. */
  previewOpenMode: "ask" | "inline" | "tab";
}

/** Live per-repo merge-train status pushed to clients (mirrors server AutoMergeStatus). */
export interface AutoMergeStatus {
  repoPath: string;
  enabled: boolean;
  /** "merging" | "rebasing" | "merge_error" | "rebase_cap" while acting/paused; null when idle. */
  state: string | null;
  /** A desig for the operator banner, when relevant. */
  detail: string | null;
  /** The affected session's id, so a deep-link selects it; null when none. */
  sessionId: string | null;
}

/** Live draft-reconcile result pushed per session (mirrors server DraftReconcileStatus).
 *  state=null = success (clear any prior alert); state=promote_error/enforce_error = failure. */
export interface DraftReconcileStatus {
  repoPath: string;
  sessionId: string;
  state: "promote_error" | "enforce_error" | null;
  detail: string | null;
}

export interface DrainStatus {
  repoPath: string;
  enabled: boolean;
  paused: boolean;
  reason: string | null;
  detail: string | null;
  queued: number;
  inFlight: number;
  max: number;
  epicParent: number | null;
}

// ── epics ──────────────────────────────────────────────────────────────────
export type EpicSource = "native" | "markdown";
export type EpicMode = "auto" | "attended";
export type EpicRunStatus = "idle" | "running" | "paused";
export type EpicChildState = "merged" | "in-review" | "running" | "ready" | "blocked";
export interface EpicChild {
  number: number;
  title: string;
  url: string;
  order: number;
  body: string;
  blockedBy: number[];
  state: EpicChildState;
  sessionId: string | null;
  prNumber: number | null;
  issueClosed: boolean;
  claimed: boolean;
}
export interface EpicRun {
  repoPath: string;
  parentIssueNumber: number;
  mode: EpicMode;
  status: EpicRunStatus;
  agentProvider?: AgentProvider | null;
  model?: string | null;
  effort?: string | null;
}
export interface Epic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  source: EpicSource;
  children: EpicChild[];
  warnings: string[];
  /** True when the epic has ≥2 `ready` children and 0 dependency edges — surfaced as a
   *  dedicated translated legibility line on the epic panel (mirrors src/epic-core.ts). */
  noDependencyEdges?: boolean;
  run: EpicRun;
}
export interface EpicSummary {
  parentIssueNumber: number;
  parentTitle: string;
  total: number;
  merged: number;
  status: EpicRunStatus;
  source: EpicSource;
  // ── "someone else is already working / owns this epic" signals (server: computeEpicOthersFlags) ──
  // NOTE: emitted by the /api/epics inline literal (src/server.ts), which has NO server-side
  // EpicSummary type — nothing cross-checks these names at compile time; keep them in sync.
  // Optional so older payloads / UI test fixtures stay valid; the server always populates them.
  /** Children with an OPEN PR by a non-viewer (viewer's own excluded from the count). 0 → no pill. */
  inFlight?: number;
  /** Distinct non-viewer authors of those in-flight child PRs — the pill's "by …". */
  inFlightBy?: string[];
  /** Parent assignees other than the viewer. */
  assignedOthers?: string[];
  /** Parent author when it isn't the viewer, else null — the tell for a fresh, unassigned epic. */
  authoredByOther?: string | null;
}

// ── epic diagnosis (GET /api/epic/diagnose) — mirrors src/epic-diagnosis.ts ──
export type EpicDiagnosisSeverity = "info" | "warning" | "error";
export type EpicDiagnosisAction = "import-structure";
/** One structural finding about an epic's shape. `id` is a stable slug (no-children |
 *  markdown-source | truncated-open-list | all-parallel | self-dependency |
 *  outside-epic-dependency | native-body-disagree); `params` feeds message interpolation;
 *  `action` names an offered remediation when present. */
export interface EpicDiagnosisFinding {
  id: string;
  severity: EpicDiagnosisSeverity;
  params?: Record<string, string | number>;
  action?: EpicDiagnosisAction;
}
export interface EpicDiagnosis {
  parentIssueNumber: number;
  recognized: boolean;
  source: EpicSource | null;
  findings: EpicDiagnosisFinding[];
  additionalWarnings: string[];
}

/** One child issue in a completed epic record.
 *  Carried inside CompletedEpic; mirrors the server-side CompletedEpicChild shape. */
export interface CompletedEpicChild {
  number: number;
  title: string;
  url: string;
  prNumber: number | null;
  prUrl: string | null;
  mergedAt: number | null;
  integrated: boolean;
}

/** A durable record of a fully-integrated epic; surfaced in the completed-epics band.
 *  GET /api/epics/completed payload item; pushed live via the `epic:completed` WS event. */
export interface CompletedEpic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  completedAt: number;
  children: CompletedEpicChild[];
  // Stage B (#635) landing-PR carried on the band; null/'pending' until the aggregate PR opens.
  landingPrNumber: number | null;
  landingPrUrl: string | null;
  // Landing-PR lifecycle state (mirrors server EpicLandingState): pending=not yet
  // resolved, open=PR opened/reused, merged=landing PR merged (epic landed), none=nothing
  // to land, error=last attempt failed.
  landingState: "pending" | "open" | "merged" | "none" | "error";
  // Migration-awareness checkpoint (#645): migration file paths detected in the landing PR
  // (empty when none / detection unavailable) + the epoch the operator acknowledged them (null
  // until acknowledged). A non-empty migrationPaths with a null migrationsAckedAt makes the row
  // ask for acknowledgement before it can be cleared — never gates the completion flip.
  migrationPaths: string[];
  migrationsAckedAt: number | null;
  // Live, display-only landing-PR gate signals from GET /api/epics/completed (server #1039);
  // present only for open-landing rows the server could fetch. Drive the "Land epic" CTA + escalation.
  landingChecks?: ChecksState;
  landingMergeable?: boolean | null;
  landingReady?: boolean;
  landingStranded?: boolean;
  // When the auto-rebase pass is paused and operator action is needed (#1071); null when not paused.
  landingRebasePauseReason?: "cap" | "conflict" | "driver" | null;
  /** Non-actionable: a capped auto-repair agent session is live and driving this landing PR's CI
   *  back to green — suppresses the operator's CI-failing surface while genuinely live (mirrors
   *  server CompletedEpic.landingRepairing). A stuck/finished session falls back to the plain
   *  CI-failing state instead. */
  landingRepairing?: boolean;
}

/** One queued backlog issue behind DrainStatus.queued — a row in the queue popover.
 *  GET /api/drain/queue?repo= payload (in drain order). */
export interface QueuedItem {
  number: number;
  title: string;
  url: string;
}

/** GET /api/sessions/:id/git payload: forge kind + current PR status. */
export interface GitState extends PrStatus {
  kind: ForgeKind;
  /** True when the repo has no CI to wait on (GitHub + zero workflows): a terminal `checks:"none"`
   *  is treated as cleared (reviewed/merge-ready/awaiting-merge) rather than as a pre-CI race.
   *  Stamped server-side; mirror of the server GitState field. Absent ⇒ false. */
  noCi?: boolean;
  /** Who is up once the PR is open + green, when it isn't the operator (computed
   *  server-side from `.shepherd/roles.json`). Absent = the operator's turn. */
  handoff?: "reviewer" | "merger";
  /** The login to display for {@link handoff} (e.g. "scoop"). */
  handoffWho?: string;
  /** Role-scoped active requested-changes block for the configured reviewer. */
  reviewBlock?: {
    reviewer: string;
    state: "changes_requested";
    latestAt: number | null;
  };
  /** Web URL of the backlog issue this session was spawned for, or absent when the
   *  session has no linked issue or the repo has no web forge (local mode). */
  issueUrl?: string;
}

/** Per-repo reviewer + merger logins, from `.shepherd/roles.json`. */
export interface RepoRoles {
  reviewer: string | null;
  merger: string | null;
}

export interface SessionActivity {
  /** ms epoch of the newest transcript record — the heartbeat. 0 if none yet. */
  lastActivityTs: number;
  /** Latest meaningful tool-use summary, verbatim (e.g. "edited poller.ts", "$ bun test"); null if no tool-use yet. */
  summary: string | null;
  /** ms-epoch timestamps of in-window tool-use events (oldest→newest) for the row heat-strip. */
  recentTs: number[];
  /** Subset of recentTs whose tool-use errored; the client tints those slices red. */
  recentErrTs: number[];
}

export interface Session {
  id: string;
  desig: string;
  name: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  branch: string | null;
  worktreePath: string;
  isolated: boolean;
  herdrSession: string;
  herdrAgentId: string;
  claudeSessionId: string;
  agentProvider?: AgentProvider;
  model: string | null;
  // Optional on the client mirror: the server always sends it, but the only consumer
  // (`s.effort ?? "default"` when seeding the relaunch composer) tolerates its absence,
  // so test fixtures need not set it.
  effort?: string | null;
  status: SessionStatus;
  /** Operator-set "parked / done" flag, orthogonal to status. Default false. */
  readyToMerge: boolean;
  /** Epoch ms when a merge train marked this PR-session in-flight; null when not.
   *  Transient — cleared server-side on merge/close, train archive, or TTL. */
  mergingSince: number | null;
  /** Id of the owning merge-train session; null when not merging. */
  mergingTrainId: string | null;
  /** PR numbers selected by the merge train for this TRAIN session; null on non-train sessions. */
  mergeTrainPrs: number[] | null;
  autopilotEnabled: boolean | null;
  autopilotStepCount: number;
  autopilotPaused: boolean;
  /** True when autopilot judged the task done with a non-PR deliverable (research / issue
   *  creation / one-off answer) — a clean "completed", distinct from a pause. */
  autopilotComplete: boolean;
  autopilotQuestion: string | null;
  /** Plan-gate opt-in: true/false override, or null to inherit the repo default. */
  planGateEnabled: boolean | null;
  /** Plan-gate phase: "planning" (grill+review) → "executing" (gate passed); null = gate off. */
  planPhase: "planning" | "executing" | null;
  autoMergeEnabled: boolean | null;
  autoMergeRebaseCount: number;
  /** Whether this session was launched by the auto-drain queue. */
  auto: boolean;
  /** The sandbox profile actually applied to this session's spawn; null if not stamped. */
  sandboxApplied: SandboxProfile | null;
  /** True when the requested sandbox couldn't be applied — the agent ran unconfined. */
  sandboxDegraded: boolean;
  /** Research task kind: web research → report PR or issue; never code-PR-steered. */
  research: boolean;
  /** Epic-authoring task kind: attended guided shaping → an EPIC draft; writes no GitHub issues. */
  epicAuthoring: boolean;
  /** True when the network-egress allowlist was applied (autonomous sessions only). */
  egressApplied: boolean;
  /** True when the egress backend was unavailable — outbound is unrestricted despite autonomous profile. */
  egressDegraded: boolean;
  /** Issue number that seeded this session; null when launched without an issue. */
  issueNumber: number | null;
  /** Launch-time display metadata for the task-id tooltip. Null/absent for legacy rows. */
  launchMetadata?: SessionLaunchMetadata | null;
  /** Web URL of the linked forge issue. Populated **only** by the Done-list endpoint
   *  (`GET /api/sessions/done`) for archived sessions — the live counterpart is
   *  {@link GitState.issueUrl}, keyed by active session id and absent once archived. Same
   *  semantic URL, two distinct population paths; neither is a single source of truth. */
  issueUrl?: string;
  lastState: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Reason the session halted mid-run; null when not halted. */
  haltReason: "usage_limit" | "completed" | "operator" | "error" | null;
  /** Epoch ms when haltReason was set; null when not halted. */
  haltedAt: number | null;
  /** Manual operator steps detected in this session's PR body (#1059); [] when none/undetected. */
  manualSteps: ManualStep[];
  /** Epoch ms the operator acknowledged the manual steps; null until acknowledged (P2). */
  manualStepsAckedAt: number | null;
  /** Comparison-experiment group id this session belongs to; null = not part of an experiment. */
  experimentId: string | null;
  /** This session's role within its experiment; null when not in one. */
  experimentRole: ExperimentRole | null;
  /** Transient, server-derived: true when the session's scratchpad holds any file/dir (#1164).
   *  Gates the Files tab. Not persisted — folded into the /api/sessions payload + session:status
   *  (idle/done) push; absent (undefined) on partial pushes that don't recompute it. */
  hasScratchpadFiles?: boolean;
}

/** A manual operator step parsed from a PR's shepherd:manual-steps carrier (#1059). Mirrors the
 *  server `ManualStep` shape in src/manual-steps.ts. */
export interface ManualStep {
  id: string;
  text: string;
  postMerge: boolean;
}

/** One materialized post-merge step (#1061): a ManualStep frozen at merge + a per-step done stamp.
 *  Mirrors the server `PostMergeStep` in src/types.ts. */
export interface PostMergeStep {
  id: string;
  text: string;
  postMerge: boolean;
  doneAt: number | null;
}

/** Durable post-merge materialization of a merged session's outstanding manual operator steps
 *  (#1061, epic #1056 P3). Mirrors the server `PostMergeSteps` in src/types.ts. */
export interface PostMergeSteps {
  sessionId: string;
  desig: string;
  repoPath: string;
  prNumber: number | null;
  prTitle: string;
  steps: PostMergeStep[];
  trackingIssueUrl: string | null;
  trackingIssueNumber: number | null;
  createdAt: number;
  updatedAt: number;
  clearedAt: number | null;
}

/** Snapshot of a session's manual steps captured when its chip is clicked, so the Owed panel can
 *  render a read-only "frozen" card when no live outstanding record exists (pre-merge, cleared,
 *  dismissed, or load-failed). #<owed> */
export interface OwedFocusSnapshot {
  sessionId: string;
  desig: string;
  prNumber: number | null;
  steps: ManualStep[]; // frozen from session.manualSteps at click time
  merged: boolean; // git state === "merged" at click time
}

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  messageCount: number;
  lastActivity: number | null;
  byModel: Record<string, number>;
}

export interface ActivityEntry {
  ts: number;
  tool: string;
  summary: string;
  status: "ok" | "error" | "pending";
}

/**
 * One entry in a session's sub-agent roster (mirrors the server shape).
 * `startedAt`/`endedAt` are ms-epoch server time; `endedAt` absent ⇒ the
 * sub-agent is still live.
 */
export interface SubagentEntry {
  agentId: string;
  agentType: string;
  startedAt: number;
  endedAt?: number;
}

export interface LimitWindow {
  pct: number;
  resetAt: number;
}
/**
 * Paid pay-as-you-go extra-credit overage (mirrors the server's CreditWindow).
 * The truth signal for "running into extra credits" is `spent > 0` on a FRESH
 * snapshot (`!stale`), NOT `pct` — pct rounds to 0 while money is already spent.
 */
export interface CreditWindow {
  /** Panel's rounded % — can be 0 while real money is spent; do NOT rely on it for "is spending". */
  pct: number;
  /** Money spent this monthly window (e.g. 0.29). */
  spent: number;
  /** Monthly extra-usage budget (e.g. 50). */
  cap: number;
  /** Currency symbol, e.g. "€" — passed through verbatim, NOT translated. */
  currency: string;
  /** Monthly reset epoch ms, or null. */
  resetAt: number | null;
  /** When this snapshot was scraped. */
  scrapedAt: number;
  /** True when the snapshot is older than 1h (credits is scrape-fresh-only). */
  stale: boolean;
}
/**
 * Live per-model weekly sub-limit ("Current week (Fable)") — a passthrough of the last /usage
 * scrape, keyed by model. Not recomputed from JSONL, so it carries its own `stale`/`scrapedAt`
 * and a nullable `resetAt` (the gauge may render without a reset label).
 */
export interface ModelWeekWindow {
  /** Lowercase model slug, e.g. "fable" (proper-noun display name derived in the UI). */
  model: string;
  pct: number;
  resetAt: number | null;
  scrapedAt: number;
  stale: boolean;
}
export interface UsageLimits {
  session5h: LimitWindow | null;
  week: LimitWindow | null;
  /** Per-model weekly sub-limits (passthrough). Empty when none rendered. */
  perModelWeek: ModelWeekWindow[];
  /** Paid extra-credit overage; null when extra usage is off or post-reset. */
  credits: CreditWindow | null;
  stale: boolean;
  calibratedAt: number | null;
  /** true in api-key auth mode: usage tracking is subscription-only, meters carry no data. */
  subscriptionOnly: boolean;
  providers?: UsageProviderSnapshot[];
}

export type UsageProviderSnapshot =
  | {
      provider: "claude";
      kind: "limits";
      session5h: LimitWindow | null;
      week: LimitWindow | null;
      perModelWeek: ModelWeekWindow[];
      credits: CreditWindow | null;
      stale: boolean;
      calibratedAt: number | null;
      subscriptionOnly: boolean;
    }
  | {
      provider: "codex";
      kind: "tokens";
      totalTokens: number;
      session5hTokens: number;
      weekTokens: number;
      updatedAt: number | null;
      stale: boolean;
      /** 5h/weekly used-% + reset scraped from Codex's own session rollout logs; null when no
       *  rate-limit event has been logged yet (UI then shows just the raw token counts). */
      session5h: LimitWindow | null;
      week: LimitWindow | null;
      rateLimitSource?: "rollout" | "missing";
      rateLimitCheckedAt?: number;
      rateLimitFilesScanned?: number;
      rateLimitLatestEventAt?: number | null;
    };

export type UsageRange = "24h" | "7d" | "30d" | "all";

/** One GitHub rate-limit bucket (REST core / GraphQL / search). Mirrors the
 *  server `GhRateBucket`. */
export interface GhRateBucket {
  limit: number;
  used: number;
  remaining: number;
  /** Epoch-ms when this bucket refills. */
  resetAt: number;
}

/** GitHub REST + GraphQL rate-limit state shown in the usage view's GitHub tab.
 *  Mirrors the server `GithubRateLimitPayload`. GitHub runs the REST and GraphQL
 *  buckets independently, so one can be exhausted while the other is healthy. */
export interface GithubRateLimit {
  rest: GhRateBucket | null;
  graphql: GhRateBucket | null;
  search: GhRateBucket | null;
  /** Epoch-ms when these readings were fetched. */
  fetchedAt: number;
  /** Shepherd's GraphQL backoff state — explains a polling pause even before a
   *  bucket is fully empty. */
  backoff: {
    remaining: number | null;
    resetAt: number | null;
    pausedUntil: number | null;
    blocked: boolean;
  };
}

/** Raw token detail (authoring side). */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One task's spend within a repo. */
export interface UsageTaskBreakdown {
  sessionId: string;
  desig: string; // e.g. "TASK-07" — data, never translated
  name: string; // human-readable short name, e.g. "add-auth-flow"; "" for legacy rows — data, never translated
  model: string; // dominant model id, e.g. "claude-opus-4-8"
  authoringUnits: number; // weighted units, main agent
  satelliteUnits: number; // weighted units, reviewer/critic/etc spawns
  dollars: number | null; // absolute USD spend; null unless api-key auth mode
  tokens: UsageTokens; // raw authoring token detail
  byModel: Record<string, number>; // weighted units per model id
}

/** A repo grouping its tasks. */
export interface UsageRepoBreakdown {
  repoPath: string;
  repoName: string;
  authoringUnits: number;
  satelliteUnits: number;
  dollars: number | null; // absolute USD spend; null unless api-key auth mode
  tasks: UsageTaskBreakdown[];
}

/** One satellite-pass kind's global, spawn-timestamp-filtered tally (Overhead lens). */
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

/** Top-level breakdown — serves the Spend + Overhead lenses. */
export interface UsageBreakdown {
  range: UsageRange;
  generatedAt: number; // ms epoch
  totalUnits: number; // authoring + satellite, all repos
  authoringUnits: number;
  satelliteUnits: number;
  cacheReadUnits: number; // cheap-cache share (Overhead b)
  generationUnits: number; // non-cacheRead share (Overhead b)
  satelliteByKind: UsageKindUnits[]; // global per-kind satellite tally, sorted desc by units
  dollars: number | null; // absolute USD spend; null unless api-key auth mode
  models: {
    claude: UsageModelBreakdown;
    codex: UsageModelBreakdown;
  };
  repos: UsageRepoBreakdown[];
}

/** One hour of weighted-unit consumption (mirrors server UsageTimelineHour). */
export interface UsageTimelineHour {
  hourStart: number; // ms epoch, floored to the hour (UTC boundary); never 0 (timeless rows excluded)
  units: number; // weighted units consumed in that hour (authoring + live + satellite)
}

/** GET /api/usage/timeline response — the Timeline lens's per-hour series.
 *  `hours` is ASC by `hourStart` and contains only non-empty hours; `totalUnits`
 *  and `peakHourUnits` span the full range even when the UI grid is row-capped. */
export interface UsageTimeline {
  range: UsageRange;
  generatedAt: number; // ms epoch
  hours: UsageTimelineHour[];
  totalUnits: number; // Σ units across all in-range hours
  peakHourUnits: number; // max single-hour units (0 when empty) — heatmap color reference
}

/** Burn-down projection for the Limits lens. */
export interface UsageProjection {
  window: "5H" | "WK";
  projectedPct: number; // projected % at window reset if burn-rate holds
  resetAt: number; // ms epoch of window reset
  burnRatePerHour: number; // recent weighted units/hour
}

/** Combined payload of GET /api/usage/limits: the limit windows + their live burn-rate projections. */
export interface UsageLimitsResponse {
  limits: UsageLimits;
  projections: UsageProjection[];
}

/** One persisted cap-scrape sample (mirrors server CapRow). */
export interface CapHistoryPoint {
  window: "session5h" | "week";
  cap: number;
  resetAt: number;
  pct: number;
  scrapedAt: number;
}

/** One persisted credit-scrape sample (mirrors server CreditSnapshot). */
export interface CreditHistoryPoint {
  spent: number;
  cap: number;
  currency: string;
  pct: number;
  resetAt: number | null;
  scrapedAt: number;
}

/** GET /api/usage/history response: all three recorded series, ASC by scrapedAt. */
export interface UsageHistoryResponse {
  caps: {
    session5h: CapHistoryPoint[];
    week: CapHistoryPoint[];
  };
  credit: CreditHistoryPoint[];
  since: number;
}

export interface UpdateCommit {
  sha: string;
  subject: string;
}

export interface UpdateStatus {
  behind: number;
  current: string | null;
  latest: string | null;
  commits: UpdateCommit[];
  checkedAt: number;
  error?: string;
}

/** Live state of the detached deploy launched by an update apply. */
export type DeployPhase = "idle" | "running" | "done" | "failed";

export interface DeployState {
  phase: DeployPhase;
  exitCode: number | null;
  log: string;
}

/** Informational herdr-version update check (no auto-apply). */
export interface HerdrUpdateStatus {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  notes: string | null;
  checkedAt: number;
  error?: string;
}

/** Informational codex-version (npm @openai/codex) update check (manual apply).
 *  Same shape as HerdrUpdateStatus; `notes` is always null for codex. */
export interface CodexUpdateStatus {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  notes: string | null;
  checkedAt: number;
  error?: string;
}

/** Terminal outcome of a codex update apply() — the UI mirror of the server's
 *  CodexUpdateResult (src/codex-update.ts). Shared by the `codex-update:done`
 *  event, the store's `codexUpdateDone` signal, and the modal's `done` prop. */
export interface CodexUpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  error?: string;
  /** On a non-converged update (version did not advance), the codex binary as
   *  resolved on PATH — lets the modal name which install is stuck instead of a
   *  blind retry loop. null/absent on success or when unresolved. */
  onPathBinary?: string | null;
}

/** Per-plugin update state (mirror of src/types.ts PluginUpdateState). */
export type PluginUpdateState =
  "up-to-date" | "update-available" | "incompatible" | "no-source" | "error";

/** One installed plugin's update status (mirror of src/types.ts PluginUpdateInfo). */
export interface PluginUpdateInfo {
  id: string;
  name: string;
  currentVersion: string;
  latestVersion: string | null;
  source: "repository" | "git" | "none";
  state: PluginUpdateState;
  detail?: string;
}

/** Informational installed-plugin update check (no auto-apply). Mirror of
 *  src/types.ts PluginUpdatesStatus. */
export interface PluginUpdatesStatus {
  plugins: PluginUpdateInfo[];
  updateAvailable: boolean;
  checkedAt: number;
}

/** State of the "star us on GitHub?" nudge (see src/star-prompt.ts). */
export interface StarPromptStatus {
  /** Render the nudge now? False once dismissed/starred/snoozed or still in the grace window. */
  shouldPrompt: boolean;
  /** Repo already starred — terminal state, so the nudge never returns. (The
   *  thank-you toast is driven by the star action's result, not this flag.) */
  starred: boolean;
}

/** repoPath → emoji map for per-project icons. */
export type ProjectIcons = Record<string, string>;

// ── backlog ────────────────────────────────────────────────────────────────
export interface BacklogProject {
  path: string;
  display: string;
  slug: string | null;
  kind: ForgeKind;
  lastUsedAt?: number;
  /** Agents run on this repo in the server's recent window — same metric the
   *  New Task repo picker pins its "recently worked on" group by. */
  recentAgentCount?: number | null;
  openIssues: number | null;
  openPRs: number | null;
  /** Open-PR breakdown by kind for the repo-list row; null for non-GitHub forges. */
  prKinds: { release: number; dependabot: number; regular: number } | null;
  /** Workflows defined under .github/workflows; null for non-GitHub forges. */
  workflows: number | null;
  /** Default-branch CI rollup for the Actions tab marker; null = unknown / non-GitHub. */
  ciStatus: "success" | "failure" | "pending" | null;
  /** Hidden from the repos panel (list-only declutter). The client filters/groups on this. */
  hidden: boolean;
}
export interface BacklogPayload {
  pinnedPath: string | null;
  projects: BacklogProject[];
  totals: { openIssues: number; openPRs: number };
}

// ── readiness (AI-readiness analyzer, Backlog "Readiness" mode) ──────────────
export type GuardrailId =
  | "formatter"
  | "linter"
  | "type_checker"
  | "commit_lint"
  | "git_hooks"
  | "pre_push_ci"
  | "lint_staged"
  | "test_runner"
  | "dead_code_audit"
  | "ci"
  | "dependency_automation"
  | "agent_instructions";
export interface GuardrailCheck {
  id: GuardrailId;
  present: boolean;
  /** Leverage-to-cut-AI-churn; higher = more human↔AI back-and-forth removed. */
  weight: number;
  /** Matched markers (file names / package fields) — verbatim, not translated. */
  evidence: string[];
}
/** Which stack the repo matched, or null when it matches no supported ecosystem. */
export type Ecosystem = "js-ts" | "rust";
export interface ReadinessReport {
  /** False when the repo matches no supported ecosystem (no package.json or Cargo.toml) — the baseline is N/A. */
  applicable: boolean;
  /** The matched ecosystem, or null on the not-applicable path. */
  ecosystem: Ecosystem | null;
  /** Weighted 0–100 score derived from `checks`. */
  score: number;
  checks: GuardrailCheck[];
  hasAgentInstructions: boolean;
  /** Generated house-rules snippet — verbatim artifact, exempt from i18n. */
  claudeMd: string;
}

// ── environment-readiness diagnostics (issue #623) ──────────────────────────
export type DiagnosticState = "ok" | "optional" | "warning" | "error";
export interface DiagnosticCheck {
  id: string;
  state: DiagnosticState;
  hintKey: string;
  /** A non-secret public install command the operator can one-click-run via the Fix
   *  button. Present only on non-ok, auto-fixable checks (server sets it; guidance-only
   *  rows like tailscale and ok rows have none → no Fix button). */
  remediation?: string;
  /** A path-free message key naming a server-side code fix (no shell command),
   *  rendered as prose in the confirm modal instead of a `<code>` block. Mutually
   *  exclusive with `remediation`; either one enables the Fix button. */
  fixActionKey?: string;
}
export interface DiagnosticsSnapshot {
  checks: DiagnosticCheck[];
  generatedAt: number;
  overall: DiagnosticState;
}

export type DocAgentOutcome = "pr" | "observe" | "nochange" | "error";
export interface DocAgentRun {
  at: number;
  url: string | null;
  outcome: DocAgentOutcome;
}

/** One node in a plugin-authored declarative UI descriptor (issue #1185). `type` must
 *  match a host registry key, else the UI renders a fallback tile. `props` are
 *  JSON-serializable only; string props render VERBATIM (plugin-authored DATA, never an
 *  i18n key — consistent with the verbatim-data rule for tool-use summaries / PR titles).
 *
 *  Graphical node types (issue #1189) the host renders from `PLUGIN_UI_REGISTRY`, in
 *  addition to the flat primitives. All props are JSON-serializable; string props render
 *  VERBATIM (plugin-authored data). Tones reuse the vocabulary `neutral | ok | warn | error | info`.
 *
 *  - `gauge`        — radial snapshot of one value.
 *                     props: { label: string; value: number; max: number; tone?: Tone; caption?: string }
 *  - `sparkline`    — inline mini-trend from a short history.
 *                     props: { label?: string; points: number[]; tone?: Tone; caption?: string }
 *  - `time-series`  — line/area chart of a value over time.
 *                     props: { series: { label: string; tone?: Tone; points: number[] }[]; yMax?: number; kind?: "line" | "area"; caption?: string }
 *  - `bar-chart`    — categorical distribution.
 *                     props: { bars: { label: string; value: number; tone?: Tone }[]; max?: number; orientation?: "horizontal" | "vertical" }
 *  - `timeline`     — recent discrete events.
 *                     props: { events: { at: string; label: string; caption?: string; tone?: Tone }[] }
 */
export interface PluginUINode {
  type: string;
  props?: Record<string, unknown>;
  children?: PluginUINode[];
}
export interface PluginUIView {
  schemaVersion: 1;
  slot: "settings-panel" | "session-sidebar" | "dashboard-card";
  title?: string;
  root: PluginUINode;
}

/** A declarative action a plugin's gear-menu item performs on click. Discriminated by `kind`.
 *  All fields JSON-serializable; strings are verbatim plugin-authored DATA, never i18n keys. */
export type PluginGearAction =
  | { kind: "route"; method: "GET" | "POST"; path: string }
  | { kind: "url"; href: string }
  | { kind: "panel" };

/** One gear-menu item a plugin contributes via `ctx.publishGearItem`. At most ONE per plugin;
 *  latest publish wins; `null` clears it. Strings are verbatim plugin-authored DATA, not i18n. */
export interface PluginGearItem {
  /** Verbatim plugin-authored label (NOT an i18n key). */
  label: string;
  /** Optional single glyph/emoji icon (verbatim). */
  icon?: string;
  action: PluginGearAction;
}

/** A loaded server-side plugin as shown in Settings → Plugins (issue #1124). `health` is
 *  core-derived (unspoofable); `status` is the plugin's last publishStatus blob (verbatim). */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** Browser-clickable manifest repository URL, when declared and valid. */
  repository?: string;
  health: "ok" | "errored" | "timed-out";
  lastError: string | null;
  status: unknown;
  ui: PluginUIView | null;
  /** Last `publishGearItem` (validated/normalized), or null. */
  gearItem: PluginGearItem | null;
}

/** A plugin FOLDER on disk, as surfaced to the Settings → Plugins manager. Mirrors
 *  `InstalledPlugin` in src/plugins/types.ts — reflects the filesystem, so pending-restart,
 *  soft-disabled, and broken folders are listed too. The manager unions this by `id` with
 *  the live `PluginInfo[]`. */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  /** Browser-clickable manifest repository URL, when declared and valid. */
  repository?: string;
  /** Directory name under the plugins dir — the uninstall key. */
  folder: string;
  loaded: boolean;
  disabled: boolean;
  broken: boolean;
}

// Up Next (#1169) — cross-repo ranked queue of un-started work. Mirrors src/up-next-core.ts.
export type UpNextKind = "epic" | "bug" | "feature";
export interface UpNextItem {
  repoPath: string;
  repoSlug: string | null;
  repoLabel: string;
  number: number;
  title: string;
  url: string;
  kind: UpNextKind;
  priority: boolean;
  createdAt: number;
  /** The issue's labels (standalone) or the parent epic's labels (epic unit) — used by the
   *  hide-blocked display filter (isBlocked in issues-panel.ts). */
  labels: string[];
  epicParent?: { number: number; title: string };
  issueRef: { number: number; url: string; title: string; body: string };
}
export interface UpNextSection {
  kind: "priority" | "repo";
  repoPath: string | null;
  repoSlug: string | null;
  repoLabel: string | null;
  items: UpNextItem[];
  totalCount: number;
}
export interface UpNextSnapshot {
  generatedAt: number;
  sections: UpNextSection[];
  repoCount: number;
  fallback: string | null;
  /** Repos whose issue fetch failed this refresh; >0 + empty queue = surface a load error,
   *  not "all caught up". */
  failedRepoCount: number;
}

export type WsEvent =
  | { event: "session:new"; data: Session }
  | {
      event: "session:status";
      data: { id: string; status: SessionStatus; hasScratchpadFiles?: boolean } & Partial<Session>;
    }
  | { event: "session:ready"; data: { id: string; ready: boolean } }
  | {
      event: "session:merging";
      data: { id: string; since: number | null; trainId: string | null };
    }
  | {
      event: "session:autopilot";
      data: {
        id: string;
        paused: boolean;
        complete: boolean;
        question: string | null;
        enabled: boolean | null;
      };
    }
  | { event: "session:archived"; data: { id: string } }
  | {
      event: "session:experiment";
      data: { id: string; experimentId: string | null; experimentRole: ExperimentRole | null };
    }
  | { event: "session:renamed"; data: { id: string; name: string; branch: string | null } }
  | { event: "usage:limits"; data: UsageLimits }
  | { event: "session:block"; data: { id: string; block: BlockReason | null } }
  | { event: "session:hold"; data: { id: string; hold: HoldReason | null } }
  | {
      event: "session:halt";
      data: { id: string; haltReason: Session["haltReason"]; haltedAt: number | null };
    }
  | { event: "session:git"; data: { id: string; git: GitState } }
  | {
      event: "session:manual-steps";
      data: { id: string; manualSteps: ManualStep[]; manualStepsAckedAt?: number | null };
    }
  | { event: "session:activity"; data: { id: string; activity: SessionActivity } }
  | { event: "session:subagents"; data: { id: string; subagents: SubagentEntry[] } }
  | { event: "session:claude-alive"; data: { id: string; claudeAlive: boolean } }
  | { event: "session:working-blocked"; data: { id: string; working: boolean } }
  | { event: "session:preview"; data: { id: string; previewPort: number | null } }
  | { event: "session:preview-serve"; data: { id: string; serve: "ok" | "failed" | null } }
  | { event: "update:status"; data: UpdateStatus }
  | { event: "herdr-update:status"; data: HerdrUpdateStatus }
  | { event: "diagnostics:status"; data: DiagnosticsSnapshot }
  | { event: "star-prompt:status"; data: StarPromptStatus }
  | { event: "herdr-update:log"; data: { line: string } }
  | {
      event: "herdr-update:done";
      data: { ok: boolean; from: string | null; to: string | null; error?: string };
    }
  | { event: "codex-update:status"; data: CodexUpdateStatus }
  | { event: "codex-update:log"; data: { line: string } }
  | { event: "codex-update:done"; data: CodexUpdateResult }
  | { event: "plugin-update:status"; data: PluginUpdatesStatus }
  | { event: "project-icons:update"; data: ProjectIcons }
  | { event: "session:recap"; data: { id: string; recap: Recap | null } }
  | { event: "herd:digest"; data: { digest: HerdDigest } }
  | { event: "upnext:snapshot"; data: { snapshot: UpNextSnapshot } }
  | { event: "session:review"; data: { id: string; review: ReviewVerdict | null } }
  | { event: "session:reviewing"; data: { id: string; reviewing: boolean } }
  | { event: "session:critic-activity"; data: { id: string; summary: string } }
  | {
      event: "session:plangate";
      // Emitted two ways: a fresh verdict carries `gate`; a phase flip carries `planPhase`.
      data: { id: string; gate?: PlanGate; planPhase?: "planning" | "executing" };
    }
  | {
      event: "session:plangate-reviewing";
      // `env` carries the reviewer CLI/model/effort on the start (reviewing:true) signal; absent on end.
      data: { id: string; reviewing: boolean; env?: ReviewerEnv };
    }
  | { event: "session:plangate-activity"; data: { id: string; summary: string } }
  | { event: "learnings:update"; data: { pending: number } }
  | {
      event: "plugin:status";
      data: { id: string; health: PluginInfo["health"]; status: unknown };
    }
  | { event: "plugin:ui"; data: { id: string; ui: PluginUIView | null } }
  | { event: "plugin:gear"; data: { id: string; gearItem: PluginGearItem | null } }
  | { event: "backlog:update"; data: BacklogPayload }
  | { event: "drain:status"; data: DrainStatus }
  | { event: "automerge:status"; data: AutoMergeStatus }
  | { event: "session:automerge"; data: { id: string; enabled: boolean | null } }
  | { event: "queue:update"; data: BuildQueue }
  | { event: "session:epic-draft"; data: EpicDraft }
  | { event: "halt:done"; data: { halted: number } }
  | { event: "mergetrain:landed"; data: { repoPath: string } }
  | { event: "draftreconcile:status"; data: DraftReconcileStatus }
  | { event: "epic:update"; data: Epic }
  | { event: "epic:completed"; data: CompletedEpic }
  | { event: "epic:completed-cleared"; data: { repoPath: string; parentIssueNumber: number } }
  | { event: "session:egress-drop"; data: { id: string; host: string } }
  | { event: "session:uploads-dropped"; data: { id: string; count: number } }
  | {
      event: "session:injection-detected";
      data: { id: string; count: number; labels: string[] };
    }
  | { event: "held:changed"; data: { count: number } }
  | { event: "post-merge-steps:changed"; data: Record<string, never> }
  | {
      event: "doc-agent:done";
      data: { repoPath: string; url: string | null; outcome: DocAgentOutcome };
    }
  | { event: "repo:untrusted-author"; data: { repoPath: string; issue: number } };

/** Optional override bag for relaunch; absent fields inherit the original session. */
export interface RelaunchOverrides {
  repoPath?: string;
  baseBranch?: string;
  prompt?: string;
  /** Agent CLI override; absent → keep the original's provider. */
  agentProvider?: AgentProvider;
  model?: string | null;
  effort?: string | null;
  planGateEnabled?: boolean | null;
  images?: string[];
  attachmentNames?: string[];
  launchUiState?: LaunchUiState;
}

export interface LaunchUiState {
  researchChecked: boolean;
  planGateChecked: boolean;
  autopilotChecked: boolean;
  epicAuthoringChecked?: boolean;
}

export interface LaunchAttachmentMetadata {
  submittedName: string;
  launchedName: string | null;
  dropped: boolean;
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

export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  agentProvider?: AgentProvider;
  model: string | null;
  effort?: string | null; // reasoning-effort tier; null/absent → provider default (no effort flag)
  images?: string[]; // absolute staged upload paths from /api/uploads
  attachmentNames?: string[];
  issueRef?: IssueRef; // optional attached issue; body appended server-side
  launchUiState?: LaunchUiState;
  planGateEnabled?: boolean | null; // per-task plan-gate override; absent → inherit repo default
  autopilotEnabled?: boolean | null; // per-task autopilot override; absent/null → inherit repo default
  sandboxProfile?: SandboxProfile | null; // per-spawn sandbox override; absent → inherit repo default
  research?: boolean; // research task kind; absent → false
  epicAuthoring?: boolean; // epic-authoring task kind; absent → false (guided EPIC-draft shaping)
  mergeTrainPrs?: number[]; // merge-train participant PR numbers; server marks them "merging" on create
}

/** A task that was held (not immediately spawned) because usage was too high.
 *  Returned by GET /api/held and the POST /api/sessions held-path. */
export interface HeldTask {
  id: string;
  repoPath: string;
  input: CreateInput;
  createdAt: number;
}

/** Returned by POST /api/sessions when the task is held instead of spawned immediately. */
export interface HeldResult {
  held: true;
  id: string;
  count: number;
}

/** Selectable Claude model aliases; null = Claude's own default.
 *  The "[1m]" suffix enables Claude Code's 1M-context window and passes straight
 *  through to --model; each 1M variant sits next to its 200K base. */
const CLAUDE_MODELS = ["fable", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"] as const;

/** Back-compat alias used throughout the existing Claude default-model settings. */
export const MODELS = CLAUDE_MODELS;

/** Reasoning-effort tiers, least→most effort. Mirrors src/types.ts EFFORTS (the Claude `--effort`
 *  domain). Codex's narrower domain (no xhigh/max) is handled by the picker's provider filter +
 *  the server-side clamp. "default" (settings) / null (session) = no flag. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Curated Codex CLI model aliases shown in the task dialog. */
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

/** Model alias list per agent provider — the source of truth the per-role environment picker reads
 *  to populate the model dropdown for the chosen CLI. Mirrors src/types.ts MODELS_BY_PROVIDER. */
export const MODELS_BY_PROVIDER: Record<AgentProvider, readonly string[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
};

/** The premium-priced tiers among MODELS. Selecting one as the default makes every
 *  autonomous auto-spawn run that tier, so the Settings picker surfaces a cost warning.
 *  Kept next to MODELS so adding a new premium model classifies it in one place.
 *  Both 1M variants are premium: the >200K long-context regime is the unattended-default
 *  cost case the warning exists for, so sonnet[1m] is premium even though plain sonnet is not. */
export const PREMIUM_MODELS: readonly string[] = ["fable", "opus", "opus[1m]", "sonnet[1m]"];

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
  hunks?: DiffHunk[]; // empty when binary or truncated; omitted on the session wire (patch sent instead)
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

/** One Diff-tab annotation (#1699). Mirrors the server `DiffNote`. `kind:"agent"` carries a line
 *  anchor (`side`+`lineNumber`) + the tool; `kind:"review"` is file-level (`path`) or panel-level
 *  (`path:""`), no anchor. `text` is VERBATIM agent/critic content — the client renders it as text
 *  only (never HTML). (Named `DiffNote`, not `DiffAnnotation` — the latter is a visual-block type.) */
export interface DiffNote {
  path: string;
  kind: "agent" | "review";
  text: string;
  side?: "additions" | "deletions";
  lineNumber?: number;
  tool?: string;
}

export interface DiffAnnotationsResult {
  notes: DiffNote[];
}

/** An agent annotation in the shape `@pierre/diffs`' `DiffLineAnnotation<{text,tool}>` expects,
 *  derived from a `DiffNote`. Kept as a structural match so the diff components need not import
 *  Pierre's types (PierreDiff's `Annotation` type is assignable from this). */
export interface DiffAgentAnnotation {
  side: "additions" | "deletions";
  lineNumber: number;
  metadata: { text: string; tool: string };
}

export type LearningStatus = "proposed" | "active" | "promoted" | "dismissed" | "retired";

/** What an evidence signal was captured from (mirrors server `SignalKind`):
 *  reply = an operator correction, critic = a code-review finding,
 *  block/stall = a session that got blocked or stalled. */
export type SignalKind = "reply" | "critic" | "block" | "stall";

/** One resolved evidence signal behind a proposed rule (provenance for the
 *  drawer). `id` is the signal id (stable render key); `desig` is the source
 *  session, null when no longer tracked. */
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
  evidence: string[];
  status: LearningStatus;
  evidenceCount: number;
  // Per-kind breakdown of the cited signals; only present on the pending payload.
  evidenceKinds?: Partial<Record<SignalKind, number>>;
  // The resolved evidence signals (kind + source session + excerpt), newest first.
  evidenceDetail?: EvidenceItem[];
  ineffectiveCount: number;
  helpfulCount: number;
  injectedCount: number;
  lastUsedAt: number | null;
  retiredAt: number | null;
  /** Timestamp (ms) when this rule was auto-promoted to an active trial; null for
   *  manually approved rules. Present on active/injectable payloads (#925). */
  trialedAt?: number | null;
  retiredReason: string | null;
  // Glob patterns scoping where this rule injects (repo-relative). Empty = an
  // Always-rule (every task); non-empty = injected only when the session's target
  // files match a glob (#842).
  scopeGlobs: string[];
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
  promotedPrUrl: string | null;
  // Phase 4: id of the surviving rule this one was merged into when soft-retired by
  // consolidation (the retained citation). Null otherwise.
  mergedIntoId?: string | null;
}

/** Phase 4 background merge-suggestion surfaced in the drawer (operator-applied). */
export type MergeSuggestionKind = "intra" | "cross";

export interface MergeSuggestionMember {
  id: string;
  repoPath: string;
  rule: string;
  status: LearningStatus;
}

export interface MergeSuggestion {
  id: string;
  kind: MergeSuggestionKind;
  repoPath: string | null;
  targetId: string | null;
  sourceIds: string[];
  mergedRule: string;
  mergedRationale: string;
  repoPaths: string[] | null;
  signature: string;
  status: "pending" | "applied" | "dismissed";
  createdAt: number;
  /** Hydrated member rules (survivor first for `intra`). */
  members?: MergeSuggestionMember[];
}

/** A learning as it appears in the injectable preview: the rule plus the planner's
 *  per-rule verdict — `injected` (made the budget cut) and `scoped` (glob-conditional,
 *  not injected in this no-session preview). */
export type InjectableRule = Learning & { injected: boolean; scoped: boolean };

/** GET /api/learnings/injectable: one entry per repo with ≥1 active/promoted rule.
 *  Drives the drawer's "Injected house rules" view; the budget value flows from
 *  here so the UI never hardcodes it. `injected` reflects the server-side planner's
 *  greedy fit; when `enabled` is false every rule is `injected:false`, `usedChars:0`.
 *  `scoped` marks a glob-scoped rule — in this preview (no session) it never injects;
 *  it's conditional on a task's files matching, NOT over-budget. */
export interface RepoInjectable {
  repoPath: string;
  enabled: boolean;
  budgetChars: number;
  usedChars: number;
  rules: InjectableRule[];
  retired: Learning[];
  unseenRetired: number;
}

export interface DistillerHealth {
  ok: boolean;
  consecutiveFailures: number;
  lastFailure: { reason: string; at: number; repoPath: string } | null;
  // Additive sub-object: health of the rule optimizer (same shape as the
  // distiller's). Always present in the current server response (the endpoint
  // defaults to a safe ok-shape when the optimizer is unwired); optional only
  // for compat with older server responses that predate this field.
  optimizer?: {
    ok: boolean;
    consecutiveFailures: number;
    lastFailure: { reason: string; at: number; repoPath: string } | null;
  };
}

// ── leftover subprocesses surfaced at session close ─────────────────────────
export type LeftoverKind = "process" | "system";

export interface Leftover {
  kind: LeftoverKind;
  name: string; // "vite", "tailscale serve"
  port: number | null;
  key: string; // stable selection key echoed back to the server
  pid?: number;
  command?: { bin: string; args: string[] };
}
