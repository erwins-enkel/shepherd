import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Session,
  SessionArchiveReason,
  ExperimentRole,
  ReviewVerdict,
  ReviewDecision,
  PlanGate,
  PlanSummaryCode,
  Recap,
  RecapSkip,
  RecapFailure,
  DiffFile,
  Signal,
  SignalKind,
  Learning,
  LearningStatus,
  MergeSuggestion,
  MergeSuggestionKind,
  MergeSuggestionStatus,
  BuildStep,
  BuildStepStatus,
  BuildQueue,
  BuildStepInput,
  EpicDraft,
  EpicDraftChild,
  EpicDraftContent,
  ReviewerSpawnRow,
  AgentProvider,
  PrReview,
  HerdDigest,
  PostMergeStep,
  PostMergeSteps,
  RundownItem,
  RundownEpicItem,
  HeldTask,
  CreateSessionInput,
  SessionUsageRow,
  SessionUsageSnapshot,
  SessionUsageBucket,
  WindowedBucketSum,
  SessionLaunchMetadata,
} from "./types";
import type { VisualBlock } from "./visual-blocks";
import type { ManualStep } from "./manual-steps";
import type {
  CapRow,
  CapStore,
  CreditSnapshot,
  CreditStore,
  ModelWeekSnapshot,
  ModelWeekStore,
  WindowKey,
} from "./usage-limits";
import { dominantModel, type SessionUsage } from "./usage";
import { type SandboxProfile, isSandboxProfile } from "./sandbox";
import { normalizeRepoDefaultModelSetting } from "./default-model";
import { normalizeRepoDefaultEffortSetting } from "./default-effort";
import { sanitizeScopeGlobs } from "./house-rules";
import type { EpicRun } from "./epic-core";
import type { EpicLandingState } from "./completed-epic";
import { normalizeRule } from "./learning-rule";

/** Tolerantly parse a persisted JSON column, falling back to `fallback` on any error. */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Tolerantly parse a persisted JSON array-of-strings column (never throws). */
function safeJsonArray(raw: string | null | undefined): string[] {
  const v = safeJsonParse<unknown>(raw, []);
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

/** Tolerantly parse the persisted findings JSON back to a string[] (never throws). */
function parseFindings(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/** Parse a persisted recap `skipReason` JSON column into a RecapSkip. null/absent/garbage → null (a
 *  legacy failed row keeps rendering its baked headline/body). Trusts the shape loosely: a stored
 *  `{code, params}` written by putRecap round-trips; anything else collapses to null. */
function parseSkipReason(raw: string | null | undefined): RecapSkip | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.code === "string") {
      return { code: parsed.code, params: parsed.params ?? {} } as RecapSkip;
    }
    return null;
  } catch {
    return null;
  }
}

function parseFailureReason(raw: string | null | undefined): RecapFailure | null {
  const parsed = safeJsonParse<Partial<RecapFailure> | null>(raw, null);
  if (!parsed) return null;
  const codes = new Set([
    "auth-unavailable",
    "source-unavailable",
    "launch-failed",
    "timed-out",
    "no-result",
    "invalid-result",
  ]);
  if (!codes.has(parsed.code ?? "")) return null;
  if (parsed.provider !== "claude" && parsed.provider !== "codex") return null;
  return {
    code: parsed.code as RecapFailure["code"],
    provider: parsed.provider,
    model: typeof parsed.model === "string" ? parsed.model : null,
    ...(typeof parsed.detail === "string" && parsed.detail ? { detail: parsed.detail } : {}),
  };
}

function parseArchiveReason(raw: string | null | undefined): SessionArchiveReason | null {
  return raw === "operator" || raw === "merged" || raw === "drain" || raw === "relaunch"
    ? raw
    : null;
}

function parseRecapBlocks(raw: string | null | undefined): VisualBlock[] {
  const parsed = safeJsonParse<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as VisualBlock[]) : [];
}

function serializeRecapSkip(recap: Recap): string | null {
  return recap.failure || !recap.skip ? null : JSON.stringify(recap.skip);
}

function serializeRecapFailure(recap: Recap): string | null {
  return recap.skip || !recap.failure ? null : JSON.stringify(recap.failure);
}

/** Coerce a persisted plan-gate summary code: only the known "no-verdict" sentinel survives; any
 *  other value (legacy prose lived in `summary`, not here) → null. */
function coerceSummaryCode(v: string | null): PlanSummaryCode | null {
  return v === "no-verdict" ? "no-verdict" : null;
}

/** Coerce a persisted tri-state flag: null/undefined stays null (inherit), else a real boolean. */
function nullableBool(v: unknown): boolean | null {
  return v === null || v === undefined ? null : !!v;
}

/** Coalesce a nullable/absent TEXT value to "" (for NOT-NULL string columns). */
function strOrEmpty(v: string | null | undefined): string {
  return v ?? "";
}

/** Coerce a persisted RundownEpicItem.pausedReason to its union, or undefined for anything else. */
function coercePauseReason(v: unknown): RundownEpicItem["pausedReason"] {
  return v === "cap" || v === "conflict" || v === "driver" ? v : undefined;
}

/** Designation prefix for task sessions, e.g. "TASK-07". Single source for the prefix + its SUBSTR offset. */
const DESIG_PREFIX = "TASK-";

/** Allowed learning status transitions (spec §3). Terminal states have no exits. */
const LEARNING_TRANSITIONS: Record<LearningStatus, LearningStatus[]> = {
  proposed: ["active", "dismissed"],
  active: ["promoted", "dismissed", "retired"],
  promoted: ["retired"],
  retired: ["active", "promoted"],
  dismissed: [],
};

export interface RepoConfig {
  criticEnabled: boolean;
  /** Standalone repo-level PR critic: review every open CI-green PR in the repo, not just session PRs (default OFF). */
  criticAllPrs: boolean;
  /** Append a named Fowler code-smell lens to the session critic's prompt (#1824, research #1812
   *  finding C). Non-blocking: smell matches go to a body section, never `findings`. Experimental
   *  trial, default OFF — extra tokens/round, so it ships opt-in pending measurement. */
  criticSmellLensEnabled: boolean;
  /** Auto-feed critic findings back to the task agent until clean or the round cap. */
  autoAddressEnabled: boolean;
  learningsEnabled: boolean;
  /** Pre-PR autopilot loop: drive procedural gates, surface real questions, lead to a PR. */
  autopilotEnabled: boolean;
  /** Pre-execution plan gate: grill + adversarial plan review before autonomous execution (default OFF). */
  planGateEnabled: boolean;
  /** Per-repo master switch for the self-draining work queue (default OFF). */
  autoDrainEnabled: boolean;
  /** Full-auto: when on, the merge train lands ready PRs instead of handing off. */
  autoMergeEnabled: boolean;
  /** Per-repo opt-in for the agent-authored build queue (default OFF). */
  buildQueueEnabled: boolean;
  /** Open PRs as GitHub drafts; holds them out of merge/retire until sign-off (default OFF). */
  draftMode: boolean;
  /** Who must sign off a draft PR before it enters the merge path (default "human"). */
  signoffAuthority: "human" | "critic" | "either";
  /** Concurrency cap on auto-spawned agents for this repo (default 1). */
  maxAuto: number;
  /** Issue label that opts an issue in for auto-spawning (default "shepherd:auto"). */
  autoLabel: string;
  /** Pause auto-spawns when usage % is at or above this threshold (default 80). */
  usageCeilingPct: number;
  /** OS-level sandbox membrane for spawned task agents (default "trusted" = unconfined). */
  sandboxProfile: SandboxProfile;
  /** Per-repo default-model override; "inherit" (default) defers to the global default setting. */
  defaultModel: string;
  /** Per-repo default-effort override; "inherit" (default) defers to the global default setting. */
  defaultEffort: string;
  /** Per-repo extra allowlisted hosts appended to the autonomous egress allowlist. */
  egressExtraHosts: string[];
  /** Repo mode: 'forge' (GitHub-backed, default) or 'lightweight' (local-only, no GitHub). */
  repoMode: "forge" | "lightweight";
  /** Auto-optimize flagged rules (default OFF — explicit opt-in). */
  autoOptimizeFlagged: boolean;
  /** On a session PR merge, open a GitHub tracking issue listing the manual operator steps
   *  (#1061). Default OFF — outbound write gated behind explicit per-repo opt-in (house rule). */
  manualStepsIssueEnabled: boolean;
  /** Pre-warm epic landing CI by opening the landing PR as an early draft during the drain
   *  (#1664). Default OFF — explicit opt-in. */
  preWarmEpicLandingCi: boolean;
  /** Hidden from the Backlog repos panel (list-only declutter; never affects sessions/drain).
   *  Default OFF. */
  hidden: boolean;
  /** Local, non-replicated script Shepherd can run to start a repo preview without steering an agent. */
  previewStartScript?: string | null;
  /** The command captured when the local preview script was generated; used to recreate stale scripts. */
  previewStartCommand?: string | null;
  /** What clicking a live Preview chip does by default for this repo. */
  previewOpenMode: "ask" | "inline" | "tab";
}

export interface LocalPr {
  number: number;
  repoPath: string;
  branch: string;
  base: string;
  state: "open" | "merged";
  createdAt: number;
  mergedAt: number | null;
}

export interface PushSubInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale?: string;
}
export interface StoredPushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string;
  locale: string;
  createdAt: number;
  cats: PushPrefs;
}

/** Which notification categories a device wants (per-subscription, all-on by default). */
export interface PushPrefs {
  agent: boolean;
  reviews: boolean;
  ci: boolean;
}

type NewSession = Omit<
  Session,
  | "id"
  | "desig"
  | "status"
  | "lastState"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "archiveReason"
  | "model"
  | "effort"
  | "claudeSessionId"
  | "providerSessionId"
  | "agentProvider"
  | "readyToMerge"
  | "mergingSince"
  | "mergingTrainId"
  | "mergeTrainPrs"
  | "mergingPrNumber"
  | "autopilotEnabled"
  | "autopilotStepCount"
  | "autopilotPaused"
  | "autopilotComplete"
  | "autopilotQuestion"
  | "completionRepromptCount"
  | "planGateEnabled"
  | "planPhase"
  | "autoMergeEnabled"
  | "autoMergeRebaseCount"
  | "autoMergeRebaseHead"
  | "autoMergeRebaseSteeredAt"
  | "auto"
  | "issueNumber"
  | "sandboxApplied"
  | "sandboxDegraded"
  | "egressApplied"
  | "egressDegraded"
  | "research"
  | "epicAuthoring"
  | "landingRepair"
  | "haltReason"
  | "haltedAt"
  | "manualSteps"
  | "manualStepsAckedAt"
  | "experimentId"
  | "experimentRole"
  | "spawnTerminalId"
  | "spawnAccountDir"
  | "launchMetadata"
> & {
  id?: string;
  model?: string | null;
  effort?: string | null;
  claudeSessionId?: string;
  providerSessionId?: string;
  agentProvider?: Session["agentProvider"];
  auto?: boolean;
  issueNumber?: number | null;
  planGateEnabled?: boolean | null;
  autopilotEnabled?: boolean | null;
  planPhase?: Session["planPhase"];
  sandboxApplied?: SandboxProfile | null;
  sandboxDegraded?: boolean;
  egressApplied?: boolean;
  egressDegraded?: boolean;
  research?: boolean;
  epicAuthoring?: boolean;
  landingRepair?: boolean;
  mergeTrainPrs?: number[];
  launchMetadata?: SessionLaunchMetadata | null;
};

const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, claudeSessionId, agentProvider, model, effort, readyToMerge, status, lastState,
  autopilotEnabled, autopilotStepCount, autopilotPaused, autopilotComplete, autopilotQuestion, completionRepromptCount,
  planGateEnabled, planPhase,
  autoMergeEnabled, autoMergeRebaseCount, autoMergeRebaseHead, autoMergeRebaseSteeredAt,
  auto, issueNumber, sandboxApplied, sandboxDegraded, egressApplied, egressDegraded,
  research, epicAuthoring, landingRepair,
  createdAt, updatedAt, archivedAt, mergingSince, mergingTrainId, mergeTrainPrs, mergingPrNumber,
  haltReason, haltedAt, manualStepsJson, manualStepsAckedAt, experimentId, experimentRole,
  spawnTerminalId, spawnAccountDir, providerSessionId, launchMetadataJson, archiveReason`;

// ── SQLite row shapes ──────────────────────────────────────────────────────────

/** SQLite row shape for the sessions table (INTEGER booleans, JSON strings). */
type SessionRow = {
  id: string;
  desig: string;
  name: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  branch: string | null;
  worktreePath: string;
  isolated: number;
  herdrSession: string;
  herdrAgentId: string;
  claudeSessionId: string | null;
  providerSessionId: string | null;
  agentProvider: string | null;
  model: string | null;
  effort: string | null;
  readyToMerge: number;
  status: string;
  lastState: string;
  autopilotEnabled: number | null;
  autopilotStepCount: number | null;
  autopilotPaused: number;
  autopilotComplete: number;
  autopilotQuestion: string | null;
  completionRepromptCount: number | null;
  planGateEnabled: number | null;
  planPhase: string | null;
  autoMergeEnabled: number | null;
  autoMergeRebaseCount: number | null;
  autoMergeRebaseHead: string | null;
  autoMergeRebaseSteeredAt: number | null;
  auto: number;
  issueNumber: number | null;
  sandboxApplied: string | null;
  sandboxDegraded: number;
  egressApplied: number;
  egressDegraded: number;
  research: number;
  epicAuthoring: number;
  landingRepair: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  archiveReason: string | null;
  mergingSince: number | null;
  mergingTrainId: string | null;
  mergeTrainPrs: string | null;
  mergingPrNumber: number | null;
  haltReason: string | null;
  haltedAt: number | null;
  manualStepsJson: string | null;
  manualStepsAckedAt: number | null;
  experimentId: string | null;
  experimentRole: string | null;
  spawnTerminalId: string | null;
  spawnAccountDir: string | null;
  launchMetadataJson: string | null;
};

/** SQLite row shape for the reviews table. */
type ReviewVerdictRow = {
  sessionId: string;
  headSha: string;
  patchId: string | null;
  decision: string;
  summary: string;
  body: string;
  findings: string;
  addressRound: number | null;
  addressCap: number | null;
  streakReviews: number | null;
  reviewedPatchIds: string;
  errorRound: number | null;
  finalRoundPending: number;
  finalRoundTimeoutMs: number | null;
  seenNoteIds: string;
  url: string | null;
  spawnAborted: number | null;
  dismissed: number | null;
  updatedAt: number;
};

/** SQLite row shape for the plan_gates table. */
type PlanGateRow = {
  sessionId: string;
  planHash: string | null;
  decision: string;
  summary: string | null;
  summaryCode: string | null;
  body: string | null;
  findings: string;
  round: number | null;
  cap: number | null;
  approved: number;
  plan: string | null;
  updatedAt: number;
  blocks: string;
  answeredQuestionKeys: string | null;
  reviewerProvider: string | null;
  reviewerModel: string | null;
  reviewerEffort: string | null;
  finalRoundPending: number | null;
  dismissed: number | null;
};

/** SQLite row shape for the recaps table. */
type RecapRow = {
  sessionId: string;
  state: string;
  headSha: string | null;
  base: string | null;
  verdict: string | null;
  headline: string | null;
  body: string | null;
  skipReason: string | null; // JSON of RecapSkip ({code, params}) for a coded failed skip; null otherwise
  failureReason: string | null;
  diffState: string | null;
  openItems: string;
  changedFiles: string;
  blocks: string;
  spawnSessionId: string | null;
  cwd: string | null;
  model: string | null;
  spawnedAt: number;
  generatedAt: number | null;
  updatedAt: number;
  pendingDiff?: string;
};

/** SQLite row shape for the herd_digests table. */
type HerdDigestRow = {
  dayKey: string;
  state: string;
  overnight: string | null;
  decisions: string;
  ciRework: string;
  train: string | null;
  focusNext: string;
  attentionFingerprint: string;
  epicsToLand: string;
  spawnSessionId: string | null;
  cwd: string | null;
  model: string | null;
  spawnedAt: number;
  generatedAt: number | null;
  updatedAt: number;
};

/** SQLite row shape for the learnings table. */
type LearningRow = {
  id: string;
  repoPath: string;
  rule: string;
  rationale: string;
  evidence: string;
  status: string;
  evidenceCount: number;
  ineffectiveCount: number;
  helpfulCount: number;
  injectedCount: number;
  lastUsedAt: number | null;
  retiredAt: number | null;
  retiredReason: string | null;
  scopeGlobs: string;
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
  promotedPrUrl: string | null;
  mergedIntoId: string | null;
  trialedAt: number | null;
  reTrialBlockedAt: number | null;
  evidenceKindsSeen: string;
  evidenceSessionsSeen: string;
};

/** SQLite row shape for the learning_merge_suggestions table (Phase 4). */
type MergeSuggestionRow = {
  id: string;
  kind: string;
  repoPath: string | null;
  targetId: string | null;
  sourceIds: string;
  mergedRule: string;
  mergedRationale: string;
  repoPaths: string | null;
  signature: string;
  status: string;
  createdAt: number;
};

/** SQLite row shape for the pr_reviews table. */
type PrReviewRow = {
  repoPath: string;
  prNumber: number;
  headSha: string;
  patchId: string | null;
  decision: string | null;
  reviewedPatchIds: string;
  updatedAt: number;
};

// ── repo_config row type + helpers ────────────────────────────────────────────

type RepoCfgRow = {
  criticEnabled: number;
  criticAllPrs: number;
  criticSmellLensEnabled: number;
  autoAddressEnabled: number;
  learningsEnabled: number;
  autopilotEnabled: number;
  planGateEnabled: number;
  autoDrainEnabled: number;
  autoMergeEnabled: number;
  buildQueueEnabled: number;
  draftMode: number;
  signoffAuthority: string;
  maxAuto: number;
  autoLabel: string;
  usageCeilingPct: number;
  sandboxProfile: string;
  defaultModel: string;
  defaultEffort: string;
  egressExtraHosts: string | null;
  repoMode: string;
  autoOptimizeFlagged: number;
  manualStepsIssueEnabled: number;
  preWarmEpicLandingCi: number;
  hidden: number;
  previewStartScript: string | null;
  previewStartCommand: string | null;
  previewOpenMode: string;
};

/** Tolerantly parse the persisted mergeTrainPrs JSON back to number[] | null (never throws). */
function parseMergeTrainPrsJson(raw: string | null | undefined): number[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (parsed.some((el) => typeof el !== "number")) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

function parseLaunchMetadataJson(raw: string | null | undefined): SessionLaunchMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const m = parsed as Partial<SessionLaunchMetadata>;
    if (m.sourceKind !== "user" && m.sourceKind !== "generated") return null;
    if (typeof m.prompt !== "string") return null;
    if (!Array.isArray(m.attachments)) return null;
    return m as SessionLaunchMetadata;
  } catch {
    return null;
  }
}

function launchMetadataJson(value: SessionLaunchMetadata | null | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

/** Tolerantly parse the persisted manualSteps JSON back to ManualStep[] (never throws). #1059. */
function parseManualStepsJson(raw: string | null | undefined): ManualStep[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is ManualStep =>
        !!s &&
        typeof s === "object" &&
        typeof s.id === "string" &&
        typeof s.text === "string" &&
        typeof s.postMerge === "boolean",
    );
  } catch {
    return [];
  }
}

/** Tolerantly parse the persisted post-merge step JSON back to PostMergeStep[] (never throws). #1061. */
function parsePostMergeStepsJson(raw: string | null | undefined): PostMergeStep[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is PostMergeStep =>
        !!s &&
        typeof s === "object" &&
        typeof s.id === "string" &&
        typeof s.text === "string" &&
        typeof s.postMerge === "boolean" &&
        (s.doneAt === null || typeof s.doneAt === "number"),
    );
  } catch {
    return [];
  }
}

type PostMergeStepsRow = {
  sessionId: string;
  desig: string;
  repoPath: string;
  prNumber: number | null;
  prTitle: string;
  stepsJson: string;
  trackingIssueUrl: string | null;
  trackingIssueNumber: number | null;
  createdAt: number;
  updatedAt: number;
  clearedAt: number | null;
};

function hydratePostMergeSteps(r: PostMergeStepsRow): PostMergeSteps {
  return {
    sessionId: r.sessionId,
    desig: r.desig,
    repoPath: r.repoPath,
    prNumber: r.prNumber ?? null,
    prTitle: r.prTitle,
    steps: parsePostMergeStepsJson(r.stepsJson),
    trackingIssueUrl: r.trackingIssueUrl ?? null,
    trackingIssueNumber: r.trackingIssueNumber ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    clearedAt: r.clearedAt ?? null,
  };
}

/** Tolerantly parse the persisted egressExtraHosts JSON back to string[] (never throws). */
function parseEgressExtraHostsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function normalizePreviewOpenMode(raw: string | null | undefined): RepoConfig["previewOpenMode"] {
  return raw === "inline" || raw === "tab" || raw === "ask" ? raw : "ask";
}

/**
 * Map a nullable repo_config row to a fully-defaulted RepoConfig.
 * absent → critic on, learnings on, auto-address off (the spendier loop is explicit opt-in).
 * drain fields default OFF / cap-1 / default-label / ceiling-80. Early-return for the absent
 * row keeps the present-row mapping branch-free (low complexity).
 */
function repoConfigFromRow(r: RepoCfgRow | null): RepoConfig {
  if (!r) {
    return {
      criticEnabled: true,
      criticAllPrs: false,
      criticSmellLensEnabled: false,
      autoAddressEnabled: false,
      learningsEnabled: true,
      autopilotEnabled: false,
      planGateEnabled: false,
      autoDrainEnabled: false,
      autoMergeEnabled: false,
      buildQueueEnabled: false,
      draftMode: false,
      signoffAuthority: "human",
      maxAuto: 1,
      autoLabel: "shepherd:auto",
      usageCeilingPct: 80,
      sandboxProfile: "trusted",
      defaultModel: "inherit",
      defaultEffort: "inherit",
      egressExtraHosts: [],
      repoMode: "forge",
      autoOptimizeFlagged: false,
      manualStepsIssueEnabled: false,
      preWarmEpicLandingCi: false,
      hidden: false,
      previewStartScript: null,
      previewStartCommand: null,
      previewOpenMode: "ask",
    };
  }
  return {
    criticEnabled: !!r.criticEnabled,
    criticAllPrs: !!r.criticAllPrs,
    criticSmellLensEnabled: !!r.criticSmellLensEnabled,
    autoAddressEnabled: !!r.autoAddressEnabled,
    learningsEnabled: !!r.learningsEnabled,
    autopilotEnabled: !!r.autopilotEnabled,
    planGateEnabled: !!r.planGateEnabled,
    autoDrainEnabled: !!r.autoDrainEnabled,
    autoMergeEnabled: !!r.autoMergeEnabled,
    buildQueueEnabled: !!r.buildQueueEnabled,
    draftMode: !!r.draftMode,
    signoffAuthority: r.signoffAuthority as RepoConfig["signoffAuthority"],
    maxAuto: r.maxAuto,
    autoLabel: r.autoLabel,
    usageCeilingPct: r.usageCeilingPct,
    sandboxProfile: isSandboxProfile(r.sandboxProfile) ? r.sandboxProfile : "trusted",
    defaultModel: normalizeRepoDefaultModelSetting(r.defaultModel) ?? "inherit",
    defaultEffort: normalizeRepoDefaultEffortSetting(r.defaultEffort) ?? "inherit",
    egressExtraHosts: parseEgressExtraHostsJson(r.egressExtraHosts),
    repoMode: r.repoMode === "lightweight" ? "lightweight" : "forge",
    autoOptimizeFlagged: !!r.autoOptimizeFlagged,
    manualStepsIssueEnabled: !!r.manualStepsIssueEnabled,
    preWarmEpicLandingCi: !!r.preWarmEpicLandingCi,
    hidden: !!r.hidden,
    previewStartScript: r.previewStartScript ?? null,
    previewStartCommand: r.previewStartCommand ?? null,
    previewOpenMode: normalizePreviewOpenMode(r.previewOpenMode),
  };
}

function repoConfigParams(repoPath: string, cfg: RepoConfig): SQLQueryBindings[] {
  return [
    repoPath,
    Number(Boolean(cfg.criticEnabled)),
    Number(Boolean(cfg.criticAllPrs)),
    Number(Boolean(cfg.criticSmellLensEnabled)),
    Number(Boolean(cfg.autoAddressEnabled)),
    Number(Boolean(cfg.learningsEnabled)),
    Number(Boolean(cfg.autopilotEnabled)),
    Number(Boolean(cfg.planGateEnabled)),
    Number(Boolean(cfg.autoDrainEnabled)),
    Number(Boolean(cfg.autoMergeEnabled)),
    Number(Boolean(cfg.buildQueueEnabled)),
    Number(Boolean(cfg.draftMode)),
    cfg.signoffAuthority,
    cfg.maxAuto,
    cfg.autoLabel,
    cfg.usageCeilingPct,
    cfg.sandboxProfile,
    cfg.defaultModel,
    cfg.defaultEffort,
    JSON.stringify(cfg.egressExtraHosts ?? []),
    cfg.repoMode,
    Number(Boolean(cfg.autoOptimizeFlagged)),
    Number(Boolean(cfg.manualStepsIssueEnabled)),
    Number(Boolean(cfg.preWarmEpicLandingCi)),
    Number(Boolean(cfg.hidden)),
    cfg.previewStartScript ?? null,
    cfg.previewStartCommand ?? null,
    cfg.previewOpenMode,
    Date.now(),
  ];
}

type LocalPrRow = {
  number: number;
  repoPath: string;
  branch: string;
  base: string;
  state: string;
  createdAt: number;
  mergedAt: number | null;
};

function localPrFromRow(r: LocalPrRow): LocalPr {
  return {
    number: r.number,
    repoPath: r.repoPath,
    branch: r.branch,
    base: r.base,
    state: r.state === "merged" ? "merged" : "open",
    createdAt: r.createdAt,
    mergedAt: r.mergedAt ?? null,
  };
}

/** Minimum length for a non-exact step-id prefix to be resolvable. 8 = the conventional
 *  short-UUID form (the first UUID segment, e.g. `1444d473`) shown in logs/progress summaries.
 *  Below this we refuse to resolve: a shorter unique prefix could silently bind to the WRONG
 *  step after a re-PUT regenerates ids, so we return not-found with guidance rather than guess. */
export const STEP_ID_PREFIX_MIN = 8;

/** Outcome of resolving a posted step id against a session's actual step ids. */
export type StepIdResolution =
  | { ok: true; id: string }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; matches: string[] };

/**
 * Pure resolver: map a posted `idOrPrefix` onto one of `ids` (a session's step ids).
 *
 * Exact match is checked FIRST and wins unconditionally, so an id that also happens to be a
 * prefix of another id resolves to itself. This exact-first ordering is LOAD-BEARING: step ids
 * are no longer all fixed-length UUIDs — an agent may own a short stable id (e.g. "s1") via a
 * verbatim `id` on PUT (see `replaceBuildQueue`). A short id is below `STEP_ID_PREFIX_MIN`, so it
 * never prefix-resolves; it resolves only by this exact match. (Server-generated ids remain
 * 36-char UUIDs, for which equal-length ⇒ prefix ⇒ identical, so exact-first is also defensive
 * there.) It is unit-tested with both a synthetic UUID-prefix collision and a short exact id.
 *
 * Failing an exact match, an unambiguous prefix of ≥ STEP_ID_PREFIX_MIN chars resolves to the
 * single id it prefixes; >1 match is `ambiguous`; 0 matches (or a too-short non-exact id) is
 * `not-found`.
 */
export function resolveStepId(ids: string[], idOrPrefix: string): StepIdResolution {
  if (ids.includes(idOrPrefix)) return { ok: true, id: idOrPrefix };
  if (idOrPrefix.length < STEP_ID_PREFIX_MIN) return { ok: false, reason: "not-found" };
  const matches = ids.filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) return { ok: true, id: matches[0]! };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };
  return { ok: false, reason: "not-found" };
}

export class SessionStore implements CapStore, CreditStore, ModelWeekStore {
  private db: Database;

  private addMissingColumns(table: string, columns: Record<string, string>): void {
    const existing = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.some((c) => c.name === name)) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  constructor(path: string) {
    this.db = new Database(path);
    // Enforce FK constraints (enforces session_usage_bucket → session_usage cascade).
    // Must be set immediately after open, BEFORE any DDL — it is a no-op inside a transaction.
    this.db.run("PRAGMA foreign_keys = ON");
    // Wait (don't throw) on a held lock. The external hourly backup (#1080) holds a SHARED read
    // lock for the duration of its `VACUUM INTO`; without a busy_timeout a concurrent write commit
    // here would get SQLITE_BUSY immediately and throw on the event loop. Snapshotting a small DB
    // is sub-second, so the worst-case wait is a brief, bounded stall — not a crash. Keep equal to
    // BUSY_TIMEOUT_MS in scripts/backup.ts.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      providerSessionId TEXT NOT NULL DEFAULT '',
      agentProvider TEXT NOT NULL DEFAULT 'claude',
      model TEXT, effort TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    this.migrateSessionColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS task_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL)`);
    // Seed once from the high-water mark of existing desigs (TASK-NN) + 1, or 1 on a fresh DB.
    // SUBSTR offset strips the fixed DESIG_PREFIX; SQLite SUBSTR is 1-based so offset = prefix.length + 1.
    // INSERT OR IGNORE keeps this idempotent.
    // NB: this guarantees no *future* reuse but does not de-duplicate desig collisions a pre-fix
    // DB may already hold (the old COUNT(*) scheme reused numbers after a prune). We deliberately
    // don't renumber historical rows: a desig is stamped into that task's already-created branch
    // name + PR title, so rewriting it would desync the label from its real-world artifacts.
    this.db.run(`INSERT OR IGNORE INTO task_seq (id, next)
      VALUES (1, (SELECT COALESCE(MAX(CAST(SUBSTR(desig, ${DESIG_PREFIX.length + 1}) AS INTEGER)), 0) + 1 FROM sessions))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_caps (
      window TEXT PRIMARY KEY, cap REAL NOT NULL, resetAt INTEGER NOT NULL,
      pct INTEGER NOT NULL, scrapedAt INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_credit (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      spent REAL NOT NULL, cap REAL NOT NULL, currency TEXT NOT NULL,
      pct INTEGER NOT NULL, resetAt INTEGER, scrapedAt INTEGER NOT NULL)`);
    // Per-model weekly passthrough sub-limits (e.g. "Current week (Fable)"): one row per model,
    // keyed by model — so surfacing another model's sub-limit later needs no schema migration.
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_model_week (
      model TEXT PRIMARY KEY,
      pct INTEGER NOT NULL, resetAt INTEGER, scrapedAt INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_caps_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window TEXT NOT NULL, cap REAL NOT NULL, resetAt INTEGER NOT NULL,
      pct INTEGER NOT NULL, scrapedAt INTEGER NOT NULL)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS usage_caps_history_window_ts ON usage_caps_history (window, scrapedAt)`,
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_credit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spent REAL NOT NULL, cap REAL NOT NULL, currency TEXT NOT NULL,
      pct INTEGER NOT NULL, resetAt INTEGER, scrapedAt INTEGER NOT NULL)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS usage_credit_history_ts ON usage_credit_history (scrapedAt)`,
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS held_tasks (
      id TEXT PRIMARY KEY,
      repoPath TEXT NOT NULL,
      input TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT 'usage'
    )`);
    this.migrateHeldTaskColumns();
    // small key/value store for runtime-configurable settings (e.g. repoRoot)
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      criticAllPrs INTEGER NOT NULL DEFAULT 0,
      learningsEnabled INTEGER NOT NULL DEFAULT 1,
      autoDrainEnabled INTEGER NOT NULL DEFAULT 0,
      autoMergeEnabled INTEGER NOT NULL DEFAULT 0,
      maxAuto INTEGER NOT NULL DEFAULT 1,
      autoLabel TEXT NOT NULL DEFAULT 'shepherd:auto',
      usageCeilingPct INTEGER NOT NULL DEFAULT 80,
      repoMode TEXT NOT NULL DEFAULT 'forge',
      updatedAt INTEGER NOT NULL)`);
    this.migrateRepoConfigColumns();
    this.migrateFirstRunMarker();
    this.db.run(`CREATE TABLE IF NOT EXISTS local_prs (
      number    INTEGER PRIMARY KEY AUTOINCREMENT,
      repoPath  TEXT NOT NULL,
      branch    TEXT NOT NULL,
      base      TEXT NOT NULL,
      state     TEXT NOT NULL DEFAULT 'open',
      createdAt INTEGER NOT NULL,
      mergedAt  INTEGER,
      UNIQUE(repoPath, branch)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS reviews (
      sessionId TEXT PRIMARY KEY, headSha TEXT NOT NULL, patchId TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '[]', addressRound INTEGER NOT NULL DEFAULT 0,
      addressCap INTEGER NOT NULL DEFAULT 3, errorRound INTEGER NOT NULL DEFAULT 0,
      streakReviews INTEGER NOT NULL DEFAULT 0, reviewedPatchIds TEXT NOT NULL DEFAULT '[]',
      seenNoteIds TEXT NOT NULL DEFAULT '[]',
      finalRoundPending INTEGER NOT NULL DEFAULT 0,
      finalRoundTimeoutMs INTEGER NOT NULL DEFAULT 900000,
      url TEXT, updatedAt INTEGER NOT NULL)`);
    this.migrateReviewColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS pr_reviews (
      repoPath TEXT NOT NULL, prNumber INTEGER NOT NULL,
      headSha TEXT NOT NULL, patchId TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '',
      reviewedPatchIds TEXT NOT NULL DEFAULT '[]',
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, prNumber))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS plan_gates (
      sessionId TEXT PRIMARY KEY, planHash TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', summaryCode TEXT, body TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '[]', round INTEGER NOT NULL DEFAULT 0,
      cap INTEGER NOT NULL DEFAULT 3, approved INTEGER NOT NULL DEFAULT 0,
      plan TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL,
      blocks TEXT NOT NULL DEFAULT '[]',
      answeredQuestionKeys TEXT NOT NULL DEFAULT '[]',
      reviewerProvider TEXT,
      reviewerModel TEXT,
      reviewerEffort TEXT)`);
    this.migratePlanGateColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS recaps (
      sessionId TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      headSha TEXT NOT NULL DEFAULT '',
      base TEXT NOT NULL DEFAULT '',
      verdict TEXT,
      headline TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      skipReason TEXT,
      failureReason TEXT,
      diffState TEXT,
      openItems TEXT NOT NULL DEFAULT '[]',
      changedFiles TEXT NOT NULL DEFAULT '[]',
      spawnSessionId TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT,
      spawnedAt INTEGER NOT NULL,
      generatedAt INTEGER,
      updatedAt INTEGER NOT NULL,
      blocks TEXT NOT NULL DEFAULT '[]',
      pendingDiff TEXT NOT NULL DEFAULT '[]')`);
    // migrate recaps that predate the changedFiles column (existing rows default to none)
    const recapCols = this.db.query(`PRAGMA table_info(recaps)`).all() as { name: string }[];
    if (!recapCols.some((c) => c.name === "changedFiles")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN changedFiles TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!recapCols.some((c) => c.name === "blocks")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!recapCols.some((c) => c.name === "pendingDiff")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN pendingDiff TEXT NOT NULL DEFAULT '[]'`);
    }
    // skipReason: JSON RecapSkip ({code, params}) for a coded `failed` skip, rendered per-locale in
    // the UI. Legacy failed rows predate it (NULL) and keep rendering their baked headline/body prose.
    if (!recapCols.some((c) => c.name === "skipReason")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN skipReason TEXT`);
    }
    if (!recapCols.some((c) => c.name === "failureReason")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN failureReason TEXT`);
    }
    if (!recapCols.some((c) => c.name === "diffState")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN diffState TEXT`);
    }
    // migrate recaps that predate the base column (legacy rows default to '' — the dedup's
    // legacy guard then never force-regenerates them on base alone).
    if (!recapCols.some((c) => c.name === "base")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN base TEXT NOT NULL DEFAULT ''`);
    }
    // Manual operator steps — durable post-merge materialization (#1061, epic #1056 P3). One row
    // per merged session carrying its outstanding manual steps so they outlive the session. This
    // table is DELIBERATELY excluded from the pruneArchivedSessions cascade (archive-decoupled,
    // like reviewer_spawns / epic_completed) — owed steps must survive teardown AND the
    // archived-session prune. Display fields (desig/repoPath/prNumber/prTitle) are denormalized so
    // the Owed panel still renders after the underlying sessions row is pruned. clearedAt NULL =
    // still owed; stamped when every step is ticked done or the operator dismisses.
    this.db.run(`CREATE TABLE IF NOT EXISTS post_merge_steps (
      sessionId TEXT PRIMARY KEY,
      desig TEXT NOT NULL DEFAULT '',
      repoPath TEXT NOT NULL DEFAULT '',
      prNumber INTEGER,
      prTitle TEXT NOT NULL DEFAULT '',
      stepsJson TEXT NOT NULL DEFAULT '[]',
      trackingIssueUrl TEXT,
      trackingIssueNumber INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      clearedAt INTEGER)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS post_merge_steps_cleared ON post_merge_steps (clearedAt)`,
    );
    // Herd Rundown: one synthesized cross-session attention digest per calendar day.
    // Same lifecycle as recaps (generating → ready/failed); verdict columns empty until ready.
    this.db.run(`CREATE TABLE IF NOT EXISTS herd_digests (
      dayKey TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      overnight TEXT NOT NULL DEFAULT '',
      decisions TEXT NOT NULL DEFAULT '[]',
      ciRework TEXT NOT NULL DEFAULT '[]',
      train TEXT NOT NULL DEFAULT '',
      focusNext TEXT NOT NULL DEFAULT '[]',
      attentionFingerprint TEXT NOT NULL DEFAULT '{}',
      epicsToLand TEXT NOT NULL DEFAULT '[]',
      spawnSessionId TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT,
      spawnedAt INTEGER NOT NULL,
      generatedAt INTEGER,
      updatedAt INTEGER NOT NULL)`);
    // migrate herd_digests rows that predate the epicsToLand column (#1045) (legacy rows default []).
    const herdCols = this.db.query(`PRAGMA table_info(herd_digests)`).all() as { name: string }[];
    if (!herdCols.some((c) => c.name === "epicsToLand"))
      this.db.run(`ALTER TABLE herd_digests ADD COLUMN epicsToLand TEXT NOT NULL DEFAULT '[]'`);
    // Exact reviewer-cost attribution. Keyed by the *reviewer's* forced --session-id (which
    // locates its transcript), NOT the task — and deliberately carries NO foreign key to
    // `sessions`. `reviews`/`plan_gates` are keyed by the task sessionId and get deleted on
    // archive + cascade-pruned, so reviewer (critic/plan-gate) token burn vanishes with the
    // task. This table is the separate, append-only, archive-decoupled record that survives
    // both, so post-hoc cost reports can still attribute that burn. Each spawn forces a fresh
    // UUID, so a plain INSERT never collides on the PK.
    this.db.run(`CREATE TABLE IF NOT EXISTS reviewer_spawns (
      reviewerSessionId TEXT PRIMARY KEY,
      taskSessionId     TEXT NOT NULL,
      kind              TEXT NOT NULL,
      worktreePath      TEXT NOT NULL,
      reviewerProvider  TEXT,
      model             TEXT,
      reviewerEffort    TEXT,
      spawnedAt         INTEGER NOT NULL,
      completedAt       INTEGER,
      inputTokens       INTEGER,
      outputTokens      INTEGER,
      cacheReadTokens   INTEGER,
      cacheWriteTokens  INTEGER,
      totalTokens       INTEGER)`);
    this.migrateReviewerSpawnColumns();
    this.db.run(
      `CREATE INDEX IF NOT EXISTS reviewer_spawns_task ON reviewer_spawns (taskSessionId)`,
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, sessionId TEXT,
      kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS signals_repo_ts ON signals (repoPath, ts)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, rule TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, evidenceCount INTEGER NOT NULL DEFAULT 0,
  ineffectiveCount INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastEvidenceAt INTEGER, promotedPrUrl TEXT,
  ineffectiveSignalIds TEXT NOT NULL DEFAULT '[]')`);
    this.db.run(`CREATE INDEX IF NOT EXISTS learnings_repo_status ON learnings (repoPath, status)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS learning_prune_tombstones (
      repoPath TEXT NOT NULL, ruleKey TEXT NOT NULL, prunedAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, ruleKey))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS session_injected_learnings (
      sessionId TEXT NOT NULL, learningId TEXT NOT NULL,
      PRIMARY KEY (sessionId, learningId))`);
    // Phase 4 background merge-suggestions (#843). kind='intra': repoPath+targetId set,
    // repoPaths NULL. kind='cross': repoPath/targetId NULL, repoPaths set. signature is a
    // hash of the sorted member rule ids only (never text) for dedupe.
    this.db.run(`CREATE TABLE IF NOT EXISTS learning_merge_suggestions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'intra',
      repoPath TEXT, targetId TEXT,
      sourceIds TEXT NOT NULL, mergedRule TEXT NOT NULL,
      mergedRationale TEXT NOT NULL DEFAULT '', repoPaths TEXT,
      signature TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      createdAt INTEGER NOT NULL)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS merge_suggestions_repo_status ON learning_merge_suggestions (repoPath, status)`,
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS merge_suggestions_kind_status ON learning_merge_suggestions (kind, status)`,
    );
    this.migrateLearningsColumns();
    this.backfillLearningDiversity();
    // PK is composite (sessionId, id): step ids are scoped to a session so an agent may own a
    // short stable id (e.g. "s1") that survives a re-PUT, without colliding with the same id in
    // another session. Every build_queue_steps query is already session-scoped.
    this.db.run(`CREATE TABLE IF NOT EXISTS build_queue_steps (
      id TEXT NOT NULL, sessionId TEXT NOT NULL, position INTEGER NOT NULL,
      title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY (sessionId, id))`);
    this.migrateBuildQueueStepsPk();
    this.db.run(
      `CREATE INDEX IF NOT EXISTS build_queue_steps_session ON build_queue_steps (sessionId, position)`,
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS build_queue_state (
      sessionId TEXT PRIMARY KEY, approved INTEGER NOT NULL DEFAULT 0, approvalKind TEXT, updatedAt INTEGER NOT NULL)`);
    // Epic-authoring draft (issue #1507): one per session. `children`/acceptance/nonGoals are
    // JSON blobs (replaced wholesale on each PUT — no per-row status like build_queue). `status`
    // drives the CAS materialize lifecycle; `materializedChildren` (key→number JSON) enables
    // partial-failure resume.
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_draft (
      sessionId TEXT PRIMARY KEY,
      parentTitle TEXT NOT NULL DEFAULT '',
      parentBody TEXT NOT NULL DEFAULT '',
      acceptanceCriteria TEXT NOT NULL DEFAULT '[]',
      nonGoals TEXT NOT NULL DEFAULT '[]',
      children TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      materializedChildren TEXT NOT NULL DEFAULT '{}',
      parentNumber INTEGER,
      parentUrl TEXT,
      updatedAt INTEGER NOT NULL)`);
    // Crash recovery: any row left 'materializing' at boot is orphaned (no materialize survives a
    // restart — single-process ownership), so revert it to 'draft' (retaining materializedChildren)
    // so the operator can re-approve and resume. See src/epic-author.ts + the approve route.
    this.resetOrphanedEpicDraftMaterialize();
    // Scoped, durable per-plugin key/value (issue #1124). Plugins reach this ONLY via
    // ctx.state — they never touch the session schema. Composite PK keeps each plugin's
    // keys isolated; values are plugin-authored JSON strings.
    this.db.run(`CREATE TABLE IF NOT EXISTS plugin_state (
      pluginId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY (pluginId, key))`);
    // migrate build_queue_state rows that predate the approvalKind column (legacy rows NULL = unknown kind)
    const bqStateCols = this.db.query(`PRAGMA table_info(build_queue_state)`).all() as {
      name: string;
    }[];
    if (!bqStateCols.some((c) => c.name === "approvalKind"))
      this.db.run(`ALTER TABLE build_queue_state ADD COLUMN approvalKind TEXT`);
    // One stamp per workflow-protocol comment posted on a session's backlog issue
    // (issue-log: `waiting:<pr>` / `merged:<pr>`), so each transition comments exactly
    // once per PR across restarts and CI flaps.
    this.db.run(`CREATE TABLE IF NOT EXISTS issue_log (
      sessionId TEXT NOT NULL, key TEXT NOT NULL, createdAt INTEGER NOT NULL,
      PRIMARY KEY (sessionId, key))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_run (
      repoPath TEXT PRIMARY KEY, parentIssueNumber INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'idle', updatedAt INTEGER NOT NULL)`);
    this.addMissingColumns("epic_run", { agentProvider: "TEXT", model: "TEXT", effort: "TEXT" });
    // #645: the pinned integration-branch name, keyed PER EPIC (repoPath, parentIssueNumber)
    // — NOT on epic_run, which is one-row-per-repo and superseded when a new epic starts on that
    // repo, so a pin stored there would be inherited by the next epic and would outlive its own
    // epic's landing. A dedicated row per epic stays correct across supersession + into landing.
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_branch (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL,
      branch TEXT NOT NULL,
      PRIMARY KEY (repoPath, parentIssueNumber))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_integrated (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL, childNumber INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, parentIssueNumber, childNumber))`);
    this.migrateEpicIntegratedColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_completed (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL,
      parentTitle TEXT NOT NULL, completedAt INTEGER NOT NULL,
      dismissedAt INTEGER,
      childrenJson TEXT NOT NULL,
      landingPrNumber INTEGER,
      landingPrUrl TEXT,
      landingState TEXT NOT NULL DEFAULT 'pending',
      landingAttempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repoPath, parentIssueNumber))`);
    this.migrateEpicCompletedColumns();
    // #645: a child whose PR targets a base other than the pinned epic branch is parked here at
    // retire (fail-closed: not merged, not integrated). Keyed per child; the row is the throttle
    // anchor (bounds prReviewMeta to ≤1/child/~60s while stuck) and the assembleEpic warning source.
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_base_mismatch (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL, childNumber INTEGER NOT NULL,
      actualBase TEXT NOT NULL, prNumber INTEGER, checkedAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, parentIssueNumber, childNumber))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      ua TEXT NOT NULL DEFAULT '', locale TEXT NOT NULL DEFAULT 'en',
      catAgent INTEGER NOT NULL DEFAULT 1, catReviews INTEGER NOT NULL DEFAULT 1,
      catCi INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL)`);
    // migrate push tables that predate per-device locale (drives notification language)
    const pushCols = this.db.query(`PRAGMA table_info(push_subscriptions)`).all() as {
      name: string;
    }[];
    if (!pushCols.some((c) => c.name === "locale")) {
      this.db.run(`ALTER TABLE push_subscriptions ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'`);
    }
    // migrate push tables that predate per-category selection (default: all categories on,
    // preserving the prior all-or-nothing behavior for existing devices)
    this.addMissingColumns("push_subscriptions", {
      catAgent: "INTEGER NOT NULL DEFAULT 1",
      catReviews: "INTEGER NOT NULL DEFAULT 1",
      catCi: "INTEGER NOT NULL DEFAULT 1",
    });
    this.db.run(`CREATE TABLE IF NOT EXISTS session_usage (
      sessionId      TEXT PRIMARY KEY,
      desig          TEXT NOT NULL,
      name           TEXT NOT NULL DEFAULT '',
      claudeSessionId TEXT NOT NULL DEFAULT '',
      repoPath       TEXT NOT NULL,
      model          TEXT NOT NULL,
      input          INTEGER NOT NULL,
      output         INTEGER NOT NULL,
      cacheRead      INTEGER NOT NULL,
      cacheWrite     INTEGER NOT NULL,
      total          INTEGER NOT NULL,
      weightedUnits  REAL NOT NULL,
      cacheReadUnits REAL NOT NULL,
      messageCount   INTEGER NOT NULL,
      byModel        TEXT NOT NULL DEFAULT '{}',
      createdAt      INTEGER NOT NULL,
      archivedAt     INTEGER NOT NULL,
      snapshotAt     INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS session_usage_bucket (
      sessionId      TEXT NOT NULL,
      bucketStart    INTEGER NOT NULL,
      input          INTEGER NOT NULL,
      output         INTEGER NOT NULL,
      cacheRead      INTEGER NOT NULL,
      cacheWrite     INTEGER NOT NULL,
      weightedUnits  REAL NOT NULL,
      cacheReadUnits REAL NOT NULL,
      byModel        TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (sessionId, bucketStart),
      FOREIGN KEY (sessionId) REFERENCES session_usage(sessionId) ON DELETE CASCADE
    )`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS session_usage_bucket_start ON session_usage_bucket (bucketStart)`,
    );
    // migrate session_usage rows that predate the human-readable name column (legacy rows
    // default to '' — the usage UI falls back to showing the desig alone for those)
    const usageCols = this.db.query(`PRAGMA table_info(session_usage)`).all() as { name: string }[];
    if (!usageCols.some((c) => c.name === "name")) {
      this.db.run(`ALTER TABLE session_usage ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
    }
    // provenance column (see SessionUsageRow.claudeSessionId): legacy rows default to '',
    // which the archived-usage read tolerates as "pre-provenance"
    if (!usageCols.some((c) => c.name === "claudeSessionId")) {
      this.db.run(`ALTER TABLE session_usage ADD COLUMN claudeSessionId TEXT NOT NULL DEFAULT ''`);
    }
  }

  // ── settings (key/value) ─────────────────────────────────────────────────
  getSetting(key: string): string | null {
    const r = this.db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as {
      value: string;
    } | null;
    return r ? r.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  // ── plugin_state (scoped per-plugin key/value, issue #1124) ──────────────
  getPluginState(pluginId: string, key: string): string | null {
    const r = this.db
      .query(`SELECT value FROM plugin_state WHERE pluginId = ? AND key = ?`)
      .get(pluginId, key) as { value: string } | null;
    return r ? r.value : null;
  }

  setPluginState(pluginId: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO plugin_state (pluginId, key, value, updatedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(pluginId, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      [pluginId, key, value, Date.now()],
    );
  }

  deletePluginState(pluginId: string, key: string): void {
    this.db.run(`DELETE FROM plugin_state WHERE pluginId = ? AND key = ?`, [pluginId, key]);
  }

  listPluginStateKeys(pluginId: string): string[] {
    const rows = this.db
      .query(`SELECT key FROM plugin_state WHERE pluginId = ? ORDER BY key`)
      .all(pluginId) as { key: string }[];
    return rows.map((r) => r.key);
  }

  // ── doc-agent run history (capped KV JSON, newest-first) ─────────────────
  recordDocAgentRun(repoPath: string, run: import("./types").DocAgentRun): void {
    const key = `docagent:runs:${repoPath}`;
    const existing = this.listDocAgentRuns(repoPath);
    const updated = [run, ...existing].slice(0, 10);
    this.setSetting(key, JSON.stringify(updated));
  }

  listDocAgentRuns(repoPath: string): import("./types").DocAgentRun[] {
    const key = `docagent:runs:${repoPath}`;
    const raw = this.getSetting(key);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as import("./types").DocAgentRun[];
    } catch {
      return [];
    }
  }

  // ── per-repo config (critic on/off) ───────────────────────────────────────
  getRepoConfig(repoPath: string): RepoConfig {
    const r = this.db
      .query(
        `SELECT criticEnabled, criticAllPrs, criticSmellLensEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled, planGateEnabled,
                autoDrainEnabled, autoMergeEnabled, buildQueueEnabled, draftMode, signoffAuthority,
                maxAuto, autoLabel, usageCeilingPct, sandboxProfile, defaultModel, defaultEffort, egressExtraHosts, repoMode,
                autoOptimizeFlagged, manualStepsIssueEnabled, preWarmEpicLandingCi, hidden, previewStartScript, previewStartCommand, previewOpenMode
         FROM repo_config WHERE repoPath = ?`,
      )
      .get(repoPath) as RepoCfgRow | null;
    return repoConfigFromRow(r);
  }

  setRepoConfig(repoPath: string, cfg: RepoConfig): void {
    this.db.run(
      `INSERT INTO repo_config
         (repoPath, criticEnabled, criticAllPrs, criticSmellLensEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled, planGateEnabled,
          autoDrainEnabled, autoMergeEnabled, buildQueueEnabled, draftMode, signoffAuthority,
          maxAuto, autoLabel, usageCeilingPct, sandboxProfile, defaultModel, defaultEffort, egressExtraHosts, repoMode,
          autoOptimizeFlagged, manualStepsIssueEnabled, preWarmEpicLandingCi, hidden, previewStartScript, previewStartCommand, previewOpenMode, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repoPath) DO UPDATE SET criticEnabled = excluded.criticEnabled,
         criticAllPrs = excluded.criticAllPrs,
         criticSmellLensEnabled = excluded.criticSmellLensEnabled,
         autoAddressEnabled = excluded.autoAddressEnabled,
         learningsEnabled = excluded.learningsEnabled,
         autopilotEnabled = excluded.autopilotEnabled,
         planGateEnabled = excluded.planGateEnabled,
         autoDrainEnabled = excluded.autoDrainEnabled,
         autoMergeEnabled = excluded.autoMergeEnabled,
         buildQueueEnabled = excluded.buildQueueEnabled,
         draftMode = excluded.draftMode,
         signoffAuthority = excluded.signoffAuthority,
         maxAuto = excluded.maxAuto,
         autoLabel = excluded.autoLabel,
         usageCeilingPct = excluded.usageCeilingPct,
         sandboxProfile = excluded.sandboxProfile,
         defaultModel = excluded.defaultModel,
         defaultEffort = excluded.defaultEffort,
         egressExtraHosts = excluded.egressExtraHosts,
         repoMode = excluded.repoMode,
         autoOptimizeFlagged = excluded.autoOptimizeFlagged,
         manualStepsIssueEnabled = excluded.manualStepsIssueEnabled,
         preWarmEpicLandingCi = excluded.preWarmEpicLandingCi,
         hidden = excluded.hidden,
         previewStartScript = excluded.previewStartScript,
         previewStartCommand = excluded.previewStartCommand,
         previewOpenMode = excluded.previewOpenMode,
         updatedAt = excluded.updatedAt`,
      repoConfigParams(repoPath, cfg),
    );
  }

  /** repoPaths flagged hidden from the Backlog repos panel — one batch read for the
   *  backlog payload (avoids a per-repo getRepoConfig). */
  hiddenRepoPaths(): Set<string> {
    const rows = this.db.query(`SELECT repoPath FROM repo_config WHERE hidden = 1`).all() as {
      repoPath: string;
    }[];
    return new Set(rows.map((r) => r.repoPath));
  }

  // ── automation-confirmation (issue #1025) ────────────────────────────────

  /** True when the repo has been explicitly confirmed OR has any prior session (legacy repos). */
  isAutomationConfirmed(repoPath: string): boolean {
    const row = this.db
      .query(`SELECT automationConfirmedAt FROM repo_config WHERE repoPath = ?`)
      .get(repoPath) as { automationConfirmedAt: number | null } | null;
    if (row?.automationConfirmedAt != null) return true;
    return this.hasSessionForRepo(repoPath);
  }

  /** True when at least one session exists for the given repoPath. */
  hasSessionForRepo(repoPath: string): boolean {
    const row = this.db.query(`SELECT 1 FROM sessions WHERE repoPath = ? LIMIT 1`).get(repoPath);
    return row != null;
  }

  /** True when a repo_config row exists for the given repoPath. */
  automationRowExists(repoPath: string): boolean {
    const row = this.db.query(`SELECT 1 FROM repo_config WHERE repoPath = ? LIMIT 1`).get(repoPath);
    return row != null;
  }

  /** Stamp automationConfirmedAt = now. A row must already exist (PUT runs setRepoConfig first). */
  markAutomationConfirmed(repoPath: string): void {
    this.db.run(`UPDATE repo_config SET automationConfirmedAt = ? WHERE repoPath = ?`, [
      Date.now(),
      repoPath,
    ]);
  }

  // ── local_prs (lightweight-mode pseudo-PRs) ──────────────────────────────

  ensureLocalPr(repoPath: string, branch: string, base: string): LocalPr {
    const existing = this.getLocalPr(repoPath, branch);
    if (existing) return existing;
    this.db.run(
      `INSERT INTO local_prs (repoPath, branch, base, state, createdAt, mergedAt)
       VALUES (?, ?, ?, 'open', ?, NULL)`,
      [repoPath, branch, base, Date.now()],
    );
    return this.getLocalPr(repoPath, branch)!;
  }

  getLocalPr(repoPath: string, branch: string): LocalPr | null {
    const r = this.db
      .query(
        `SELECT number, repoPath, branch, base, state, createdAt, mergedAt
         FROM local_prs WHERE repoPath = ? AND branch = ?`,
      )
      .get(repoPath, branch) as LocalPrRow | null;
    return r ? localPrFromRow(r) : null;
  }

  getLocalPrByNumber(number: number): LocalPr | null {
    const r = this.db
      .query(
        `SELECT number, repoPath, branch, base, state, createdAt, mergedAt
         FROM local_prs WHERE number = ?`,
      )
      .get(number) as LocalPrRow | null;
    return r ? localPrFromRow(r) : null;
  }

  markLocalPrMerged(number: number): void {
    this.db.run(`UPDATE local_prs SET state = 'merged', mergedAt = ? WHERE number = ?`, [
      Date.now(),
      number,
    ]);
  }

  // ── web push subscriptions ────────────────────────────────────────────────
  putPushSub(sub: PushSubInput, ua: string): void {
    this.db.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, ua, locale, createdAt)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, locale = excluded.locale`,
      [sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua, sub.locale ?? "en", Date.now()],
    );
  }

  deletePushSub(endpoint: string): void {
    this.db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
  }

  listPushSubs(): StoredPushSub[] {
    const rows = this.db
      .query(
        `SELECT endpoint, p256dh, auth, ua, locale, catAgent, catReviews, catCi, createdAt
         FROM push_subscriptions`,
      )
      .all() as (Omit<StoredPushSub, "cats"> & {
      catAgent: number;
      catReviews: number;
      catCi: number;
    })[];
    return rows.map(({ catAgent, catReviews, catCi, ...rest }) => ({
      ...rest,
      cats: { agent: !!catAgent, reviews: !!catReviews, ci: !!catCi },
    }));
  }

  getPushPrefs(endpoint: string): PushPrefs | null {
    const r = this.db
      .query(`SELECT catAgent, catReviews, catCi FROM push_subscriptions WHERE endpoint = ?`)
      .get(endpoint) as { catAgent: number; catReviews: number; catCi: number } | null;
    return r ? { agent: !!r.catAgent, reviews: !!r.catReviews, ci: !!r.catCi } : null;
  }

  /** Update a device's category selection; false when no such subscription exists. */
  setPushPrefs(endpoint: string, prefs: PushPrefs): boolean {
    const { changes } = this.db.run(
      `UPDATE push_subscriptions SET catAgent = ?, catReviews = ?, catCi = ? WHERE endpoint = ?`,
      [prefs.agent ? 1 : 0, prefs.reviews ? 1 : 0, prefs.ci ? 1 : 0, endpoint],
    );
    return changes > 0;
  }

  // ── epic run (one active epic per repo) ──────────────────────────────────
  getEpicRun(repoPath: string): EpicRun | null {
    return (
      (this.db
        .query(
          `SELECT repoPath, parentIssueNumber, mode, status, agentProvider, model, effort FROM epic_run WHERE repoPath = ?`,
        )
        .get(repoPath) as EpicRun | null) ?? null
    );
  }

  /** All persisted epic_run rows (one per repo). Mirrors getEpicRun's row shape. */
  listEpicRuns(): EpicRun[] {
    return this.db
      .query(
        `SELECT repoPath, parentIssueNumber, mode, status, agentProvider, model, effort FROM epic_run`,
      )
      .all() as EpicRun[];
  }

  setEpicRun(r: EpicRun): void {
    this.db.run(
      `INSERT INTO epic_run (repoPath, parentIssueNumber, mode, status, agentProvider, model, effort, updatedAt) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(repoPath) DO UPDATE SET parentIssueNumber=excluded.parentIssueNumber, mode=excluded.mode, status=excluded.status, agentProvider=excluded.agentProvider, model=excluded.model, effort=excluded.effort, updatedAt=excluded.updatedAt`,
      [
        r.repoPath,
        r.parentIssueNumber,
        r.mode,
        r.status,
        r.agentProvider ?? null,
        r.agentProvider ? (r.model ?? null) : null,
        r.agentProvider ? (r.effort ?? null) : null,
        Date.now(),
      ],
    );
  }

  /** Single source of truth for an epic's pinned integration-branch name (#645), keyed
   *  PER EPIC `(repoPath, parentIssueNumber)`. The name derives from the parent title, but
   *  the title can be edited mid-run — re-deriving everywhere would re-point new spawns +
   *  the landing base and orphan children already merged on the old branch. So we pin it
   *  once on first sight and read it forever: an existing pin is returned as-is; otherwise
   *  `derived` is persisted for THIS epic and returned. Per-epic keying is load-bearing —
   *  `epic_run` is one-row-per-repo and superseded when a new epic starts, so a repo-scoped
   *  pin would be inherited by the next epic and would be wrong for a superseded epic's
   *  still-pending landing PR. */
  getOrInitEpicIntegrationBranch(
    repoPath: string,
    parentIssueNumber: number,
    derived: string,
  ): string {
    const row = this.db
      .query(`SELECT branch FROM epic_branch WHERE repoPath = ? AND parentIssueNumber = ?`)
      .get(repoPath, parentIssueNumber) as { branch: string } | null;
    if (row) return row.branch; // already pinned for this epic
    this.db.run(
      `INSERT INTO epic_branch (repoPath, parentIssueNumber, branch) VALUES (?,?,?)
       ON CONFLICT(repoPath, parentIssueNumber) DO NOTHING`,
      [repoPath, parentIssueNumber, derived],
    );
    return derived;
  }

  /** SELECT-only sibling of getOrInitEpicIntegrationBranch. Returns the pinned integration
   *  branch for an epic, or null when no pin exists. Safe to call from read paths — never
   *  INSERTs a row. */
  getEpicIntegrationBranch(repoPath: string, parentIssueNumber: number): string | null {
    const row = this.db
      .query(`SELECT branch FROM epic_branch WHERE repoPath = ? AND parentIssueNumber = ?`)
      .get(repoPath, parentIssueNumber) as { branch: string } | null;
    return row?.branch ?? null;
  }

  /** Record that a child PR was squash-merged into the epic integration branch.
   *  Idempotent (PK upsert) — the drain may re-observe a merge across pumps.
   *  On conflict, updates only PR columns (guarded by COALESCE so a null re-observe
   *  cannot clobber previously-recorded good values). createdAt is never overwritten. */
  recordEpicIntegrated(
    repoPath: string,
    parentIssueNumber: number,
    childNumber: number,
    pr?: { number: number; url: string },
    mergedBase?: string,
  ): void {
    this.db.run(
      `INSERT INTO epic_integrated (repoPath, parentIssueNumber, childNumber, createdAt, prNumber, prUrl, mergedBase)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT DO UPDATE SET
         prNumber = COALESCE(excluded.prNumber, epic_integrated.prNumber),
         prUrl = COALESCE(NULLIF(excluded.prUrl, ''), epic_integrated.prUrl),
         mergedBase = COALESCE(excluded.mergedBase, epic_integrated.mergedBase)`,
      [
        repoPath,
        parentIssueNumber,
        childNumber,
        Date.now(),
        pr?.number ?? null,
        pr?.url ?? null,
        mergedBase ?? null,
      ],
    );
  }

  /** Child #s squash-merged into the integration branch for one epic. */
  listEpicIntegrated(repoPath: string, parentIssueNumber: number): Set<number> {
    const rows = this.db
      .query(`SELECT childNumber FROM epic_integrated WHERE repoPath = ? AND parentIssueNumber = ?`)
      .all(repoPath, parentIssueNumber) as { childNumber: number }[];
    return new Set(rows.map((r) => r.childNumber));
  }

  /** True when this issue was already squash-merged into an epic's integration branch (#1037).
   *  Single source of truth for "this is an integrated epic child" — the merged-PR teardown path
   *  consults it to ARCHIVE-ONLY (never `closeIssue`) such a child, keeping the invariant that an
   *  epic child closes only when the landing PR merges into the default branch. Keyed by
   *  (repoPath, childNumber): a child belongs to exactly one epic per repo. */
  isEpicIntegratedChild(repoPath: string, childNumber: number): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM epic_integrated WHERE repoPath = ? AND childNumber = ? LIMIT 1`)
        .get(repoPath, childNumber) != null
    );
  }

  /** All integrated child rows for one epic, with PR details and mergedAt timestamp. */
  listEpicIntegratedDetails(
    repoPath: string,
    parentIssueNumber: number,
  ): {
    childNumber: number;
    prNumber: number | null;
    prUrl: string | null;
    mergedBase: string | null;
    mergedAt: number;
  }[] {
    return this.db
      .query(
        `SELECT childNumber, prNumber, prUrl, mergedBase, createdAt AS mergedAt
         FROM epic_integrated WHERE repoPath = ? AND parentIssueNumber = ?
         ORDER BY childNumber`,
      )
      .all(repoPath, parentIssueNumber) as {
      childNumber: number;
      prNumber: number | null;
      prUrl: string | null;
      mergedBase: string | null;
      mergedAt: number;
    }[];
  }

  // ── epic base-mismatch markers (#645) ─────────────────────────────────────
  /** Park a child whose PR targets the wrong base. Upsert — refreshes actualBase/prNumber/checkedAt
   *  (checkedAt is the throttle anchor, so it must advance on every recheck). */
  recordEpicBaseMismatch(
    repoPath: string,
    parentIssueNumber: number,
    childNumber: number,
    m: { actualBase: string; prNumber: number | null; checkedAt: number },
  ): void {
    this.db.run(
      `INSERT INTO epic_base_mismatch (repoPath, parentIssueNumber, childNumber, actualBase, prNumber, checkedAt)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT DO UPDATE SET
         actualBase = excluded.actualBase,
         prNumber = excluded.prNumber,
         checkedAt = excluded.checkedAt`,
      [repoPath, parentIssueNumber, childNumber, m.actualBase, m.prNumber, m.checkedAt],
    );
  }

  /** Clear a child's base-mismatch marker (the PR was re-targeted / merged correctly). */
  clearEpicBaseMismatch(repoPath: string, parentIssueNumber: number, childNumber: number): void {
    this.db.run(
      `DELETE FROM epic_base_mismatch WHERE repoPath = ? AND parentIssueNumber = ? AND childNumber = ?`,
      [repoPath, parentIssueNumber, childNumber],
    );
  }

  /** A single child's marker (or null) — drives the doRetire throttle read. */
  getEpicBaseMismatch(
    repoPath: string,
    parentIssueNumber: number,
    childNumber: number,
  ): { actualBase: string; prNumber: number | null; checkedAt: number } | null {
    return this.db
      .query(
        `SELECT actualBase, prNumber, checkedAt FROM epic_base_mismatch
         WHERE repoPath = ? AND parentIssueNumber = ? AND childNumber = ?`,
      )
      .get(repoPath, parentIssueNumber, childNumber) as {
      actualBase: string;
      prNumber: number | null;
      checkedAt: number;
    } | null;
  }

  /** All parked children for one epic — fed into assembleEpic for the actionable warnings. */
  listEpicBaseMismatches(
    repoPath: string,
    parentIssueNumber: number,
  ): { childNumber: number; actualBase: string; prNumber: number | null }[] {
    return this.db
      .query(
        `SELECT childNumber, actualBase, prNumber FROM epic_base_mismatch
         WHERE repoPath = ? AND parentIssueNumber = ? ORDER BY childNumber`,
      )
      .all(repoPath, parentIssueNumber) as {
      childNumber: number;
      actualBase: string;
      prNumber: number | null;
    }[];
  }

  /** Record a completed epic (all children done-in-epic). Idempotent upsert.
   *  On conflict, refreshes parentTitle/completedAt/childrenJson but leaves dismissedAt untouched
   *  so a previously dismissed epic never resurrects. */
  recordEpicCompleted(row: {
    repoPath: string;
    parentIssueNumber: number;
    parentTitle: string;
    completedAt: number;
    childrenJson: string;
  }): void {
    this.db.run(
      `INSERT INTO epic_completed (repoPath, parentIssueNumber, parentTitle, completedAt, childrenJson)
       VALUES (?,?,?,?,?)
       ON CONFLICT DO UPDATE SET
         parentTitle = excluded.parentTitle,
         completedAt = excluded.completedAt,
         childrenJson = excluded.childrenJson`,
      [row.repoPath, row.parentIssueNumber, row.parentTitle, row.completedAt, row.childrenJson],
    );
  }

  /** True if an epic_completed row exists for this key, regardless of dismissedAt.
   *  Used by the backfill pre-check so a dismissed-but-idle run isn't re-backfilled. */
  hasEpicCompleted(repoPath: string, parentIssueNumber: number): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM epic_completed WHERE repoPath = ? AND parentIssueNumber = ? LIMIT 1`)
        .get(repoPath, parentIssueNumber) !== null
    );
  }

  /** All non-dismissed completed epics, optionally filtered by repoPath, newest-completed first. */
  listEpicCompleted(repoPath?: string): {
    repoPath: string;
    parentIssueNumber: number;
    parentTitle: string;
    completedAt: number;
    childrenJson: string;
    landingPrNumber: number | null;
    landingPrUrl: string | null;
    landingState: EpicLandingState;
    landingAttempts: number;
    landingRebaseCount: number;
    landingRebaseDriverMisses: number;
    landingRebasePauseReason: "cap" | "conflict" | "driver" | null;
    migrationPaths: string[];
    migrationsAckedAt: number | null;
    landingRepairCount: number;
    landingRepairHead: string | null;
  }[] {
    const sql = `SELECT repoPath, parentIssueNumber, parentTitle, completedAt, childrenJson,
                landingPrNumber, landingPrUrl, landingState, landingAttempts,
                landingRebaseCount, landingRebaseDriverMisses, landingRebasePauseReason,
                migrationPathsJson, migrationsAckedAt, landingRepairCount, landingRepairHead
         FROM epic_completed WHERE dismissedAt IS NULL`;
    type Raw = {
      repoPath: string;
      parentIssueNumber: number;
      parentTitle: string;
      completedAt: number;
      childrenJson: string;
      landingPrNumber: number | null;
      landingPrUrl: string | null;
      landingState: EpicLandingState;
      landingAttempts: number;
      landingRebaseCount: number;
      landingRebaseDriverMisses: number;
      landingRebasePauseReason: string | null;
      migrationPathsJson: string | null;
      migrationsAckedAt: number | null;
      landingRepairCount: number;
      landingRepairHead: string | null;
    };
    const rows =
      repoPath !== undefined
        ? (this.db
            .query(`${sql} AND repoPath = ? ORDER BY completedAt DESC`)
            .all(repoPath) as Raw[])
        : (this.db.query(`${sql} ORDER BY completedAt DESC`).all() as Raw[]);
    return rows.map(({ migrationPathsJson, landingRebasePauseReason, ...rest }) => ({
      ...rest,
      landingRebasePauseReason: landingRebasePauseReason as "cap" | "conflict" | "driver" | null,
      migrationPaths: parseFindings(migrationPathsJson),
    }));
  }

  /** Write the Stage B (#635) landing-PR resolution onto a completed epic.
   *  Direct UPDATE (not part of recordEpicCompleted's preserve-by-omission upsert). */
  setEpicLandingPr(
    repoPath: string,
    parentIssueNumber: number,
    fields: {
      state: EpicLandingState;
      prNumber: number | null;
      prUrl: string | null;
      attempts: number;
    },
  ): void {
    this.db.run(
      `UPDATE epic_completed SET landingState = ?, landingPrNumber = ?, landingPrUrl = ?, landingAttempts = ?
       WHERE repoPath = ? AND parentIssueNumber = ?`,
      [fields.state, fields.prNumber, fields.prUrl, fields.attempts, repoPath, parentIssueNumber],
    );
  }

  /** Write rebase-state fields onto a completed epic's row (#1071). Only updates the fields
   *  present in `fields` (partial SET), so callers can bump one counter without clobbering others.
   *  Mirrors {@link setEpicLandingPr}'s direct-UPDATE style. */
  setEpicLandingRebaseState(
    repoPath: string,
    parentIssueNumber: number,
    fields: {
      count?: number;
      driverMisses?: number;
      pauseReason?: "cap" | "conflict" | "driver" | null;
    },
  ): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (fields.count !== undefined) {
      sets.push("landingRebaseCount = ?");
      vals.push(fields.count);
    }
    if (fields.driverMisses !== undefined) {
      sets.push("landingRebaseDriverMisses = ?");
      vals.push(fields.driverMisses);
    }
    if ("pauseReason" in fields) {
      sets.push("landingRebasePauseReason = ?");
      vals.push(fields.pauseReason ?? null);
    }
    if (sets.length === 0) return;
    vals.push(repoPath, parentIssueNumber);
    this.db.run(
      `UPDATE epic_completed SET ${sets.join(", ")} WHERE repoPath = ? AND parentIssueNumber = ?`,
      vals,
    );
  }

  /** Write the landing-repair session counters onto a completed epic's row: lifetime dispatch
   *  count + the epic-branch head SHA recorded at the last repair dispatch. Direct UPDATE,
   *  mirroring {@link setEpicLandingPr}'s style. */
  setEpicLandingRepairCount(
    repoPath: string,
    parentIssueNumber: number,
    count: number,
    head: string | null,
  ): void {
    this.db.run(
      `UPDATE epic_completed SET landingRepairCount = ?, landingRepairHead = ?
       WHERE repoPath = ? AND parentIssueNumber = ?`,
      [count, head, repoPath, parentIssueNumber],
    );
  }

  /** Persist the migration paths detected in a completed epic's landing PR (#645). Stored as a
   *  JSON array; an empty array clears any prior detection. Direct UPDATE, mirroring
   *  {@link setEpicLandingPr}'s style. */
  setEpicMigrationPaths(repoPath: string, parentIssueNumber: number, paths: string[]): void {
    this.db.run(
      `UPDATE epic_completed SET migrationPathsJson = ? WHERE repoPath = ? AND parentIssueNumber = ?`,
      [JSON.stringify(paths), repoPath, parentIssueNumber],
    );
  }

  /** Acknowledge a completed epic's landing-PR migrations (#645): stamp `migrationsAckedAt` AND
   *  dismiss the row in one operator action. `migrationsAckedAt` is the durable audit record of
   *  WHEN the human acknowledged; the coupled `dismissedAt` is what actually clears the band and
   *  prevents a re-prompt (listEpicCompleted filters `dismissedAt IS NULL`). */
  ackEpicMigrations(repoPath: string, parentIssueNumber: number): void {
    const now = Date.now();
    this.db.run(
      `UPDATE epic_completed SET migrationsAckedAt = ?, dismissedAt = ?
       WHERE repoPath = ? AND parentIssueNumber = ?`,
      [now, now, repoPath, parentIssueNumber],
    );
  }

  /** Mark a completed epic as dismissed (hides it from listEpicCompleted).
   *  At land-time there's no explicit dismiss call: the aggregate landing PR's
   *  `Closes #<parent>` closes the parent on merge, and the autoDismissClosed
   *  reconcile (src/server.ts) then dismisses the band once the parent is
   *  confidently closed. */
  dismissEpicCompleted(repoPath: string, parentIssueNumber: number): void {
    this.db.run(
      `UPDATE epic_completed SET dismissedAt = ? WHERE repoPath = ? AND parentIssueNumber = ?`,
      [Date.now(), repoPath, parentIssueNumber],
    );
  }

  private nextDesignationSeq(): number {
    const row = this.db.query(`SELECT next FROM task_seq WHERE id = 1`).get() as { next: number };
    this.db.run(`UPDATE task_seq SET next = next + 1 WHERE id = 1`);
    return row.next;
  }

  /** Assemble a fresh Session row from creation input + the assigned seq/timestamp. */
  private buildSessionRow(input: NewSession, seq: number, now: number): Session {
    return {
      ...input,
      model: input.model ?? null,
      effort: input.effort ?? null,
      claudeSessionId: input.claudeSessionId ?? "",
      providerSessionId: strOrEmpty(input.providerSessionId),
      agentProvider: input.agentProvider ?? "claude",
      id: input.id ?? randomUUID(),
      desig: `${DESIG_PREFIX}${String(seq).padStart(2, "0")}`,
      readyToMerge: false,
      autopilotEnabled: input.autopilotEnabled ?? null,
      autopilotStepCount: 0,
      autopilotPaused: false,
      autopilotComplete: false,
      autopilotQuestion: null,
      completionRepromptCount: 0,
      planGateEnabled: input.planGateEnabled ?? null,
      planPhase: input.planPhase ?? null,
      autoMergeEnabled: null,
      autoMergeRebaseCount: 0,
      autoMergeRebaseHead: null,
      autoMergeRebaseSteeredAt: null,
      auto: input.auto ?? false,
      issueNumber: input.issueNumber ?? null,
      sandboxApplied: input.sandboxApplied ?? null,
      sandboxDegraded: input.sandboxDegraded ?? false,
      egressApplied: input.egressApplied ?? false,
      egressDegraded: input.egressDegraded ?? false,
      research: input.research ?? false,
      // Boolean() (not `?? false`) so this new field adds no cyclomatic branch to the flat,
      // field-count-driven buildSessionRow (keeps it under its complexity cap).
      epicAuthoring: Boolean(input.epicAuthoring),
      landingRepair: Boolean(input.landingRepair),
      status: "running",
      lastState: "idle",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      archiveReason: null,
      mergingSince: null,
      mergingTrainId: null,
      mergeTrainPrs: input.mergeTrainPrs ?? null,
      mergingPrNumber: null,
      haltReason: null,
      haltedAt: null,
      manualSteps: [],
      manualStepsAckedAt: null,
      experimentId: null,
      experimentRole: null,
      spawnTerminalId: null, // stamped post-create by persistSpawnIdentity
      spawnAccountDir: null,
      launchMetadata: input.launchMetadata ?? null,
    };
  }

  create(input: NewSession): Session {
    return this.db.transaction(() => {
      const now = Date.now();
      const seq = this.nextDesignationSeq();
      const s = this.buildSessionRow(input, seq, now);
      this.db.run(
        `INSERT INTO sessions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          s.id,
          s.desig,
          s.name,
          s.prompt,
          s.repoPath,
          s.baseBranch,
          s.branch,
          s.worktreePath,
          s.isolated ? 1 : 0,
          s.herdrSession,
          s.herdrAgentId,
          s.claudeSessionId,
          s.agentProvider ?? "claude",
          s.model,
          s.effort,
          s.readyToMerge ? 1 : 0,
          s.status,
          s.lastState,
          s.autopilotEnabled === null ? null : s.autopilotEnabled ? 1 : 0, // autopilotEnabled
          0, // autopilotStepCount
          0, // autopilotPaused
          0, // autopilotComplete
          null, // autopilotQuestion
          0, // completionRepromptCount
          s.planGateEnabled === null ? null : s.planGateEnabled ? 1 : 0, // planGateEnabled — inherit repo default
          s.planPhase, // planPhase — null = gate off
          null, // autoMergeEnabled — inherit repo default
          0, // autoMergeRebaseCount
          null, // autoMergeRebaseHead — none outstanding
          null, // autoMergeRebaseSteeredAt — never steered
          s.auto ? 1 : 0,
          s.issueNumber,
          s.sandboxApplied,
          s.sandboxDegraded ? 1 : 0,
          s.egressApplied ? 1 : 0,
          s.egressDegraded ? 1 : 0,
          s.research ? 1 : 0,
          Number(s.epicAuthoring), // Number() not `? 1 : 0` — no ternary → no cognitive bump on the INSERT arrow
          Number(s.landingRepair), // Number() not `? 1 : 0` — no ternary → no cognitive bump on the INSERT arrow
          s.createdAt,
          s.updatedAt,
          s.archivedAt,
          s.mergingSince,
          s.mergingTrainId,
          s.mergeTrainPrs !== null ? JSON.stringify(s.mergeTrainPrs) : null,
          null, // mergingPrNumber — always null at create
          null, // haltReason — always null at create
          null, // haltedAt — always null at create
          null, // manualStepsJson — always null at create (detected later from the PR body)
          null, // manualStepsAckedAt — always null at create (P2)
          null, // experimentId — always null at create (stamped post-create by startVariant/startComparison)
          null, // experimentRole — always null at create
          null, // spawnTerminalId — always null at create (stamped post-create by persistSpawnIdentity)
          null, // spawnAccountDir — always null at create
          strOrEmpty(s.providerSessionId), // "" at create for both providers; Codex id captured post-spawn
          launchMetadataJson(s.launchMetadata),
          null, // archiveReason — a fresh session has not been archived
        ],
      );
      return s;
    })();
  }

  get(id: string): Session | null {
    const r = this.db
      .query(`SELECT ${COLS} FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | null;
    return r ? this.hydrate(r) : null;
  }

  list(opts?: { activeOnly?: boolean }): Session[] {
    const where = opts?.activeOnly ? `WHERE status != 'archived'` : ``;
    return (
      this.db
        .query(`SELECT ${COLS} FROM sessions ${where} ORDER BY createdAt`)
        .all() as SessionRow[]
    ).map((r) => this.hydrate(r));
  }

  /** Archived sessions retired since `sinceMs`, newest-first — drives the read-only
   *  "recently done" surface (recaps survive worktree teardown). */
  listRecentlyArchived(sinceMs: number): Session[] {
    return (
      this.db
        .query(
          `SELECT ${COLS} FROM sessions WHERE status = 'archived' AND archivedAt >= ? ORDER BY archivedAt DESC`,
        )
        .all(sinceMs) as SessionRow[]
    ).map((r) => this.hydrate(r));
  }

  /** All archived sessions, newest-first by real archive time. Includes legacy rows whose
   *  archivedAt column is NULL (a `archivedAt >= 0` filter would drop them). */
  listArchivedSessions(): Session[] {
    return (
      this.db
        .query(
          `SELECT ${COLS} FROM sessions WHERE status = 'archived' ORDER BY COALESCE(archivedAt, updatedAt, createdAt) DESC`,
        )
        .all() as SessionRow[]
    ).map((r) => this.hydrate(r));
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Session,
        | "name"
        | "status"
        | "lastState"
        | "branch"
        | "herdrAgentId"
        | "claudeSessionId"
        | "providerSessionId"
        | "agentProvider"
        | "model"
        | "effort"
        | "readyToMerge"
        | "mergingSince"
        | "mergingTrainId"
        | "mergingPrNumber"
        | "planGateEnabled"
        | "planPhase"
      >
    >,
  ) {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE sessions SET name=?, status=?, lastState=?, branch=?, herdrAgentId=?, claudeSessionId=?, providerSessionId=?, agentProvider=?, model=?, effort=?, readyToMerge=?, mergingSince=?, mergingTrainId=?, mergingPrNumber=?, planGateEnabled=?, planPhase=?, updatedAt=? WHERE id=?`,
      [
        next.name,
        next.status,
        next.lastState,
        next.branch,
        next.herdrAgentId,
        next.claudeSessionId,
        strOrEmpty(next.providerSessionId),
        next.agentProvider ?? "claude",
        next.model,
        next.effort,
        next.readyToMerge ? 1 : 0,
        next.mergingSince,
        next.mergingTrainId,
        next.mergingPrNumber,
        next.planGateEnabled === null ? null : next.planGateEnabled ? 1 : 0,
        next.planPhase,
        next.updatedAt,
        id,
      ],
    );
  }

  /** Patch a session's applied sandbox state (set at spawn by the sandbox wrapper).
   *  Only the provided keys are written. */
  setSandboxState(
    id: string,
    patch: {
      applied?: SandboxProfile | null;
      degraded?: boolean;
      egressApplied?: boolean;
      egressDegraded?: boolean;
    },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const applied = patch.applied === undefined ? cur.sandboxApplied : patch.applied;
    const degraded = patch.degraded === undefined ? cur.sandboxDegraded : patch.degraded;
    const egressApplied =
      patch.egressApplied === undefined ? cur.egressApplied : patch.egressApplied;
    const egressDegraded =
      patch.egressDegraded === undefined ? cur.egressDegraded : patch.egressDegraded;
    this.db.run(
      `UPDATE sessions SET sandboxApplied=?, sandboxDegraded=?, egressApplied=?, egressDegraded=?, updatedAt=? WHERE id=?`,
      [applied, degraded ? 1 : 0, egressApplied ? 1 : 0, egressDegraded ? 1 : 0, Date.now(), id],
    );
  }

  /** Patch a session's autopilot fields. Only the provided keys are written. */
  setAutopilotState(
    id: string,
    patch: {
      enabled?: boolean | null;
      stepCount?: number;
      paused?: boolean;
      complete?: boolean;
      question?: string | null;
      completionReprompt?: number;
    },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const enabled = patch.enabled === undefined ? cur.autopilotEnabled : patch.enabled;
    const stepCount = patch.stepCount ?? cur.autopilotStepCount;
    const paused = patch.paused ?? cur.autopilotPaused;
    const complete = patch.complete ?? cur.autopilotComplete;
    const question = patch.question === undefined ? cur.autopilotQuestion : patch.question;
    const completionReprompt = patch.completionReprompt ?? cur.completionRepromptCount;
    this.db.run(
      `UPDATE sessions SET autopilotEnabled=?, autopilotStepCount=?, autopilotPaused=?, autopilotComplete=?, autopilotQuestion=?, completionRepromptCount=?, updatedAt=? WHERE id=?`,
      [
        enabled === null ? null : enabled ? 1 : 0,
        stepCount,
        paused ? 1 : 0,
        complete ? 1 : 0,
        question,
        completionReprompt,
        Date.now(),
        id,
      ],
    );
  }

  /** Update full-auto merge fields. `enabled`: override (boolean|null). `rebaseCount`: absolute.
   *  `rebaseHead`: the head SHA last steered for (string), or null to clear. */
  setAutoMergeState(
    id: string,
    patch: {
      enabled?: boolean | null;
      rebaseCount?: number;
      rebaseHead?: string | null;
      /** Epoch ms of the last conflict-path rebase steer. Drives the expiring dedup AND the
       *  CI-fix stand-down's ownership window — cleared wherever rebaseHead is cleared. */
      rebaseSteeredAt?: number | null;
    },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const enabled = patch.enabled === undefined ? cur.autoMergeEnabled : patch.enabled;
    const rebaseCount =
      patch.rebaseCount === undefined ? cur.autoMergeRebaseCount : patch.rebaseCount;
    const rebaseHead = patch.rebaseHead === undefined ? cur.autoMergeRebaseHead : patch.rebaseHead;
    const rebaseSteeredAt =
      patch.rebaseSteeredAt === undefined
        ? (cur.autoMergeRebaseSteeredAt ?? null)
        : patch.rebaseSteeredAt;
    this.db.run(
      `UPDATE sessions SET autoMergeEnabled=?, autoMergeRebaseCount=?, autoMergeRebaseHead=?, autoMergeRebaseSteeredAt=?, updatedAt=? WHERE id=?`,
      [
        enabled === null ? null : enabled ? 1 : 0,
        rebaseCount,
        rebaseHead,
        rebaseSteeredAt,
        Date.now(),
        id,
      ],
    );
  }

  /** Link a session into a comparison experiment (group id + role), or clear it with both
   *  null. Idempotent. Bumps updatedAt so a re-fetch reflects the change. */
  setExperiment(
    id: string,
    patch: { experimentId: string | null; role: ExperimentRole | null },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    this.db.run(`UPDATE sessions SET experimentId=?, experimentRole=?, updatedAt=? WHERE id=?`, [
      patch.experimentId,
      patch.role,
      Date.now(),
      id,
    ]);
  }

  /** All sessions tagged with `experimentId`, oldest-first (variants + the comparison session).
   *  Includes archived rows so a comparison can still reference a torn-down variant's branch. */
  variantsForExperiment(experimentId: string): Session[] {
    return (
      this.db
        .query(`SELECT ${COLS} FROM sessions WHERE experimentId = ? ORDER BY createdAt`)
        .all(experimentId) as SessionRow[]
    ).map((r) => this.hydrate(r));
  }

  /** Map of repoPath → most-recent session createdAt (across all sessions, incl. archived). */
  lastUsedByRepo(): Record<string, number> {
    const rows = this.db
      .query(`SELECT repoPath, MAX(createdAt) AS t FROM sessions GROUP BY repoPath`)
      .all() as { repoPath: string; t: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.repoPath] = r.t;
    return out;
  }

  /**
   * Map of repoPath → count of sessions (agents) created since `since` (ms epoch).
   * Drives the "recently worked on" shortcut in the repo picker — a measure of how
   * many agents were run on each repo in the recent window, across all sessions.
   */
  recentSessionCountsByRepo(since: number): Record<string, number> {
    const rows = this.db
      .query(`SELECT repoPath, COUNT(*) AS n FROM sessions WHERE createdAt >= ? GROUP BY repoPath`)
      .all(since) as { repoPath: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.repoPath] = r.n;
    return out;
  }

  archive(id: string, reason: SessionArchiveReason = "operator") {
    const now = Date.now();
    this.db.run(
      `UPDATE sessions SET status='archived', archivedAt=?, archiveReason=?, updatedAt=? WHERE id=? AND status!='archived'`,
      [now, reason, now, id],
    );
  }

  unarchive(id: string) {
    const now = Date.now();
    this.db.run(`UPDATE sessions SET archivedAt=NULL, archiveReason=NULL, updatedAt=? WHERE id=?`, [
      now,
      id,
    ]);
  }

  // ── usage limit caps (CapStore) ──────────────────────────────────────────
  getCaps(): CapRow[] {
    return this.db
      .query(`SELECT window, cap, resetAt, pct, scrapedAt FROM usage_caps`)
      .all() as CapRow[];
  }

  putCap(row: CapRow): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO usage_caps (window, cap, resetAt, pct, scrapedAt) VALUES (?,?,?,?,?)
         ON CONFLICT(window) DO UPDATE SET cap=excluded.cap, resetAt=excluded.resetAt,
           pct=excluded.pct, scrapedAt=excluded.scrapedAt`,
        [row.window as WindowKey, row.cap, row.resetAt, row.pct, row.scrapedAt],
      );
      this.db.run(
        `INSERT INTO usage_caps_history (window, cap, resetAt, pct, scrapedAt) VALUES (?,?,?,?,?)`,
        [row.window as WindowKey, row.cap, row.resetAt, row.pct, row.scrapedAt],
      );
    })();
  }

  getCreditSnapshot(): CreditSnapshot | null {
    return (
      (this.db
        .query(
          `SELECT spent, cap, currency, pct, resetAt, scrapedAt FROM usage_credit WHERE id = 1`,
        )
        .get() as CreditSnapshot | null) ?? null
    );
  }

  putCreditSnapshot(row: CreditSnapshot): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO usage_credit (id, spent, cap, currency, pct, resetAt, scrapedAt) VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET spent=excluded.spent, cap=excluded.cap, currency=excluded.currency,
           pct=excluded.pct, resetAt=excluded.resetAt, scrapedAt=excluded.scrapedAt`,
        [row.spent, row.cap, row.currency, row.pct, row.resetAt, row.scrapedAt],
      );
      this.db.run(
        `INSERT INTO usage_credit_history (spent, cap, currency, pct, resetAt, scrapedAt) VALUES (?,?,?,?,?,?)`,
        [row.spent, row.cap, row.currency, row.pct, row.resetAt, row.scrapedAt],
      );
    })();
  }

  getModelWeekSnapshots(): ModelWeekSnapshot[] {
    return this.db
      .query(`SELECT model, pct, resetAt, scrapedAt FROM usage_model_week`)
      .all() as ModelWeekSnapshot[];
  }

  putModelWeekSnapshot(row: ModelWeekSnapshot): void {
    this.db.run(
      `INSERT INTO usage_model_week (model, pct, resetAt, scrapedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET pct=excluded.pct, resetAt=excluded.resetAt, scrapedAt=excluded.scrapedAt`,
      [row.model, row.pct, row.resetAt, row.scrapedAt],
    );
  }

  getCapsHistory(sinceTs: number): CapRow[] {
    return this.db
      .query(
        `SELECT window, cap, resetAt, pct, scrapedAt FROM usage_caps_history
         WHERE scrapedAt >= ? ORDER BY scrapedAt ASC`,
      )
      .all(sinceTs) as CapRow[];
  }

  getCreditHistory(sinceTs: number): CreditSnapshot[] {
    return this.db
      .query(
        `SELECT spent, cap, currency, pct, resetAt, scrapedAt FROM usage_credit_history
         WHERE scrapedAt >= ? ORDER BY scrapedAt ASC`,
      )
      .all(sinceTs) as CreditSnapshot[];
  }

  /** Delete history rows older than `beforeTs` from both tables; returns total rows removed. */
  pruneUsageHistory(beforeTs: number): number {
    const caps = (
      this.db
        .query(`SELECT COUNT(*) AS c FROM usage_caps_history WHERE scrapedAt < ?`)
        .get(beforeTs) as { c: number }
    ).c;
    const credits = (
      this.db
        .query(`SELECT COUNT(*) AS c FROM usage_credit_history WHERE scrapedAt < ?`)
        .get(beforeTs) as { c: number }
    ).c;
    this.db.run(`DELETE FROM usage_caps_history WHERE scrapedAt < ?`, [beforeTs]);
    this.db.run(`DELETE FROM usage_credit_history WHERE scrapedAt < ?`, [beforeTs]);
    return caps + credits;
  }

  // ── critic reviews ─────────────────────────────────────────────────────────
  private hydrateReview(r: ReviewVerdictRow): ReviewVerdict {
    return {
      ...r,
      patchId: r.patchId ?? "",
      findings: parseFindings(r.findings),
      addressRound: r.addressRound ?? 0,
      addressCap: r.addressCap ?? 3,
      streakReviews: r.streakReviews ?? 0,
      reviewedPatchIds: parseFindings(r.reviewedPatchIds), // same string[] JSON shape as seenNoteIds
      errorRound: r.errorRound ?? 0,
      finalRoundPending: !!r.finalRoundPending,
      finalRoundTimeoutMs: r.finalRoundTimeoutMs ?? 900_000,
      seenNoteIds: parseFindings(r.seenNoteIds), // same string[] JSON shape as findings
      url: r.url ?? undefined,
      // Optional flag: present only on a pre-spawn abort row; a normal verdict omits it entirely.
      spawnAborted: r.spawnAborted ? true : undefined,
      // Optional flag: true only when the operator dismissed/took over this stalled rework.
      dismissed: r.dismissed ? true : undefined,
    } as ReviewVerdict;
  }

  getReview(sessionId: string): ReviewVerdict | null {
    const r = this.db
      .query(
        `SELECT sessionId, headSha, patchId, decision, summary, body, findings, addressRound,
                addressCap, streakReviews, reviewedPatchIds, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, spawnAborted, dismissed, updatedAt
              FROM reviews WHERE sessionId = ?`,
      )
      .get(sessionId) as ReviewVerdictRow | null;
    return r ? this.hydrateReview(r) : null;
  }

  putReview(v: ReviewVerdict): void {
    this.db.run(
      `INSERT INTO reviews (sessionId, headSha, patchId, decision, summary, body, findings, addressRound,
         addressCap, streakReviews, reviewedPatchIds, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, spawnAborted, dismissed, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET headSha=excluded.headSha, patchId=excluded.patchId,
         decision=excluded.decision,
         summary=excluded.summary, body=excluded.body, findings=excluded.findings,
         addressRound=excluded.addressRound, addressCap=excluded.addressCap,
         streakReviews=excluded.streakReviews, reviewedPatchIds=excluded.reviewedPatchIds,
         errorRound=excluded.errorRound, finalRoundPending=excluded.finalRoundPending,
         finalRoundTimeoutMs=excluded.finalRoundTimeoutMs, seenNoteIds=excluded.seenNoteIds,
         url=excluded.url, spawnAborted=excluded.spawnAborted, dismissed=excluded.dismissed, updatedAt=excluded.updatedAt`,
      [
        v.sessionId,
        v.headSha,
        v.patchId ?? "",
        v.decision,
        v.summary,
        v.body,
        JSON.stringify(v.findings ?? []),
        v.addressRound ?? 0,
        v.addressCap ?? 3,
        v.streakReviews ?? 0,
        JSON.stringify(v.reviewedPatchIds ?? []),
        v.errorRound ?? 0,
        v.finalRoundPending ? 1 : 0,
        v.finalRoundTimeoutMs ?? 900_000,
        JSON.stringify(v.seenNoteIds ?? []),
        v.url ?? null,
        v.spawnAborted ? 1 : 0,
        v.dismissed ? 1 : 0,
        v.updatedAt,
      ],
    );
  }

  dropReview(sessionId: string): void {
    this.db.run(`DELETE FROM reviews WHERE sessionId = ?`, [sessionId]);
  }

  // ── issue workflow log (one stamp per posted issue comment) ───────────────
  hasIssueLog(sessionId: string, key: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM issue_log WHERE sessionId = ? AND key = ?`)
        .get(sessionId, key) != null
    );
  }

  markIssueLog(sessionId: string, key: string): void {
    this.db.run(`INSERT OR IGNORE INTO issue_log (sessionId, key, createdAt) VALUES (?, ?, ?)`, [
      sessionId,
      key,
      Date.now(),
    ]);
  }

  /** Re-point an existing verdict at a new head without re-reviewing. Used when a head
   *  change (rebase/force-push) leaves the reviewed diff content-identical (same patchId):
   *  the prior decision/findings/rounds still apply, so only headSha + updatedAt move. */
  bumpReviewHead(sessionId: string, headSha: string, updatedAt: number): void {
    this.db.run(`UPDATE reviews SET headSha = ?, updatedAt = ? WHERE sessionId = ?`, [
      headSha,
      updatedAt,
      sessionId,
    ]);
  }

  snapshotReviews(): Record<string, ReviewVerdict> {
    const rows = this.db
      .query(
        `SELECT sessionId, headSha, patchId, decision, summary, body, findings, addressRound,
                addressCap, streakReviews, reviewedPatchIds, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, spawnAborted, dismissed, updatedAt FROM reviews`,
      )
      .all() as ReviewVerdictRow[];
    const out: Record<string, ReviewVerdict> = {};
    for (const r of rows) out[r.sessionId] = this.hydrateReview(r);
    return out;
  }

  // ── pre-execution plan gates ─────────────────────────────────────────────────
  private hydratePlanGate(r: PlanGateRow): PlanGate {
    // Persisted blocks were already validated + server-grounded at gate finalization. Parse as
    // trusted data — do NOT re-run parseVisualBlocks, the LLM-input trust boundary, which would
    // strip the server-forced `inferred` flag off data-model/api-endpoint/mermaid blocks.
    // parseVisualBlocks runs only on fresh spawn output, never on DB reads.
    let blocks: VisualBlock[] = [];
    try {
      const parsed = JSON.parse(r.blocks);
      if (Array.isArray(parsed)) blocks = parsed as VisualBlock[];
    } catch {
      blocks = [];
    }
    let answeredQuestionKeys: string[] = [];
    try {
      const parsed = JSON.parse(r.answeredQuestionKeys ?? "[]");
      if (Array.isArray(parsed))
        answeredQuestionKeys = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      answeredQuestionKeys = [];
    }
    return {
      sessionId: r.sessionId,
      planHash: r.planHash ?? "",
      decision: r.decision,
      summary: r.summary ?? "",
      summaryCode: coerceSummaryCode(r.summaryCode),
      body: r.body ?? "",
      findings: parseFindings(r.findings),
      round: r.round ?? 0,
      cap: r.cap ?? 3,
      approved: !!r.approved,
      plan: r.plan ?? "",
      reviewerProvider:
        r.reviewerProvider === "claude" || r.reviewerProvider === "codex"
          ? r.reviewerProvider
          : null,
      reviewerModel: r.reviewerModel ?? null,
      reviewerEffort: r.reviewerEffort ?? null,
      updatedAt: r.updatedAt,
      blocks,
      answeredQuestionKeys,
      finalRoundPending: !!r.finalRoundPending,
      dismissed: !!r.dismissed,
    } as PlanGate;
  }

  getPlanGate(sessionId: string): PlanGate | null {
    const r = this.db
      .query(
        `SELECT sessionId, planHash, decision, summary, summaryCode, body, findings, round, cap, approved, plan, updatedAt, blocks, answeredQuestionKeys, reviewerProvider, reviewerModel, reviewerEffort, finalRoundPending, dismissed
              FROM plan_gates WHERE sessionId = ?`,
      )
      .get(sessionId) as PlanGateRow | null;
    return r ? this.hydratePlanGate(r) : null;
  }

  putPlanGate(g: PlanGate): void {
    this.db.run(
      `INSERT INTO plan_gates (sessionId, planHash, decision, summary, summaryCode, body, findings, round, cap, approved, plan, updatedAt, blocks, answeredQuestionKeys, reviewerProvider, reviewerModel, reviewerEffort, finalRoundPending, dismissed)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET planHash=excluded.planHash, decision=excluded.decision,
         summary=excluded.summary, summaryCode=excluded.summaryCode, body=excluded.body, findings=excluded.findings,
         round=excluded.round, cap=excluded.cap, approved=excluded.approved,
         plan=excluded.plan, updatedAt=excluded.updatedAt, blocks=excluded.blocks,
         answeredQuestionKeys=excluded.answeredQuestionKeys,
         reviewerProvider=excluded.reviewerProvider, reviewerModel=excluded.reviewerModel,
         reviewerEffort=excluded.reviewerEffort,
         finalRoundPending=excluded.finalRoundPending, dismissed=excluded.dismissed`,
      [
        g.sessionId,
        g.planHash ?? "",
        g.decision,
        g.summary,
        g.summaryCode ?? null,
        g.body,
        JSON.stringify(g.findings ?? []),
        g.round ?? 0,
        g.cap ?? 3,
        g.approved ? 1 : 0,
        g.plan ?? "",
        g.updatedAt,
        JSON.stringify(g.blocks ?? []),
        JSON.stringify(g.answeredQuestionKeys ?? []),
        g.reviewerProvider ?? null,
        g.reviewerModel ?? null,
        g.reviewerEffort ?? null,
        g.finalRoundPending ? 1 : 0,
        g.dismissed ? 1 : 0,
      ],
    );
  }

  dropPlanGate(sessionId: string): void {
    this.db.run(`DELETE FROM plan_gates WHERE sessionId = ?`, [sessionId]);
  }

  snapshotPlanGates(): Record<string, PlanGate> {
    const rows = this.db
      .query(
        `SELECT sessionId, planHash, decision, summary, summaryCode, body, findings, round, cap, approved, plan, updatedAt, blocks, answeredQuestionKeys, reviewerProvider, reviewerModel, reviewerEffort, finalRoundPending, dismissed FROM plan_gates`,
      )
      .all() as PlanGateRow[];
    const out: Record<string, PlanGate> = {};
    for (const r of rows) out[r.sessionId] = this.hydratePlanGate(r);
    return out;
  }

  // ── session recaps ────────────────────────────────────────────────────────────
  private hydrateRecap(r: RecapRow): Recap {
    // Persisted blocks were already validated + server-grounded at finalize (the real DiffFile is
    // joined onto diff blocks there). Parse as trusted data — do NOT re-run parseVisualBlocks, the
    // LLM-input trust boundary, which strips the joined `file` off diff blocks. parseVisualBlocks
    // runs only on fresh spawn output (recap-core.ts), never on DB reads.
    return {
      sessionId: r.sessionId,
      state: r.state,
      headSha: r.headSha ?? "",
      base: r.base ?? "",
      verdict: r.verdict ?? null,
      headline: r.headline ?? "",
      body: r.body ?? "",
      skip: parseSkipReason(r.skipReason),
      failure: r.skipReason ? null : parseFailureReason(r.failureReason),
      diffState:
        r.diffState === "none" || r.diffState === "present" || r.diffState === "landed"
          ? r.diffState
          : null,
      openItems: safeJsonArray(r.openItems),
      changedFiles: safeJsonArray(r.changedFiles),
      blocks: parseRecapBlocks(r.blocks),
      spawnSessionId: r.spawnSessionId ?? "",
      cwd: r.cwd ?? "",
      model: r.model ?? null,
      spawnedAt: r.spawnedAt,
      generatedAt: r.generatedAt ?? null,
      updatedAt: r.updatedAt,
    } as Recap;
  }

  private parsePendingDiff(raw: unknown): DiffFile[] {
    try {
      const p = JSON.parse(raw as string);
      return Array.isArray(p) ? (p as DiffFile[]) : [];
    } catch {
      return [];
    }
  }

  getRecap(sessionId: string): Recap | null {
    const r = this.db
      .query(
        `SELECT sessionId, state, headSha, base, verdict, headline, body, skipReason, failureReason, diffState, openItems, changedFiles, blocks,
                spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt
              FROM recaps WHERE sessionId = ?`,
      )
      .get(sessionId) as RecapRow | null;
    return r ? this.hydrateRecap(r) : null;
  }

  putRecap(recap: Recap): void {
    this.db.run(
      `INSERT INTO recaps (sessionId, state, headSha, base, verdict, headline, body, skipReason, failureReason, diffState, openItems, changedFiles,
         blocks, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET state=excluded.state, headSha=excluded.headSha,
         base=excluded.base,
         verdict=excluded.verdict, headline=excluded.headline, body=excluded.body,
         skipReason=excluded.skipReason,
         failureReason=excluded.failureReason,
         diffState=excluded.diffState,
         openItems=excluded.openItems, changedFiles=excluded.changedFiles,
         blocks=excluded.blocks,
         spawnSessionId=excluded.spawnSessionId,
         cwd=excluded.cwd, model=excluded.model, spawnedAt=excluded.spawnedAt,
         generatedAt=excluded.generatedAt, updatedAt=excluded.updatedAt`,
      [
        recap.sessionId,
        recap.state,
        recap.headSha ?? "",
        recap.base ?? "",
        recap.verdict ?? null,
        recap.headline ?? "",
        recap.body ?? "",
        serializeRecapSkip(recap),
        serializeRecapFailure(recap),
        recap.diffState ?? null,
        JSON.stringify(recap.openItems ?? []),
        JSON.stringify(recap.changedFiles ?? []),
        JSON.stringify(recap.blocks ?? []),
        recap.spawnSessionId ?? "",
        recap.cwd ?? "",
        recap.model ?? null,
        recap.spawnedAt,
        recap.generatedAt ?? null,
        recap.updatedAt,
      ],
    );
  }

  /** All recaps, including pre-feature `empty` rows whose historical cause the UI explains. */
  snapshotRecaps(): Record<string, Recap> {
    const rows = this.db
      .query(
        `SELECT sessionId, state, headSha, base, verdict, headline, body, skipReason, failureReason, diffState, openItems, changedFiles, blocks,
                spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt
              FROM recaps`,
      )
      .all() as RecapRow[];
    const out: Record<string, Recap> = {};
    for (const r of rows) out[r.sessionId] = this.hydrateRecap(r);
    return out;
  }

  /** Rows currently in-flight — used by the service's finalize loop (restart-safe). */
  generatingRecaps(): Recap[] {
    const rows = this.db
      .query(
        `SELECT sessionId, state, headSha, base, verdict, headline, body, skipReason, failureReason, diffState, openItems, changedFiles, blocks,
                pendingDiff, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt
              FROM recaps WHERE state = 'generating'`,
      )
      .all() as RecapRow[];
    return rows.map((r) => ({
      ...this.hydrateRecap(r),
      pendingDiff: this.parsePendingDiff(r.pendingDiff),
    }));
  }

  /** Set/clear the transient diff carrier used by finalize's block-join. Server-only — never read by
   *  the client-facing getRecap/snapshotRecaps paths. Pass [] to clear. */
  setRecapPendingDiff(sessionId: string, files: DiffFile[]): void {
    this.db.run(`UPDATE recaps SET pendingDiff = ? WHERE sessionId = ?`, [
      JSON.stringify(files ?? []),
      sessionId,
    ]);
  }

  dropRecap(sessionId: string): void {
    this.db.run(`DELETE FROM recaps WHERE sessionId = ?`, [sessionId]);
  }

  // ── post-merge steps (durable manual-step materialization, #1061) ─────────────

  private readonly POST_MERGE_COLS = `sessionId, desig, repoPath, prNumber, prTitle, stepsJson,
    trackingIssueUrl, trackingIssueNumber, createdAt, updatedAt, clearedAt`;

  /** Materialize a merged session's outstanding manual steps. IDEMPOTENT: a row already present
   *  (the merged event replays — boot warm-tick) is left untouched, preserving any tick-state.
   *  Returns true only when it actually inserted (so the caller emits/logs + attempts the gated
   *  tracking issue exactly once on first materialization). DB ops are synchronous on the single
   *  event loop, so the existence-check + insert is atomic from any caller's view. */
  materializePostMergeSteps(rec: {
    sessionId: string;
    desig: string;
    repoPath: string;
    prNumber: number | null;
    prTitle: string;
    steps: PostMergeStep[];
  }): boolean {
    const exists = this.db
      .query(`SELECT 1 FROM post_merge_steps WHERE sessionId = ? LIMIT 1`)
      .get(rec.sessionId);
    if (exists) return false;
    const t = Date.now();
    this.db.run(
      `INSERT INTO post_merge_steps (sessionId, desig, repoPath, prNumber, prTitle, stepsJson, createdAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        rec.sessionId,
        rec.desig,
        rec.repoPath,
        rec.prNumber,
        rec.prTitle,
        JSON.stringify(rec.steps),
        t,
        t,
      ],
    );
    return true;
  }

  getPostMergeSteps(sessionId: string): PostMergeSteps | null {
    const r = this.db
      .query(`SELECT ${this.POST_MERGE_COLS} FROM post_merge_steps WHERE sessionId = ?`)
      .get(sessionId) as PostMergeStepsRow | null;
    return r ? hydratePostMergeSteps(r) : null;
  }

  /** All records still owing steps (clearedAt IS NULL), newest-materialized first. */
  listOutstandingPostMergeSteps(): PostMergeSteps[] {
    const rows = this.db
      .query(
        `SELECT ${this.POST_MERGE_COLS} FROM post_merge_steps WHERE clearedAt IS NULL ORDER BY createdAt DESC`,
      )
      .all() as PostMergeStepsRow[];
    return rows.map(hydratePostMergeSteps);
  }

  /** Tick (or un-tick) one step. Recomputes clearedAt: stamped when every step is done, cleared
   *  again if any is re-opened. Returns the updated record, or null if no row / unknown step. */
  setPostMergeStepDone(sessionId: string, stepId: string, done: boolean): PostMergeSteps | null {
    const rec = this.getPostMergeSteps(sessionId);
    if (!rec) return null;
    const t = Date.now();
    let found = false;
    const steps = rec.steps.map((s) => {
      if (s.id !== stepId) return s;
      found = true;
      return { ...s, doneAt: done ? (s.doneAt ?? t) : null };
    });
    if (!found) return rec;
    const allDone = steps.length > 0 && steps.every((s) => s.doneAt != null);
    const clearedAt = allDone ? (rec.clearedAt ?? t) : null;
    this.db.run(
      `UPDATE post_merge_steps SET stepsJson = ?, clearedAt = ?, updatedAt = ? WHERE sessionId = ?`,
      [JSON.stringify(steps), clearedAt, t, sessionId],
    );
    return { ...rec, steps, clearedAt, updatedAt: t };
  }

  /** Operator dismiss — clear the whole record (stamp clearedAt). Returns updated record or null. */
  dismissPostMergeSteps(sessionId: string): PostMergeSteps | null {
    const rec = this.getPostMergeSteps(sessionId);
    if (!rec) return null;
    const t = Date.now();
    const clearedAt = rec.clearedAt ?? t;
    this.db.run(`UPDATE post_merge_steps SET clearedAt = ?, updatedAt = ? WHERE sessionId = ?`, [
      clearedAt,
      t,
      sessionId,
    ]);
    return { ...rec, clearedAt, updatedAt: t };
  }

  /** Link the opt-in tracking issue onto the record (idempotency keys off trackingIssueUrl). */
  setPostMergeTrackingIssue(sessionId: string, url: string, number: number): void {
    this.db.run(
      `UPDATE post_merge_steps SET trackingIssueUrl = ?, trackingIssueNumber = ?, updatedAt = ? WHERE sessionId = ?`,
      [url, number, Date.now(), sessionId],
    );
  }

  // ── herd rundown (cross-session attention digest, per calendar day) ───────────
  private hydrateItems(raw: unknown): RundownItem[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: RundownItem[] = [];
    for (const x of parsed) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      if (typeof o.label !== "string") continue;
      const item: RundownItem = { label: o.label };
      if (typeof o.sessionId === "string") item.sessionId = o.sessionId;
      if (typeof o.pr === "number") item.pr = o.pr;
      out.push(item);
    }
    return out;
  }

  private hydrateEpics(raw: unknown): RundownEpicItem[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: RundownEpicItem[] = [];
    for (const x of parsed) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      if (typeof o.repo !== "string" || typeof o.parent !== "number") continue;
      out.push({
        repo: o.repo,
        parent: o.parent,
        title: typeof o.title === "string" ? o.title : "",
        landingPr: typeof o.landingPr === "number" ? o.landingPr : null,
        stranded: o.stranded === true,
        ciFailing: o.ciFailing === true,
        pausedReason: coercePauseReason(o.pausedReason),
      });
    }
    return out;
  }

  private hydrateHerdDigest(r: HerdDigestRow): HerdDigest {
    let fingerprint: Record<string, string[]> = {};
    try {
      const parsed = JSON.parse(r.attentionFingerprint);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v))
            fingerprint[k] = v.filter((x): x is string => typeof x === "string");
        }
      }
    } catch {
      fingerprint = {};
    }
    return {
      dayKey: r.dayKey,
      state: r.state,
      overnight: r.overnight ?? "",
      decisions: this.hydrateItems(r.decisions),
      ciRework: this.hydrateItems(r.ciRework),
      train: r.train ?? "",
      focusNext: this.hydrateItems(r.focusNext),
      epicsToLand: this.hydrateEpics(r.epicsToLand),
      attentionFingerprint: fingerprint,
      spawnSessionId: r.spawnSessionId ?? "",
      cwd: r.cwd ?? "",
      model: r.model ?? null,
      spawnedAt: r.spawnedAt,
      generatedAt: r.generatedAt ?? null,
      updatedAt: r.updatedAt,
    } as HerdDigest;
  }

  private readonly HERD_COLS = `dayKey, state, overnight, decisions, ciRework, train, focusNext,
    attentionFingerprint, epicsToLand, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt`;

  getHerdDigest(dayKey: string): HerdDigest | null {
    const r = this.db
      .query(`SELECT ${this.HERD_COLS} FROM herd_digests WHERE dayKey = ?`)
      .get(dayKey) as HerdDigestRow | null;
    return r ? this.hydrateHerdDigest(r) : null;
  }

  getLatestHerdDigest(): HerdDigest | null {
    const r = this.db
      .query(`SELECT ${this.HERD_COLS} FROM herd_digests ORDER BY spawnedAt DESC LIMIT 1`)
      .get() as HerdDigestRow | null;
    return r ? this.hydrateHerdDigest(r) : null;
  }

  putHerdDigest(d: HerdDigest): void {
    this.db.run(
      `INSERT INTO herd_digests (dayKey, state, overnight, decisions, ciRework, train, focusNext,
         attentionFingerprint, epicsToLand, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(dayKey) DO UPDATE SET state=excluded.state, overnight=excluded.overnight,
         decisions=excluded.decisions, ciRework=excluded.ciRework, train=excluded.train,
         focusNext=excluded.focusNext, attentionFingerprint=excluded.attentionFingerprint,
         epicsToLand=excluded.epicsToLand, spawnSessionId=excluded.spawnSessionId, cwd=excluded.cwd,
         model=excluded.model, spawnedAt=excluded.spawnedAt, generatedAt=excluded.generatedAt,
         updatedAt=excluded.updatedAt`,
      [
        d.dayKey,
        d.state,
        d.overnight ?? "",
        JSON.stringify(d.decisions ?? []),
        JSON.stringify(d.ciRework ?? []),
        d.train ?? "",
        JSON.stringify(d.focusNext ?? []),
        JSON.stringify(d.attentionFingerprint ?? {}),
        JSON.stringify(d.epicsToLand ?? []),
        d.spawnSessionId ?? "",
        d.cwd ?? "",
        d.model ?? null,
        d.spawnedAt,
        d.generatedAt ?? null,
        d.updatedAt,
      ],
    );
  }

  /** Rows currently in-flight — used by the service's finalize loop (restart-safe). */
  generatingHerdDigests(): HerdDigest[] {
    const rows = this.db
      .query(`SELECT ${this.HERD_COLS} FROM herd_digests WHERE state = 'generating'`)
      .all() as HerdDigestRow[];
    return rows.map((r) => this.hydrateHerdDigest(r));
  }

  /** Overnight delta since `sinceTs`: PRs merged (from issue_log `merged:<pr>` stamps) and
   *  sessions archived after that instant. Feeds the rundown's "while you were away" summary. */
  overnightDelta(sinceTs: number): {
    mergedPrs: number[];
    archivedSessions: { id: string; desig: string }[];
  } {
    const mergedRows = this.db
      .query(`SELECT key FROM issue_log WHERE key LIKE 'merged:%' AND createdAt > ?`)
      .all(sinceTs) as { key: string }[];
    const mergedPrs: number[] = [];
    for (const row of mergedRows) {
      const n = Number(row.key.slice("merged:".length));
      if (Number.isFinite(n)) mergedPrs.push(n);
    }
    const archived = this.db
      .query(
        `SELECT id, desig FROM sessions WHERE archivedAt IS NOT NULL AND archivedAt > ? ORDER BY archivedAt`,
      )
      .all(sinceTs) as { id: string; desig: string }[];
    return { mergedPrs, archivedSessions: archived };
  }

  setPlanPhase(id: string, phase: Session["planPhase"]): void {
    this.db.run(`UPDATE sessions SET planPhase = ?, updatedAt = ? WHERE id = ?`, [
      phase,
      Date.now(),
      id,
    ]);
  }

  setHaltReason(id: string, reason: Session["haltReason"], haltedAt: number | null): void {
    this.db.run(`UPDATE sessions SET haltReason = ?, haltedAt = ?, updatedAt = ? WHERE id = ?`, [
      reason,
      haltedAt,
      Date.now(),
      id,
    ]);
  }

  /** Write the poller/reconcile-immune spawn-identity markers (herdr-restart account-loss
   *  detection). The ONLY writer is {@link SessionService}'s `persistSpawnIdentity` helper,
   *  which applies the sticky/conditional rule (never null-over-non-null); this setter itself
   *  is an unconditional targeted UPDATE, mirroring {@link setHaltReason}. */
  setSpawnIdentity(
    id: string,
    spawnTerminalId: string | null,
    spawnAccountDir: string | null,
  ): void {
    this.db.run(
      `UPDATE sessions SET spawnTerminalId=?, spawnAccountDir=?, updatedAt=? WHERE id=?`,
      [spawnTerminalId, spawnAccountDir, Date.now(), id],
    );
  }

  /** Persist a provider-native session id (the Codex rollout UUID) discovered post-spawn. Dedicated
   *  setter (the generic update() whitelist would work too, but this mirrors {@link setSpawnIdentity}'s
   *  targeted-UPDATE style for a post-spawn-discovered marker). Callers only ever pass a non-empty id. */
  setProviderSessionId(id: string, providerSessionId: string): void {
    this.db.run(`UPDATE sessions SET providerSessionId = ?, updatedAt = ? WHERE id = ?`, [
      providerSessionId,
      Date.now(),
      id,
    ]);
  }

  /** Persist the manual operator steps detected in a session's PR body (#1059). Stored as a JSON
   *  array; an empty array clears any prior detection. Dedicated setter (the generic update()
   *  whitelist would silently drop it), mirroring {@link setHaltReason}'s direct-UPDATE style. */
  setSessionManualSteps(id: string, steps: ManualStep[]): void {
    this.db.run(`UPDATE sessions SET manualStepsJson = ?, updatedAt = ? WHERE id = ?`, [
      JSON.stringify(steps),
      Date.now(),
      id,
    ]);
  }

  /** Acknowledge a session's manual operator steps (#1060): stamp `manualStepsAckedAt`, clearing
   *  the auto-merge gate. Ack = "operator owns these" (acknowledged-will-do, mirrors
   *  {@link ackEpicMigrations}) — NOT an assertion the steps are done. Idempotent: `COALESCE`
   *  keeps the FIRST ack time, so a re-ack is a durable no-op. */
  ackManualSteps(id: string): void {
    const now = Date.now();
    this.db.run(
      `UPDATE sessions SET manualStepsAckedAt = COALESCE(manualStepsAckedAt, ?), updatedAt = ? WHERE id = ?`,
      [now, now, id],
    );
  }

  // ── reviewer spawn cost attribution ──────────────────────────────────────────
  /** Record a freshly-spawned reviewer session. Token/completed columns stay NULL until
   *  finalize (`completeReviewerSpawn`). A plain INSERT is correct — every spawn forces a
   *  fresh reviewerSessionId UUID, so the PK never collides. */
  recordReviewerSpawn(r: {
    reviewerSessionId: string;
    taskSessionId: string;
    kind: "review" | "plan_gate" | "recap" | "rundown" | "doc_agent";
    worktreePath: string;
    reviewerProvider?: AgentProvider | null;
    model: string | null;
    reviewerEffort?: string | null;
    spawnedAt: number;
  }): void {
    this.db.run(
      `INSERT INTO reviewer_spawns
         (reviewerSessionId, taskSessionId, kind, worktreePath, reviewerProvider, model, reviewerEffort, spawnedAt)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        r.reviewerSessionId,
        r.taskSessionId,
        r.kind,
        r.worktreePath,
        r.reviewerProvider ?? null,
        r.model,
        r.reviewerEffort ?? null,
        r.spawnedAt,
      ],
    );
  }

  /** Fill a spawn's token totals + completedAt once its transcript is read. No-op when the
   *  reviewerSessionId is unknown (the WHERE simply matches nothing). */
  completeReviewerSpawn(reviewerSessionId: string, u: SessionUsage, completedAt: number): void {
    // Backfill the TRUE model from the transcript: the spawn-time `model` column held the
    // configured override, which is null when auto-resolved — but the transcript names the model
    // that actually ran. A reviewer spawn is one model, so `dominantModel(u)` is it. It returns
    // null for empty usage or records that named no real model (only parseLine's "unknown"
    // sentinel), and COALESCE then keeps the recorded value — the sentinel never overwrites it.
    // This lets usage-report weight a GC'd-transcript spawn's cost by its real tier, not a
    // task-model proxy. `u.messageCount` is intentionally dropped — not a cost fact.
    this.db.run(
      `UPDATE reviewer_spawns SET inputTokens = ?, outputTokens = ?, cacheReadTokens = ?,
         cacheWriteTokens = ?, totalTokens = ?, completedAt = ?, model = COALESCE(?, model)
         WHERE reviewerSessionId = ?`,
      [
        u.input,
        u.output,
        u.cacheRead,
        u.cacheWrite,
        u.total,
        completedAt,
        dominantModel(u),
        reviewerSessionId,
      ],
    );
  }

  /** All reviewer-spawn rows, oldest-spawned first. Column names already match the
   *  ReviewerSpawnRow fields, so a direct cast suffices. */
  listReviewerSpawns(): ReviewerSpawnRow[] {
    return this.db
      .query(`SELECT * FROM reviewer_spawns ORDER BY spawnedAt`)
      .all() as ReviewerSpawnRow[];
  }

  /** Drop reviewer-spawn rows older than `beforeTs` (own retention sweep — these are
   *  decoupled from the session archive path on purpose). Returns the count removed. */
  pruneReviewerSpawns(beforeTs: number): number {
    const n = (
      this.db
        .query(`SELECT COUNT(*) AS c FROM reviewer_spawns WHERE spawnedAt < ?`)
        .get(beforeTs) as { c: number }
    ).c;
    this.db.run(`DELETE FROM reviewer_spawns WHERE spawnedAt < ?`, [beforeTs]);
    return n;
  }

  // ── learning signals ─────────────────────────────────────────────────────────
  addSignal(input: {
    repoPath: string;
    sessionId: string | null;
    kind: SignalKind;
    payload: string;
  }): Signal {
    const sig: Signal = {
      id: randomUUID(),
      repoPath: input.repoPath,
      sessionId: input.sessionId,
      kind: input.kind,
      payload: input.payload,
      ts: Date.now(),
    };
    this.db.run(
      `INSERT INTO signals (id, repoPath, sessionId, kind, payload, ts) VALUES (?,?,?,?,?,?)`,
      [sig.id, sig.repoPath, sig.sessionId, sig.kind, sig.payload, sig.ts],
    );
    return sig;
  }

  listSignals(repoPath: string, opts?: { sinceTs?: number; limit?: number }): Signal[] {
    const since = opts?.sinceTs ?? 0;
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .query(
        `SELECT id, repoPath, sessionId, kind, payload, ts FROM signals
         WHERE repoPath = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(repoPath, since, limit) as Signal[];
    return rows;
  }

  pruneSignals(beforeTs: number): number {
    const n = (
      this.db.query(`SELECT COUNT(*) AS c FROM signals WHERE ts < ?`).get(beforeTs) as { c: number }
    ).c;
    this.db.run(`DELETE FROM signals WHERE ts < ?`, [beforeTs]);
    return n;
  }

  /**
   * Delete archived sessions beyond the retention window — those older than `maxAgeMs`
   * OR ranked past the newest `keepNewest` (global, union: whichever evicts first). Only
   * `status = 'archived'` rows are eligible; live sessions are never touched. Each victim's
   * `reviews` row is cascaded in the same transaction so it can't orphan. `signals` are left
   * to their own prune. Age and rank both key off COALESCE(archivedAt, updatedAt, createdAt)
   * so legacy archived rows predating the `archivedAt` column still sort/expire correctly.
   * Returns the number of sessions removed.
   */
  pruneArchivedSessions(opts: { maxAgeMs: number; keepNewest: number }): number {
    const cutoff = Date.now() - opts.maxAgeMs;
    const rank = `COALESCE(archivedAt, updatedAt, createdAt)`;
    // Victim set expressed as a predicate (re-used by the count + both deletes) rather
    // than a bound id list — a large first sweep could otherwise exceed SQLite's 32766
    // bound-parameter cap. Each use carries the same two params (cutoff, keepNewest).
    const victims = `status = 'archived' AND (
        ${rank} < ?
        OR id NOT IN (
          SELECT id FROM sessions WHERE status = 'archived' ORDER BY ${rank} DESC LIMIT ?
        )
      )`;
    const params = [cutoff, opts.keepNewest];
    return this.db.transaction(() => {
      const n = (
        this.db.query(`SELECT COUNT(*) AS c FROM sessions WHERE ${victims}`).get(...params) as {
          c: number;
        }
      ).c;
      if (n === 0) return 0;
      // reviews first (keyed by sessionId) so the cascade can't orphan; the sessions
      // subquery still resolves the same set afterward (deleting reviews doesn't touch it).
      this.db.run(
        `DELETE FROM reviews WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM build_queue_steps WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM build_queue_state WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM plan_gates WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM issue_log WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM recaps WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      // NOTE: post_merge_steps is INTENTIONALLY NOT cascaded here (#1061) — owed manual steps must
      // outlive the archived session AND this prune. Its display fields are denormalized so it
      // renders fine once the sessions row below is gone. Don't "tidy" it into this cascade.
      this.db.run(`DELETE FROM sessions WHERE ${victims}`, params);
      return n;
    })();
  }

  // migrate reviews that predate the auto-address loop columns
  // migrate older DBs that predate later sessions columns
  private migrateSessionColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name)) this.db.run(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
    };
    add("model", `model TEXT`);
    add("effort", `effort TEXT`);
    add("claudeSessionId", `claudeSessionId TEXT NOT NULL DEFAULT ''`);
    add("providerSessionId", `providerSessionId TEXT NOT NULL DEFAULT ''`);
    add("agentProvider", `agentProvider TEXT NOT NULL DEFAULT 'claude'`);
    add("readyToMerge", `readyToMerge INTEGER NOT NULL DEFAULT 0`);
    // nullable: NULL = inherit repo default, 0/1 = explicit per-session override
    add("autopilotEnabled", `autopilotEnabled INTEGER`);
    add("autopilotStepCount", `autopilotStepCount INTEGER NOT NULL DEFAULT 0`);
    add("autopilotPaused", `autopilotPaused INTEGER NOT NULL DEFAULT 0`);
    add("autopilotComplete", `autopilotComplete INTEGER NOT NULL DEFAULT 0`);
    add("autopilotQuestion", `autopilotQuestion TEXT`);
    add("completionRepromptCount", `completionRepromptCount INTEGER NOT NULL DEFAULT 0`);
    // nullable: NULL = inherit / gate off, 0/1 = explicit per-session override
    add("planGateEnabled", `planGateEnabled INTEGER`);
    add("planPhase", `planPhase TEXT`);
    add("autoMergeEnabled", `autoMergeEnabled INTEGER`);
    add("autoMergeRebaseCount", `autoMergeRebaseCount INTEGER NOT NULL DEFAULT 0`);
    add("autoMergeRebaseHead", `autoMergeRebaseHead TEXT`);
    add("autoMergeRebaseSteeredAt", `autoMergeRebaseSteeredAt INTEGER`);
    add("auto", `auto INTEGER NOT NULL DEFAULT 0`);
    add("issueNumber", `issueNumber INTEGER`);
    // sandbox badge/banner: applied profile (nullable for legacy rows) + degrade flag.
    add("sandboxApplied", `sandboxApplied TEXT`);
    add("sandboxDegraded", `sandboxDegraded INTEGER NOT NULL DEFAULT 0`);
    // egress firewall: applied flag + degrade flag (legacy rows default false/false).
    add("egressApplied", `egressApplied INTEGER NOT NULL DEFAULT 0`);
    add("egressDegraded", `egressDegraded INTEGER NOT NULL DEFAULT 0`);
    add("mergingSince", `mergingSince INTEGER`);
    add("mergingTrainId", `mergingTrainId TEXT`);
    // research task kind: default 0 (false) for pre-existing rows.
    add("research", `research INTEGER NOT NULL DEFAULT 0`);
    // epic-authoring task kind: default 0 (false) for pre-existing rows.
    add("epicAuthoring", `epicAuthoring INTEGER NOT NULL DEFAULT 0`);
    // epic-landing-PR repair task kind: default 0 (false) for pre-existing rows.
    add("landingRepair", `landingRepair INTEGER NOT NULL DEFAULT 0`);
    add("mergeTrainPrs", `mergeTrainPrs TEXT`);
    add("mergingPrNumber", `mergingPrNumber INTEGER`);
    // halt detection: reason + timestamp; nullable, no default (null = not halted).
    add("haltReason", `haltReason TEXT`);
    add("haltedAt", `haltedAt INTEGER`);
    // manual operator steps (#1059): detected carrier steps (JSON ManualStep[]) + the epoch the
    // operator acknowledged them. manualStepsAckedAt is written by P2; the column lands here so P2
    // is purely additive. Both nullable: absence = no detection ran / not yet acknowledged.
    add("manualStepsJson", `manualStepsJson TEXT`);
    add("manualStepsAckedAt", `manualStepsAckedAt INTEGER`);
    // comparison experiments: group id + role (variant|comparison). Both nullable; legacy
    // rows default to null (not part of any experiment).
    add("experimentId", `experimentId TEXT`);
    add("experimentRole", `experimentRole TEXT`);
    // Poller/reconcile-immune spawn-identity markers (herdr-restart account-loss detection):
    // the terminalId of the pane Shepherd itself last spawned on the owning account, and that
    // account's CLAUDE_CONFIG_DIR. Both nullable; written only via setSpawnIdentity.
    add("spawnTerminalId", `spawnTerminalId TEXT`);
    add("spawnAccountDir", `spawnAccountDir TEXT`);
    add("launchMetadataJson", `launchMetadataJson TEXT`);
    add("archiveReason", `archiveReason TEXT`);
  }

  // Migrate build_queue_steps from the legacy global `PRIMARY KEY (id)` to the composite
  // `PRIMARY KEY (sessionId, id)`. SQLite can't ALTER a primary key, so this rebuilds the table
  // once. Detect the legacy shape via PRAGMA (the `id` column carries pk=1 while `sessionId`
  // carries pk=0); a table already on the composite PK reports sessionId with pk>0 and is skipped.
  // Idempotent + transactional; existing ids are globally-unique UUIDs, so they migrate trivially.
  private migrateBuildQueueStepsPk(): void {
    const cols = this.db.query(`PRAGMA table_info(build_queue_steps)`).all() as {
      name: string;
      pk: number;
    }[];
    const sessionIdInPk = cols.some((c) => c.name === "sessionId" && c.pk > 0);
    if (sessionIdInPk) return; // already composite (or freshly created above)
    this.db.transaction(() => {
      this.db.run(`CREATE TABLE build_queue_steps_new (
        id TEXT NOT NULL, sessionId TEXT NOT NULL, position INTEGER NOT NULL,
        title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (sessionId, id))`);
      this.db.run(
        `INSERT INTO build_queue_steps_new (id, sessionId, position, title, detail, status, createdAt, updatedAt)
         SELECT id, sessionId, position, title, detail, status, createdAt, updatedAt FROM build_queue_steps`,
      );
      this.db.run(`DROP TABLE build_queue_steps`);
      this.db.run(`ALTER TABLE build_queue_steps_new RENAME TO build_queue_steps`);
    })();
  }

  /** Add columns to held_tasks that postdate the original schema (existing rows default
   *  to 'usage' — they were all usage-gate holds before capacity-hold support was added). */
  private migrateHeldTaskColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(held_tasks)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "reason")) {
      this.db.run(`ALTER TABLE held_tasks ADD COLUMN reason TEXT NOT NULL DEFAULT 'usage'`);
    }
  }

  // migrate repo_config that predates these opt-in columns. auto-address defaults
  // OFF (the spendier loop — existing repos opt in explicitly); learnings defaults ON.
  private migrateRepoConfigColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(repo_config)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE repo_config ADD COLUMN ${ddl}`);
    };
    add("autoAddressEnabled", `autoAddressEnabled INTEGER NOT NULL DEFAULT 0`);
    add("criticAllPrs", `criticAllPrs INTEGER NOT NULL DEFAULT 0`);
    // #1824: named Fowler code-smell lens for the session critic. Default OFF — experimental
    // trial, extra tokens/round; non-blocking (body section, never findings).
    add("criticSmellLensEnabled", `criticSmellLensEnabled INTEGER NOT NULL DEFAULT 0`);
    add("learningsEnabled", `learningsEnabled INTEGER NOT NULL DEFAULT 1`);
    add("autopilotEnabled", `autopilotEnabled INTEGER NOT NULL DEFAULT 0`);
    add("planGateEnabled", `planGateEnabled INTEGER NOT NULL DEFAULT 0`);
    add("autoDrainEnabled", `autoDrainEnabled INTEGER NOT NULL DEFAULT 0`);
    add("autoMergeEnabled", `autoMergeEnabled INTEGER NOT NULL DEFAULT 0`);
    add("buildQueueEnabled", `buildQueueEnabled INTEGER NOT NULL DEFAULT 0`);
    add("maxAuto", `maxAuto INTEGER NOT NULL DEFAULT 1`);
    add("autoLabel", `autoLabel TEXT NOT NULL DEFAULT 'shepherd:auto'`);
    add("usageCeilingPct", `usageCeilingPct INTEGER NOT NULL DEFAULT 80`);
    add("draftMode", `draftMode INTEGER NOT NULL DEFAULT 0`);
    add("signoffAuthority", `signoffAuthority TEXT NOT NULL DEFAULT 'human'`);
    add("sandboxProfile", `sandboxProfile TEXT NOT NULL DEFAULT 'trusted'`);
    add("defaultModel", `defaultModel TEXT NOT NULL DEFAULT 'inherit'`);
    add("defaultEffort", `defaultEffort TEXT NOT NULL DEFAULT 'inherit'`);
    // per-repo egress extra-hosts: JSON-encoded string array (nullable, default []).
    add("egressExtraHosts", `egressExtraHosts TEXT`);
    // per-repo mode: 'forge' (GitHub-backed, default) or 'lightweight' (local-only).
    add("repoMode", `repoMode TEXT NOT NULL DEFAULT 'forge'`);
    // auto-optimize flagged rules: default OFF (explicit opt-in).
    add("autoOptimizeFlagged", `autoOptimizeFlagged INTEGER NOT NULL DEFAULT 0`);
    // #1061: open a GitHub tracking issue for manual operator steps on merge. Default OFF —
    // outbound write gated behind explicit per-repo opt-in (house rule).
    add("manualStepsIssueEnabled", `manualStepsIssueEnabled INTEGER NOT NULL DEFAULT 0`);
    // default OFF — opt-in; pre-warm epic landing CI via an early draft landing PR (#1664)
    add("preWarmEpicLandingCi", `preWarmEpicLandingCi INTEGER NOT NULL DEFAULT 0`);
    // Hidden from the Backlog repos panel (list-only declutter). Default OFF.
    add("hidden", `hidden INTEGER NOT NULL DEFAULT 0`);
    // Local preview launcher metadata. Nullable: absent until first successful script setup.
    add("previewStartScript", `previewStartScript TEXT`);
    add("previewStartCommand", `previewStartCommand TEXT`);
    add("previewOpenMode", `previewOpenMode TEXT NOT NULL DEFAULT 'ask'`);
    // Issue #1025: first-task automation-confirmation. Nullable — new repos start unconfirmed.
    if (!cols.some((c) => c.name === "automationConfirmedAt")) {
      this.db.run(`ALTER TABLE repo_config ADD COLUMN automationConfirmedAt INTEGER`);
      // Issue #1025: pre-feature rows = already-engaged repos ⇒ treat as already-confirmed so the
      // first-task confirm step only fires for genuinely new repos. Backfill from updatedAt (NOT NULL
      // on every row, store.ts:607). Gated inside this column-missing branch so it runs EXACTLY ONCE —
      // a server bounce must never auto-confirm a freshly-seeded-but-unconfirmed row.
      this.db.run(
        `UPDATE repo_config SET automationConfirmedAt = updatedAt WHERE automationConfirmedAt IS NULL`,
      );
    }
  }

  // One-time first-run classification (see first-run gate). Runs once per DB, keyed off its
  // OWN marker so it can never re-fire: on a NEW install it runs on boot 1 against an empty DB
  // (before bootstrapAuth seeds any secret) → not pre-existing → not stamped, so the gate
  // applies; a genuinely pre-existing DB (auth secrets / a chosen root / any session already
  // present) is stamped resolved once so it is never gated.
  private migrateFirstRunMarker(): void {
    if (this.getSetting("firstRunMigrated")) return; // run-once, idempotent on its OWN marker
    const preExisting =
      !!this.getSetting("cookieSecret") ||
      !!this.getSetting("passwordHash") ||
      !!this.getSetting("repoRoot") ||
      this.list().length > 0;
    if (preExisting) this.setSetting("firstRunResolved", "1");
    this.setSetting("firstRunMigrated", "1"); // unconditional → never runs again
  }

  private migrateEpicIntegratedColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(epic_integrated)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE epic_integrated ADD COLUMN ${ddl}`);
    };
    add("prNumber", `prNumber INTEGER`);
    add("prUrl", `prUrl TEXT`);
    // #645: the branch the child actually squash-merged into. Nullable — pre-existing rows
    // backfill to NULL and never fire divergence warnings (forward-looking only; no backfill).
    add("mergedBase", `mergedBase TEXT`);
  }

  private migrateEpicCompletedColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(epic_completed)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE epic_completed ADD COLUMN ${ddl}`);
    };
    // Stage B (#635) landing-PR lifecycle. NOT NULL columns carry constant defaults so the
    // ALTER backfills existing rows to 'pending'/0.
    add("landingPrNumber", `landingPrNumber INTEGER`);
    add("landingPrUrl", `landingPrUrl TEXT`);
    add("landingState", `landingState TEXT NOT NULL DEFAULT 'pending'`);
    add("landingAttempts", `landingAttempts INTEGER NOT NULL DEFAULT 0`);
    // #1071: rebase-state counters + pause reason for session-less landing PRs.
    add("landingRebaseCount", `landingRebaseCount INTEGER NOT NULL DEFAULT 0`);
    add("landingRebaseDriverMisses", `landingRebaseDriverMisses INTEGER NOT NULL DEFAULT 0`);
    add("landingRebasePauseReason", `landingRebasePauseReason TEXT`);
    // Migration-awareness checkpoint (#645). migrationPathsJson: paths of migration files
    // detected in the landing PR (JSON array). migrationsAckedAt: a durable audit timestamp
    // recording WHEN a human acknowledged those migrations — written alongside dismissedAt by
    // ackEpicMigrations. It is a record, NOT a gate: re-prompt suppression is the coupled
    // dismissedAt (listEpicCompleted filters `dismissedAt IS NULL`), so an acked row is hidden
    // by the dismiss, never by this column. Both nullable: absence = no detection ran / not
    // yet acknowledged.
    add("migrationPathsJson", `migrationPathsJson TEXT`);
    add("migrationsAckedAt", `migrationsAckedAt INTEGER`);
    // Landing-repair session counters: lifetime dispatch count + the epic-branch head SHA
    // recorded at the last repair dispatch. Mirrors landingRebaseCount / landingPrUrl's
    // nullable-TEXT handling.
    add("landingRepairCount", `landingRepairCount INTEGER NOT NULL DEFAULT 0`);
    add("landingRepairHead", `landingRepairHead TEXT`);
  }

  private migrateReviewColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(reviews)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name)) this.db.run(`ALTER TABLE reviews ADD COLUMN ${ddl}`);
    };
    add("findings", `findings TEXT NOT NULL DEFAULT '[]'`);
    add("addressRound", `addressRound INTEGER NOT NULL DEFAULT 0`);
    // addressCap's DEFAULT 3 only backfills pre-#247 rows; every live row carries
    // ReviewService's actual cap, so the literal here is a one-time migration value, not
    // an ongoing mirror. errorRound/seenNoteIds back the error-escalation + note dedup.
    add("addressCap", `addressCap INTEGER NOT NULL DEFAULT 3`);
    add("errorRound", `errorRound INTEGER NOT NULL DEFAULT 0`);
    // Per-streak spawn ceiling + churn/revert dedup (#501). Old rows backfill to 0 / '[]':
    // a row at rest hydrates to a fresh streak (next head reviews once and starts counting),
    // and an empty reviewedPatchIds set keeps the patchId OR-branch as the lone rebase-skip.
    add("streakReviews", `streakReviews INTEGER NOT NULL DEFAULT 0`);
    add("reviewedPatchIds", `reviewedPatchIds TEXT NOT NULL DEFAULT '[]'`);
    add("seenNoteIds", `seenNoteIds TEXT NOT NULL DEFAULT '[]'`);
    // patchId backs rebase-skip: pre-existing rows backfill to '' (unknown), so the
    // next head change reviews once and records the fingerprint going forward.
    add("patchId", `patchId TEXT NOT NULL DEFAULT ''`);
    add("finalRoundPending", `finalRoundPending INTEGER NOT NULL DEFAULT 0`);
    // 900000ms = 15min; one-time backfill for pre-existing rows, not an ongoing mirror —
    // live rows carry ReviewService's DEFAULT_FINAL_ROUND_TIMEOUT_MS.
    add("finalRoundTimeoutMs", `finalRoundTimeoutMs INTEGER NOT NULL DEFAULT 900000`);
    // spawnAborted (#1211): marks a row that records a pre-spawn onSpawn abort (critic never ran),
    // exempting it from the same-head re-review dedup. Pre-existing rows backfill to 0 (real reviews).
    add("spawnAborted", `spawnAborted INTEGER NOT NULL DEFAULT 0`);
    // dismissed: operator took over this stalled critic rework; classification/attention consumers
    // skip it. Pre-existing rows backfill to 0 (not dismissed).
    add("dismissed", `dismissed INTEGER NOT NULL DEFAULT 0`);
  }

  private migratePlanGateColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(plan_gates)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE plan_gates ADD COLUMN ${ddl}`);
    };
    add("blocks", `blocks TEXT NOT NULL DEFAULT '[]'`);
    add("answeredQuestionKeys", `answeredQuestionKeys TEXT NOT NULL DEFAULT '[]'`);
    add("reviewerProvider", `reviewerProvider TEXT`);
    add("reviewerModel", `reviewerModel TEXT`);
    add("reviewerEffort", `reviewerEffort TEXT`);
    // finalRoundPending: the cap-th plan-rework steer just landed and the agent is revising the
    // FINAL round (planStallStatus reads it). dismissed: operator took over this stalled plan
    // rework. Pre-existing rows backfill to 0 (not final / not dismissed).
    add("finalRoundPending", `finalRoundPending INTEGER NOT NULL DEFAULT 0`);
    add("dismissed", `dismissed INTEGER NOT NULL DEFAULT 0`);
    // summaryCode: sentinel for a server-authored summary (error → "no-verdict"), rendered per-locale
    // in the UI. Pre-existing rows backfill to NULL (render their stored `summary` prose verbatim).
    add("summaryCode", `summaryCode TEXT`);
    // Migrate legacy `error` rows that baked the English summary in: flip the exact known prose to the
    // sentinel code + clear the summary so the UI localizes it. Idempotent (after the flip the WHERE
    // no longer matches) and no-clobber (only the exact prose string, only `error` rows).
    this.db.run(
      `UPDATE plan_gates SET summaryCode='no-verdict', summary=''
         WHERE decision='error' AND summary='plan reviewer did not produce a verdict'`,
    );
  }

  private migrateReviewerSpawnColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(reviewer_spawns)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE reviewer_spawns ADD COLUMN ${ddl}`);
    };
    add("reviewerProvider", `reviewerProvider TEXT`);
    add("reviewerEffort", `reviewerEffort TEXT`);
  }

  // ── learnings ─────────────────────────────────────────────────────────────
  /** Add columns laid after the original `learnings` table for existing DBs.
   *  Idempotent: each column is only added when PRAGMA shows it absent. */
  private migrateLearningsColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(learnings)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE learnings ADD COLUMN ${ddl}`);
    };
    add("promotedPrUrl", `promotedPrUrl TEXT`);
    // Signal ids already counted toward each rule's ineffectiveCount. Without this
    // the daily re-distill over the rolling 60-day window would re-increment the
    // same rule from the same stale signals every run, inflating "Not working (N)".
    add("ineffectiveSignalIds", `ineffectiveSignalIds TEXT NOT NULL DEFAULT '[]'`);
    // Effectiveness loop + auto-retire columns (#838).
    add("helpfulCount", `helpfulCount INTEGER NOT NULL DEFAULT 0`);
    add("injectedCount", `injectedCount INTEGER NOT NULL DEFAULT 0`);
    add("lastUsedAt", `lastUsedAt INTEGER`);
    add("retiredAt", `retiredAt INTEGER`);
    add("retiredReason", `retiredReason TEXT`);
    add("retiredFromStatus", `retiredFromStatus TEXT`);
    add("autoOptimizedAt", `autoOptimizedAt INTEGER`);
    // Glob-scoped injection (#842). JSON array of repo-relative glob patterns; '[]'
    // = an Always-rule (every task), matching the original always-inject behavior.
    add("scopeGlobs", `scopeGlobs TEXT NOT NULL DEFAULT '[]'`);
    // Phase 4 merge citation (#843): on a rule soft-retired by consolidation, the id of
    // the surviving rule it was merged into. Null otherwise; cleared on restore.
    add("mergedIntoId", `mergedIntoId TEXT`);
    // Auto-trial columns (#925): timestamp of proposed→active auto-promotion (null for
    // manually-approved rules); durable diversity sets (JSON arrays) that survive 60-day
    // signal pruning so the trial gate can read kind/session counts even after signals prune.
    add("trialedAt", `trialedAt INTEGER`);
    add("evidenceKindsSeen", `evidenceKindsSeen TEXT NOT NULL DEFAULT '[]'`);
    add("evidenceSessionsSeen", `evidenceSessionsSeen TEXT NOT NULL DEFAULT '[]'`);
    // Re-trial block marker (#945): set on revertTrial(id,"proposed"); presence suppresses
    // auto-re-trial until fresh evidence clears it or the rule expires.
    add("reTrialBlockedAt", `reTrialBlockedAt INTEGER`);
  }

  private hydrateLearning(r: LearningRow): Learning {
    return {
      id: r.id,
      repoPath: r.repoPath,
      rule: r.rule,
      rationale: r.rationale,
      evidence: JSON.parse(r.evidence) as string[],
      status: r.status as LearningStatus,
      evidenceCount: r.evidenceCount,
      ineffectiveCount: r.ineffectiveCount,
      helpfulCount: r.helpfulCount,
      injectedCount: r.injectedCount,
      lastUsedAt: r.lastUsedAt ?? null,
      retiredAt: r.retiredAt ?? null,
      retiredReason: r.retiredReason ?? null,
      scopeGlobs: parseFindings(r.scopeGlobs),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastEvidenceAt: r.lastEvidenceAt,
      promotedPrUrl: r.promotedPrUrl ?? null,
      mergedIntoId: r.mergedIntoId ?? null,
      trialedAt: r.trialedAt ?? null,
      reTrialBlockedAt: r.reTrialBlockedAt ?? null,
      distinctKinds: parseFindings(r.evidenceKindsSeen).length,
      distinctSessions: parseFindings(r.evidenceSessionsSeen).length,
    };
  }

  private hydrateMergeSuggestion(r: MergeSuggestionRow): MergeSuggestion {
    return {
      id: r.id,
      kind: r.kind === "cross" ? "cross" : "intra",
      repoPath: r.repoPath ?? null,
      targetId: r.targetId ?? null,
      sourceIds: parseFindings(r.sourceIds),
      mergedRule: r.mergedRule,
      mergedRationale: r.mergedRationale,
      repoPaths: r.repoPaths ? parseFindings(r.repoPaths) : null,
      signature: r.signature,
      status:
        r.status === "applied" ? "applied" : r.status === "dismissed" ? "dismissed" : "pending",
      createdAt: r.createdAt,
    };
  }

  /** Resolve signal ids to their distinct kind + session sets for durable diversity tracking.
   *  kinds = distinct signal.kind values; sessions = distinct non-null/non-empty sessionIds,
   *  capped at 50 to bound row growth. Used by addLearning and accrueProposedEvidence. */
  private resolveDiversity(signalIds: string[]): { kinds: string[]; sessions: string[] } {
    if (signalIds.length === 0) return { kinds: [], sessions: [] };
    const signals = this.getSignalsByIds(signalIds);
    const kinds = [...new Set(signals.map((s) => s.kind))];
    const sessions = [
      ...new Set(signals.map((s) => s.sessionId).filter((id): id is string => !!id)),
    ].slice(0, 50);
    return { kinds, sessions };
  }

  addLearning(input: {
    repoPath: string;
    rule: string;
    rationale: string;
    evidence: string[];
    scopeGlobs?: string[];
  }): Learning {
    const now = Date.now();
    const { kinds, sessions } = this.resolveDiversity(input.evidence);
    const l: Learning = {
      id: randomUUID(),
      repoPath: input.repoPath,
      rule: input.rule,
      rationale: input.rationale,
      evidence: input.evidence,
      status: "proposed",
      evidenceCount: input.evidence.length,
      ineffectiveCount: 0,
      helpfulCount: 0,
      injectedCount: 0,
      lastUsedAt: null,
      retiredAt: null,
      retiredReason: null,
      scopeGlobs: input.scopeGlobs ?? [],
      createdAt: now,
      updatedAt: now,
      lastEvidenceAt: input.evidence.length ? now : null,
      promotedPrUrl: null,
      mergedIntoId: null,
      trialedAt: null,
      reTrialBlockedAt: null,
      distinctKinds: kinds.length,
      distinctSessions: sessions.length,
    };
    this.db.run(
      `INSERT INTO learnings
         (id, repoPath, rule, rationale, evidence, status, evidenceCount, ineffectiveCount, scopeGlobs, createdAt, updatedAt, lastEvidenceAt, evidenceKindsSeen, evidenceSessionsSeen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        l.id,
        l.repoPath,
        l.rule,
        l.rationale,
        JSON.stringify(l.evidence),
        l.status,
        l.evidenceCount,
        l.ineffectiveCount,
        JSON.stringify(l.scopeGlobs),
        l.createdAt,
        l.updatedAt,
        l.lastEvidenceAt,
        JSON.stringify(kinds),
        JSON.stringify(sessions),
      ],
    );
    return l;
  }

  listLearnings(repoPath: string, opts?: { status?: LearningStatus }): Learning[] {
    const rows = opts?.status
      ? this.db
          .query(
            `SELECT * FROM learnings WHERE repoPath = ? AND status = ? ORDER BY updatedAt DESC`,
          )
          .all(repoPath, opts.status)
      : this.db
          .query(`SELECT * FROM learnings WHERE repoPath = ? ORDER BY updatedAt DESC`)
          .all(repoPath);
    return (rows as LearningRow[]).map((r) => this.hydrateLearning(r));
  }

  /** Active + promoted rules for a repo, for prompt injection (spec §4a). Oldest-updated first. */
  listActiveLearnings(repoPath: string): Learning[] {
    const rows = this.db
      .query(
        `SELECT * FROM learnings WHERE repoPath = ? AND status IN ('active','promoted')
         ORDER BY updatedAt ASC`,
      )
      .all(repoPath);
    return (rows as LearningRow[]).map((r) => this.hydrateLearning(r));
  }

  /** Distinct repoPaths that have ≥1 active/promoted (injectable) rule, for the
   *  cross-repo injectable sweep (GET /api/learnings/injectable). */
  listRepoPathsWithInjectableLearnings(): string[] {
    const rows = this.db
      .query(`SELECT DISTINCT repoPath FROM learnings WHERE status IN ('active','promoted')`)
      .all() as { repoPath: string }[];
    return rows.map((r) => r.repoPath);
  }

  getLearning(id: string): Learning | null {
    const r = this.db.query(`SELECT * FROM learnings WHERE id = ?`).get(id) as LearningRow | null;
    return r ? this.hydrateLearning(r) : null;
  }

  setLearningStatus(id: string, status: LearningStatus, rule?: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur) return null;
    if (!LEARNING_TRANSITIONS[cur.status].includes(status)) return null;
    // #945 fold-in: dismissing a trial (active→dismissed) must clear the auto-trial timestamp,
    // else the terminal row carries a stale `trialedAt` (cosmetic provenance leak). Scoped to
    // the dismissed target per the issue; active→retired via this path is a stated deferral.
    const clearTrialed = status === "dismissed" ? ", trialedAt = NULL" : "";
    this.db.run(
      `UPDATE learnings SET status = ?, rule = ?, updatedAt = ?${clearTrialed} WHERE id = ?`,
      [status, rule ?? cur.rule, Date.now(), id],
    );
    return this.getLearning(id);
  }

  /** Replace a rule's scope globs (operator edit, #842). Runs the same `sanitizeScopeGlobs`
   *  the distiller uses — normalize to repo-relative form, drop empty/over-long patterns,
   *  dedupe, and cap the count — so both paths persist identical, bounded scope; `[]` makes
   *  it an Always-rule again. No-op (returns null) for a missing rule. */
  setLearningScope(id: string, globs: string[]): Learning | null {
    const cur = this.getLearning(id);
    if (!cur) return null;
    const clean = sanitizeScopeGlobs(globs);
    this.db.run(`UPDATE learnings SET scopeGlobs = ?, updatedAt = ? WHERE id = ?`, [
      JSON.stringify(clean),
      Date.now(),
      id,
    ]);
    return this.getLearning(id);
  }

  /** Bump ineffectiveCount for an active/promoted rule (self-audit, spec §5) by the
   *  number of `signalIds` not already counted against it, recording them so a later
   *  re-distill over the same rolling window can't re-count the same evidence. A
   *  no-op (returns null) for proposed/dismissed/missing rules, or when every cited
   *  signal was already counted — keeping "Not working (N)" honest. */
  incrementLearningIneffective(id: string, signalIds: string[]): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || (cur.status !== "active" && cur.status !== "promoted")) return null;
    const row = this.db
      .query(`SELECT ineffectiveSignalIds FROM learnings WHERE id = ?`)
      .get(id) as { ineffectiveSignalIds?: string } | null;
    const counted = new Set(parseFindings(row?.ineffectiveSignalIds));
    const fresh = signalIds.filter((s) => typeof s === "string" && s && !counted.has(s));
    if (fresh.length === 0) return null;
    for (const s of fresh) counted.add(s);
    this.db.run(
      `UPDATE learnings SET ineffectiveCount = ineffectiveCount + ?, ineffectiveSignalIds = ?, updatedAt = ? WHERE id = ?`,
      [fresh.length, JSON.stringify([...counted]), Date.now(), id],
    );
    return this.getLearning(id);
  }

  /** Replace a flagged rule's text (and optionally rationale) and clear the visible
   *  ineffective flag. Only operates on active/promoted rules; no-ops for
   *  proposed/dismissed/missing. Blank rewrites are rejected (returns null).
   *  PRESERVES `ineffectiveSignalIds` so the dedup set survives the revision — only
   *  genuinely new failure signals can re-raise the flag after an optimization.
   *  RESETS the effectiveness baseline (`helpfulCount`/`injectedCount`/`lastUsedAt`)
   *  to zero: the rule's help-rate measures CURRENT text, so a rewrite is a fresh
   *  artifact that must re-earn its record. Without this, an auto-optimized rule
   *  would inherit the old text's poor help-rate and `shouldRetire` would re-trip on
   *  the cumulative Wilson bound at the first fresh ineffective signal — hollowing
   *  out the "second chance" the auto-optimize flag promises (the n_min gate also
   *  re-applies, so the rewrite must accrue fresh injections before it can retire). */
  reviseLearning(id: string, rule: string, rationale?: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || (cur.status !== "active" && cur.status !== "promoted")) return null;
    const text = rule.trim().slice(0, 240);
    if (!text) return null;
    const resolvedRationale = rationale !== undefined ? rationale : cur.rationale;
    const now = Date.now();
    this.db.run(
      `UPDATE learnings SET rule = ?, rationale = ?, ineffectiveCount = 0,
         helpfulCount = 0, injectedCount = 0, lastUsedAt = NULL,
         autoOptimizedAt = ?, updatedAt = ? WHERE id = ?`,
      [text, resolvedRationale, now, now, id],
    );
    return this.getLearning(id);
  }

  /** Deliberate inverse of `reviseLearning`: enriches a rule's text while PRESERVING all
   *  effectiveness counters (`helpfulCount`, `injectedCount`, `ineffectiveCount`, `lastUsedAt`,
   *  `evidenceCount`, `ineffectiveSignalIds`). Use when the distiller wants to apply an
   *  mem0-style UPDATE — merging richer text into an existing rule so the help-rate record
   *  carries forward. Unlike `reviseLearning`, this does NOT reset counters and does NOT stamp
   *  `autoOptimizedAt`. Hard-guards active-only: promoted rules have their text mirrored in
   *  CLAUDE.md verbatim and must never be silently rewritten here. */
  mergeLearning(id: string, rule: string, rationale?: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || cur.status !== "active") return null;
    const text = rule.trim().slice(0, 240);
    if (!text) return null;
    const resolvedRationale = rationale !== undefined ? rationale : cur.rationale;
    const now = Date.now();
    this.db.run(
      `UPDATE learnings SET rule = ?, rationale = ?, updatedAt = ?, lastEvidenceAt = ? WHERE id = ?`,
      [text, resolvedRationale, now, now, id],
    );
    return this.getLearning(id);
  }

  /** Resolve the stored `ineffectiveSignalIds` for a rule to full Signal rows.
   *  Server-side only — `ineffectiveSignalIds` is intentionally absent from the
   *  Learning type and hydrateLearning. Returns [] for missing/unflagged rules. */
  ineffectiveSignalsFor(id: string): Signal[] {
    const row = this.db
      .query(`SELECT ineffectiveSignalIds FROM learnings WHERE id = ?`)
      .get(id) as { ineffectiveSignalIds?: string } | null;
    if (!row) return [];
    const ids = parseFindings(row.ineffectiveSignalIds);
    return this.getSignalsByIds(ids);
  }

  /** Record that a set of learning ids were injected into a session's context.
   *  INSERT OR IGNORE keeps it idempotent. Empty ids → no-op. No counter bump. */
  recordInjectedLearnings(sessionId: string, ids: string[]): void {
    if (ids.length === 0) return;
    for (const learningId of ids) {
      this.db.run(
        `INSERT OR IGNORE INTO session_injected_learnings (sessionId, learningId) VALUES (?, ?)`,
        [sessionId, learningId],
      );
    }
  }

  /** For each id: bump `injectedCount` + stamp `lastUsedAt`; bump `helpfulCount` only when `good`.
   *  Empty ids → no-op. */
  attributeInjected(ids: string[], opts: { good: boolean }): void {
    if (ids.length === 0) return;
    const now = Date.now();
    for (const id of ids) {
      this.db.run(
        `UPDATE learnings SET injectedCount = injectedCount + 1, helpfulCount = helpfulCount + ?, lastUsedAt = ?, updatedAt = ? WHERE id = ?`,
        [opts.good ? 1 : 0, now, now, id],
      );
    }
  }

  /** Return and delete the learningIds recorded for a session. A second call returns []. */
  takeSessionInjectedLearnings(sessionId: string): string[] {
    const rows = this.db
      .query(`SELECT learningId FROM session_injected_learnings WHERE sessionId = ?`)
      .all(sessionId) as { learningId: string }[];
    if (rows.length === 0) return [];
    this.db.run(`DELETE FROM session_injected_learnings WHERE sessionId = ?`, [sessionId]);
    return rows.map((r) => r.learningId);
  }

  /** COUNT of blocking signals (block/stall/critic) for a session. */
  countSessionBlockingSignals(sessionId: string): number {
    return (
      this.db
        .query(
          `SELECT COUNT(*) AS c FROM signals WHERE sessionId = ? AND kind IN ('block','stall','critic')`,
        )
        .get(sessionId) as { c: number }
    ).c;
  }

  /** active|promoted → retired; sets retiredAt, retiredReason, retiredFromStatus, updatedAt.
   *  Returns the updated Learning, or null for illegal source state / missing row. */
  retireLearning(id: string, reason: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur) return null;
    if (!LEARNING_TRANSITIONS[cur.status].includes("retired")) return null;
    const now = Date.now();
    this.db.run(
      `UPDATE learnings SET status = 'retired', retiredAt = ?, retiredReason = ?, retiredFromStatus = ?, updatedAt = ? WHERE id = ?`,
      [now, reason, cur.status, now, id],
    );
    return this.getLearning(id);
  }

  /** retired → retiredFromStatus (or 'active'); clears retiredAt/retiredReason/retiredFromStatus,
   *  and clears `mergedIntoId` so a rule restored after a Phase-4 consolidation carries no
   *  dangling citation back to its former survivor. Returns null when not retired or missing. */
  restoreLearning(id: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || cur.status !== "retired") return null;
    const row = this.db.query(`SELECT retiredFromStatus FROM learnings WHERE id = ?`).get(id) as {
      retiredFromStatus?: string | null;
    } | null;
    const restoreTo: LearningStatus =
      (row?.retiredFromStatus as LearningStatus | null | undefined) ?? "active";
    const now = Date.now();
    this.db.run(
      `UPDATE learnings SET status = ?, retiredAt = NULL, retiredReason = NULL, retiredFromStatus = NULL, mergedIntoId = NULL, updatedAt = ? WHERE id = ?`,
      [restoreTo, now, id],
    );
    return this.getLearning(id);
  }

  /** Soft-retire a rule that was consolidated into another (Phase 4 merge): same as
   *  `retireLearning(id, "merged")` but also records `mergedIntoId = targetId` as the
   *  retained citation back to the surviving rule. active|promoted → retired only. */
  retireLearningMerged(sourceId: string, targetId: string): Learning | null {
    const cur = this.getLearning(sourceId);
    if (!cur) return null;
    if (!LEARNING_TRANSITIONS[cur.status].includes("retired")) return null;
    const now = Date.now();
    this.db.run(
      `UPDATE learnings SET status = 'retired', retiredAt = ?, retiredReason = 'merged',
         retiredFromStatus = ?, mergedIntoId = ?, updatedAt = ? WHERE id = ?`,
      [now, cur.status, targetId, now, sourceId],
    );
    return this.getLearning(sourceId);
  }

  /** Rules soft-retired by being merged into `targetId` (Phase 4 citation list). Scoped to
   *  status='retired' AND retiredReason='merged' so a since-restored member (which has its
   *  mergedIntoId cleared) can never reappear here. Newest-retired first. */
  listSubsumedLearnings(targetId: string): Learning[] {
    const rows = this.db
      .query(
        `SELECT * FROM learnings WHERE mergedIntoId = ? AND status = 'retired'
           AND retiredReason = 'merged' ORDER BY retiredAt DESC`,
      )
      .all(targetId);
    return (rows as LearningRow[]).map((r) => this.hydrateLearning(r));
  }

  /** Active + promoted rules across ALL repos (Phase 4 cross-repo recurrence pass).
   *  Oldest-updated first. */
  listAllActiveLearnings(): Learning[] {
    const rows = this.db
      .query(`SELECT * FROM learnings WHERE status IN ('active','promoted') ORDER BY updatedAt ASC`)
      .all();
    return (rows as LearningRow[]).map((r) => this.hydrateLearning(r));
  }

  // ── merge suggestions (Phase 4) ───────────────────────────────────────────
  /** Persist a background merge suggestion. */
  addMergeSuggestion(input: {
    kind: MergeSuggestionKind;
    repoPath: string | null;
    targetId: string | null;
    sourceIds: string[];
    mergedRule: string;
    mergedRationale: string;
    repoPaths: string[] | null;
    signature: string;
  }): MergeSuggestion {
    const s: MergeSuggestion = {
      id: randomUUID(),
      kind: input.kind,
      repoPath: input.repoPath,
      targetId: input.targetId,
      sourceIds: input.sourceIds,
      mergedRule: input.mergedRule,
      mergedRationale: input.mergedRationale,
      repoPaths: input.repoPaths,
      signature: input.signature,
      status: "pending",
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO learning_merge_suggestions
         (id, kind, repoPath, targetId, sourceIds, mergedRule, mergedRationale, repoPaths, signature, status, createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id,
        s.kind,
        s.repoPath,
        s.targetId,
        JSON.stringify(s.sourceIds),
        s.mergedRule,
        s.mergedRationale,
        s.repoPaths ? JSON.stringify(s.repoPaths) : null,
        s.signature,
        s.status,
        s.createdAt,
      ],
    );
    return s;
  }

  listMergeSuggestions(opts?: {
    repoPath?: string;
    kind?: MergeSuggestionKind;
    status?: MergeSuggestionStatus;
  }): MergeSuggestion[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts?.repoPath !== undefined) {
      where.push(`repoPath = ?`);
      args.push(opts.repoPath);
    }
    if (opts?.kind) {
      where.push(`kind = ?`);
      args.push(opts.kind);
    }
    if (opts?.status) {
      where.push(`status = ?`);
      args.push(opts.status);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM learning_merge_suggestions ${clause} ORDER BY createdAt DESC`)
      .all(...args);
    return (rows as MergeSuggestionRow[]).map((r) => this.hydrateMergeSuggestion(r));
  }

  getMergeSuggestion(id: string): MergeSuggestion | null {
    const r = this.db
      .query(`SELECT * FROM learning_merge_suggestions WHERE id = ?`)
      .get(id) as MergeSuggestionRow | null;
    return r ? this.hydrateMergeSuggestion(r) : null;
  }

  setMergeSuggestionStatus(id: string, status: MergeSuggestionStatus): MergeSuggestion | null {
    const cur = this.getMergeSuggestion(id);
    if (!cur) return null;
    this.db.run(`UPDATE learning_merge_suggestions SET status = ? WHERE id = ?`, [status, id]);
    return this.getMergeSuggestion(id);
  }

  /** Signatures of suggestions of a kind, so a background pass can skip re-proposing a group
   *  the operator already has (or rejected). `intra` is scoped to a repo; `cross` is global
   *  (repoPath ignored).
   *
   *  `cross` additionally includes `applied`: promoting a cross group to the global CLAUDE.md
   *  (#872) leaves its member rules ACTIVE, so without this carve-out the next cross pass would
   *  re-detect and re-suggest the same group. `intra`-apply retires its members, so the group
   *  can't recur — `applied` is intentionally excluded there. */
  mergeSuggestionSignatures(opts: { kind: MergeSuggestionKind; repoPath?: string }): Set<string> {
    const statuses =
      opts.kind === "cross" ? `('pending','dismissed','applied')` : `('pending','dismissed')`;
    const where = [`kind = ?`, `status IN ${statuses}`];
    const args: string[] = [opts.kind];
    if (opts.kind === "intra" && opts.repoPath !== undefined) {
      where.push(`repoPath = ?`);
      args.push(opts.repoPath);
    }
    const rows = this.db
      .query(`SELECT signature FROM learning_merge_suggestions WHERE ${where.join(" AND ")}`)
      .all(...args) as { signature: string }[];
    return new Set(rows.map((r) => r.signature));
  }

  /** Signature of the active-rule set the last merge pass processed for a scope
   *  (`<repoPath>` for intra, `__cross__` for the global pass). Lets the background pass
   *  skip re-spawning when nothing changed. Empty string when never run. */
  getMergePassSignature(key: string): string {
    return this.getSetting(`learnings:merge-pass-sig:${key}`) ?? "";
  }

  setMergePassSignature(key: string, sig: string): void {
    this.setSetting(`learnings:merge-pass-sig:${key}`, sig);
  }

  /** Drop pending suggestions whose member rules no longer all exist (a member was hard-
   *  deleted, or — for safety — left the schema). Keeps the drawer from offering a merge
   *  that can't apply. Applied/dismissed rows are kept as history. */
  pruneOrphanMergeSuggestions(): void {
    const pending = this.listMergeSuggestions({ status: "pending" });
    for (const s of pending) {
      const ids = [...(s.targetId ? [s.targetId] : []), ...s.sourceIds];
      const allExist = ids.every((id) => this.getLearning(id) !== null);
      if (!allExist) {
        this.db.run(`DELETE FROM learning_merge_suggestions WHERE id = ?`, [s.id]);
      }
    }
  }

  /** Retired rules for a repo, newest-updated first. */
  listRetiredLearnings(repoPath: string): Learning[] {
    const rows = this.db
      .query(
        `SELECT * FROM learnings WHERE repoPath = ? AND status = 'retired' ORDER BY updatedAt DESC`,
      )
      .all(repoPath);
    return (rows as LearningRow[]).map((r) => this.hydrateLearning(r));
  }

  // ── unseen-retired marker ─────────────────────────────────────────────────
  /** Return the last time the user acknowledged retired rules for a repo (epoch ms).
   *  Defaults to 0 when never set. */
  getRetiredSeenAt(repoPath: string): number {
    return Number(this.getSetting(`learnings:retired-seen:${repoPath}`) ?? 0);
  }

  /** Record that the user has seen retired rules for a repo up to `ts` (epoch ms). */
  markRetiredSeen(repoPath: string, ts: number): void {
    this.setSetting(`learnings:retired-seen:${repoPath}`, String(ts));
  }

  /** Distinct repoPaths that have ≥1 retired rule, for the cross-repo injectable sweep. */
  listRepoPathsWithRetiredLearnings(): string[] {
    return (
      this.db.query(`SELECT DISTINCT repoPath FROM learnings WHERE status = 'retired'`).all() as {
        repoPath: string;
      }[]
    ).map((r) => r.repoPath);
  }

  /** Delete session_injected_learnings rows whose session no longer exists. */
  pruneOrphanInjectedLearnings(): void {
    this.db.run(
      `DELETE FROM session_injected_learnings WHERE sessionId NOT IN (SELECT id FROM sessions)`,
    );
  }

  /** Server-internal getter: the timestamp when reviseLearning last ran on this id.
   *  Exposed so tests can assert the autoOptimizedAt stamp without reaching into private db. */
  autoOptimizedAt(id: string): number | null {
    const row = this.db.query(`SELECT autoOptimizedAt FROM learnings WHERE id = ?`).get(id) as {
      autoOptimizedAt?: number | null;
    } | null;
    return row?.autoOptimizedAt ?? null;
  }

  /** active → promoted, recording the CLAUDE.md PR url (spec §4b). Returns null
   *  when the rule is missing or not in a state that allows promotion. */
  promoteLearning(id: string, prUrl: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || !LEARNING_TRANSITIONS[cur.status].includes("promoted")) return null;
    this.db.run(
      `UPDATE learnings SET status = 'promoted', promotedPrUrl = ?, updatedAt = ? WHERE id = ?`,
      [prUrl, Date.now(), id],
    );
    return this.getLearning(id);
  }

  pendingLearningCount(): number {
    return (
      this.db.query(`SELECT COUNT(*) AS c FROM learnings WHERE status = 'proposed'`).get() as {
        c: number;
      }
    ).c;
  }

  listPendingLearnings(): Learning[] {
    const rows = this.db
      .query(
        `SELECT * FROM learnings WHERE status = 'proposed' ORDER BY evidenceCount DESC, lastEvidenceAt DESC`,
      )
      .all();
    return (rows as LearningRow[]).map((r) => this.hydrateLearning(r));
  }

  // ── auto-trial primitives (#925) ──────────────────────────────────────────

  /** Promote a proposed rule to active as a trial (auto-trial path). Sets trialedAt
   *  to mark it as auto-promoted — distinguishes it from manually-approved active rules.
   *  Returns null if the rule is not currently proposed. */
  trialLearning(id: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || cur.status !== "proposed") return null;
    const now = Date.now();
    this.db.run(
      `UPDATE learnings SET status = 'active', trialedAt = ?, updatedAt = ? WHERE id = ?`,
      [now, now, id],
    );
    return this.getLearning(id);
  }

  /** Revert an auto-trialed active rule back to proposed or dismissed. Guards that the
   *  rule is currently active AND was auto-trialed (trialedAt != null). Clears trialedAt.
   *
   *  NOTE: active→proposed is not in LEARNING_TRANSITIONS (it is a terminal-ish flow in the
   *  normal FSM). This method deliberately bypasses that table for the auto-trial case only —
   *  a trial is a reversible auto-promotion, not a user-driven manual promotion, so the
   *  reverse path must be open without widening the general FSM. */
  revertTrial(id: string, target: "proposed" | "dismissed"): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || cur.trialedAt == null || cur.status !== "active") return null;
    const now = Date.now();
    // #945: when sending the rule back to the queue (target "proposed"), stamp the re-trial
    // block marker so the auto-trial gate won't immediately re-promote it off its still-strong
    // frozen diversity counters. "dismissed" is terminal — no marker needed (leave it null).
    const blockedAt = target === "proposed" ? now : null;
    this.db.run(
      `UPDATE learnings SET status = ?, trialedAt = NULL, reTrialBlockedAt = ?, updatedAt = ? WHERE id = ?`,
      [target, blockedAt, now, id],
    );
    return this.getLearning(id);
  }

  /** Retire a stale trialed rule. Guards that the rule is active and was auto-trialed
   *  (trialedAt != null). Sets status='retired' with retiredReason='trial-expired' and clears
   *  trialedAt. Retires (not dismisses) so it shows in the retired drawer and stays restorable. */
  reapStaleTrial(id: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || cur.trialedAt == null || cur.status !== "active") return null;
    const now = Date.now();
    this.db.run(
      `UPDATE learnings SET status = 'retired', retiredAt = ?, retiredReason = 'trial-expired',
         retiredFromStatus = 'active', trialedAt = NULL, updatedAt = ? WHERE id = ?`,
      [now, now, id],
    );
    return this.getLearning(id);
  }

  /** Append new evidence signal ids to a proposed rule's evidence array and merge new
   *  kind/session diversity into the durable sets. Deduplicates against stored evidence;
   *  returns null if the rule is not proposed, or if all supplied ids are already counted
   *  (no-op, keeps counts honest — mirrors incrementLearningIneffective). */
  accrueProposedEvidence(id: string, signalIds: string[]): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || cur.status !== "proposed") return null;
    const existingSet = new Set(cur.evidence);
    const fresh = signalIds.filter((s) => typeof s === "string" && s && !existingSet.has(s));
    if (fresh.length === 0) return null;
    const newEvidence = [...cur.evidence, ...fresh];
    const { kinds: freshKinds, sessions: freshSessions } = this.resolveDiversity(fresh);
    // Read existing diversity sets from the raw row to avoid double-parsing via hydrate.
    const row = this.db
      .query(`SELECT evidenceKindsSeen, evidenceSessionsSeen FROM learnings WHERE id = ?`)
      .get(id) as { evidenceKindsSeen: string; evidenceSessionsSeen: string } | null;
    const existingKinds = new Set(parseFindings(row?.evidenceKindsSeen));
    const existingSessionsArr = parseFindings(row?.evidenceSessionsSeen);
    for (const k of freshKinds) existingKinds.add(k);
    const mergedSessions = [...new Set([...existingSessionsArr, ...freshSessions])].slice(0, 50);
    const now = Date.now();
    // #945: genuinely fresh evidence (recurrence) lifts any re-trial block so the rule can
    // re-qualify for auto-trial on its renewed strength.
    this.db.run(
      `UPDATE learnings SET evidence = ?, evidenceCount = ?, evidenceKindsSeen = ?,
         evidenceSessionsSeen = ?, lastEvidenceAt = ?, reTrialBlockedAt = NULL, updatedAt = ? WHERE id = ?`,
      [
        JSON.stringify(newEvidence),
        newEvidence.length,
        JSON.stringify([...existingKinds]),
        JSON.stringify(mergedSessions),
        now,
        now,
        id,
      ],
    );
    return this.getLearning(id);
  }

  /** Durable normalized signatures for pruned proposals. The distiller uses `prunedAt` to reject
   *  recurrence from its unchanged signal window while permitting genuinely newer evidence. */
  listLearningPruneTombstones(repoPath: string): { ruleKey: string; prunedAt: number }[] {
    return this.db
      .query(`SELECT ruleKey, prunedAt FROM learning_prune_tombstones WHERE repoPath = ?`)
      .all(repoPath) as { ruleKey: string; prunedAt: number }[];
  }

  /** #1794: permanently delete every `proposed` learning whose latest supporting evidence is
   *  older than `beforeTs` (age = COALESCE(lastEvidenceAt, createdAt), strict `<` so a row
   *  exactly at the cutoff survives). Only `proposed` rows are eligible; accepted/history rows
   *  (active/promoted/dismissed/retired) are never touched. Normalized tombstones are retained and
   *  inbound merge-history citations are cleared in the same transaction before the status-scoped
   *  bulk delete. Returns the number of rows removed. */
  pruneStaleProposedLearnings(beforeTs: number, prunedAt = Date.now()): number {
    return this.db.transaction(() => {
      const stale = this.db
        .query(
          `SELECT repoPath, rule FROM learnings
           WHERE status = 'proposed' AND COALESCE(lastEvidenceAt, createdAt) < ?`,
        )
        .all(beforeTs) as { repoPath: string; rule: string }[];
      for (const learning of stale) {
        this.db.run(
          `INSERT INTO learning_prune_tombstones (repoPath, ruleKey, prunedAt) VALUES (?, ?, ?)
           ON CONFLICT(repoPath, ruleKey) DO UPDATE SET prunedAt = MAX(prunedAt, excluded.prunedAt)`,
          [learning.repoPath, normalizeRule(learning.rule), prunedAt],
        );
      }
      this.db.run(
        `UPDATE learnings SET mergedIntoId = NULL WHERE mergedIntoId IN (
           SELECT id FROM learnings
           WHERE status = 'proposed' AND COALESCE(lastEvidenceAt, createdAt) < ?
         )`,
        [beforeTs],
      );
      return this.db.run(
        `DELETE FROM learnings WHERE status = 'proposed' AND COALESCE(lastEvidenceAt, createdAt) < ?`,
        [beforeTs],
      ).changes;
    })();
  }

  /** All active rules that were auto-trialed (trialedAt IS NOT NULL), across all repos,
   *  ordered oldest-trial first (so the most-stale trial is first in the sweep). */
  listTrialLearnings(): Learning[] {
    const rows = this.db
      .query(
        `SELECT * FROM learnings WHERE status = 'active' AND trialedAt IS NOT NULL ORDER BY trialedAt ASC, rowid ASC`,
      )
      .all();
    return (rows as LearningRow[]).map((r) => this.hydrateLearning(r));
  }

  /** One-time backfill: populate evidenceKindsSeen + evidenceSessionsSeen for existing
   *  proposed rows that still have empty sets.
   *  Guarded by the kv flag "learnings:diversity-backfilled" so it runs exactly once. */
  private backfillLearningDiversity(): void {
    if (this.getSetting("learnings:diversity-backfilled") === "1") return;
    const rows = this.db
      .query(
        `SELECT id, evidence FROM learnings WHERE status = 'proposed'
         AND evidenceKindsSeen = '[]' AND evidenceSessionsSeen = '[]' AND evidenceCount > 0`,
      )
      .all() as { id: string; evidence: string }[];
    for (const row of rows) {
      const ids = parseFindings(row.evidence);
      const { kinds, sessions } = this.resolveDiversity(ids);
      if (kinds.length > 0 || sessions.length > 0) {
        this.db.run(
          `UPDATE learnings SET evidenceKindsSeen = ?, evidenceSessionsSeen = ? WHERE id = ?`,
          [JSON.stringify(kinds), JSON.stringify(sessions), row.id],
        );
      }
    }
    this.setSetting("learnings:diversity-backfilled", "1");
  }

  /** Resolve cited evidence signal ids to their full rows (newest first), for the
   *  drawer's "where did this come from" view. Ids that no longer resolve (pruned
   *  signals) are silently dropped, so the result can be shorter than `ids`. Empty
   *  in, empty out. */
  getSignalsByIds(ids: string[]): Signal[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .query(
        // rowid tiebreak keeps newest-inserted first when two signals share a ms.
        `SELECT id, repoPath, sessionId, kind, payload, ts FROM signals
         WHERE id IN (${placeholders}) ORDER BY ts DESC, rowid DESC`,
      )
      .all(...ids) as Signal[];
  }

  // ── build queue ──────────────────────────────────────────────────────────────
  getBuildQueue(sessionId: string): BuildQueue {
    const rows = this.db
      .query(
        `SELECT id, position, title, detail, status
         FROM build_queue_steps WHERE sessionId = ? ORDER BY position`,
      )
      .all(sessionId) as {
      id: string;
      position: number;
      title: string;
      detail: string;
      status: string;
    }[];
    const state = this.db
      .query(`SELECT approved, approvalKind FROM build_queue_state WHERE sessionId = ?`)
      .get(sessionId) as { approved: number; approvalKind: string | null } | null;
    const steps: BuildStep[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      detail: r.detail,
      status: r.status as BuildStepStatus,
      position: r.position,
    }));
    const kind = state?.approvalKind as "auto" | "operator" | null | undefined;
    return {
      sessionId,
      steps,
      approved: state ? !!state.approved : false,
      ...(kind ? { approvalKind: kind } : {}),
    };
  }

  /**
   * Replace a session's whole queue, preserving step identity across the re-PUT two ways:
   *
   *  1. **Verbatim client ids.** A step posted WITH an `id` keeps that id as-is (matched or new),
   *     so an agent that owns stable ids (e.g. "s1") survives reorder/insert/delete with no
   *     regeneration. A matched id also preserves its prior `status` + `createdAt` (unless an
   *     explicit `status` is given — that still wins).
   *  2. **Conservative carry-over for an OMITTED id.** Reuse the existing step's id only when the
   *     step at the SAME position has the SAME title (position AND title must agree). This never
   *     mis-binds; any insert/delete/rename/reorder falls back to a fresh UUID. It is the safe
   *     synthesis of the two single-key heuristics (positional / title-keyed) that are each unsafe
   *     alone, and it keeps cached ids valid for the common "revise the tail, keep finished steps"
   *     re-PUT even when the agent omits ids.
   *
   * Duplicate explicit ids are rejected upstream (`validateBuildSteps`); the `reserved`/`used`
   * guards below additionally ensure no two rows resolve to the same id (which would throw on the
   * composite PK): an omitted-id step never carries over an id another step claims explicitly, nor
   * one already assigned earlier in this PUT.
   */
  replaceBuildQueue(sessionId: string, steps: BuildStepInput[]): BuildQueue {
    const now = Date.now();
    this.db.transaction(() => {
      // read existing rows (inside the txn) to preserve status + createdAt across the replace
      const byId = new Map<string, { status: BuildStepStatus; createdAt: number }>();
      const byPosition = new Map<
        number,
        { id: string; title: string; status: BuildStepStatus; createdAt: number }
      >();
      const existingRows = this.db
        .query(
          `SELECT id, position, title, status, createdAt FROM build_queue_steps WHERE sessionId = ?`,
        )
        .all(sessionId) as {
        id: string;
        position: number;
        title: string;
        status: string;
        createdAt: number;
      }[];
      for (const r of existingRows) {
        byId.set(r.id, { status: r.status as BuildStepStatus, createdAt: r.createdAt });
        byPosition.set(r.position, {
          id: r.id,
          title: r.title,
          status: r.status as BuildStepStatus,
          createdAt: r.createdAt,
        });
      }
      // ids the agent claims explicitly this PUT — an omitted-id carry-over must not steal one.
      const reserved = new Set(steps.filter((s) => s.id).map((s) => s.id!));
      const used = new Set<string>();

      this.db.run(`DELETE FROM build_queue_steps WHERE sessionId = ?`, [sessionId]);
      for (let i = 0; i < steps.length; i++) {
        const input = steps[i]!;
        let id: string;
        let prior: { status: BuildStepStatus; createdAt: number } | null = null;
        if (input.id) {
          id = input.id; // verbatim
          prior = byId.get(id) ?? null;
        } else {
          const cand = byPosition.get(i);
          if (cand && cand.title === input.title && !reserved.has(cand.id) && !used.has(cand.id)) {
            id = cand.id; // position+title carry-over
            prior = { status: cand.status, createdAt: cand.createdAt };
          } else {
            id = randomUUID();
          }
        }
        used.add(id);
        const status = input.status ?? prior?.status ?? "pending";
        const createdAt = prior?.createdAt ?? now;
        this.db.run(
          `INSERT INTO build_queue_steps (id, sessionId, position, title, detail, status, createdAt, updatedAt)
           VALUES (?,?,?,?,?,?,?,?)`,
          [id, sessionId, i, input.title, input.detail ?? "", status, createdAt, now],
        );
      }
    })();
    return this.getBuildQueue(sessionId);
  }

  /**
   * Resolve a posted step `idOrPrefix` against this session's actual step ids (exact match first,
   * else an unambiguous ≥8-char prefix — see the pure `resolveStepId` helper). The POST handler
   * uses this to turn a short/abbreviated id into the full id (or a clear 404/409) so a status
   * update can't silently no-op on an unmatched id.
   */
  resolveStepId(sessionId: string, idOrPrefix: string): StepIdResolution {
    const rows = this.db
      .query(`SELECT id FROM build_queue_steps WHERE sessionId = ?`)
      .all(sessionId) as { id: string }[];
    return resolveStepId(
      rows.map((r) => r.id),
      idOrPrefix,
    );
  }

  /**
   * Update the status of a single step. Returns true when the TARGET row was actually
   * changed (unchanged contract; the cascade below is additive).
   *
   * Monotonic forward-fill: when a step is advanced to `active` or `done`, every EARLIER
   * step still `pending` is auto-completed to `done`, in the same transaction. The
   * build-queue contract is ordered execution ("work the steps in order"), so reaching
   * step N implies steps before it are done — this keeps the displayed status from lagging
   * actual progress even when the agent under-reports (e.g. marks a later step but never
   * the earlier ones). Deterministic and server-side: needs zero agent compliance.
   *
   * Strictly monotonic + safe: only `pending → done`, only at LOWER positions; never
   * un-completes a step, never touches later steps, and never overrides `skipped` (an
   * explicit terminal state the agent sets to drop a step). A step the agent silently
   * jumped over (left `pending`) is treated as `done` — the reasonable default under the
   * ordered contract; the agent has the explicit `skipped` status if it means otherwise.
   * Only fires on `active`/`done`, never on `pending` (un-set) or `skipped`.
   */
  setBuildStepStatus(sessionId: string, stepId: string, status: BuildStepStatus): boolean {
    const now = Date.now();
    let changed = false;
    this.db.transaction(() => {
      const { changes } = this.db.run(
        `UPDATE build_queue_steps SET status = ?, updatedAt = ? WHERE id = ? AND sessionId = ?`,
        [status, now, stepId, sessionId],
      );
      changed = changes > 0;
      if (!changed) return;
      if (status === "active" || status === "done") {
        const row = this.db
          .query(`SELECT position FROM build_queue_steps WHERE id = ? AND sessionId = ?`)
          .get(stepId, sessionId) as { position: number } | null;
        if (row) {
          this.db.run(
            `UPDATE build_queue_steps SET status = 'done', updatedAt = ?
             WHERE sessionId = ? AND position < ? AND status = 'pending'`,
            [now, sessionId, row.position],
          );
        }
      }
    })();
    return changed;
  }

  /** Flip the human-curation gate for a session's queue. */
  setBuildQueueApproved(sessionId: string, approved: boolean, kind?: "auto" | "operator"): void {
    const approvalKind = approved ? (kind ?? null) : null;
    this.db.run(
      `INSERT INTO build_queue_state (sessionId, approved, approvalKind, updatedAt) VALUES (?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET approved = excluded.approved, approvalKind = excluded.approvalKind, updatedAt = excluded.updatedAt`,
      [sessionId, approved ? 1 : 0, approvalKind, Date.now()],
    );
  }

  // ── epic authoring drafts (issue #1507) ────────────────────────────────────

  /** Read a session's epic draft, or null when none has been authored. */
  getEpicDraft(sessionId: string): EpicDraft | null {
    const r = this.db.query(`SELECT * FROM epic_draft WHERE sessionId = ?`).get(sessionId) as {
      sessionId: string;
      parentTitle: string;
      parentBody: string;
      acceptanceCriteria: string;
      nonGoals: string;
      children: string;
      status: string;
      materializedChildren: string;
      parentNumber: number | null;
      parentUrl: string | null;
    } | null;
    if (!r) return null;
    return {
      sessionId: r.sessionId,
      parent: {
        title: r.parentTitle,
        body: r.parentBody,
        acceptanceCriteria: safeJsonArray(r.acceptanceCriteria),
        nonGoals: safeJsonArray(r.nonGoals),
      },
      children: safeJsonParse(r.children, []) as EpicDraftChild[],
      status: r.status as EpicDraft["status"],
      materializedChildren: safeJsonParse(r.materializedChildren, {}) as Record<string, number>,
      parentNumber: r.parentNumber,
      parentUrl: r.parentUrl,
    };
  }

  /** Author/replace a session's draft CONTENT. Resets the materialize lifecycle to `draft` and
   *  clears any prior materialized state (the amend loop re-drafts before approval). */
  replaceEpicDraft(sessionId: string, content: EpicDraftContent): EpicDraft {
    this.db.run(
      `INSERT INTO epic_draft
         (sessionId, parentTitle, parentBody, acceptanceCriteria, nonGoals, children,
          status, materializedChildren, parentNumber, parentUrl, updatedAt)
       VALUES (?,?,?,?,?,?, 'draft', '{}', NULL, NULL, ?)
       ON CONFLICT(sessionId) DO UPDATE SET
         parentTitle = excluded.parentTitle, parentBody = excluded.parentBody,
         acceptanceCriteria = excluded.acceptanceCriteria, nonGoals = excluded.nonGoals,
         children = excluded.children, status = 'draft', materializedChildren = '{}',
         parentNumber = NULL, parentUrl = NULL, updatedAt = excluded.updatedAt`,
      [
        sessionId,
        content.parent.title,
        content.parent.body,
        JSON.stringify(content.parent.acceptanceCriteria ?? []),
        JSON.stringify(content.parent.nonGoals ?? []),
        JSON.stringify(content.children ?? []),
        Date.now(),
      ],
    );
    return this.getEpicDraft(sessionId)!;
  }

  /** CAS `draft → materializing`, run BEFORE the first createIssue. Returns true when this call
   *  won the transition (the caller proceeds); false when the row is absent or not `draft`
   *  (already materializing/approved — the caller 409s or returns the stored result). */
  beginEpicDraftMaterialize(sessionId: string): boolean {
    const { changes } = this.db.run(
      `UPDATE epic_draft SET status = 'materializing', updatedAt = ?
       WHERE sessionId = ? AND status = 'draft'`,
      [Date.now(), sessionId],
    );
    return changes > 0;
  }

  /** Persist a child's real issue number the instant it is created (partial-failure resume). */
  recordEpicDraftChild(sessionId: string, key: string, number: number): void {
    this.db.transaction(() => {
      const row = this.db
        .query(`SELECT materializedChildren FROM epic_draft WHERE sessionId = ?`)
        .get(sessionId) as { materializedChildren: string } | null;
      if (!row) return;
      const map = safeJsonParse(row.materializedChildren, {}) as Record<string, number>;
      map[key] = number;
      this.db.run(
        `UPDATE epic_draft SET materializedChildren = ?, updatedAt = ? WHERE sessionId = ?`,
        [JSON.stringify(map), Date.now(), sessionId],
      );
    })();
  }

  /** Persist the parent number/url the instant it is created (resume skips re-creating it). */
  recordEpicDraftParent(sessionId: string, parentNumber: number, parentUrl: string): void {
    this.db.run(
      `UPDATE epic_draft SET parentNumber = ?, parentUrl = ?, updatedAt = ? WHERE sessionId = ?`,
      [parentNumber, parentUrl, Date.now(), sessionId],
    );
  }

  /** On-error transition `materializing → draft`, retaining materializedChildren so an explicit
   *  retry re-wins the CAS and resumes. */
  revertEpicDraftToDraft(sessionId: string): void {
    this.db.run(
      `UPDATE epic_draft SET status = 'draft', updatedAt = ? WHERE sessionId = ? AND status = 'materializing'`,
      [Date.now(), sessionId],
    );
  }

  /** Boot sweep: revert every orphaned `materializing` row to `draft` (see the table DDL note). */
  resetOrphanedEpicDraftMaterialize(): void {
    this.db.run(
      `UPDATE epic_draft SET status = 'draft', updatedAt = ? WHERE status = 'materializing'`,
      [Date.now()],
    );
  }

  /** Terminal transition `→ approved` with the created parent's number/url. */
  setEpicDraftApproved(sessionId: string, parentNumber: number, parentUrl: string): void {
    this.db.run(
      `UPDATE epic_draft SET status = 'approved', parentNumber = ?, parentUrl = ?, updatedAt = ? WHERE sessionId = ?`,
      [parentNumber, parentUrl, Date.now(), sessionId],
    );
  }

  /** Return one BuildQueue per session that has ≥1 step, via a single JOIN.
   *  Sessions with no steps are omitted entirely. */
  listBuildQueues(): BuildQueue[] {
    const rows = this.db
      .query(
        `SELECT s.id AS stepId, s.sessionId, s.position, s.title, s.detail, s.status, st.approved, st.approvalKind
         FROM build_queue_steps s
         LEFT JOIN build_queue_state st ON st.sessionId = s.sessionId
         ORDER BY s.sessionId, s.position`,
      )
      .all() as {
      stepId: string;
      sessionId: string;
      position: number;
      title: string;
      detail: string;
      status: string;
      approved: number | null;
      approvalKind: string | null;
    }[];
    const map = new Map<string, BuildQueue>();
    for (const r of rows) {
      let q = map.get(r.sessionId);
      if (!q) {
        const kind = r.approvalKind as "auto" | "operator" | null;
        q = {
          sessionId: r.sessionId,
          steps: [],
          approved: !!r.approved,
          ...(kind ? { approvalKind: kind } : {}),
        };
        map.set(r.sessionId, q);
      }
      q.steps.push({
        id: r.stepId,
        title: r.title,
        detail: r.detail,
        status: r.status as BuildStepStatus,
        position: r.position,
      });
    }
    return [...map.values()];
  }

  // ── standalone repo-level PR reviews ─────────────────────────────────────
  getPrReview(repoPath: string, prNumber: number): PrReview | null {
    const r = this.db
      .query(
        `SELECT repoPath, prNumber, headSha, patchId, decision, reviewedPatchIds, updatedAt
         FROM pr_reviews WHERE repoPath = ? AND prNumber = ?`,
      )
      .get(repoPath, prNumber) as PrReviewRow | null;
    if (!r) return null;
    return {
      repoPath: r.repoPath,
      prNumber: r.prNumber,
      headSha: r.headSha,
      patchId: r.patchId ?? "",
      decision: (r.decision ?? "") as ReviewDecision | "",
      reviewedPatchIds: parseFindings(r.reviewedPatchIds),
      updatedAt: r.updatedAt,
    };
  }

  putPrReview(r: PrReview): void {
    this.db.run(
      `INSERT INTO pr_reviews (repoPath, prNumber, headSha, patchId, decision, reviewedPatchIds, updatedAt)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(repoPath, prNumber) DO UPDATE SET headSha=excluded.headSha,
         patchId=excluded.patchId, decision=excluded.decision,
         reviewedPatchIds=excluded.reviewedPatchIds, updatedAt=excluded.updatedAt`,
      [
        r.repoPath,
        r.prNumber,
        r.headSha,
        r.patchId ?? "",
        r.decision ?? "",
        JSON.stringify(r.reviewedPatchIds ?? []),
        r.updatedAt,
      ],
    );
  }

  /** Re-point an existing pr_review at a new head without changing the verdict. No-op when no row exists. */
  bumpPrReviewHead(repoPath: string, prNumber: number, headSha: string, now: number): void {
    this.db.run(
      `UPDATE pr_reviews SET headSha = ?, updatedAt = ? WHERE repoPath = ? AND prNumber = ?`,
      [headSha, now, repoPath, prNumber],
    );
  }

  private hydrate(r: SessionRow): Session {
    return {
      ...r,
      isolated: !!r.isolated,
      readyToMerge: !!r.readyToMerge,
      claudeSessionId: r.claudeSessionId ?? "",
      providerSessionId: strOrEmpty(r.providerSessionId),
      agentProvider: r.agentProvider === "codex" ? "codex" : "claude",
      autopilotEnabled: nullableBool(r.autopilotEnabled),
      autopilotStepCount: r.autopilotStepCount ?? 0,
      autopilotPaused: !!r.autopilotPaused,
      autopilotComplete: !!r.autopilotComplete,
      autopilotQuestion: r.autopilotQuestion ?? null,
      completionRepromptCount: r.completionRepromptCount ?? 0,
      planGateEnabled: nullableBool(r.planGateEnabled),
      planPhase: r.planPhase ?? null,
      autoMergeEnabled: nullableBool(r.autoMergeEnabled),
      autoMergeRebaseCount: r.autoMergeRebaseCount ?? 0,
      autoMergeRebaseHead: r.autoMergeRebaseHead ?? null,
      autoMergeRebaseSteeredAt: r.autoMergeRebaseSteeredAt,
      auto: !!r.auto,
      issueNumber: r.issueNumber ?? null,
      sandboxApplied: isSandboxProfile(r.sandboxApplied) ? r.sandboxApplied : null,
      sandboxDegraded: !!r.sandboxDegraded,
      egressApplied: !!r.egressApplied,
      egressDegraded: !!r.egressDegraded,
      research: !!r.research,
      epicAuthoring: !!r.epicAuthoring,
      landingRepair: !!r.landingRepair,
      mergingSince: r.mergingSince ?? null,
      mergingTrainId: r.mergingTrainId ?? null,
      mergeTrainPrs: parseMergeTrainPrsJson(r.mergeTrainPrs),
      mergingPrNumber: r.mergingPrNumber ?? null,
      haltReason: r.haltReason ?? null,
      haltedAt: r.haltedAt ?? null,
      manualSteps: parseManualStepsJson(r.manualStepsJson),
      manualStepsAckedAt: r.manualStepsAckedAt ?? null,
      archiveReason: parseArchiveReason(r.archiveReason),
      launchMetadata: parseLaunchMetadataJson(r.launchMetadataJson),
      experimentId: r.experimentId ?? null,
      experimentRole:
        r.experimentRole === "variant" || r.experimentRole === "comparison"
          ? (r.experimentRole as ExperimentRole)
          : null,
      spawnTerminalId: r.spawnTerminalId ?? null,
      spawnAccountDir: r.spawnAccountDir ?? null,
    } as Session;
  }

  // ── held tasks (usage-aware task holding) ──────────────────────────────────

  addHeldTask(row: {
    id: string;
    repoPath: string;
    input: CreateSessionInput;
    createdAt: number;
    reason: "usage" | "capacity";
  }): void {
    this.db.run(
      `INSERT INTO held_tasks (id, repoPath, input, createdAt, reason) VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.repoPath, JSON.stringify(row.input), row.createdAt, row.reason],
    );
  }

  listHeldTasks(): HeldTask[] {
    const rows = this.db
      .query(
        `SELECT id, repoPath, input, createdAt, reason FROM held_tasks ORDER BY (reason = 'capacity'), createdAt ASC`,
      )
      .all() as {
      id: string;
      repoPath: string;
      input: string;
      createdAt: number;
      reason: string;
    }[];
    return rows.map((r) => ({
      ...r,
      input: JSON.parse(r.input) as CreateSessionInput,
      reason: r.reason as "usage" | "capacity",
    }));
  }

  getHeldTask(id: string): HeldTask | null {
    const r = this.db
      .query(`SELECT id, repoPath, input, createdAt, reason FROM held_tasks WHERE id = ?`)
      .get(id) as {
      id: string;
      repoPath: string;
      input: string;
      createdAt: number;
      reason: string;
    } | null;
    if (!r) return null;
    return {
      ...r,
      input: JSON.parse(r.input) as CreateSessionInput,
      reason: r.reason as "usage" | "capacity",
    };
  }

  removeHeldTask(id: string): void {
    this.db.run(`DELETE FROM held_tasks WHERE id = ?`, [id]);
  }

  /** Replace a held task's stored input (e.g. an operator edited it while it stays
   *  held). repoPath mirrors input.repoPath so a repo change updates both columns. */
  updateHeldTask(id: string, input: CreateSessionInput): void {
    this.db.run(`UPDATE held_tasks SET repoPath = ?, input = ? WHERE id = ?`, [
      input.repoPath,
      JSON.stringify(input),
      id,
    ]);
  }

  countHeldTasks(): number {
    const row = this.db.query(`SELECT COUNT(*) AS n FROM held_tasks`).get() as { n: number };
    return row.n;
  }

  // ── session usage snapshots ──────────────────────────────────────────────────

  /** Persist (or overwrite) a per-session authoring spend snapshot. Idempotent:
   *  re-archiving the same sessionId overwrites, never duplicates. */
  upsertSessionUsage(snap: SessionUsageSnapshot): void {
    this.db.run(
      `INSERT INTO session_usage
         (sessionId, desig, name, claudeSessionId, repoPath, model, input, output, cacheRead, cacheWrite, total,
          weightedUnits, cacheReadUnits, messageCount, byModel, createdAt, archivedAt, snapshotAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET
         desig = excluded.desig,
         name = excluded.name,
         claudeSessionId = excluded.claudeSessionId,
         repoPath = excluded.repoPath,
         model = excluded.model,
         input = excluded.input,
         output = excluded.output,
         cacheRead = excluded.cacheRead,
         cacheWrite = excluded.cacheWrite,
         total = excluded.total,
         weightedUnits = excluded.weightedUnits,
         cacheReadUnits = excluded.cacheReadUnits,
         messageCount = excluded.messageCount,
         byModel = excluded.byModel,
         createdAt = excluded.createdAt,
         archivedAt = excluded.archivedAt,
         snapshotAt = excluded.snapshotAt`,
      [
        snap.sessionId,
        snap.desig,
        snap.name,
        snap.claudeSessionId ?? "",
        snap.repoPath,
        snap.model,
        snap.input,
        snap.output,
        snap.cacheRead,
        snap.cacheWrite,
        snap.total,
        snap.weightedUnits,
        snap.cacheReadUnits,
        snap.messageCount,
        JSON.stringify(snap.byModel),
        snap.createdAt,
        snap.archivedAt,
        snap.snapshotAt,
      ],
    );
  }

  /** All session usage snapshots, with byModel hydrated from JSON. */
  listSessionUsage(): SessionUsageSnapshot[] {
    const rows = this.db.query(`SELECT * FROM session_usage`).all() as SessionUsageRow[];
    return rows.map((row) => ({
      ...row,
      byModel: JSON.parse(row.byModel) as Record<string, number>,
    }));
  }

  /** One session's archive-time usage snapshot, or null when none was recorded
   *  (writer skips operational archetypes / empty transcripts; backfill can miss). */
  getSessionUsage(sessionId: string): SessionUsageSnapshot | null {
    const row = this.db
      .query(`SELECT * FROM session_usage WHERE sessionId = ?`)
      .get(sessionId) as SessionUsageRow | null;
    return row ? { ...row, byModel: JSON.parse(row.byModel) as Record<string, number> } : null;
  }

  // ── per-session usage buckets ────────────────────────────────────────────────

  /** Replace all bucket rows for sessionId atomically.
   *  DELETE existing + INSERT all new in one transaction — idempotent on re-archive.
   *  Requires the parent session_usage row to already exist (FK). */
  replaceSessionUsageBuckets(sessionId: string, buckets: SessionUsageBucket[]): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM session_usage_bucket WHERE sessionId = ?`, [sessionId]);
      for (const b of buckets) {
        this.db.run(
          `INSERT INTO session_usage_bucket
             (sessionId, bucketStart, input, output, cacheRead, cacheWrite, weightedUnits, cacheReadUnits, byModel)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            // bind the method's sessionId (which scoped the DELETE), not b.sessionId, so a
            // bucket row can never land under a different parent than the one being replaced.
            sessionId,
            b.bucketStart,
            b.input,
            b.output,
            b.cacheRead,
            b.cacheWrite,
            b.weightedUnits,
            b.cacheReadUnits,
            JSON.stringify(b.byModel),
          ],
        );
      }
    })();
  }

  /** Sum bucket rows per session for the given cutoff window.
   *  Selects rows WHERE bucketStart = 0 OR bucketStart >= floorHour(cutoff).
   *  Folds in JS (no SQL SUM) so float math matches archive-time folding. */
  sumSessionUsageBucketsSince(cutoff: number): Map<string, WindowedBucketSum> {
    const floorHour = cutoff - (cutoff % 3_600_000);
    type BucketRow = {
      sessionId: string;
      bucketStart: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      weightedUnits: number;
      cacheReadUnits: number;
      byModel: string;
    };
    const rows = this.db
      .query(
        `SELECT sessionId, bucketStart, input, output, cacheRead, cacheWrite,
                weightedUnits, cacheReadUnits, byModel
         FROM session_usage_bucket
         WHERE bucketStart = 0 OR bucketStart >= ?`,
      )
      .all(floorHour) as BucketRow[];

    const result = new Map<string, WindowedBucketSum>();
    for (const row of rows) {
      const existing = result.get(row.sessionId);
      const rowByModel = JSON.parse(row.byModel) as Record<string, number>;
      if (!existing) {
        result.set(row.sessionId, {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          weightedUnits: row.weightedUnits,
          cacheReadUnits: row.cacheReadUnits,
          byModel: { ...rowByModel },
        });
      } else {
        existing.input += row.input;
        existing.output += row.output;
        existing.cacheRead += row.cacheRead;
        existing.cacheWrite += row.cacheWrite;
        existing.weightedUnits += row.weightedUnits;
        existing.cacheReadUnits += row.cacheReadUnits;
        for (const [model, units] of Object.entries(rowByModel)) {
          existing.byModel[model] = (existing.byModel[model] ?? 0) + units;
        }
      }
    }
    return result;
  }

  /** Sum weighted units per hour across ALL sessions' persisted buckets, for the timeline.
   *  Selects rows WHERE bucketStart >= floorHour(cutoff) AND bucketStart != 0 (the timeless
   *  bucket has no placeable hour). cutoff===0 ⇒ all timestamped buckets. Returns a map keyed
   *  by bucketStart (ms-epoch hour) → Σ weightedUnits.
   *  Folds in JS (no SQL SUM) so float math matches archive-time folding, exactly as
   *  sumSessionUsageBucketsSince does. */
  sumUsageUnitsByHourSince(cutoff: number): Map<number, number> {
    const floorHour = cutoff - (cutoff % 3_600_000);
    const rows = this.db
      .query(
        `SELECT bucketStart, weightedUnits
         FROM session_usage_bucket
         WHERE bucketStart != 0 AND bucketStart >= ?`,
      )
      .all(floorHour) as { bucketStart: number; weightedUnits: number }[];
    const result = new Map<number, number>();
    for (const row of rows) {
      result.set(row.bucketStart, (result.get(row.bucketStart) ?? 0) + row.weightedUnits);
    }
    return result;
  }

  /** Distinct sessionIds that have at least one bucket row. */
  bucketedSessionIds(): Set<string> {
    const rows = this.db.query(`SELECT DISTINCT sessionId FROM session_usage_bucket`).all() as {
      sessionId: string;
    }[];
    return new Set(rows.map((r) => r.sessionId));
  }
}
