export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";

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
}

export interface RepoEntry {
  name: string;
  path: string;
  display: string;
  /** Most-recent session createdAt for this repo; undefined if never used. */
  lastUsedAt?: number;
}

export interface Settings {
  repoRoot: string;
  repoRootDisplay: string;
  remoteControlAtStartup: boolean;
  /** Prompt seeded behind the backlog quick-launch button; empty disables it. */
  standardCommand: string;
  /** Daily sweep that prunes old archived sessions; kill switch (default on). */
  sessionHousekeepingEnabled: boolean;
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
  /** Display-only: archived sessions older than this many days are pruned. */
  sessionRetentionDays: number;
  /** Display-only: newest archived sessions kept regardless of age. */
  sessionRetentionKeep: number;
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

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  createdAt: number;
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
  name: string;
  description: string;
  scope: SlashCommandScope;
  /** Front-matter `argument-hint` (e.g. "<ticket>"), shown dimmed after the name. */
  argumentHint?: string;
}

export type BlockShape = "menu" | "yes-no" | "awaiting-input" | "stall";
export interface BlockOption {
  label: string;
  send: string;
}
export interface BlockReason {
  shape: BlockShape;
  options: BlockOption[];
  tail: string[];
}

export type ForgeKind = "github" | "gitea";
export type MergeMethod = "merge" | "squash" | "rebase";
export type ChecksState = "none" | "pending" | "success" | "failure";

export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  title?: string;
  mergeable?: boolean | null;
  checks: ChecksState;
  deployConfigured: boolean;
  headSha?: string;
  latestReview?: {
    state: "approved" | "changes_requested" | "commented";
    author: string;
    submittedAt: number;
  };
}

/** An open PR row in the backlog PRs tab (mirrors server `PullRequest`). */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
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
}

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
/** A plan-gate verdict (mirrors server `PlanGate`), keyed client-side by session id. */
export interface PlanGate {
  sessionId: string;
  planHash: string; // sha256 of the reviewed plan; dedups re-reviews of an unchanged plan
  decision: PlanDecision;
  summary: string; // <=100 char one-liner for the badge tooltip
  body: string; // full markdown reviewer write-up
  findings: string[]; // discrete actionable items; [] = nothing to address
  round: number; // adversarial rounds spent on the current plan streak (0 = reset)
  cap: number; // the round cap this run used — the badge reads it instead of mirroring
  approved: boolean; // load-bearing gate flag: execution allowed only when true
  plan: string; // snapshot of the reviewed plan text (surfaced in the UI panel)
  updatedAt: number;
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
  url?: string;
  updatedAt: number;
}
export interface RepoConfig {
  criticEnabled: boolean;
  autoAddressEnabled: boolean;
  learningsEnabled: boolean;
  autopilotEnabled: boolean;
  autoDrainEnabled: boolean;
  autoMergeEnabled: boolean;
  buildQueueEnabled: boolean;
  /** Pre-execution plan gate: grill + adversarial plan review before execution (default off). */
  planGateEnabled: boolean;
  maxAuto: number;
  autoLabel: string;
  usageCeilingPct: number;
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

export interface DrainStatus {
  repoPath: string;
  enabled: boolean;
  paused: boolean;
  reason: string | null;
  detail: string | null;
  queued: number;
  inFlight: number;
  max: number;
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
  model: string | null;
  status: SessionStatus;
  /** Operator-set "parked / done" flag, orthogonal to status. Default false. */
  readyToMerge: boolean;
  /** Epoch ms when a merge train marked this PR-session in-flight; null when not.
   *  Transient — cleared server-side on merge/close, train archive, or TTL. */
  mergingSince: number | null;
  /** Id of the owning merge-train session; null when not merging. */
  mergingTrainId: string | null;
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
  /** Issue number that seeded this session; null when launched without an issue. */
  issueNumber: number | null;
  lastState: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
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

export interface LimitWindow {
  pct: number;
  resetAt: number;
}
export interface UsageLimits {
  session5h: LimitWindow | null;
  week: LimitWindow | null;
  stale: boolean;
  calibratedAt: number | null;
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

/** repoPath → emoji map for per-project icons. */
export type ProjectIcons = Record<string, string>;

// ── backlog ────────────────────────────────────────────────────────────────
export interface BacklogProject {
  path: string;
  display: string;
  slug: string | null;
  kind: "github" | "gitea";
  lastUsedAt?: number;
  openIssues: number | null;
  openPRs: number | null;
  /** Workflows defined under .github/workflows; null for non-GitHub forges. */
  workflows: number | null;
  /** Default-branch CI rollup for the Actions tab marker; null = unknown / non-GitHub. */
  ciStatus: "success" | "failure" | "pending" | null;
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
  | "agent_instructions";
export interface GuardrailCheck {
  id: GuardrailId;
  present: boolean;
  /** Leverage-to-cut-AI-churn; higher = more human↔AI back-and-forth removed. */
  weight: number;
  /** Matched markers (file names / package fields) — verbatim, not translated. */
  evidence: string[];
}
export interface ReadinessReport {
  /** False when not a JS/TS repo (no package.json) — the baseline is N/A. */
  applicable: boolean;
  /** Weighted 0–100 score derived from `checks`. */
  score: number;
  checks: GuardrailCheck[];
  hasAgentInstructions: boolean;
  /** Generated house-rules snippet — verbatim artifact, exempt from i18n. */
  claudeMd: string;
}

export type WsEvent =
  | { event: "session:new"; data: Session }
  | { event: "session:status"; data: { id: string; status: SessionStatus } }
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
  | { event: "session:renamed"; data: { id: string; name: string; branch: string | null } }
  | { event: "usage:limits"; data: UsageLimits }
  | { event: "session:block"; data: { id: string; block: BlockReason | null } }
  | { event: "session:git"; data: { id: string; git: GitState } }
  | { event: "session:activity"; data: { id: string; activity: SessionActivity } }
  | { event: "update:status"; data: UpdateStatus }
  | { event: "herdr-update:status"; data: HerdrUpdateStatus }
  | { event: "herdr-update:log"; data: { line: string } }
  | {
      event: "herdr-update:done";
      data: { ok: boolean; from: string | null; to: string | null; error?: string };
    }
  | { event: "project-icons:update"; data: ProjectIcons }
  | { event: "session:review"; data: { id: string; review: ReviewVerdict | null } }
  | { event: "session:reviewing"; data: { id: string; reviewing: boolean } }
  | {
      event: "session:plangate";
      // Emitted two ways: a fresh verdict carries `gate`; a phase flip carries `planPhase`.
      data: { id: string; gate?: PlanGate; planPhase?: "planning" | "executing" };
    }
  | { event: "session:plangate-reviewing"; data: { id: string; reviewing: boolean } }
  | { event: "learnings:update"; data: { pending: number } }
  | { event: "backlog:update"; data: BacklogPayload }
  | { event: "drain:status"; data: DrainStatus }
  | { event: "automerge:status"; data: AutoMergeStatus }
  | { event: "session:automerge"; data: { id: string; enabled: boolean | null } }
  | { event: "queue:update"; data: BuildQueue }
  | { event: "halt:done"; data: { halted: number } };

export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
  images?: string[]; // absolute staging paths from /api/uploads
  issueRef?: IssueRef; // optional attached issue; body appended server-side
  planGateEnabled?: boolean | null; // per-task plan-gate override; absent → inherit repo default
}

/** Selectable claude model aliases; null = claude's own default. */
export const MODELS = ["opus", "sonnet", "haiku"] as const;

export interface Steer {
  id: string;
  label: string;
  text: string;
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
}

export interface DiffResult {
  base: string; // logical base branch, e.g. "main"
  baseRef: string; // ref actually diffed against, e.g. "origin/main" or "main"
  head: string | null; // session branch; null for non-isolated sessions
  fetchFailed: boolean; // true when `git fetch` failed and we fell back to local base
  truncated: boolean; // true when any file was truncated
  files: DiffFile[];
}

export type LearningStatus = "proposed" | "active" | "promoted" | "dismissed";

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
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
  promotedPrUrl: string | null;
}

/** GET /api/learnings/injectable: one entry per repo with ≥1 active/promoted rule.
 *  Drives the drawer's "Injected house rules" view; the budget value flows from
 *  here so the UI never hardcodes it. `injected` reflects the server-side planner's
 *  greedy fit; when `enabled` is false every rule is `injected:false`, `usedChars:0`. */
export interface RepoInjectable {
  repoPath: string;
  enabled: boolean;
  budgetChars: number;
  usedChars: number;
  rules: (Learning & { injected: boolean })[];
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
