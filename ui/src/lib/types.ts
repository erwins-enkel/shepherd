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
  /** Count of sessions (agents) run on this repo within the recent window; undefined if none. */
  recentAgentCount?: number;
}

export interface Settings {
  repoRoot: string;
  repoRootDisplay: string;
  remoteControlAtStartup: boolean;
  /** Daily sweep that prunes old archived sessions; kill switch (default on). */
  sessionHousekeepingEnabled: boolean;
  /** Raw configured default-model setting (auto|default|<alias>); the New Task
   *  picker resolves `auto` via the client promo. */
  defaultModel: string;
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
  /** The agent node's own tailnet hostname; the UI builds preview iframe URLs from it
   *  when the HUD is fronted on a different host than the node. Null when tailscale is
   *  absent → fall back to the operator's own connection host. */
  previewHost: string | null;
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
/** GitHub's mergeStateStatus (mirrors server `MergeStateStatus`); absent for Gitea. */
export type MergeStateStatus =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "draft"
  | "has_hooks"
  | "unknown"
  | "unstable";

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
  /** GitHub's precise merge-state signal; absent for Gitea (mirrors server PrStatus). */
  mergeStateStatus?: MergeStateStatus;
  deployConfigured: boolean;
  headSha?: string;
  latestReview?: {
    state: "approved" | "changes_requested" | "commented";
    author: string;
    submittedAt: number;
  };
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
/** The per-repo sandbox confinement profile. trusted = no sandbox (default);
 *  standard = filesystem/process membrane; autonomous = same membrane + required
 *  for auto/drain sessions (network-egress allowlist not yet implemented). */
export type SandboxProfile = "trusted" | "standard" | "autonomous";

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
  /** Open new PRs as drafts; mutually exclusive with autoMergeEnabled (default false). */
  draftMode: boolean;
  /** Who may promote a draft PR to ready-for-review (default "human"). */
  signoffAuthority: "human" | "critic" | "either";
  /** Per-repo sandbox confinement profile (default "trusted" = no sandbox). */
  sandboxProfile: SandboxProfile;
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
}
export interface Epic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  source: EpicSource;
  children: EpicChild[];
  warnings: string[];
  run: EpicRun;
}
export interface EpicSummary {
  parentIssueNumber: number;
  parentTitle: string;
  total: number;
  merged: number;
  status: EpicRunStatus;
  source: EpicSource;
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
  /** Who is up once the PR is open + green, when it isn't the operator (computed
   *  server-side from `.shepherd/roles.json`). Absent = the operator's turn. */
  handoff?: "reviewer" | "merger";
  /** The login to display for {@link handoff} (e.g. "scoop"). */
  handoffWho?: string;
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
  /** The sandbox profile actually applied to this session's spawn; null if not stamped. */
  sandboxApplied: SandboxProfile | null;
  /** True when the requested sandbox couldn't be applied — the agent ran unconfined. */
  sandboxDegraded: boolean;
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
  kind: "github" | "gitea";
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
  | { event: "session:claude-alive"; data: { id: string; claudeAlive: boolean } }
  | { event: "session:working-blocked"; data: { id: string; working: boolean } }
  | { event: "session:preview"; data: { id: string; previewPort: number | null } }
  | { event: "session:preview-serve"; data: { id: string; serve: "ok" | "failed" | null } }
  | { event: "update:status"; data: UpdateStatus }
  | { event: "herdr-update:status"; data: HerdrUpdateStatus }
  | { event: "star-prompt:status"; data: StarPromptStatus }
  | { event: "herdr-update:log"; data: { line: string } }
  | {
      event: "herdr-update:done";
      data: { ok: boolean; from: string | null; to: string | null; error?: string };
    }
  | { event: "project-icons:update"; data: ProjectIcons }
  | { event: "session:review"; data: { id: string; review: ReviewVerdict | null } }
  | { event: "session:reviewing"; data: { id: string; reviewing: boolean } }
  | { event: "session:critic-activity"; data: { id: string; summary: string } }
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
  | { event: "halt:done"; data: { halted: number } }
  | { event: "mergetrain:landed"; data: { repoPath: string } }
  | { event: "draftreconcile:status"; data: DraftReconcileStatus }
  | { event: "epic:update"; data: Epic };

/** Optional override bag for relaunch; absent fields inherit the original session. */
export interface RelaunchOverrides {
  repoPath?: string;
  baseBranch?: string;
  prompt?: string;
  model?: string | null;
  planGateEnabled?: boolean | null;
  images?: string[];
}

export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
  images?: string[]; // absolute staging paths from /api/uploads
  issueRef?: IssueRef; // optional attached issue; body appended server-side
  planGateEnabled?: boolean | null; // per-task plan-gate override; absent → inherit repo default
  sandboxProfile?: SandboxProfile | null; // per-spawn sandbox override; absent → inherit repo default
}

/** Selectable claude model aliases; null = claude's own default. */
export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;

/** The premium-priced tiers among MODELS. Selecting one as the default makes every
 *  autonomous auto-spawn run that tier, so the Settings picker surfaces a cost warning.
 *  Kept next to MODELS so adding a new premium model classifies it in one place. */
export const PREMIUM_MODELS: readonly string[] = ["fable", "opus"];

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
