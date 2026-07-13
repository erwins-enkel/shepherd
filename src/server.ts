import type { RepoConfig, SessionStore } from "./store";
import type { PluginRegistry } from "./plugins/loader";
import type { PluginInfo } from "./plugins/types";
import type { SessionService } from "./service";
import { PREVIEW_SETUP_STEER, RestoreError } from "./service";
import { WorktreeMissingBaseError, WorktreeRestoreError } from "./worktree";
import { LearningsService } from "./learnings-service";
import { RepoConfigService } from "./repo-config-service";
import type { CreateSessionInput } from "./types";
import type { EventHub } from "./events";
import { PtyBridge } from "./pty-bridge";
import { SocketPtyBridge } from "./socket-pty-bridge";
import {
  config,
  DONE_LENS_WINDOW_MS,
  SESSION_RETENTION_DAYS,
  SESSION_RETENTION_KEEP,
  clampCap,
  PR_REVIEW_CYCLES_MIN,
  PR_REVIEW_CYCLES_MAX,
  PLAN_REVIEW_CYCLES_MIN,
  PLAN_REVIEW_CYCLES_MAX,
  USAGE_HISTORY_RETENTION_MS,
} from "./config";
import { normalizeTelemetryConsent } from "./telemetry-consent";
import { resolveAptabaseHost } from "./telemetry";
import {
  validateCreate,
  validateRelaunchOverrides,
  validateModelChoice,
  validateReplaceAgentChoice,
  validateCloneUrl,
  validateForkTarget,
  validateNewProject,
  isAuthorized,
  originAllowed,
  classifyOrigin,
  safeRepoDir,
  parseTermDims,
  validateSteers,
  validateBroadcast,
  validateRetry,
  validateIconPatch,
  validateBuildSteps,
  validateBuildStepStatus,
  validateEpicRunPatch,
  type EpicRunPatch,
  validateEgressExtraHosts,
  validateEpicDraftBody,
} from "./validate";
import {
  parseCookie,
  verifyCookie,
  signCookie,
  serializeCookie,
  clearCookie,
  shouldRestamp,
  isSecureRequest,
  verifyPassword,
  SESSION_COOKIE,
} from "./operator-auth";
import { resolvePlanAnswers, planAnswerSteerText, type RawAnswer } from "./plan-gate";
import { slugifyManual } from "./namer";
import {
  listRepos,
  reconcileRealPathsToRaw,
  readTodo,
  writeTodo,
  cloneRepo,
  createProject,
  listGithubOwners,
  listGithubRepos,
  forkRepo,
  type GhRunner,
  type GhOutRunner,
} from "./repos";
import { resolveDefaultBranch, fastForwardDefaultBranch } from "./pull";
import { analyzeReadiness } from "./readiness";
import { listCommands } from "./commands";
import { listDirs, validateRoot, collapseHome } from "./dirs";
import { scratchpadHasFiles } from "./tmp-sweep";
import {
  listScratchpad,
  resolveScratchpadFile,
  attachmentDisposition,
  resolveScratchpadUploadDir,
  placeScratchpadUpload,
} from "./scratchpad";
import { listWorktree, resolveWorktreeFile } from "./worktree-files";
import { loadSteers, saveSteers } from "./steers";
import { loadIcons, setIcon } from "./project-icons";
import { listBranches } from "./branches";
import { computeDiff, toSessionDiff } from "./diff";
import { buildDiffNotes } from "./diff-annotations";
import { resolveDiffBase } from "./diff-base";
import { sessionTokens, jsonlPathFor, type SessionUsageRollup } from "./usage";
import { buildUsageBreakdown } from "./usage-breakdown";
import { buildUsageTimeline } from "./usage-timeline";
import { isApiKeyMode } from "./spawn-auth";
import { detectDevCommand } from "./preview";
import {
  ensurePreviewStartScript,
  findPreviewDevPort,
  previewScriptExists,
  resolvePreviewStartScriptPath,
  startPreviewScript,
} from "./preview-launch";
import { sessionActivity } from "./activity";
import { firstRun } from "./first-run";
import { handleUpload, parseUploadFile, MAX_UPLOAD_BYTES } from "./uploads";
import type { UsageLimits, UsageLimitsService } from "./usage-limits";
import type { UpdateService } from "./update";
import type { HerdrUpdateService } from "./herdr-update";
import type { CodexUpdateService } from "./codex-update";
import type { PluginUpdateService } from "./plugin-update";
import type { RestartService } from "./restart";
import type { DiagnosticsService } from "./diagnostics";
import type { VerifyKeyResult } from "./verify-key";
import type { StarPromptStatus } from "./star-prompt";
import type {
  Session,
  AgentProvider,
  LearningStatus,
  SessionPreviewState,
  IssueRef,
  RelaunchOverrides,
  PlanGate,
} from "./types";
import type { HerdrDriver } from "./herdr";
import { matchAgent } from "./herdr";
import {
  terminalTransportMetrics,
  recordSocketAttach,
  recordFallback,
} from "./terminal-transport-metrics";
import type {
  GitForge,
  GitState,
  Issue,
  LinkedPr,
  MergeMethod,
  PrStatus,
  WorkflowRun,
} from "./forge/types";
import { DEPENDABOT_REBASE_COMMAND, EmptyDiffError } from "./forge/types";
import { buildIssueUrl } from "./forge";
import type { GithubRateLimitPayload } from "./forge/github-rate-limit";
import { BaseCheckoutBusyError, MergeConflictError } from "./forge/local";
import { recordEpicIntegrationIfChild, settleMergedSession } from "./merge-teardown";
import { type PrCache, gitStateChanged, guardStaleTerminal, trustsTerminal } from "./pr-poller";
import {
  readRepoRoles,
  writeRepoRoles,
  annotateHandoff,
  normalizeLogin,
  type RepoRoles,
} from "./repo-roles";
import type { PushService } from "./push";
import type { Presence } from "./presence";
import type { StatusPoller } from "./poller";
import type { SessionActivity } from "./activity-signal";
import type { DrainStatus, QueuedItem } from "./drain";
import { ACTIVE_LABEL } from "./drain-core";
import type { Epic, EpicRun, EpicSource } from "./epic-core";
import { computeEpicOthersFlags } from "./epic-core";
import type { EpicDiagnosis } from "./epic-diagnosis";
import { importEpicLinks, type ImportResult } from "./epic-import";
import { validateEpicDraft, materializeEpicDraft, forgeSupportsIssueCreation } from "./epic-author";
import {
  anyLiveRepairSession,
  buildRollup,
  computeLandingReady,
  enrichLandingEpics,
  type CompletedEpic,
} from "./completed-epic";
import { repoHasNoCiCached } from "./checks-gate";
import { parseEpicBody } from "./epic-parse";
import { countDefinedWorkflows, type CountsService, type RepoCounts } from "./backlog";
import type { OpenPrSnapshotService } from "./open-pr-snapshot";
import { join, normalize, basename } from "node:path";
import { homedir } from "node:os";
import type { ServerWebSocket } from "bun";
import { execFileSync, markPtyEvent } from "./instrument";
import { isOperatorKeystroke, stampOperatorKeystroke } from "./operator-activity";
import {
  normalizeDefaultModelSetting,
  normalizeFableAvailable,
  normalizeRepoDefaultModelSetting,
  drainSpawnModel,
  resolveDefaultModelSetting,
  normalizeRoleCli,
  normalizeRoleModelToken,
  clampCodexModelForAuth,
  modelCompatibleWithProvider,
  type CodexAuthMode,
} from "./default-model";
import { readCodexAuthMode } from "./codex-auth";
import {
  normalizeDefaultEffortSetting,
  normalizeRepoDefaultEffortSetting,
  drainSpawnEffort,
  resolveDefaultEffortSetting,
  effortBelowHigh,
} from "./default-effort";
import { startSerially } from "./up-next";
import { excludeHiddenSections } from "./up-next-core";
import type { UpNextSnapshot } from "./up-next-core";
import { normalizeAgentProvider } from "./agent-provider";
import { normalizeAuthModeSetting, writeApiKeyHelper, clearApiKeyHelper } from "./auth-mode";
import { normalizeOperatorLanguage } from "./operator-language";
import {
  type SandboxProfile,
  SANDBOX_PROFILES,
  isSandboxProfile,
  SandboxAutoRefused,
} from "./sandbox";
import { validateHookEvent, type HookEvent, type SubagentEntry } from "./hooks-ingest";
import { fingerprintDiffCount } from "./rundown-core";
import { quotaBlockReason, type BlockReason } from "./blocked";
import { upstreamStatus } from "./upstream-status";
import { shouldHold } from "./usage-hold";
import { PluginSpawnAborted } from "./plugins/types";
import { signedOff, type SignoffView } from "./signoff";
import { scanInstalled, installPlugin, uninstallPlugin } from "./plugins/manage";
import { randomUUID } from "node:crypto";

const UI_DIR = join(import.meta.dir, "..", "ui", "build");

async function serveStatic(pathname: string): Promise<Response> {
  // strip leading traversal, normalize
  const rel = normalize(pathname)
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/^\/+/, "");
  const target = rel === "" ? "index.html" : rel;
  const resolved = join(UI_DIR, target);
  // extra traversal guard: resolved path must stay within UI_DIR
  if (!resolved.startsWith(UI_DIR + "/") && resolved !== UI_DIR) {
    return new Response(Bun.file(join(UI_DIR, "index.html")), {
      headers: { "content-type": "text/html" },
    });
  }
  const file = Bun.file(resolved);
  const headers: Record<string, string> = {};
  if (target.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
  if (await file.exists()) return new Response(file, { headers });
  return new Response(Bun.file(join(UI_DIR, "index.html")), {
    headers: { "content-type": "text/html" },
  });
}

export interface AppDeps {
  store: SessionStore;
  service: SessionService;
  events: EventHub;
  /** Live Codex auth mode; optional for tests and read on demand in production. */
  readCodexAuthMode?: () => CodexAuthMode;
  /** Anonymous product telemetry (Aptabase). `event()` itself no-ops unless consent is
   *  granted (config.telemetryConsent === "granted") and DO_NOT_TRACK isn't set. Optional
   *  so the many test `makeDeps()` builders need no change; wired to the real
   *  TelemetryService in index.ts. */
  telemetry?: import("./telemetry").TelemetryService;
  /** Memo slots (#1092) for the learnings + repo-config deep modules. Optional so the
   *  many test `makeDeps()` builders need no change; routes never read these directly —
   *  they go through the total `learnings(deps)` / `repoConfig(deps)` accessors below,
   *  which lazily build-and-cache an instance from `store`(+`events`) on first use.
   *  `index.ts` injects explicit singletons so production shares one instance. */
  learnings?: LearningsService;
  repoConfig?: RepoConfigService;
  /** Server-side plugin registry (issue #1124); absent → `/api/plugins/*` 404s and the
   *  Settings → Plugins panel stays hidden (the zero-plugin invariant). */
  pluginRegistry?: PluginRegistry;
  /** Plugins dir on disk (`config.pluginsDir`), for the install/uninstall/scan management
   *  routes. Absent in tests that don't wire it → `/api/plugins/manage/*` falls through. */
  pluginsDir?: string;
  usageLimits: Pick<UsageLimitsService, "limits" | "projections">;
  /** Force a `/usage` re-scrape (calibration) and return fresh limits plus whether the probe
   *  actually returned a usable frame this run; absent in tests that don't wire the live
   *  calibrator (the route then falls back to the current snapshot, treated as scraped). */
  refreshUsage?: () => Promise<{ limits: UsageLimits; scraped: boolean }>;
  /** Incremental per-session rollup; absent in tests → breakdown falls back to re-parsing JSONL. */
  usageRollup?: SessionUsageRollup;
  /** Live GitHub REST + GraphQL rate-limit buckets (via `gh api rate_limit`, which is
   *  itself quota-exempt); absent in tests → `/api/usage/github` 503s. */
  githubRateLimit?: () => Promise<GithubRateLimitPayload>;
  /** Resolve the git forge for a repo dir; null when none is configured. */
  resolveForge?: (repoDir: string) => GitForge | null;
  /** Self-update tracker; absent in environments where it isn't wired. */
  updates?: Pick<UpdateService, "current" | "apply"> & Partial<Pick<UpdateService, "applyState">>;
  /** herdr-version tracker + applier; absent in environments where it isn't wired. */
  herdrUpdates?: Pick<HerdrUpdateService, "current" | "apply">;
  /** codex-version tracker + applier; absent in environments where it isn't wired. */
  codexUpdates?: Pick<CodexUpdateService, "current" | "apply">;
  /** installed-plugin update tracker: `current()` for the badge/status, `check()` for
   *  an on-demand re-scan, `apply()` to fetch-and-swap a plugin's new version on disk
   *  (issue #1124); absent when unwired. */
  pluginUpdates?: Pick<PluginUpdateService, "current" | "apply" | "check">;
  /** one-click shepherd restart (optionally with a herdr live-handoff first);
   *  absent in environments where it isn't wired (tests). */
  restart?: Pick<RestartService, "apply">;
  /** environment-readiness diagnostics (issue #623); absent in tests that don't wire it. */
  diagnostics?: Pick<DiagnosticsService, "current" | "check" | "fix">;
  /** GitHub-star nudge: tracks first-use + the operator's choice, stars the repo
   *  via gh. Absent in tests that don't exercise it. */
  starPrompt?: {
    status(): StarPromptStatus;
    dismiss(): StarPromptStatus;
    snooze(): StarPromptStatus;
    star(): Promise<StarPromptStatus>;
  };
  /** Herdr driver (for liveness checks). Absent in some tests; gate fails open. */
  herdr?: Pick<HerdrDriver, "list">;
  /** True when the herdr socket driver is active (flag on + protocol probe ok). Gates the socket terminal path; absent/false → node-pty. */
  herdrSocketActive?: boolean;
  /** In-memory PR-status cache surfaced in the list overview; absent in tests
   *  that don't exercise it. */
  prCache?: PrCache;
  /** Whether a name-matched terminal PR's head commit belongs to the session's
   *  branch — same guard the poller injects, so the on-demand git endpoint can't
   *  flip GitRail to a false MERGED on a reused-name collision. Absent → unguarded
   *  (tests). */
  ownsPr?: (s: Session, headSha: string) => boolean | null;
  /** Last-emitted activity signal per running session, for client bootstrap; absent in tests that skip it. */
  activity?: { snapshot(): Record<string, SessionActivity> };
  /** Last-swept claude-process liveness per session (does a `claude` process still
   *  live in the worktree?), for client bootstrap; updates flow via the
   *  `session:claude-alive` event. Absent in tests that skip it. */
  claudeAlive?: { snapshot(): Record<string, boolean> };
  /** Sessions herdr reports blocked whose TUI shows a live turn spinner
   *  (working-while-blocked display flag), for client bootstrap; updates flow via
   *  the `session:working-blocked` event. Absent in tests that skip it. */
  workingBlocked?: { snapshot(): Record<string, boolean> };
  /** Last-emitted block reason per session, for client bootstrap; updates flow via the
   *  `session:block` event. Lets a fresh page load / push-then-open surface a live block
   *  (incl. an MCP-auth `authUrl`) that was edge-emitted before the client connected. */
  blocks?: { snapshot(): Record<string, BlockReason> };
  /** Live preview port per session, for client bootstrap; absent until PreviewService is wired (Task 2+).
   *  `session:preview` events are emitted via PreviewService.onChange in index.ts. */
  preview?: {
    snapshot(): Record<string, SessionPreviewState>;
    ensure?(sessionId: string, devPort: number): number | null;
  };
  /** Local preview launcher. Defaults to `.git/shepherd/preview-start.sh` scripts;
   *  injectable so route tests never spawn real dev servers. */
  previewLauncher?: {
    findDevPort(worktreePath: string): Promise<number | null>;
    scriptExists(path: string | null | undefined): Promise<boolean>;
    scriptPath(worktreePath: string): Promise<string | null>;
    ensureScript(worktreePath: string, command: string): Promise<string | null>;
    startScript(scriptPath: string, worktreePath: string): Promise<void>;
  };
  /** Tailscale serve registration status per session slot; absent when auto-serve is
   *  disabled or tailscale is unavailable. Merged into /api/preview responses. */
  previewServe?: { snapshot(): Record<string, "ok" | "failed"> };
  /** Web Push delivery; absent in tests that don't exercise notifications. */
  push?: Pick<PushService, "publicKey" | "subscribe" | "unsubscribe">;
  /** Active-window tracker fed by /events presence frames; gates push suppression. */
  presence?: Pick<Presence, "set" | "drop" | "connect">;
  /** Status poller; used to manually dismiss a stall flag (`acknowledgeStall`) and, when
   *  `hooksSignals` is on, as the Phase-1 signal sink the index.ts onSignal closure feeds
   *  push events to (`ingestActivity` / `ingestNotification` — issue #704). The route
   *  itself never calls the ingest methods; the onSignal closure in index.ts does. */
  poller?: Pick<StatusPoller, "acknowledgeStall" | "ingestActivity" | "ingestNotification">;
  /** Phase-0 hook ingest ring buffer (issue #704); absent in tests/envs that skip it.
   *  `record` is observe-only here — it forwards to signals only when Task 3 wires
   *  `onSignal` (the `hooksSignals` flag). */
  hooks?: {
    record(id: string, ev: HookEvent): void;
    snapshot(id: string): HookEvent[];
    /** Every tracked session's sub-agent roster, keyed by sessionId (Phase 3, #710);
     *  served at `GET /api/subagents` for a global bootstrap, mirror of `activity`. */
    allSubagentsSnapshot(): Record<string, SubagentEntry[]>;
  };
  /** Snapshot of critic verdicts keyed by session id (+ in-flight run ids); absent in tests that skip it. */
  reviewCache?: {
    snapshot(): Record<string, import("./types").ReviewVerdict>;
    reviewing?(): string[];
  };
  /** Snapshot of plan-gate verdicts keyed by session id (+ in-flight reviewer ids); absent in
   *  tests that skip it. The parallel of reviewCache for the pre-execution plan gate. */
  planGateCache?: {
    snapshot(): Record<string, import("./types").PlanGate>;
    reviewing?(): string[];
  };
  /** Trigger an adversarial plan review for a session on demand (the /review-plan route).
   *  Wired to PlanGateService.consider in index.ts; absent in tests that don't exercise it. */
  planGate?: {
    consider: import("./plan-gate").PlanGateService["consider"];
    /** Reset the plan-gate round so the quota block clears, re-delivering findings to the agent.
     *  Async since #1567 — resolves true when the re-delivered steer reached the live pane. */
    resume?(session: Session): Promise<boolean>;
    /** Reset the plan-gate round WITHOUT re-delivering findings (dismiss the quota block). */
    dismiss?(session: Session): void;
  };
  /** Operator-initiated critic review (the POST /review-pr route). Wired to
   *  ReviewService.forceReview in index.ts; absent in tests that don't exercise it. */
  reviewTrigger?: {
    force(session: Session, git: GitState): Promise<import("./review").ReviewOutcome>;
    /** Reset escalation counters WITHOUT re-triggering a review (dismiss the quota block). */
    clearStallState?(session: Session): void;
  };
  /** Snapshot of session recaps keyed by session id; absent in tests that skip it. */
  recapCache?: { snapshot(): Record<string, import("./types").Recap> };
  /** Force-regenerate a session recap on demand (the /recap/regenerate route). */
  recap?: { regenerate(session: Session): Promise<"started" | "empty" | "error"> };
  /** Live hold-reason snapshot keyed by session id; absent in tests that skip it. */
  holds?: { snapshot(): Record<string, import("./types").HoldReason> };
  /** Herd Rundown digest — the daily cross-session attention synthesis. Absent in tests
   *  that don't exercise it. `snapshot` is the latest stored digest (null when none yet);
   *  `currentFingerprint` re-derives the herd's live attention surface so the GET route can
   *  compute `staleCount` (drift since the digest was generated); `regenerate` forces a
   *  fresh spawn. */
  herdDigest?: {
    snapshot(): import("./types").HerdDigest | null;
    currentFingerprint(): Record<string, string[]>;
    regenerate(): Promise<"started" | "in-flight" | "empty" | "error">;
  };
  /** Up Next (#1169) cross-repo ranked queue of un-started work. `snapshot` is the cached
   *  in-memory snapshot (null until the first compute); `refresh` forces a single-flight
   *  recompute. Absent in tests/environments that don't wire it. */
  upNext?: {
    snapshot(): UpNextSnapshot | null;
    refresh(): Promise<UpNextSnapshot>;
    /** Recompute (guaranteed-fresh, verify-and-retry) until the just-started items drop from
     *  the lens — i.e. their `shepherd:active` claim labels have landed. Backgrounded by the
     *  caller so it never blocks the start response. */
    recomputeUntilCleared(
      started: readonly { repoPath: string; issueNumber: number }[],
    ): Promise<void>;
    /** Raw-path-space hidden set (reconciled), applied at read time for instant freshness. */
    hiddenRepoPathsRaw(): Set<string>;
  };
  /** Verify the configured api-key authenticates end-to-end (the /settings/verify-key route);
   *  absent in environments where it isn't wired. Returns only {ok,reason?,detail?} — no key/path. */
  verifyKey?: () => Promise<VerifyKeyResult>;
  /** Backlog counts service; absent in tests that don't exercise it. */
  backlog?: Pick<CountsService, "counts">;
  /** Shared per-repo open-PR snapshot cache (read by the PRs tab; warmed by the pr-poller).
   *  `invalidate` is evicted after an interactive merge so the panel's refetch misses the
   *  stale snapshot. It is optional so `get`-only test stubs keep compiling.
   *  Absent in tests that don't exercise it — the PRs route then fetches fresh. */
  openPrSnapshot?: Pick<OpenPrSnapshotService, "get"> &
    Partial<Pick<OpenPrSnapshotService, "invalidate">>;
  /** Force-refresh one repo's backlog counts (bypassing the read-TTL) and push the
   *  rebuilt overview to every client. Fired after a mutation that changes a repo's
   *  open issue/PR counts (e.g. a merge) so the counters + headline drop the item
   *  immediately instead of lingering until the next warm poll. Absent in tests. */
  refreshBacklog?: (repoDir: string) => Promise<void>;
  /** Learning distiller — manual trigger for the proposal pass over a repo's transcripts.
   *  Optional so environments/tests that don't wire it still type-check; the route
   *  no-ops the trigger when absent. Wired to the real DistillerService in index.ts. */
  distiller?: {
    distillNow: (repoPath: string) => Promise<void>;
    health?: () => {
      ok: boolean;
      consecutiveFailures: number;
      lastFailure: { reason: string; at: number; repoPath: string } | null;
    };
  };
  /** Learning optimizer — operator-triggered LLM rewrite pass over flagged ("not working")
   *  rules. Optional so tests that don't wire it still type-check; routes no-op when absent.
   *  Wired to the real OptimizerService in index.ts. */
  optimizer?: {
    optimizeOne: (id: string) => Promise<void>;
    optimizeAllFlagged: (repoPath: string) => Promise<void>;
    health?: () => {
      ok: boolean;
      consecutiveFailures: number;
      lastFailure: { reason: string; at: number; repoPath: string } | null;
    };
  };
  /** Background merge-suggestion pass — manual per-repo trigger ("Suggest merges now").
   *  Optional so tests that don't wire it still type-check; route no-ops when absent. */
  mergeSuggest?: {
    /** Async (MergeSuggestService.mergeNow); the trigger route fires it and forgets. */
    mergeNow: (repoPath: string) => Promise<void>;
  };
  /** Promote a curated rule into the repo's CLAUDE.md via an auto-opened PR, or a cross-repo
   *  recurrence rule into the user-global ~/.claude/CLAUDE.md directly (#872). */
  promoter?: {
    promote: (id: string) => Promise<import("./promote").PromoteResult>;
    promoteGlobal: (rule: string) => Promise<import("./promote").PromoteResult>;
  };
  /** PR-gated AI doc agent (issue #882). Optional + flag-gated (config.docAgentEnabled); the route
   *  404s when the flag is off or the service is unwired. Wired to DocAgentService in index.ts. */
  docAgent?: {
    consider: (repoPath: string) => Promise<import("./doc-agent").DocAgentResult>;
    isRunning: (repoPath: string) => boolean;
  };
  /** Open a PR adding Shepherd's managed `.shepherd-*` ignore block to a repo's `.gitignore`. */
  gitignoreAdopter?: {
    adopt: (repoPath: string) => Promise<import("./gitignore-adopt").AdoptResult>;
  };
  /** Self-draining work queue snapshot; absent in tests that don't exercise it. */
  drain?: {
    snapshot(): Promise<DrainStatus[]>;
    queue(repoPath: string): Promise<QueuedItem[]>;
    /** One-shot: keep ACTIVE_LABEL on the next `session:archived` for this id (a
     *  relaunch is not a retire — the actively-worked issue stays claimed). */
    retainClaim(id: string): void;
    /** Assemble the live Epic for a repo's running epic (server routes + pump). */
    buildEpic(repoPath: string, run: EpicRun): Promise<Epic | null>;
    /** On-demand structural diagnosis for one epic parent (GET /api/epic/diagnose). */
    diagnoseEpic(repoPath: string, run: EpicRun): Promise<EpicDiagnosis | null>;
    /** Operator approves the next epic-attended spawn for the given repo. */
    approveEpicNext(repoPath: string): void;
    /** Drive one pump cycle across all drain-enabled repos. */
    tick(): Promise<void>;
  };
  /** Full-auto merge train snapshot; absent in tests that don't exercise it. */
  autoMerge?: { snapshot(): Promise<import("./automerge").AutoMergeStatus[]> };
  /** Injectable `gh` CLI runner for the POST /api/projects remote step. Absent in
   *  production (createProject falls back to the real `gh` runner); tests inject a
   *  fake so the route's partial-success mapping can be exercised WITHOUT creating
   *  real GitHub repos. */
  newProjectGhRunner?: GhRunner;
  /** Injectable stdout `gh` runner for GET /api/github/owners. Absent in production
   *  (listGithubOwners falls back to the real `gh` runner); tests inject a fake so the
   *  owner-enumeration route can be exercised without hitting GitHub. */
  githubOwnersRunner?: GhOutRunner;
  /** Injectable stdout `gh` runner for GET /api/github/repos. Absent in production
   *  (listGithubRepos falls back to the real `gh` runner); tests inject a fake so the
   *  repo-enumeration route can be exercised without hitting GitHub. */
  githubReposRunner?: GhOutRunner;
  /** Analyze a session's recent terminal history via a transient second agent and return a
   *  recommended next prompt (the task-id menu's "Promptempfehlung"). Wired to
   *  recommendPrompt in index.ts; absent in tests that don't exercise it → route 503s. */
  recommend?: (
    id: string,
    provider: AgentProvider,
    model: string,
  ) => Promise<import("./prompt-recommend").RecommendResult>;
}

const sessionUsage = (s: Session) =>
  s.claudeSessionId
    ? sessionTokens(jsonlPathFor(s.worktreePath, s.claudeSessionId))
    : sessionTokens("/nonexistent"); // pre-feature session → zeroed usage

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 409 while the first-run gate is pending — nothing may spawn or scaffold until a repo root
 *  is picked. Returns null (proceed) once resolved. */
function firstRunBlock(): Response | null {
  return firstRun.pending ? json({ error: "first_run_pending" }, 409) : null;
}

/**
 * Total accessors (#1092) for the learnings / repo-config deep modules. They lazily
 * build-and-memoize an instance onto the `deps` object from the always-present
 * `store`(+`events`), so a handler reached via ANY dispatch entry point (both
 * `makeApp.fetch` and `serve().fetch`) always gets a defined instance — no `deps.x!`
 * non-null assertion, no makeApp-only fallback to drift. `index.ts` injects explicit
 * singletons, so in production these return that shared instance.
 */
function learnings(deps: AppDeps): LearningsService {
  return (deps.learnings ??= new LearningsService(deps.store, deps.events));
}
function repoConfigSvc(deps: AppDeps): RepoConfigService {
  return (deps.repoConfig ??= new RepoConfigService(deps.store));
}

/**
 * Requests that pass the gate UN-credentialed (issue #1079). Scoped deliberately tight:
 *  - `POST /api/login` — the only unauthenticated mutation (it's how you GET a cookie);
 *  - static-shell GET/HEAD — the SPA bundle must load so the login view can render. This is
 *    NOT a blanket "any non-/api GET": `/events` and `/pty/:id` are GET WebSocket upgrades that
 *    MUST stay gated (they're the live-PTY hole this feature closes), so they're excluded here.
 */
function isPublicRequest(req: Request): boolean {
  const path = new URL(req.url).pathname;
  if (req.method === "POST" && path === "/api/login") return true;
  if (req.method === "GET" || req.method === "HEAD") {
    // Public liveness (handleHealth): an un-credentialed probe deploy/update.sh + the
    // onboarding harness can hit BEFORE login. Exempt it ahead of the /api reject below.
    if (path === "/api/health") return true;
    if (path.startsWith("/api")) return false;
    if (path === "/events" || path.startsWith("/pty/")) return false;
    return true; // static SPA shell
  }
  return false;
}

/**
 * The single auth seam (issue #1079). Pass when the request is public (above), carries a valid
 * signed session cookie (humans), or carries a valid operator bearer token (CLI/curl — when the
 * operator set `config.token`). Spawned agents do NOT pass here — they reach the server via the
 * loopback ingress listener, which builds its app with `skipAuth` (see makeAgentIngressApp).
 * Called by BOTH makeApp.fetch and serve().fetch, so HTTP routes and the WS upgrades inherit the
 * gate from this one function.
 *
 * Fail-closed in production: the boot bootstrap (bootstrapAuth, src/index.ts) ALWAYS provisions a
 * cookie-signing secret + password hash before the server serves, so a deployed instance is always
 * gated. When NO auth is configured at all (no cookie secret AND no token — only ever the case in
 * an un-bootstrapped unit-test app) the gate is open, mirroring the prior `config.token === null`
 * contract the test suite relies on.
 */
function checkAuth(req: Request): Response | null {
  if (config.cookieSecret === null && config.token === null) return null; // un-bootstrapped (tests)
  if (isPublicRequest(req)) return null;
  if (
    config.cookieSecret &&
    verifyCookie(config.cookieSecret, parseCookie(req.headers.get("cookie"))).ok
  ) {
    return null;
  }
  if (config.token !== null && isAuthorized(req.headers.get("Authorization"), config.token)) {
    return null;
  }
  return json({ error: "unauthorized" }, 401);
}

/**
 * Sliding-window re-stamp (issue #1079). When a cookie-authed request is past its half-life and
 * the response is a success, attach a fresh `Set-Cookie` so an active operator effectively never
 * re-logs-in. Attached at exactly ONE seam — the makeApp wrapper — so it can't double-apply; WS
 * upgrades return before this seam, so they never carry a cookie. Re-verifying here is a cheap
 * HMAC. Token-authed (no cookie) requests and failures are left untouched.
 *
 * CRITICAL: never re-stamp a response that ALREADY sets the session cookie. The handler owns the
 * cookie in those cases — `POST /api/logout` clears it (Max-Age=0) and `POST /api/login` mints a
 * fresh one — and the incoming request still carries the OLD cookie. Appending a second, valid
 * `Set-Cookie` would re-authenticate the operator on logout (stateless: no server-side revocation),
 * silently defeating it; on login it would just duplicate. So the handler's own cookie always wins.
 */
function responseSetsSessionCookie(res: Response): boolean {
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  return cookies.some((c) => c.includes(`${SESSION_COOKIE}=`));
}

function maybeRestamp(req: Request, res: Response): Response {
  if (res.status >= 400) return res;
  if (responseSetsSessionCookie(res)) return res; // handler owns the cookie (login/logout)
  const secret = config.cookieSecret;
  if (!secret) return res;
  const v = verifyCookie(secret, parseCookie(req.headers.get("cookie")));
  if (!v.ok || !shouldRestamp(v.iat)) return res;
  const headers = new Headers(res.headers);
  headers.append(
    "Set-Cookie",
    serializeCookie(signCookie(secret), { secure: isSecureRequest(req) }),
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function checkOrigin(req: Request): Response | null {
  const method = req.method;
  if (method !== "POST" && method !== "DELETE" && method !== "PUT") return null;
  const previewRange = { base: config.previewPortBase, count: config.previewPortCount };
  const verdict = classifyOrigin(
    req.headers.get("Origin"),
    config.allowedOriginHosts,
    previewRange,
  );
  // Distinct bodies so the client can show accurate copy (issue #1645 Fix 3): a preview-port
  // origin genuinely IS read-only; an un-allowlisted host should be pointed at
  // SHEPHERD_ALLOWED_HOSTS, not told to "open Shepherd directly" (it already is).
  if (verdict === "preview-port") return json({ error: "forbidden: origin not allowed" }, 403);
  if (verdict === "host-not-allowed")
    return json({ error: "forbidden: origin host not allowed" }, 403);
  return null;
}

// Shared `Content-Type: application/json` guard. Returns the 415 Response when
// the header is absent/wrong, or null to proceed — same message everywhere.
function requireJsonContentType(req: Request): Response | null {
  if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return json({ error: "Content-Type must be application/json" }, 415);
  }
  return null;
}

// ── per-resource route handlers ────────────────────────────────────────────
// Each handler matches its own resource group and returns a Response when it
// owns the request, or `null` to fall through to the next handler — mirroring
// the original sequential `if`-guard chain exactly. Ordering is significant:
// some groups share a `parts[1]` prefix (e.g. `sessions`), and a handler must
// return `null` (not a 404) for sub-routes it doesn't own so a later handler
// can claim them.

type Ctx = { req: Request; parts: string[]; url: URL; deps: AppDeps };

// ── single-operator auth routes (issue #1079) ──────────────────────────────
// login is the only unauthenticated mutation (isPublicRequest); logout + me sit behind the gate.

async function handleLogin({ req, parts }: Ctx): Promise<Response | null> {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "login" || parts[2]) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const password =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { password?: unknown }).password === "string"
      ? (body as { password: string }).password
      : "";
  const hash = config.passwordHash;
  if (!hash || !config.cookieSecret || !(await verifyPassword(password, hash))) {
    return json({ error: "invalid password" }, 401);
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.append(
    "Set-Cookie",
    serializeCookie(signCookie(config.cookieSecret), { secure: isSecureRequest(req) }),
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function handleLogout({ req, parts }: Ctx): Response | null {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "logout" || parts[2]) return null;
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", clearCookie({ secure: isSecureRequest(req) }));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function handleMe({ req, parts }: Ctx): Response | null {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "me" || parts[2]) return null;
  // Only reachable when checkAuth already passed — an unauthed /api/me 401s at the gate.
  return json({ authenticated: true });
}

function handleGitSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "git" && !parts[2]) {
    return json(deps.prCache?.snapshot() ?? {});
  }
  return null;
}

function handleActivitySnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "activity" && !parts[2]) {
    return json(deps.activity?.snapshot() ?? {});
  }
  return null;
}

function handleClaudeAliveSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "claude-alive" && !parts[2]) {
    return json(deps.claudeAlive?.snapshot() ?? {});
  }
  return null;
}

function handleWorkingBlockedSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "working-blocked" && !parts[2]) {
    return json(deps.workingBlocked?.snapshot() ?? {});
  }
  return null;
}

function handleBlocksSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "blocks" && !parts[2]) {
    return json(deps.blocks?.snapshot() ?? {});
  }
  return null;
}

function handleHoldsSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "holds" && !parts[2]) {
    return json(deps.holds?.snapshot() ?? {});
  }
  return null;
}

function handleSubagentsSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "subagents" && !parts[2]) {
    return json(deps.hooks?.allSubagentsSnapshot() ?? {});
  }
  return null;
}

function handleQueuesSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "queues" && !parts[2]) {
    const queues = deps.store.listBuildQueues();
    const map: Record<string, (typeof queues)[number]> = {};
    for (const q of queues) map[q.sessionId] = q;
    return json(map);
  }
  return null;
}

function handlePreviewSnapshot({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "preview" && !parts[2]) {
    const preview = deps.preview?.snapshot() ?? {};
    const serve = deps.previewServe?.snapshot() ?? {};
    const merged: Record<string, SessionPreviewState> = {};
    for (const [id, st] of Object.entries(preview)) {
      merged[id] = serve[id] ? { ...st, serve: serve[id] } : st;
    }
    return json(merged);
  }
  return null;
}

function handleReviews({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "reviews") {
    if (!parts[2]) return json(deps.reviewCache?.snapshot() ?? {});
    // in-flight run ids so a client loading mid-review still shows the indicator
    if (parts[2] === "inflight") return json(deps.reviewCache?.reviewing?.() ?? []);
  }
  return null;
}

// GET /api/plan-gates[/inflight] — the pre-execution plan gate's bootstrap snapshot,
// the parallel of /api/reviews. `/plan-gates` → verdicts keyed by session id;
// `/plan-gates/inflight` → session ids whose plan reviewer is mid-flight.
function handlePlanGates({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "plan-gates") {
    if (!parts[2]) return json(deps.planGateCache?.snapshot() ?? {});
    if (parts[2] === "inflight") return json(deps.planGateCache?.reviewing?.() ?? []);
  }
  return null;
}

// GET /api/recaps — bootstrap snapshot of session recaps keyed by session id.
// Mirrors handleReviews / handlePlanGates; absent dep returns {}.
function handleRecaps({ req, parts, deps }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "recaps") {
    if (!parts[2]) return json(deps.recapCache?.snapshot() ?? {});
  }
  return null;
}

// Manual operator steps — durable post-merge materialization (#1061, epic #1056 P3).
//   GET  /api/manual-steps/outstanding                     → records still owing steps (Owed lens)
//   POST /api/manual-steps/:sessionId/steps/:stepId {done} → tick / un-tick one step
//   POST /api/manual-steps/:sessionId/dismiss              → clear the whole record
// Mutations emit `post-merge-steps:changed` so every client's Owed lens refreshes.
async function manualStepDone(
  req: Request,
  deps: Ctx["deps"],
  sessionId: string,
  stepId: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { done?: unknown } | null;
  if (!body || typeof body.done !== "boolean")
    return json({ error: "body.done must be a boolean" }, 400);
  const updated = deps.store.setPostMergeStepDone(sessionId, stepId, body.done);
  if (!updated) return json({ error: "post-merge steps not found" }, 404);
  deps.events?.emit("post-merge-steps:changed", {});
  return json(updated);
}

function manualStepsDismiss(deps: Ctx["deps"], sessionId: string): Response {
  const updated = deps.store.dismissPostMergeSteps(sessionId);
  if (!updated) return json({ error: "post-merge steps not found" }, 404);
  deps.events?.emit("post-merge-steps:changed", {});
  return json(updated);
}

async function handleManualSteps({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "manual-steps")) return null;
  if (req.method === "GET" && parts[2] === "outstanding" && !parts[3])
    return json(deps.store.listOutstandingPostMergeSteps());

  const sessionId = parts[2];
  if (!sessionId || req.method !== "POST") return null;
  if (parts[3] === "steps" && parts[4] && !parts[5])
    return manualStepDone(req, deps, sessionId, parts[4]);
  if (parts[3] === "dismiss" && !parts[4]) return manualStepsDismiss(deps, sessionId);
  return null;
}

// GET /api/herd/digest — the latest Herd Rundown digest, with a route-computed `staleCount`
// (how many attention-bearing sessions' signal sets changed since it was generated). null when
// no digest exists yet (mirrors the recap empty pattern). staleCount is cheap: it re-derives the
// CURRENT fingerprint from the in-memory caches (pure classification, no spawn) and diffs it
// against the stored one.
// POST /api/herd/digest/regenerate — force a fresh daily digest; 202 with {status}.
async function handleHerdDigest({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "herd" && parts[2] === "digest")) return null;

  if (req.method === "POST" && parts[3] === "regenerate") {
    const status = (await deps.herdDigest?.regenerate()) ?? "error";
    return json({ ok: true, status }, 202);
  }

  if (req.method === "GET" && !parts[3]) {
    const digest = deps.herdDigest?.snapshot() ?? null;
    if (!digest) return json(null);
    const current = deps.herdDigest?.currentFingerprint() ?? {};
    const staleCount = fingerprintDiffCount(digest.attentionFingerprint, current);
    return json({ ...digest, staleCount });
  }

  return null;
}

// GET  /api/up-next          — cached Up Next snapshot; kicks a single-flight recompute so an
//                              open lens updates in place (paint cached, then refresh).
// POST /api/up-next/refresh  — force a recompute (the manual refresh button); 202.
// POST /api/up-next/start    — start one or many items; spawns are SERIALIZED server-side
//                              because WorktreeMgr.create() (sync `git worktree add`) is not
//                              parallel-safe per repo.
/** GET /api/up-next — paint the cached snapshot. The default (lens-open) path also kicks a
 *  single-flight recompute that lands in place via WS; `?peek` (app-load) paints cached only so
 *  a session that never opens the lens costs zero cross-repo `gh` fan-out (the 15-min loop +
 *  lens-open keep it fresh). */
function handleUpNextGet(url: URL, deps: AppDeps): Response {
  const cached = deps.upNext?.snapshot() ?? null;
  // Apply a read-time hidden filter so a repo hidden after the last background compute is
  // excluded on the very next GET without waiting for the next recompute cycle (≤15 min).
  const snap =
    cached && deps.upNext
      ? excludeHiddenSections(cached, deps.upNext.hiddenRepoPathsRaw())
      : cached;
  if (!url.searchParams.has("peek") && deps.upNext)
    void deps.upNext.refresh().catch((err) => console.warn("[up-next] open:", err));
  return json(snap);
}

async function handleUpNext(ctx: Ctx): Promise<Response | null> {
  const { req, parts, url, deps } = ctx;
  if (!(parts[0] === "api" && parts[1] === "up-next")) return null;

  if (req.method === "GET" && !parts[2]) return handleUpNextGet(url, deps);

  if (req.method === "POST" && parts[2] === "refresh") {
    if (!deps.upNext) return json({ error: "up-next unavailable" }, 503);
    void deps.upNext.refresh().catch((err) => console.warn("[up-next] manual refresh:", err));
    return json({ ok: true }, 202);
  }

  if (req.method === "POST" && parts[2] === "start") {
    const ctErr = requireJsonContentType(req);
    if (ctErr) return ctErr;
    return handleUpNextStart(req, deps);
  }
  return null;
}

interface UpNextStartItem {
  dir: string;
  issueRef: { number: number; url: string; title: string; body: string };
}

interface UpNextStartChoice {
  agentProvider: AgentProvider;
  model?: string | null;
  effort?: string | null;
}

interface UpNextStartPayload {
  items: UpNextStartItem[];
  choice: UpNextStartChoice | null;
}

/** Cap on how long the backgrounded post-start recompute waits for the claim label writes
 *  to settle before recomputing anyway — a hung `gh` must not stall it (verify-and-retry and
 *  the 15-min interval loop still backstop). */
const CLAIM_SETTLE_TIMEOUT_MS = 8_000;

function parseUpNextStartItem(raw: unknown): UpNextStartItem | null {
  const it = raw as { repoPath?: unknown; issueRef?: Record<string, unknown> };
  const dir = safeRepoDir(typeof it?.repoPath === "string" ? it.repoPath : "", config.repoRoot);
  const ir = it?.issueRef;
  if (
    !dir ||
    !ir ||
    typeof ir.number !== "number" ||
    typeof ir.url !== "string" ||
    typeof ir.title !== "string"
  )
    return null;
  return {
    dir,
    issueRef: {
      number: ir.number,
      url: ir.url,
      title: ir.title,
      body: typeof ir.body === "string" ? ir.body : "",
    },
  };
}

function parseUpNextStartChoice(obj: Record<string, unknown>): UpNextStartChoice | Response | null {
  const hasChoice = "agentProvider" in obj || "model" in obj || "effort" in obj;
  if (!hasChoice) return null;

  const choice = validateModelChoice(obj);
  if (!choice.ok) return json({ error: choice.error }, 400);
  if (!choice.value.agentProvider)
    return json({ error: "agentProvider required when model or effort is supplied" }, 400);
  const parsed: UpNextStartChoice = { agentProvider: choice.value.agentProvider };
  if ("model" in obj) parsed.model = choice.value.model;
  if ("effort" in obj) parsed.effort = choice.value.effort;
  return parsed;
}

/** Validate the POST /api/up-next/start body into safe, repo-scoped start items + optional
 * provider/model/effort choice. */
function parseUpNextStartPayload(body: unknown): UpNextStartPayload | Response {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ error: "items required" }, 400);
  const itemsRaw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0)
    return json({ error: "items required" }, 400);
  const items = itemsRaw.map(parseUpNextStartItem);
  if (items.some((it) => it === null)) return json({ error: "items required" }, 400);
  const choice = parseUpNextStartChoice(body as Record<string, unknown>);
  if (choice instanceof Response) return choice;
  return {
    items: items as UpNextStartItem[],
    choice,
  };
}

function usageHoldApplies(value: CreateSessionInput, deps: AppDeps): boolean {
  const provider = normalizeAgentProvider(value.agentProvider ?? config.defaultAgentProvider);
  if (provider !== "claude") return false;
  const lim = deps.usageLimits.limits(Date.now());
  return shouldHold({
    enabled: config.usageHoldEnabled,
    holdPct: config.usageHoldPct,
    session5hPct: lim.session5h?.pct ?? 0,
    weekPct: lim.week?.pct ?? 0,
    force: false,
  });
}

function findHeldIssue(deps: AppDeps, repoPath: string, issueNumber: number) {
  return deps.store
    .listHeldTasks()
    .find((h) => h.repoPath === repoPath && h.input.issueRef?.number === issueNumber);
}

function holdUpNextIssue(
  deps: AppDeps,
  input: CreateSessionInput,
): { id: string; repoPath: string; number: number; reused?: boolean } {
  const number = input.issueRef?.number;
  if (number == null) throw new Error("held Up Next item missing issueRef");
  const existing = findHeldIssue(deps, input.repoPath, number);
  if (existing) return { id: existing.id, repoPath: input.repoPath, number, reused: true };
  const id = randomUUID();
  deps.store.addHeldTask({
    id,
    repoPath: input.repoPath,
    input,
    createdAt: Date.now(),
    reason: "usage",
  });
  deps.events.emit("held:changed", { count: deps.store.countHeldTasks() });
  return { id, repoPath: input.repoPath, number };
}

async function handleUpNextStart(req: Request, deps: AppDeps): Promise<Response> {
  const b = firstRunBlock();
  if (b) return b;
  const payload = parseUpNextStartPayload(await req.json().catch(() => null));
  if (payload instanceof Response) return payload;
  const { items, choice } = payload;

  const created: Session[] = [];
  const held: { id: string; repoPath: string; number: number; reused?: boolean }[] = [];
  const errors: { number: number; error: string }[] = [];
  const claims: Promise<void>[] = [];
  const startedRefs: { repoPath: string; issueNumber: number }[] = [];
  // Strictly serial — concurrent `git worktree add` on the same repo would contend.
  await startSerially(items, async (it) => {
    const forge = deps.resolveForge?.(it.dir) ?? null;
    if (!forge) {
      errors.push({ number: it.issueRef.number, error: "no forge for repo" });
      return;
    }
    try {
      // Base + prompt = the drain auto-prompt for a plain issue (issue title on the default
      // branch). Manual epic-child starts also base on default here; integration-branch
      // orchestration stays the auto epic-runner's job (documented v1 scoping, #1169).
      const base = await forge.defaultBranch();
      const rc = deps.store.getRepoConfig(it.dir);
      const input: CreateSessionInput = {
        repoPath: it.dir,
        baseBranch: base,
        prompt: it.issueRef.title,
        // Operator default model (repo override wins; "auto"/"inherit" → no --model flag).
        // The Fable promo is client-only and never applied here, matching drain spawns.
        agentProvider: choice?.agentProvider,
        model:
          choice && "model" in choice
            ? (choice.model ?? null)
            : drainSpawnModel(resolveDefaultModelSetting(rc.defaultModel, config.defaultModel)),
        effort:
          choice && "effort" in choice
            ? choice.effort
            : drainSpawnEffort(resolveDefaultEffortSetting(rc.defaultEffort, config.defaultEffort)),
        images: [],
        auto: false,
        issueRef: it.issueRef,
      };
      if (usageHoldApplies(input, deps)) {
        held.push(holdUpNextIssue(deps, input));
        claims.push(claimLinkedIssue(forge, it.issueRef.number));
        startedRefs.push({ repoPath: it.dir, issueNumber: it.issueRef.number });
        return;
      }
      const s = await deps.service.create(input);
      created.push(s);
      deps.events.emit("session:new", s);
      // Stamp the drain claim so the board reflects it's being worked (mirrors New Task).
      // Keep the handle so the post-start recompute can wait for the label write to land
      // before re-reading issues — an immediate refresh re-surfaces the just-started item.
      claims.push(claimLinkedIssue(forge, it.issueRef.number));
      startedRefs.push({ repoPath: it.dir, issueNumber: it.issueRef.number });
    } catch (e) {
      errors.push({
        number: it.issueRef.number,
        error: e instanceof Error ? e.message : "create failed",
      });
    }
  });

  // Drop the just-started items from the lens promptly. Backgrounded (never blocks this
  // response, which already paid for the serial worktree creates): wait for the claim label
  // writes to return — behind a timeout guard so a hung `gh` can't stall it — then
  // verify-and-retry recompute until the items clear (handles read-after-write lag).
  if (deps.upNext && startedRefs.length > 0) {
    const up = deps.upNext;
    void (async () => {
      await Promise.race([
        Promise.allSettled(claims),
        new Promise<void>((r) => setTimeout(r, CLAIM_SETTLE_TIMEOUT_MS).unref?.()),
      ]);
      await up.recomputeUntilCleared(startedRefs);
    })().catch((err) => console.warn("[up-next] post-start:", err));
  }
  return json({ created, held, errors }, created.length > 0 ? 201 : held.length > 0 ? 200 : 502);
}

async function handleDrain({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "GET" && parts[0] === "api" && parts[1] === "drain")) return null;
  // GET /api/drain/queue?repo= — the backlog issues behind a repo's `queued` count
  if (parts[2] === "queue") {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    return json((await deps.drain?.queue(dir)) ?? []);
  }
  // GET /api/drain — a status per drain-enabled repo
  if (!parts[2]) return json((await deps.drain?.snapshot()) ?? []);
  return null;
}

// GET /api/automerge — a status per auto-merge-enabled repo (client bootstrap).
async function handleAutoMerge({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "GET" && parts[0] === "api" && parts[1] === "automerge" && !parts[2])) {
    return null;
  }
  return json((await deps.autoMerge?.snapshot()) ?? []);
}

// maxAuto: finite integer ≥ 1; clamp > 20 to 20
function parseMaxAuto(v: unknown): number | { error: string } {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || !Number.isInteger(v)) {
    return { error: "maxAuto must be an integer >= 1" };
  }
  return Math.min(v, 20);
}

// autoLabel: non-empty string after trim
function parseAutoLabel(v: unknown): string | { error: string } {
  if (typeof v !== "string" || v.trim() === "") {
    return { error: "autoLabel must be a non-empty string" };
  }
  return v.trim();
}

// usageCeilingPct: finite number; clamp to [0, 100], floor
function parseUsageCeiling(v: unknown): number | { error: string } {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { error: "usageCeilingPct must be a number" };
  }
  return Math.floor(Math.min(100, Math.max(0, v)));
}

// signoffAuthority: one of the three valid enum values
const SIGNOFF_AUTHORITY_VALUES = ["human", "critic", "either"] as const;
function parseSignoffAuthority(v: unknown): "human" | "critic" | "either" | { error: string } {
  if (!SIGNOFF_AUTHORITY_VALUES.includes(v as (typeof SIGNOFF_AUTHORITY_VALUES)[number])) {
    return { error: `signoffAuthority must be one of: ${SIGNOFF_AUTHORITY_VALUES.join(", ")}` };
  }
  return v as "human" | "critic" | "either";
}

// repoMode: "forge" | "lightweight"
const REPO_MODE_VALUES = ["forge", "lightweight"] as const;
function parseRepoMode(v: unknown): "forge" | "lightweight" | { error: string } {
  if (!REPO_MODE_VALUES.includes(v as (typeof REPO_MODE_VALUES)[number])) {
    return { error: `repoMode must be one of: ${REPO_MODE_VALUES.join(", ")}` };
  }
  return v as "forge" | "lightweight";
}

// sandboxProfile: one of the three valid profile values
function parseSandboxProfile(v: unknown): SandboxProfile | { error: string } {
  if (!isSandboxProfile(v)) {
    return { error: `sandboxProfile must be one of: ${SANDBOX_PROFILES.join(", ")}` };
  }
  return v;
}

// defaultModel: a per-repo override SETTING ("inherit" | "auto" | "default" | <model alias>)
function parseRepoDefaultModel(v: unknown): string | { error: string } {
  const r = normalizeRepoDefaultModelSetting(v);
  if (r === null)
    return { error: "defaultModel must be one of: inherit, auto, default, or a model alias" };
  return r;
}

// defaultEffort: a per-repo override SETTING ("inherit" | "default" | <effort tier>)
function parseRepoDefaultEffort(v: unknown): string | { error: string } {
  const r = normalizeRepoDefaultEffortSetting(v);
  if (r === null)
    return {
      error: "defaultEffort must be one of: inherit, default, low, medium, high, xhigh, max",
    };
  return r;
}

function parsePreviewOpenMode(v: unknown): "ask" | "inline" | "tab" | { error: string } {
  if (v === "ask" || v === "inline" || v === "tab") return v;
  return { error: "previewOpenMode must be one of: ask, inline, tab" };
}

// the optional boolean fields of a repo-config patch body
const REPO_CFG_BOOL_FIELDS = [
  "criticEnabled",
  "criticAllPrs",
  "autoAddressEnabled",
  "learningsEnabled",
  "autopilotEnabled",
  "planGateEnabled",
  "autoDrainEnabled",
  "autoMergeEnabled",
  "buildQueueEnabled",
  "draftMode",
  "autoOptimizeFlagged",
  "manualStepsIssueEnabled",
  "preWarmEpicLandingCi",
  "hidden",
] as const;

type RepoCfgBody = {
  criticEnabled?: unknown;
  criticAllPrs?: unknown;
  autoAddressEnabled?: unknown;
  learningsEnabled?: unknown;
  autopilotEnabled?: unknown;
  planGateEnabled?: unknown;
  autoDrainEnabled?: unknown;
  autoMergeEnabled?: unknown;
  buildQueueEnabled?: unknown;
  draftMode?: unknown;
  autoOptimizeFlagged?: unknown;
  manualStepsIssueEnabled?: unknown;
  preWarmEpicLandingCi?: unknown;
  hidden?: unknown;
  signoffAuthority?: unknown;
  sandboxProfile?: unknown;
  defaultModel?: unknown;
  defaultEffort?: unknown;
  egressExtraHosts?: unknown;
  maxAuto?: unknown;
  autoLabel?: unknown;
  usageCeilingPct?: unknown;
  repoMode?: unknown;
  previewStartScript?: unknown;
  previewStartCommand?: unknown;
  previewOpenMode?: unknown;
  automationConfirmed?: unknown;
};

// true when any present boolean field is not actually a boolean
function hasBadBoolField(body: RepoCfgBody): boolean {
  return REPO_CFG_BOOL_FIELDS.some((k) => {
    const v = body[k];
    return v !== undefined && typeof v !== "boolean";
  });
}

type RepoCfgScalars = {
  maxAuto?: number;
  autoLabel?: string;
  usageCeilingPct?: number;
  signoffAuthority?: "human" | "critic" | "either";
  sandboxProfile?: SandboxProfile;
  defaultModel?: string;
  defaultEffort?: string;
  egressExtraHosts?: string[];
  repoMode?: "forge" | "lightweight";
  previewStartScript?: string | null;
  previewStartCommand?: string | null;
  previewOpenMode?: "ask" | "inline" | "tab";
};

/** Adapt validateEgressExtraHosts (a Field result) to the scalar-parser contract:
 *  return the validated host array, or a { error } object the loop turns into a 400. */
function parseRepoEgressExtraHosts(v: unknown): unknown {
  const r = validateEgressExtraHosts(v);
  return r.ok ? r.value : { error: r.error };
}

function parseNullableString(v: unknown): string | null | { error: string } {
  if (v === null) return null;
  if (typeof v !== "string") return { error: "field must be a string or null" };
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Each non-boolean field paired with its validator. A validator returns the
// validated value, or a { error } object that becomes a 400 Response.
const REPO_CFG_SCALAR_PARSERS: readonly [keyof RepoCfgScalars, (v: unknown) => unknown][] = [
  ["maxAuto", parseMaxAuto],
  ["autoLabel", parseAutoLabel],
  ["usageCeilingPct", parseUsageCeiling],
  ["signoffAuthority", parseSignoffAuthority],
  ["sandboxProfile", parseSandboxProfile],
  ["defaultModel", parseRepoDefaultModel],
  ["defaultEffort", parseRepoDefaultEffort],
  ["egressExtraHosts", parseRepoEgressExtraHosts],
  ["repoMode", parseRepoMode],
  ["previewStartScript", parseNullableString],
  ["previewStartCommand", parseNullableString],
  ["previewOpenMode", parsePreviewOpenMode],
];

/** Validate the non-boolean (scalar/enum) repo-config fields, or the 400 Response to
 *  send. Each present field must pass its validator; absent fields are skipped. */
function parseRepoCfgScalars(body: RepoCfgBody): RepoCfgScalars | Response {
  const out: Record<string, unknown> = {};
  for (const [field, parse] of REPO_CFG_SCALAR_PARSERS) {
    const raw = body[field];
    if (raw === undefined) continue;
    const r = parse(raw);
    if (r !== null && typeof r === "object" && "error" in r) return json(r, 400);
    out[field] = r;
  }
  return out as RepoCfgScalars;
}

async function parseRepoConfigPatch(req: Request): Promise<
  | {
      criticEnabled?: boolean;
      criticAllPrs?: boolean;
      autoAddressEnabled?: boolean;
      learningsEnabled?: boolean;
      autopilotEnabled?: boolean;
      planGateEnabled?: boolean;
      autoDrainEnabled?: boolean;
      autoMergeEnabled?: boolean;
      buildQueueEnabled?: boolean;
      draftMode?: boolean;
      autoOptimizeFlagged?: boolean;
      manualStepsIssueEnabled?: boolean;
      preWarmEpicLandingCi?: boolean;
      hidden?: boolean;
      signoffAuthority?: "human" | "critic" | "either";
      sandboxProfile?: SandboxProfile;
      defaultModel?: string;
      defaultEffort?: string;
      egressExtraHosts?: string[];
      maxAuto?: number;
      autoLabel?: string;
      usageCeilingPct?: number;
      repoMode?: "forge" | "lightweight";
      previewStartScript?: string | null;
      previewStartCommand?: string | null;
      previewOpenMode?: "ask" | "inline" | "tab";
      automationConfirmed?: boolean;
    }
  | Response
> {
  const body = (await req.json().catch(() => null)) as RepoCfgBody | null;
  if (!body || hasBadBoolField(body)) {
    return json(
      {
        error:
          "boolean fields (criticEnabled/autoAddressEnabled/learningsEnabled/autopilotEnabled/autoDrainEnabled/autoMergeEnabled/buildQueueEnabled/draftMode/autoOptimizeFlagged/hidden) must be booleans",
      },
      400,
    );
  }
  if (body.automationConfirmed !== undefined && typeof body.automationConfirmed !== "boolean")
    return json({ error: "automationConfirmed must be a boolean" }, 400);
  const scalars = parseRepoCfgScalars(body);
  if (scalars instanceof Response) return scalars;
  const {
    maxAuto,
    autoLabel,
    usageCeilingPct,
    signoffAuthority,
    sandboxProfile,
    defaultModel,
    defaultEffort,
    egressExtraHosts,
    repoMode,
    previewStartScript,
    previewStartCommand,
    previewOpenMode,
  } = scalars;
  const present =
    REPO_CFG_BOOL_FIELDS.some((k) => body[k] !== undefined) ||
    maxAuto !== undefined ||
    autoLabel !== undefined ||
    usageCeilingPct !== undefined ||
    signoffAuthority !== undefined ||
    sandboxProfile !== undefined ||
    defaultModel !== undefined ||
    defaultEffort !== undefined ||
    egressExtraHosts !== undefined ||
    repoMode !== undefined ||
    previewStartScript !== undefined ||
    previewStartCommand !== undefined ||
    previewOpenMode !== undefined ||
    body.automationConfirmed !== undefined;
  if (!present) {
    return json(
      {
        error:
          "body must set at least one of: criticEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled, autoDrainEnabled, autoMergeEnabled, buildQueueEnabled, draftMode, autoOptimizeFlagged, hidden, signoffAuthority, sandboxProfile, defaultModel, defaultEffort, egressExtraHosts, maxAuto, autoLabel, usageCeilingPct, repoMode, previewStartScript, previewStartCommand, previewOpenMode, automationConfirmed",
      },
      400,
    );
  }
  return {
    criticEnabled: body.criticEnabled as boolean | undefined,
    criticAllPrs: body.criticAllPrs as boolean | undefined,
    autoAddressEnabled: body.autoAddressEnabled as boolean | undefined,
    learningsEnabled: body.learningsEnabled as boolean | undefined,
    autopilotEnabled: body.autopilotEnabled as boolean | undefined,
    planGateEnabled: body.planGateEnabled as boolean | undefined,
    autoDrainEnabled: body.autoDrainEnabled as boolean | undefined,
    autoMergeEnabled: body.autoMergeEnabled as boolean | undefined,
    buildQueueEnabled: body.buildQueueEnabled as boolean | undefined,
    draftMode: body.draftMode as boolean | undefined,
    autoOptimizeFlagged: body.autoOptimizeFlagged as boolean | undefined,
    manualStepsIssueEnabled: body.manualStepsIssueEnabled as boolean | undefined,
    preWarmEpicLandingCi: body.preWarmEpicLandingCi as boolean | undefined,
    hidden: body.hidden as boolean | undefined,
    signoffAuthority,
    sandboxProfile,
    defaultModel,
    defaultEffort,
    egressExtraHosts,
    maxAuto,
    autoLabel,
    usageCeilingPct,
    repoMode,
    previewStartScript,
    previewStartCommand,
    previewOpenMode,
    automationConfirmed: body.automationConfirmed as boolean | undefined,
  };
}

/** Merge a validated patch onto the current repo config, returning the new full config.
 *  Patch fields are only ever undefined (absent) or a valid value, so every defined
 *  field overrides and absent fields keep the current value. */
async function handleRepoConfig({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "repo-config" && !parts[2])) return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (req.method === "GET") return json(repoConfigSvc(deps).read(dir));
  if (req.method !== "PUT") return null;

  const patch = await parseRepoConfigPatch(req);
  if (patch instanceof Response) return patch;
  // Load-bearing destructure: the automationConfirmed metadata is applied separately
  // by the service, never merged into the RepoConfig row.
  const { automationConfirmed, ...cfgPatch } = patch;
  if (cfgPatch.previewStartScript !== undefined && cfgPatch.previewStartScript !== null) {
    const canonicalScript = await resolvePreviewStartScriptPath(dir);
    if (cfgPatch.previewStartScript !== canonicalScript) {
      return json({ error: "previewStartScript must use the canonical repo-local path" }, 400);
    }
  }
  const r = repoConfigSvc(deps).patch(dir, cfgPatch, { automationConfirmed });
  if (!r.ok) return json({ error: r.error }, 400);
  return json(r.config);
}

// /api/repo-roles?repo=<path> — read (GET) / set (PUT) the committed reviewer +
// merger logins for a repo. PUT commits & pushes .shepherd/roles.json to the
// default branch and immediately re-pushes the affected sessions' waiting-state.
async function handleRepoRoles({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "repo-roles" && !parts[2])) return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  const me = (await forge?.currentUser?.()) ?? null;
  if (req.method === "GET") return json({ roles: readRepoRoles(dir), me });
  if (req.method !== "PUT") return null;
  return setRepoRoles(req, dir, forge, me, deps);
}

async function setRepoRoles(
  req: Request,
  dir: string,
  forge: GitForge | null,
  me: string | null,
  deps: AppDeps,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Partial<RepoRoles> | null;
  if (!body) return json({ error: "invalid body" }, 400);
  const cur = readRepoRoles(dir);
  const next: RepoRoles = {
    reviewer: "reviewer" in body ? normalizeLogin(body.reviewer) : cur.reviewer,
    merger: "merger" in body ? normalizeLogin(body.merger) : cur.merger,
  };
  // No change → don't author a redundant commit (and CI run) on the default branch.
  // Fold case to match handoff: a casing-only edit is a no-op (logins are
  // case-insensitive). Return the persisted `cur` so the response keeps on-disk casing.
  const sameLogin = (a: string | null, b: string | null) =>
    (a?.toLowerCase() ?? null) === (b?.toLowerCase() ?? null);
  if (sameLogin(next.reviewer, cur.reviewer) && sameLogin(next.merger, cur.merger)) {
    return json({ roles: cur, me });
  }
  try {
    if (!forge) throw new Error("no forge configured for repo");
    writeRepoRoles(dir, next, await forge.defaultBranch());
  } catch (e) {
    // Push rejected (protected branch / no-ff / auth) or no forge. Log the detail
    // server-side; return a generic, non-error-derived message so raw error/stack text
    // never reaches the client (CodeQL js/stack-trace-exposure #14). The dialog still
    // shows its localized "roles push failed" message alongside this.
    console.error("[repo-roles] role push failed:", e);
    return json({ roles: readRepoRoles(dir), me, pushError: "push rejected" }, 502);
  }
  repushHandoff(deps, dir, me);
  return json({ roles: next, me });
}

/** Recompute + re-push the waiting-state for every session in `dir` so the herd
 *  reflects a role change at once, rather than lagging until an unrelated PR flip. */
function repushHandoff(deps: AppDeps, dir: string, me: string | null): void {
  if (!deps.prCache) return;
  const snap = deps.prCache.snapshot();
  for (const s of deps.store.list({ activeOnly: true })) {
    if (s.repoPath !== dir) continue;
    const prev = snap[s.id];
    if (!prev) continue;
    const updated = annotateHandoff(prev, dir, me);
    if (
      updated.handoff !== prev.handoff ||
      updated.handoffWho !== prev.handoffWho ||
      updated.handoffInferred !== prev.handoffInferred
    ) {
      deps.prCache.set(s.id, updated);
      deps.events.emit("session:git", { id: s.id, git: updated });
    }
  }
}

// /api/repo-collaborators?repo=<path> — logins for the roles dialog's people
// picker, plus the operator's own login. `collaboratorsUnavailable` lets the
// dialog fall back to free-text when the host won't list them (e.g. GitHub 403).
async function handleRepoCollaborators({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "repo-collaborators" && !parts[2])) return null;
  if (req.method !== "GET") return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  const me = (await forge?.currentUser?.()) ?? null;
  const list = (await forge?.listCollaborators?.()) ?? { logins: [], unavailable: true };
  return json({ logins: list.logins, me, collaboratorsUnavailable: list.unavailable });
}

// POST /api/doc-agent?repo= — manually trigger the PR-gated AI doc agent (issue #882).
// Opt-in + flag-gated: when SHEPHERD_DOC_AGENT is off (or the service is unwired) the endpoint
// 404s deliberately, so a disabled feature is unadvertised (a chosen divergence from the 403/null
// precedent — see configuration.md). On success the server (never the agent) commits/pushes/opens a
// PR for human review; this just kicks the run off.
async function handleDocAgent({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "doc-agent" && !parts[2])) return null;
  if (req.method !== "POST") return null;
  if (!config.docAgentEnabled || !deps.docAgent) return json({ error: "not found" }, 404);
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const res = await deps.docAgent.consider(dir);
  if (res.status === "started") return json({ ok: true }, 202);
  if (res.status === "skipped") return json({ ok: false, reason: res.reason }, 409);
  return json({ error: res.reason ?? "doc agent failed" }, 400);
}

// GET /api/doc-agent/runs?repo= — per-repo run history + live running flag (issue #906).
// Same unadvertised 404 contract as POST /api/doc-agent when the feature is disabled or unwired.
function handleDocAgentRuns({ req, parts, url, deps }: Ctx): Response | null {
  if (!(parts[0] === "api" && parts[1] === "doc-agent" && parts[2] === "runs" && !parts[3]))
    return null;
  if (req.method !== "GET") return null;
  if (!config.docAgentEnabled || !deps.docAgent) return json({ error: "not found" }, 404);
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  return json({
    running: deps.docAgent.isRunning(dir),
    runs: deps.store.listDocAgentRuns(dir),
  });
}

// /api/learnings — list (GET ?repo=), approve/dismiss (POST :id/action), distill (POST distill ?repo=)
async function handleLearnings(ctx: Ctx): Promise<Response | null> {
  if (ctx.parts[0] !== "api" || ctx.parts[1] !== "learnings") return null;
  if (ctx.req.method === "GET") return handleLearningsGet(ctx);
  if (ctx.req.method === "POST") return handleLearningsPost(ctx);
  return null;
}

function handleLearningsGet({ parts, url, deps }: Ctx): Response | null {
  // GET /api/learnings/pending — all proposed rules across repos (drawer + badge),
  // each rule's cited signals resolved into provenance (kind breakdown + source
  // session + excerpt). The N+N+1 read lives in LearningsService now.
  if (parts[2] === "pending") {
    return json(learnings(deps).pendingWithEvidence());
  }

  // GET /api/learnings/injectable — cross-repo injected/over-budget view (drawer).
  // The budget value flows from here so the UI never hardcodes it; the per-repo
  // aggregation + planner share live in LearningsService.injectableOverview.
  if (parts[2] === "injectable") {
    return json(learnings(deps).injectableOverview(config.houseRulesBudgetChars));
  }

  // GET /api/learnings/health — distiller health (fail-safe: safe default when absent)
  if (parts[2] === "health") {
    const safe = { ok: true, consecutiveFailures: 0, lastFailure: null };
    const distiller = deps.distiller?.health?.() ?? safe;
    const optimizer = deps.optimizer?.health?.() ?? safe;
    return json({ ...distiller, optimizer });
  }

  // GET /api/learnings/merge-suggestions — pending Phase-4 merge suggestions (intra + cross),
  // each with its member rules hydrated for the drawer. Stale members (no longer present) are
  // dropped; pruneOrphanMergeSuggestions sweeps fully-broken suggestions on the daily pass.
  if (parts[2] === "merge-suggestions") {
    return json(learnings(deps).mergeSuggestionsWithMembers());
  }

  // GET /api/learnings?repo=&status=
  if (!parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    const status = url.searchParams.get("status") ?? undefined;
    return json(
      deps.store.listLearnings(dir, status ? { status: status as LearningStatus } : undefined),
    );
  }

  return null;
}

/** POST /api/learnings/{distill,optimize,seen-retired}?repo= — repo-scoped learning
 *  triggers (matched before :id). Returns null when `parts[2]` is none of these. */
function handleRepoScopedLearningPost(parts: string[], url: URL, deps: AppDeps): Response | null {
  if (
    parts[2] !== "distill" &&
    parts[2] !== "optimize" &&
    parts[2] !== "seen-retired" &&
    parts[2] !== "merge-suggest"
  )
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  // Async fire-and-forget whose service chains (enqueueOrBegin → begin) never catch internally, so
  // the `.catch` here is what stops an unhandled rejection; `void` satisfies no-floating-promises.
  if (parts[2] === "distill")
    void deps.distiller
      ?.distillNow(dir)
      .catch((err) => console.warn("[distill] distillNow failed:", err));
  else if (parts[2] === "optimize")
    void deps.optimizer
      ?.optimizeAllFlagged(dir)
      .catch((err) => console.warn("[optimize] optimizeAllFlagged failed:", err));
  else if (parts[2] === "merge-suggest")
    void deps.mergeSuggest
      ?.mergeNow(dir)
      .catch((err) => console.warn("[merge-suggest] mergeNow failed:", err));
  else if (parts[2] === "seen-retired") {
    deps.store.markRetiredSeen(dir, Date.now());
  }
  return json({ ok: true });
}

/** POST /api/learnings/merge — apply an intra-repo merge suggestion (body {suggestionId}).
 *  Consolidates the group via mergeLearning (survivor counters preserved) + soft-retires the
 *  other members with a citation, re-validating every member is still active first. */
async function handleMergeApply(req: Request, deps: AppDeps): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { suggestionId?: unknown };
  const id = typeof body.suggestionId === "string" ? body.suggestionId : "";
  if (!id) return json({ error: "suggestionId required" }, 400);
  const r = learnings(deps).applyMergeSuggestion(id);
  if (r.ok) return json({ ok: true });
  if (r.reason === "not-found") return json({ error: "not found" }, 404);
  if (r.reason === "stale") return json({ error: "stale" }, 409);
  return json({ error: "already resolved" }, 409); // already-resolved
}

/** Route the two Phase-4 merge-suggestion POSTs (`merge` apply, `merge-dismiss`). Returns
 *  null when `parts[2]` is neither, so the caller falls through to the `:id` routes. */
function handleMergeSuggestionPost(
  parts: string[],
  req: Request,
  deps: AppDeps,
): Promise<Response> | null {
  if (parts[2] === "merge" && !parts[3]) return handleMergeApply(req, deps);
  if (parts[2] === "merge-dismiss") return handleMergeDismiss(req, deps);
  if (parts[2] === "promote-global") return handleMergePromoteGlobal(req, deps);
  return null;
}

/** POST /api/learnings/promote-global — write a cross-repo recurrence rule into the user-global
 *  ~/.claude/CLAUDE.md (issue #872), body {suggestionId}. Explicit, operator-confirmed; no PR.
 *  Marks the suggestion `applied` so it leaves the band and isn't re-suggested (the cross dedup
 *  set includes `applied`). 409 on a stale re-post, mirroring handleMergeApply. */
async function handleMergePromoteGlobal(req: Request, deps: AppDeps): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { suggestionId?: unknown };
  const id = typeof body.suggestionId === "string" ? body.suggestionId : "";
  if (!id) return json({ error: "suggestionId required" }, 400);
  const sug = deps.store.getMergeSuggestion(id);
  if (!sug) return json({ error: "not found" }, 404);
  if (sug.kind !== "cross") return json({ error: "not a cross-repo suggestion" }, 400);
  if (sug.status !== "pending") return json({ error: "already resolved" }, 409);
  if (!deps.promoter) return json({ error: "promote unavailable" }, 503);
  const res = await deps.promoter.promoteGlobal(sug.mergedRule);
  if (!res.ok) return json({ error: res.error }, res.status);
  // Promoter-orchestrated (separate service): the suggestion bookkeeping stays inline; only
  // the recurring emit tail unifies through the learnings service (#1092).
  deps.store.setMergeSuggestionStatus(id, "applied");
  learnings(deps).emitPending();
  return json({ ok: true });
}

/** POST /api/learnings/merge-dismiss — dismiss a merge suggestion (intra or cross), body
 *  {suggestionId}. The id-signature keeps the same group from being re-suggested. */
async function handleMergeDismiss(req: Request, deps: AppDeps): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { suggestionId?: unknown };
  const id = typeof body.suggestionId === "string" ? body.suggestionId : "";
  if (!id) return json({ error: "suggestionId required" }, 400);
  if (!learnings(deps).dismissMergeSuggestion(id)) return json({ error: "not found" }, 404);
  return json({ ok: true });
}

async function handleLearningPromote(deps: AppDeps, id: string): Promise<Response> {
  if (!deps.promoter) return json({ error: "promote unavailable" }, 503);
  const res = await deps.promoter.promote(id);
  if (!res.ok) return json({ error: res.error }, res.status);
  // Promoter-orchestrated; only the emit tail unifies through the learnings service (#1092).
  learnings(deps).emitPending();
  return json({ url: res.url });
}

async function handleLearningsPost(ctx: Ctx): Promise<Response | null> {
  const { req, parts, url, deps } = ctx;
  // POST /api/learnings/{distill,optimize,merge-suggest}?repo= — checked BEFORE :id so they aren't ids
  const repoScoped = handleRepoScopedLearningPost(parts, url, deps);
  if (repoScoped) return repoScoped;

  // POST /api/learnings/{merge,merge-dismiss} — apply/dismiss a Phase-4 merge suggestion
  const mergePost = await handleMergeSuggestionPost(parts, req, deps);
  if (mergePost) return mergePost;

  // POST /api/learnings/:id/<action>
  return handleLearningIdAction(ctx);
}

/** Dispatch the per-`:id` learning action routes (promote/optimize/restore/scope/revert-trial/
 *  approve/dismiss). Split out of handleLearningsPost to keep each dispatcher's branch count low. */
async function handleLearningIdAction(ctx: Ctx): Promise<Response | null> {
  const { req, parts, deps } = ctx;
  if (!parts[2]) return null;

  // POST /api/learnings/:id/promote — open a CLAUDE.md PR for an active rule
  if (parts[3] === "promote") return handleLearningPromote(deps, parts[2]);

  // POST /api/learnings/:id/optimize — optimize a single flagged rule
  if (parts[3] === "optimize") {
    // Async fire-and-forget (same shape as the distill/optimize triggers above): catch the rejection,
    // `void` for no-floating-promises.
    void deps.optimizer
      ?.optimizeOne(parts[2])
      .catch((err) => console.warn("[optimize] optimizeOne failed:", err));
    return json({ ok: true });
  }

  // POST /api/learnings/:id/restore — restore a retired rule to its previous status
  if (parts[3] === "restore") {
    const updated = learnings(deps).restore(parts[2]);
    if (!updated) return json({ error: "not found" }, 404);
    return json(updated);
  }

  // POST /api/learnings/:id/scope — set/clear a rule's glob scope (operator edit, #842)
  if (parts[3] === "scope") return handleLearningScope(req, deps, parts[2]);

  // POST /api/learnings/:id/revert-trial — revert an auto-trial back to proposed or dismissed
  if (parts[3] === "revert-trial") return handleLearningRevertTrial(req, deps, parts[2]);

  // POST /api/learnings/:id/approve  |  /:id/dismiss
  if (parts[3] === "approve" || parts[3] === "dismiss") {
    return handleLearningStatus(req, deps, parts[2], parts[3]);
  }

  return null;
}

/** POST /api/learnings/:id/scope — replace a rule's `scopeGlobs` (body `{globs:string[]}`).
 *  An empty array makes it an Always-rule again. The store dedupes/trims; matching honesty
 *  is the operator's. Refreshes the drawer via learnings:update. */
async function handleLearningScope(req: Request, deps: AppDeps, id: string): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { globs?: unknown } | null;
  const globs = Array.isArray(body?.globs)
    ? body!.globs.filter((g): g is string => typeof g === "string")
    : [];
  const updated = learnings(deps).setScope(id, globs);
  if (!updated) return json({ error: "not found" }, 404);
  return json(updated);
}

/** POST /api/learnings/:id/revert-trial — undo an auto-trial. Body `{target:'proposed'|'dismissed'}`.
 *  Only affects active trial rules (store guards `trialedAt != null`); 400 on a bad target,
 *  404 when the rule isn't a revertable trial. Refreshes the drawer via learnings:update. */
async function handleLearningRevertTrial(
  req: Request,
  deps: AppDeps,
  id: string,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { target?: unknown } | null;
  const target = body?.target;
  if (target !== "proposed" && target !== "dismissed")
    return json({ error: "invalid target" }, 400);
  const updated = learnings(deps).revertTrial(id, target);
  if (!updated) return json({ error: "not found" }, 404);
  return json(updated);
}

async function handleLearningStatus(
  req: Request,
  deps: AppDeps,
  id: string,
  action: "approve" | "dismiss",
): Promise<Response> {
  // The edited-rule body is parsed here (HTTP concern); the service normalizes it (trim + 240
  // cap, blank → fall back to the stored rule) to match addLearning's contract.
  let ruleEdit: string | undefined;
  if (action === "approve") {
    const body = (await req.json().catch(() => null)) as { rule?: unknown } | null;
    if (body && typeof body.rule === "string") ruleEdit = body.rule;
  }
  const updated = learnings(deps).setStatus(id, action, ruleEdit);
  if (!updated) return json({ error: "not found" }, 404);
  return json(updated);
}

async function pushSubscribe(req: Request, deps: AppDeps): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
    locale?: unknown;
  } | null;
  if (
    !body ||
    typeof body.endpoint !== "string" ||
    typeof body.keys?.p256dh !== "string" ||
    typeof body.keys?.auth !== "string"
  ) {
    return json({ error: "body must be a PushSubscription" }, 400);
  }
  deps.push?.subscribe(
    {
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      locale: typeof body.locale === "string" ? body.locale : undefined,
    },
    req.headers.get("User-Agent") ?? "",
  );
  return json({ ok: true });
}

async function pushUnsubscribe(req: Request, deps: AppDeps): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (!body || typeof body.endpoint !== "string") {
    return json({ error: "body must be {endpoint: string}" }, 400);
  }
  deps.push?.unsubscribe(body.endpoint);
  return json({ ok: true });
}

/** GET /api/push/prefs?endpoint=… — the device's category selection (all-on if unknown). */
function pushPrefsRead(url: URL, deps: AppDeps): Response {
  const endpoint = url.searchParams.get("endpoint");
  if (!endpoint) return json({ error: "endpoint query param required" }, 400);
  const prefs = deps.store.getPushPrefs(endpoint) ?? { agent: true, reviews: true, ci: true };
  return json({ categories: prefs });
}

/** POST /api/push/prefs {endpoint, categories} — update a device's category selection. */
async function pushPrefsWrite(req: Request, deps: AppDeps): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as {
    endpoint?: unknown;
    categories?: { agent?: unknown; reviews?: unknown; ci?: unknown };
  } | null;
  const c = body?.categories;
  if (
    !body ||
    typeof body.endpoint !== "string" ||
    !c ||
    typeof c.agent !== "boolean" ||
    typeof c.reviews !== "boolean" ||
    typeof c.ci !== "boolean"
  ) {
    return json({ error: "body must be {endpoint, categories:{agent,reviews,ci}}" }, 400);
  }
  const ok = deps.store.setPushPrefs(body.endpoint, {
    agent: c.agent,
    reviews: c.reviews,
    ci: c.ci,
  });
  // No row means the client thinks it's subscribed but the server has no record
  // (pruned/raced) — report it so the UI can revert rather than silently no-op.
  return ok ? json({ ok: true }) : json({ error: "no subscription for endpoint" }, 404);
}

// Table-driven so adding a push route doesn't grow handlePush's branch count.
const PUSH_ROUTES: {
  method: string;
  seg: string;
  run: (ctx: Ctx) => Response | Promise<Response>;
}[] = [
  {
    method: "GET",
    seg: "vapid",
    run: ({ deps }) => json({ publicKey: deps.push?.publicKey() ?? null }),
  },
  { method: "POST", seg: "subscribe", run: ({ req, deps }) => pushSubscribe(req, deps) },
  { method: "POST", seg: "unsubscribe", run: ({ req, deps }) => pushUnsubscribe(req, deps) },
  { method: "GET", seg: "prefs", run: ({ url, deps }) => pushPrefsRead(url, deps) },
  { method: "POST", seg: "prefs", run: ({ req, deps }) => pushPrefsWrite(req, deps) },
];

async function handlePush(ctx: Ctx): Promise<Response | null> {
  const { req, parts } = ctx;
  if (parts[0] !== "api" || parts[1] !== "push") return null;
  const route = PUSH_ROUTES.find((r) => r.method === req.method && r.seg === parts[2]);
  return route ? route.run(ctx) : null;
}

/** Best-effort: stamp the drain claim label on a manually-linked issue so the board shows it's
 *  being worked and the drain won't double-spawn it. Fire-and-forget — failures must never affect
 *  the create response. Mirrors doSpawn's best-effort claim for the auto path. */
export async function claimLinkedIssue(forge: GitForge | null, issueNumber: number): Promise<void> {
  try {
    await forge?.addIssueLabel?.(issueNumber, ACTIVE_LABEL);
  } catch (err) {
    console.warn(`[create] claim label for issue #${issueNumber} failed:`, err);
  }
}

/** Map a service.create() error to the appropriate Response.
 *  SandboxAutoRefused → 403; missing base ref → 422; agent_name_taken → 409;
 *  anything else → 502. */
function createErrorResponse(e: unknown): Response {
  if (e instanceof SandboxAutoRefused) return json({ error: e.holdReason }, 403);
  if (e instanceof WorktreeMissingBaseError) return json({ error: e.message }, 422);
  const msg = e instanceof Error ? e.message : "create failed";
  const taken = /agent_name_taken/.test(msg);
  return json({ error: taken ? "task name already in use, retry" : msg }, taken ? 409 : 502);
}

/** Check hold gate; if triggered, persist the held task and return the 200 response.
 *  Returns null when the task should proceed to normal creation. */
function persistHeldTask(
  value: CreateSessionInput,
  deps: AppDeps,
  reason: "usage" | "capacity",
): Response {
  const id = randomUUID();
  const createdAt = Date.now();
  deps.store.addHeldTask({ id, repoPath: value.repoPath, input: value, createdAt, reason });
  deps.events.emit("held:changed", { count: deps.store.countHeldTasks() });
  return json({ held: true, id, count: deps.store.countHeldTasks() }, 200);
}

function tryHoldNewTask(body: unknown, value: CreateSessionInput, deps: AppDeps): Response | null {
  const provider = normalizeAgentProvider(value.agentProvider ?? config.defaultAgentProvider);
  if (provider !== "claude") return null;

  const force = !!(
    body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).force === true
  );
  const lim = deps.usageLimits.limits(Date.now());
  const s5h = lim.session5h?.pct ?? 0;
  const week = lim.week?.pct ?? 0;
  if (
    !shouldHold({
      enabled: config.usageHoldEnabled,
      holdPct: config.usageHoldPct,
      session5hPct: s5h,
      weekPct: week,
      force,
    })
  )
    return null;
  return persistHeldTask(value, deps, "usage");
}

// POST /api/sessions — create a session.
async function handleSessionCreate({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && !parts[2])) return null;
  const b = firstRunBlock();
  if (b) return b;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  const result = validateCreate(body, config.repoRoot);
  if (!result.ok) return json({ error: result.error }, 400);

  // ── usage-aware hold gate ──────────────────────────────────────────────────
  const held = tryHoldNewTask(body, result.value, deps);
  if (held) return held;

  let s;
  try {
    s = await deps.service.create(result.value);
  } catch (e) {
    // Plugin-refused create: park in held_tasks as a capacity hold for retry.
    if (e instanceof SandboxAutoRefused && e.cause instanceof PluginSpawnAborted) {
      return persistHeldTask(result.value, deps, "capacity");
    }
    // create shells out to herdr (and git); surface the real reason instead of a
    // bare 500 so the New Task dialog can show it.
    return createErrorResponse(e);
  }
  deps.events.emit("session:new", s);
  // A human linked an issue: stamp the drain claim so the board reflects it's being
  // worked and the drain won't double-spawn it. Deferred (macrotask) + best-effort:
  // addIssueLabel shells out synchronously via execFileSync, so merely not awaiting
  // would still block this tick — setTimeout(0) lets json(s, 201) flush first.
  if (result.value.issueRef) {
    const { repoPath, issueRef } = result.value;
    setTimeout(
      () => void claimLinkedIssue(deps.resolveForge?.(repoPath) ?? null, issueRef.number),
      0,
    );
  }
  return json(s, 201);
}

async function sessionUsageRead(id: string, deps: AppDeps): Promise<Response> {
  const s = deps.store.get(id);
  return s ? json(await sessionUsage(s)) : json({ error: "not found" }, 404);
}

async function sessionActivityRead(id: string, deps: AppDeps): Promise<Response> {
  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);
  // pre-feature session (no pinned id) → no transcript to read
  const path = s.claudeSessionId ? jsonlPathFor(s.worktreePath, s.claudeSessionId) : "";
  return json(path ? await sessionActivity(path) : []);
}

async function sessionDiffRead(id: string, deps: AppDeps): Promise<Response> {
  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);
  try {
    // Diff against the PR's actual base (so it matches the PR's "Files changed" even when
    // the PR targets a non-default branch), falling back to the session's stored baseBranch.
    const { base } = await resolveDiffBase(s, deps.prCache, deps.resolveForge);
    return json(toSessionDiff(await computeDiff(s.worktreePath, base, s.branch)));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "diff failed" }, 500);
  }
}

// Per-line Diff-tab annotations (#1699): agent reasoning anchored to changed lines (from the
// transcript) + Critic findings routed to per-file / panel banners. Best-effort chrome — a
// sibling of /diff so its heavier computation (transcript parse + anchoring) can never block or
// break the diff itself. The client fetches it on diff-load + manual refresh, NOT on the 15s poll.
// Uses the SAME base the tab renders; findings are already scope-filtered at critic time, so the
// builder re-routes (never re-drops). Any failure degrades to an empty list, never a tab error.
async function sessionDiffAnnotationsRead(id: string, deps: AppDeps): Promise<Response> {
  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);
  try {
    const { base } = await resolveDiffBase(s, deps.prCache, deps.resolveForge);
    const diff = await computeDiff(s.worktreePath, base, s.branch); // structured hunks (not toSessionDiff)
    // spawnAccountDir MUST be passed: a spawn-account session writes its JSONL under
    // <account>/projects (see src/usage.ts) — omitting it resolves a nonexistent path and
    // silently yields no agent notes. Matches poller/recap/reaper.
    const transcriptPath = s.claudeSessionId
      ? jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir)
      : "";
    const findings = deps.store.getReview(id)?.findings ?? [];
    return json({
      notes: buildDiffNotes({
        files: diff.files,
        worktreePath: s.worktreePath,
        transcriptPath,
        findings,
      }),
    });
  } catch {
    return json({ notes: [] });
  }
}

async function sessionRead(id: string, deps: AppDeps): Promise<Response> {
  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);
  if (s.status === "archived") return json(s);
  return json({
    ...s,
    hasScratchpadFiles: await scratchpadHasFiles(s.worktreePath, s.claudeSessionId),
  });
}

// Attach the transient, derived `hasScratchpadFiles` flag (#1164) to each ACTIVE session in
// parallel — the cheap signal the UI's Files tab is gated on. Archived sessions keep their bare
// row (the scratchpad is out of scope post-archive). Not persisted: computed at serialize time.
async function withScratchpadFlags(
  sessions: Session[],
): Promise<Array<Session & { hasScratchpadFiles?: boolean }>> {
  return Promise.all(
    sessions.map(async (s) =>
      s.status === "archived"
        ? s
        : { ...s, hasScratchpadFiles: await scratchpadHasFiles(s.worktreePath, s.claudeSessionId) },
    ),
  );
}

// Recently-archived sessions for the Done lens, each enriched with the web URL of its
// linked forge issue (when derivable). The archived session row carries `issueNumber` but
// no URL, and the live GitState.issueUrl is keyed by *active* session id — gone once
// archived — so we derive it here. Forge `webUrl` is resolved once per unique repoPath
// (not per session): the window can hold many sessions across a few repos, and the first
// resolveForge() call per dir shells out to git on a cold cache. Warm cache → no shell-out.
function doneSessionsWithIssueUrl(deps: AppDeps): Array<Session & { issueUrl?: string }> {
  const sessions = deps.store.listRecentlyArchived(Date.now() - DONE_LENS_WINDOW_MS);
  const repoWebUrl = new Map<string, string | null>();
  for (const path of new Set(sessions.map((s) => s.repoPath)))
    repoWebUrl.set(path, deps.resolveForge?.(path)?.webUrl ?? null);
  return sessions.map((s) => {
    const issueUrl = buildIssueUrl(repoWebUrl.get(s.repoPath), s.issueNumber);
    return issueUrl ? { ...s, issueUrl } : s;
  });
}

// GET reads on /api/sessions[/:id[/usage|/activity|/diff|/leftovers]].
async function handleSessionReads({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (!parts[2]) return json(await withScratchpadFlags(deps.store.list({ activeOnly: true })));
  // "Done" lens: sessions archived within the last DONE_LENS_WINDOW_MS, newest-first.
  // Must precede the bare sessionRead fall-through so "done" isn't read as a session id.
  if (parts[2] === "done" && !parts[3]) return json(doneSessionsWithIssueUrl(deps));
  if (parts[3] === "usage") return sessionUsageRead(parts[2], deps);
  if (parts[3] === "activity") return sessionActivityRead(parts[2], deps);
  // annotations must precede the bare `diff` check (which matches parts[3]==="diff" regardless).
  if (parts[3] === "diff" && parts[4] === "annotations")
    return sessionDiffAnnotationsRead(parts[2], deps);
  if (parts[3] === "diff") return sessionDiffRead(parts[2], deps);
  // leftover subprocesses/proxies that would survive this session's close
  if (parts[3] === "leftovers") return json(deps.service.leftovers(parts[2]));
  if (!parts[3]) return sessionRead(parts[2], deps);
  return null;
}

// ── scratchpad file browser: GET /api/sessions/:id/scratchpad[?path=] (list)
//                            GET /api/sessions/:id/scratchpad/download?path= (file) ──
// Read-only browse + single-file download, rooted at and realpath-contained to the session's
// OWN scratchpad dir (#1164). Live sessions only: 404 on a missing/archived session. `path` is
// relative to the scratchpad root; containment is enforced in src/scratchpad.ts.
// Stream one contained scratchpad file as an attachment download.
async function scratchpadDownload(s: Session, rel: string): Promise<Response> {
  const file = await resolveScratchpadFile(s.worktreePath, s.claudeSessionId, rel);
  if (!file) return json({ error: "not found" }, 404);
  const f = Bun.file(file);
  return new Response(f, {
    headers: {
      "content-type": f.type || "application/octet-stream",
      "content-disposition": attachmentDisposition(basename(file)),
    },
  });
}

// List one scratchpad directory. A missing ROOT for a started session (agent hasn't written
// yet) returns a synthetic empty listing so the Files tab doesn't error before the first
// upload/write; a missing non-root path still 404s.
async function scratchpadList(s: Session, rel: string): Promise<Response> {
  const listing = await listScratchpad(s.worktreePath, s.claudeSessionId, rel);
  if (listing) return json(listing);
  if (rel === "" && s.claudeSessionId) return json({ path: "", parent: null, entries: [] });
  return json({ error: "not found" }, 404);
}

async function handleSessionScratchpad({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[3] !== "scratchpad") return null;
  const s = deps.store.get(parts[2] ?? "");
  if (!s || s.status === "archived") return json({ error: "not found" }, 404);
  const rel = url.searchParams.get("path") ?? "";
  if (parts[4] === "download") return scratchpadDownload(s, rel);
  if (!parts[4]) return scratchpadList(s, rel);
  return null;
}

// ── worktree file browser: GET /api/sessions/:id/worktree[?path=] (list)
//                           GET /api/sessions/:id/worktree/download?path= (file) ──
// Read-only browse + single-file download, rooted at and realpath-contained to the session's
// worktree. `.git` is hidden; out-of-root symlinks are surfaced disabled. Live sessions only:
// 404 on a missing/archived session. Containment is enforced in src/worktree-files.ts.
async function worktreeDownload(s: Session, rel: string): Promise<Response> {
  const file = await resolveWorktreeFile(s.worktreePath, rel);
  if (!file) return json({ error: "not found" }, 404);
  const f = Bun.file(file);
  return new Response(f, {
    headers: {
      "content-type": f.type || "application/octet-stream",
      "content-disposition": attachmentDisposition(basename(file)),
    },
  });
}

async function worktreeList(s: Session, rel: string): Promise<Response> {
  const listing = await listWorktree(s.worktreePath, rel);
  if (listing) return json(listing);
  return json({ error: "not found" }, 404);
}

async function handleSessionWorktree({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[3] !== "worktree") return null;
  const s = deps.store.get(parts[2] ?? "");
  if (!s || s.status === "archived") return json({ error: "not found" }, 404);
  const rel = url.searchParams.get("path") ?? "";
  if (parts[4] === "download") return worktreeDownload(s, rel);
  if (!parts[4]) return worktreeList(s, rel);
  return null;
}

// ── scratchpad upload: POST /api/sessions/:id/scratchpad/upload[?path=] ──
// Accepts any binary file (no MIME restriction) up to MAX_UPLOAD_BYTES. The `?path` param
// is a relative subdir within the scratchpad root (default: root). The scratchpad root is
// created on demand (start-of-session path). Live sessions only; 404 on archived/unknown.
async function handleSessionScratchpadUpload({
  req,
  parts,
  url,
  deps,
}: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[3] === "scratchpad" && parts[4] === "upload")) return null;
  const s = deps.store.get(parts[2] ?? "");
  if (!s || s.status === "archived") return json({ error: "not found" }, 404);

  const file = await parseUploadFile(req);
  if (file instanceof Response) return file;

  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "file too large" }, 413);

  const rel = url.searchParams.get("path") ?? "";
  const dir = await resolveScratchpadUploadDir(s.worktreePath, s.claudeSessionId, rel);
  if (!dir) return json({ error: "not found" }, 404);

  const placed = await placeScratchpadUpload(dir.rootReal, dir.dirReal, file.name);
  if (!placed) return json({ error: "not found" }, 404);

  await Bun.write(placed.abs, file);
  return json({ path: placed.rel });
}

// Active sessions whose cached PR state is "merged" — the set "clear all merged"
// operates on. Reads the same prCache snapshot the UI partitions on, so server and
// client agree on what "merged" means without extra `gh` calls.
function mergedSessionIds(deps: AppDeps): string[] {
  const git = deps.prCache?.snapshot() ?? {};
  return deps.store
    .list({ activeOnly: true })
    .filter((s) => git[s.id]?.state === "merged")
    .map((s) => s.id);
}

// /api/sessions/clear-merged — bulk-close every merged-branch session.
//   GET  → { ids, leftovers } summary feeding the confirm modal.
//   POST {ids} → archive the merged subset, terminating each one's leftover
//     subprocesses. The client ids are intersected with the server's merged set
//     (re-validation) so a stale snapshot can never archive a still-live session;
//     an absent or non-array `ids` falls back to the full merged set (an explicit
//     empty array clears nothing). Returns what was actually cleared. Registered
//     before the generic :id handlers so the literal "clear-merged" segment is never
//     mistaken for a session id — including a 405 on DELETE/PUT so it can't fall
//     through to handleSessionDelete and emit a spurious archived event.
async function handleSessionsClearMerged({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[2] !== "clear-merged" || parts[3]) return null;
  const merged = new Set(mergedSessionIds(deps));
  if (req.method === "GET") {
    const ids = [...merged];
    const leftovers = ids.reduce((n, id) => n + deps.service.leftovers(id).length, 0);
    return json({ ids, leftovers });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const requested = Array.isArray(body?.ids)
    ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [...merged];
  const target = requested.filter((id) => merged.has(id)); // merged-only, no matter what was sent
  const { cleared, leftovers } = await deps.service.archiveMany(target);
  for (const id of cleared) {
    deps.prCache?.drop(id);
    deps.events.emit("session:archived", { id });
  }
  return json({ cleared, leftovers });
}

// DELETE /api/sessions/:id — archive. An optional `{reap: string[]}` body lists the
// leftover keys (from GET …/leftovers) the operator chose to terminate alongside.
async function handleSessionDelete({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "DELETE" && parts[2])) return null;
  const body = (await req.json().catch(() => null)) as { reap?: unknown } | null;
  const reap = Array.isArray(body?.reap)
    ? (body!.reap as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  await deps.service.archive(parts[2], reap);
  deps.prCache?.drop(parts[2]);
  deps.events.emit("session:archived", { id: parts[2] });
  return json({ ok: true });
}

// POST /api/sessions/:id/reply — steer a running session.
async function handleSessionReply({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "reply")) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  if (!body || typeof (body as { text?: unknown }).text !== "string") {
    return json({ error: "body must be {text: string}" }, 400);
  }
  // operatorReply() is the human free-text boundary: same false semantics as reply() (unknown id,
  // dead pane, or transient herdr-unreachable → 404 here), but it also injects the epic-authoring
  // notice once per session when the message signals epic intent (#1405). Internal steers keep
  // calling service.reply() directly, so they never trip that path.
  const ok = await deps.service.operatorReply(parts[2], (body as { text: string }).text);
  return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
}

// POST /api/sessions/:id/recommend-prompt — analyze the session's recent terminal history via a
// transient second agent (claude opus / codex gpt-5.5) and return a recommended next prompt.
// 200 {prompt} on success; 422 {error} on an analysis failure; 503 when unwired.
async function handleSessionRecommend({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "recommend-prompt")) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  const provider = (body as { provider?: unknown } | null)?.provider;
  const model = (body as { model?: unknown } | null)?.model;
  if ((provider !== "claude" && provider !== "codex") || typeof model !== "string" || !model) {
    return json({ error: "body must be {provider: 'claude'|'codex', model: string}" }, 400);
  }
  if (!deps.recommend) return json({ error: "unavailable" }, 503);
  const result = await deps.recommend(parts[2], provider, model);
  return "prompt" in result ? json({ prompt: result.prompt }) : json({ error: result.error }, 422);
}

// POST /api/sessions/:id/go — release an APPROVED planning session into execution.
// 200 when the plan-gate transition fires (planning + approved); 409 otherwise.
async function handleSessionGo({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "go")) return null;
  return (await deps.service.releasePlanGate(parts[2]))
    ? json({ ok: true })
    : json({ error: "plan not approved or not in planning phase" }, 409);
}

// POST /api/sessions/:id/answer-plan-questions — steer the operator's answers to the gate's
// question-form blocks back into the live planning agent (#803). Planning-phase only: the gate +
// its questions persist past approval and AUTO sessions auto-release into execution, so without the
// guard an operator could steer "incorporate answers, stop" into an already-executing agent.
// Mirrors handleSessionReply's content-type + body-shape guards.
async function handleSessionAnswerPlanQuestions({
  req,
  parts,
  deps,
}: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "answer-plan-questions")) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  const answers = (body as { answers?: unknown } | null)?.answers;
  if (
    !Array.isArray(answers) ||
    !answers.every(
      (a) =>
        !!a &&
        typeof a === "object" &&
        typeof (a as RawAnswer).blockId === "string" &&
        typeof (a as RawAnswer).questionId === "string",
    )
  ) {
    return json({ error: "body must be {answers: RawAnswer[]}" }, 400);
  }
  const id = parts[2];
  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);
  if (s.planPhase !== "planning") return json({ error: "not in planning phase" }, 409);
  const gate = deps.store.getPlanGate(id);
  if (!gate || !gate.blocks?.some((b) => b.type === "question-form")) {
    return json({ error: "no plan questions" }, 409);
  }
  const resolved = resolvePlanAnswers(gate.blocks, answers as RawAnswer[]);
  if (resolved.length === 0) return json({ error: "no answers resolved" }, 400);
  const delivered = await deps.service.reply(id, planAnswerSteerText(resolved));
  // Durably record the answered questions so the "unanswered plan question" attention signal
  // clears (#1332). Keys derive from the RESOLVED answers only — a dropped invalid/blank answer
  // never records a key. Re-fetch + planHash-guard so a concurrent finalize() that reset the
  // keys for a NEW planHash can't be clobbered by writing back a stale gate; the read-modify-
  // write is synchronous (no await between getPlanGate and putPlanGate) — the steer's await
  // above sits BEFORE the re-fetch, so it widens no window the planHash guard doesn't cover.
  const answeredKeys = resolved.map((r) => `${r.blockId} ${r.questionId}`);
  const fresh = deps.store.getPlanGate(id);
  if (fresh && fresh.planHash === gate.planHash) {
    const merged: PlanGate = {
      ...fresh,
      answeredQuestionKeys: [...new Set([...(fresh.answeredQuestionKeys ?? []), ...answeredKeys])],
    };
    deps.store.putPlanGate(merged);
    deps.events.emit("session:plangate", { id, gate: merged });
  }
  return json({ ok: true, delivered });
}

function previewLauncher(deps: AppDeps): NonNullable<AppDeps["previewLauncher"]> {
  return {
    findDevPort: deps.previewLauncher?.findDevPort ?? findPreviewDevPort,
    scriptExists: deps.previewLauncher?.scriptExists ?? previewScriptExists,
    scriptPath: deps.previewLauncher?.scriptPath ?? resolvePreviewStartScriptPath,
    ensureScript: deps.previewLauncher?.ensureScript ?? ensurePreviewStartScript,
    startScript: deps.previewLauncher?.startScript ?? startPreviewScript,
  };
}

type PreviewLauncher = NonNullable<AppDeps["previewLauncher"]>;

async function parsePreviewStartCommand(req: Request): Promise<string | undefined> {
  const body = (await req.json().catch(() => null)) as { command?: unknown } | null;
  const rawCommand = body && typeof body.command === "string" ? body.command.trim() : undefined;
  return rawCommand || undefined;
}

async function bindExistingPreviewServer(
  id: string,
  s: Session,
  deps: AppDeps,
  launcher: PreviewLauncher,
): Promise<Response | null> {
  const devPort = await launcher.findDevPort(s.worktreePath);
  if (devPort === null) return null;
  const previewPort = deps.preview?.ensure?.(id, devPort) ?? null;
  if (previewPort === null) return json({ error: "preview_slot_unavailable" }, 503);
  return json({
    ok: true,
    mode: "local",
    alreadyRunning: true,
    command: "existing dev server",
    previewPort,
  });
}

async function startStoredPreviewScript(
  s: Session,
  launcher: PreviewLauncher,
  storedScript: string | null,
  command: string | null,
): Promise<Response | null> {
  const canonicalScript = await launcher.scriptPath(s.worktreePath);
  if (storedScript === null || storedScript !== canonicalScript) return null;
  const scriptStillExists = await launcher.scriptExists(storedScript);
  if (!scriptStillExists) return null;
  try {
    await launcher.startScript(storedScript, s.worktreePath);
    return json({
      ok: true,
      mode: "local",
      command: command ?? storedScript,
      script: storedScript,
    });
  } catch {
    return null;
  }
}

async function sendPreviewSetupSteer(
  id: string,
  s: Session,
  deps: AppDeps,
  launcher: PreviewLauncher,
  cfg: RepoConfig,
  command: string | null,
): Promise<Response | null> {
  const canonicalScript = await launcher.scriptPath(s.worktreePath);
  const setupScriptPath =
    cfg.previewStartScript === canonicalScript ? cfg.previewStartScript : canonicalScript;
  if (setupScriptPath === null) return null;
  deps.store.setRepoConfig(s.repoPath, {
    ...cfg,
    previewStartScript: setupScriptPath,
    previewStartCommand: command,
  });
  const ok = await deps.service.reply(
    id,
    PREVIEW_SETUP_STEER({
      scriptPath: setupScriptPath,
      worktreePath: s.worktreePath,
      command,
      agentProvider: s.agentProvider ?? "claude",
    }),
  );
  return ok
    ? json({
        ok: true,
        mode: "agent_setup",
        command: command ?? "setup local preview script",
        script: setupScriptPath,
      })
    : json({ error: "not found" }, 404);
}

async function sendLegacyPreviewStart(
  id: string,
  s: Session,
  deps: AppDeps,
  command: string | null,
): Promise<Response> {
  const resolved = command ?? (await detectDevCommand(s.worktreePath));
  if (!resolved) return json({ error: "command_unknown" }, 409);
  const ok = await deps.service.startPreview(id, resolved);
  return ok
    ? json({ ok: true, mode: "agent", command: resolved })
    : json({ error: "not found" }, 404);
}

// POST /api/sessions/:id/preview/start — start a dev-server preview.
// Flow: already_bound? → 409. If a dev server already listens in the worktree,
// bind the proxy immediately. Otherwise run the repo's stored local preview script
// (`.git/shepherd/preview-start.sh`, path stored in repo_config). When the script
// is missing, send a one-time setup steer so the agent can author repo-specific
// local start logic instead of Shepherd guessing a generic dev command.
async function handlePreviewStart({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "preview" && parts[4] === "start"))
    return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;

  const id = parts[2];

  // 1. Already-bound check FIRST, before any fs work.
  if (deps.preview?.snapshot()[id]?.previewPort != null) {
    return json({ error: "already_bound" }, 409);
  }

  const s = deps.store.get(id);
  if (!s) return json({ error: "not found" }, 404);

  const bodyCommand = await parsePreviewStartCommand(req);
  const launcher = previewLauncher(deps);

  // 2. If the server is already running in this worktree but the preview proxy
  // has not bound yet, bind it now instead of spawning anything.
  const existingServer = await bindExistingPreviewServer(id, s, deps, launcher);
  if (existingServer) return existingServer;

  // 3. Prefer an existing local repo script. It lives under the repo's git common
  // dir and is recorded in repo_config, so it is shared by sessions for this repo
  // without entering the git-tracked working tree.
  const cfg = deps.store.getRepoConfig(s.repoPath);
  const storedScript = cfg.previewStartScript ?? null;
  const storedCommand = cfg.previewStartCommand ?? null;
  const detectedCommand = bodyCommand ?? storedCommand ?? (await detectDevCommand(s.worktreePath));

  const localStart = await startStoredPreviewScript(s, launcher, storedScript, detectedCommand);
  if (localStart) return localStart;

  // 4. No script yet: ask the session agent once to create a repo-specific local
  // script at the canonical path and remember that path in repo_config. Later
  // sessions for this repo can then start the script directly without LLM work.
  const setupStart = await sendPreviewSetupSteer(id, s, deps, launcher, cfg, detectedCommand);
  if (setupStart) return setupStart;

  // 5. Legacy fallback: if local script setup is not possible (for example no git
  // common dir), steer the agent exactly like previous versions did.
  return sendLegacyPreviewStart(id, s, deps, detectedCommand);
}

// POST /api/sessions/:id/preview/stop — force-stop the previewed dev server.
// Signals the worktree dev-server process (SIGKILL) to terminate and reclaim RAM.
// The preview clears via the poller sweep once the port stops listening (that
// port-gone event is the real confirmation) — this endpoint only dispatches the
// signal and reports how many processes it signalled.
//   unknown id   → 404 { error: "not found" }
//   not bound    → 409 { error: "not_bound" }
//   stopped      → 200 { killed: <n> }   (killed is a signals-SENT count)
function handlePreviewStop({ req, parts, deps }: Ctx): Response | null {
  if (!(req.method === "POST" && parts[2] && parts[3] === "preview" && parts[4] === "stop"))
    return null;
  const id = parts[2];
  const { result, killed } = deps.service.stopPreview(id, "SIGKILL");
  if (result === "not_found") return json({ error: "not found" }, 404);
  if (result === "not_bound") return json({ error: "not_bound" }, 409);
  return json({ killed });
}

// POST /api/sessions/:id/review-plan — operator-initiated (re)start of the adversarial plan
// review. 404 for an unknown id; 202 once the review is kicked off (consider() is fire-and-go).
// Mirrors /review-pr → reviewTrigger.force: this is a manual click, so it passes `force: true`
// to bypass the unchanged-plan dedupe (an operator re-clicking on an identical plan should still
// re-review). `status` tells the caller what happened: a reviewer actually spawned ("started"),
// the plan artifact is unavailable ("plan-unavailable"), a spawn attempt failed with a specific
// cause ("error-spawn" | "error-worktree" | "error-auth"), or
// nothing happened ("skipped" — a review is already in flight, the gate is already approved, or
// the session has left the plan phase; the route can't distinguish which), so the UI can explain
// the outcome without mislabelling a failure as a no-op.
async function handleSessionReviewPlan({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "review-plan")) return null;
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "not found" }, 404);
  const status = (await deps.planGate?.consider(s, { force: true })) ?? "skipped";
  return json({ ok: true, status }, 202);
}

// POST /api/sessions/:id/review-pr — operator-initiated (re)start of the critic review.
// 404 unknown id; 404 when the repo has no forge; 502 on a forge error; 202 with
// {status} = "started" | "skipped" | "error" so the UI can explain the outcome (fail-closed:
// "skipped"/"error" must never read as success). forceReview itself enforces the CI-green /
// open / critic-enabled / not-already-running preconditions and returns "skipped" when unmet.
async function handleSessionReviewPr({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "review-pr")) return null;
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "not found" }, 404);
  const forge = deps.resolveForge?.(s.repoPath) ?? null;
  if (!forge) return json({ error: "no forge for this repo" }, 404);
  try {
    const git = await resolveGitState(forge, s, deps);
    const status = (await deps.reviewTrigger?.force(s, git)) ?? "skipped";
    return json({ ok: true, status }, 202);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "forge error" }, 502);
  }
}

// POST /api/sessions/:id/recap/regenerate — force-regenerate the session recap on demand.
// 404 unknown id; 202 with {status} = "started" | "empty" | "error" so the UI can explain the outcome.
// NOTE: unlike the auto-fire sweep (which skips drain sessions), on-demand regenerate is
// intentionally allowed for ANY session — an operator may want a summary of a drain run.
async function handleSessionRecapRegenerate({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "recap" && parts[4] === "regenerate"))
    return null;
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "not found" }, 404);
  const status = (await deps.recap?.regenerate(s)) ?? "error";
  return json({ ok: true, status }, 202);
}

// Validate the rename body, returning the typed name or the error Response to send.
async function parseRenameName(req: Request): Promise<string | Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = await req.json().catch(() => null);
  const raw = (body as { name?: unknown })?.name;
  if (typeof raw !== "string" || raw.trim() === "") {
    return json({ error: "body must be {name: string}" }, 400);
  }
  return raw;
}

// Decide whether the local branch moves. An OPEN PR forces the host into the loop:
// GitHub retargets it by renaming the remote branch first (so `s.branch` never points
// away from the PR); a host that can't (Gitea) yields a display-only rename. Returns the
// flag, or a 502 Response when the remote rename failed.
async function resolveRenameBranch(
  deps: AppDeps,
  s: Session,
  newBranch: string,
  hasOpenPr: boolean,
): Promise<boolean | Response> {
  const renameLocalBranch = s.isolated && !!s.branch;
  if (!hasOpenPr || !renameLocalBranch || !s.branch) return renameLocalBranch;

  const forge = deps.resolveForge?.(s.repoPath) ?? null;
  if (!forge?.renameBranch) return false; // can't retarget → keep the branch + PR, display-only

  try {
    await forge.renameBranch(s.branch, newBranch);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "rename failed" }, 502);
  }
  return renameLocalBranch;
}

// POST /api/sessions/:id/rename — rename a session (display name + git branch).
// When a PR is already open the local branch only moves if the host can retarget the
// PR (GitHub renames the remote branch; Gitea can't, so it's a display-only rename).
async function handleSessionRename({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "rename")) return null;
  const raw = await parseRenameName(req);
  if (raw instanceof Response) return raw;
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "not found" }, 404);

  const slug = slugifyManual(raw);
  if (slug === s.name) return json({ session: s, branchRenamed: false, prRetargeted: false });

  const newBranch = `shepherd/${slug}`;
  if (s.isolated && deps.service.branchExists(s.repoPath, newBranch)) {
    return json({ error: "name_taken" }, 409);
  }

  // capture before the cache drop below, which would otherwise hide the open PR
  const hadOpenPr = deps.prCache?.snapshot()[s.id]?.state === "open";
  const renameLocalBranch = await resolveRenameBranch(deps, s, newBranch, hadOpenPr);
  if (renameLocalBranch instanceof Response) return renameLocalBranch;

  let updated: Session | null;
  try {
    updated = deps.service.rename(s.id, slug, { renameLocalBranch });
  } catch {
    return json({ error: "name_taken" }, 409); // git branch -m lost a race since the pre-check
  }
  if (!updated) return json({ error: "not found" }, 404);

  deps.prCache?.drop(s.id); // clear stale state; the next poll re-reads the new/retargeted branch
  deps.events.emit("session:renamed", {
    id: updated.id,
    name: updated.name,
    branch: updated.branch,
  });
  return json({
    session: updated,
    branchRenamed: renameLocalBranch,
    prRetargeted: renameLocalBranch && hadOpenPr,
  });
}

// POST /api/sessions/:id/resume — resume a finished session in a fresh agent.
// Body `{ force: true }` forces a fresh provider resume even when a husk shell
// still backs the worktree (agent exited but its herdr tab survived).
async function handleSessionResume({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "resume")) return null;
  const body = (await req.json().catch(() => null)) as { force?: unknown } | null;
  const s = await deps.service.resume(parts[2], { force: body?.force === true });
  if (!s) return json({ error: "cannot resume" }, 409);
  // flip the badge back to running + nudge clients to re-attach to the fresh agent
  deps.events.emit("session:status", { id: s.id, status: s.status });
  return json(s);
}

// POST /api/sessions/:id/ready — toggle the manual "ready to merge" flag.
async function handleSessionReady({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "ready")) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as { ready?: unknown } | null;
  if (!body || typeof body.ready !== "boolean") {
    return json({ error: "body must be {ready: boolean}" }, 400);
  }
  if (!deps.store.get(parts[2])) return json({ error: "not found" }, 404);
  deps.service.setReadyToMerge(parts[2], body.ready);
  return json({ ok: true });
}

// POST /api/sessions/:id/dismiss-stall — acknowledge a stall flag.
function handleSessionDismissStall({ req, parts, deps }: Ctx): Response | null {
  if (!(req.method === "POST" && parts[2] && parts[3] === "dismiss-stall")) return null;
  const ok = deps.poller?.acknowledgeStall(parts[2]) ?? false;
  return ok ? json({ ok: true }) : json({ error: "no stall to dismiss" }, 404);
}

// POST /api/sessions/:id/quota/resume — operator "Resume" for a quota-blocked session.
// Determines the block kind via quotaBlockReason (the pure detector), then:
//   plan kind → planGate.resume (resets round + re-delivers findings); status: "resumed"|"unreachable"
//   critic kinds (rework/review/error) → resolves forge + GitState (fail-closed: 502 on error),
//     merged/closed PR → clearStallState so block clears; status: "pr-merged"|"pr-closed"
//     open PR → reviewTrigger.force; status passthrough from force()
//   not stalled → 202 status: "not-stalled"
//   unknown id → 404; no forge → 404

/** Resume handler for critic-kind quota blocks (rework / review / error). */
async function resumeCriticQuota(s: Session, deps: AppDeps): Promise<Response> {
  const forge = deps.resolveForge?.(s.repoPath) ?? null;
  if (!forge) return json({ error: "no forge for this repo" }, 404);
  try {
    const git = await resolveGitState(forge, s, deps);
    if (git.state !== "open") {
      // PR closed/merged: block is moot — dismiss so the nudge clears
      deps.reviewTrigger?.clearStallState?.(s);
      return json({ ok: true, status: git.state === "merged" ? "pr-merged" : "pr-closed" }, 202);
    }
    const status = (await deps.reviewTrigger?.force(s, git)) ?? "skipped";
    return json({ ok: true, status }, 202);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "forge error" }, 502);
  }
}

async function handleSessionQuotaResume({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "quota" && parts[4] === "resume"))
    return null;
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "not found" }, 404);
  const reason = quotaBlockReason(
    s,
    deps.store.getReview(s.id),
    deps.store.getPlanGate(s.id),
    Date.now(),
  );
  if (!reason) return json({ ok: true, status: "not-stalled" }, 202);
  if (reason.quotaKind === "plan") {
    // `await` BEFORE `?? false`: without it `ok` would be an always-truthy Promise and every
    // unreachable pane would report "resumed".
    const ok = (await deps.planGate?.resume?.(s)) ?? false;
    return json({ ok: true, status: ok ? "resumed" : "unreachable" }, 202);
  }
  // critic kinds: rework / review / error
  return resumeCriticQuota(s, deps);
}

// POST /api/sessions/:id/quota/dismiss — operator "Dismiss / Take over" for a quota-blocked session.
// Determines the block kind via quotaBlockReason, resets the underlying row so the block
// clears on the next poll tick (does NOT re-trigger a review or re-deliver plan findings).
//   plan kind → planGate.dismiss (round reset, no steer)
//   critic kinds → reviewTrigger.clearStallState (counter reset, no re-review)
//   not stalled → 202 status: "not-stalled"
//   unknown id → 404
function handleSessionQuotaDismiss({ req, parts, deps }: Ctx): Response | null {
  if (!(req.method === "POST" && parts[2] && parts[3] === "quota" && parts[4] === "dismiss"))
    return null;
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "not found" }, 404);
  const reason = quotaBlockReason(
    s,
    deps.store.getReview(s.id),
    deps.store.getPlanGate(s.id),
    Date.now(),
  );
  if (!reason) return json({ ok: true, status: "not-stalled" }, 202);
  if (reason.quotaKind === "plan") {
    deps.planGate?.dismiss?.(s);
  } else {
    deps.reviewTrigger?.clearStallState?.(s);
  }
  return json({ ok: true, status: "dismissed" }, 202);
}

// PUT /api/sessions/:id/autopilot — set the per-session opt-in override.
// Body: { enabled: boolean | null }  (null = inherit the repo default)
async function handleSessionAutopilot({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "PUT" && parts[2] && parts[3] === "autopilot")) return null;
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
  const e = body.enabled;
  if (!(e === true || e === false || e === null)) {
    return json({ error: "enabled must be true, false, or null" }, 400);
  }
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "no session" }, 404);
  deps.store.setAutopilotState(parts[2], { enabled: e });
  const updated = deps.store.get(parts[2]);
  if (updated)
    deps.events.emit("session:autopilot", {
      id: parts[2],
      paused: updated.autopilotPaused,
      complete: updated.autopilotComplete,
      question: updated.autopilotQuestion,
      enabled: updated.autopilotEnabled,
    });
  return json(updated);
}

// PUT /api/sessions/:id/automerge — set the per-session full-auto-merge override.
// Body: { enabled: boolean | null }  (null = inherit the repo default)
async function handleSessionAutoMerge({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "PUT" && parts[2] && parts[3] === "automerge")) return null;
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
  const e = body.enabled;
  if (!(e === true || e === false || e === null)) {
    return json({ error: "enabled must be true, false, or null" }, 400);
  }
  const s = deps.store.get(parts[2]);
  if (!s) return json({ error: "no session" }, 404);
  deps.store.setAutoMergeState(parts[2], { enabled: e });
  const updated = deps.store.get(parts[2]);
  if (updated)
    deps.events.emit("session:automerge", {
      id: parts[2],
      enabled: updated.autoMergeEnabled,
    });
  return json(updated);
}

// Per-id guard against a concurrent second relaunch of the same card. The original
// stays non-archived across the async spawn→teardown window (so the step-1
// archived-check wouldn't catch it), and the UI's two-step arm is per-menu-instance
// — a re-opened menu or a second client isn't covered. Module-level so it's shared
// across requests within a process.
const inFlightRelaunch = new Set<string>();
const inFlightRestore = new Set<string>();

// Re-resolve a relaunch original's linked issue (by number) in the route — the service
// has no forge access. The issue BODY rides the argv into the new prompt, so an
// unresolvable issue would spawn a context-degraded replacement; the caller hard-aborts
// (502) on a `false` result instead, leaving the original intact for a retry. Returns the
// fresh IssueRef, `false` when the issue is gone/unreachable, or `undefined` when there's
// nothing to re-resolve (non-issue-linked, or a forge that can't fetch issues at all).
async function reResolveRelaunchIssue(
  original: Session,
  deps: Ctx["deps"],
): Promise<IssueRef | undefined | false> {
  if (original.issueNumber == null) return undefined;
  const forge = deps.resolveForge?.(original.repoPath) ?? null;
  // Capability gap: getIssue is OPTIONAL on GitForge. A forge that doesn't implement it
  // can never re-resolve, so hard-aborting would permanently break issue-linked relaunch
  // on that host. Fall back to relaunching WITHOUT the issue (drops the link — logged, not
  // silent), mirroring the drain's "a host without getIssue never blocks" stance. Both
  // supported forges (github/gitea) implement it, so today this is purely defensive.
  if (forge && typeof forge.getIssue !== "function") {
    console.warn(
      `[relaunch] forge for ${original.repoPath} has no getIssue; relaunching #${original.issueNumber} without issue context`,
    );
    return undefined;
  }
  let iss: import("./forge/types").Issue | null | undefined;
  try {
    iss = await forge?.getIssue?.(original.issueNumber);
  } catch {
    iss = null;
  }
  // getIssue is best-effort: github/gitea swallow BOTH a gone/closed issue AND a transient
  // forge error to null (they never throw), so the two are indistinguishable here. Both
  // hard-abort (502, original kept) under one neutral "couldn't re-resolve" message rather
  // than risk spawning a context-degraded replacement — distinguishing them would need a
  // forge-layer redesign (a discriminated gone-vs-error result).
  if (!iss) return false;
  return { number: iss.number, url: iss.url, title: iss.title, body: iss.body };
}

// Parse + validate the optional relaunch override body. A bare POST / empty body yields
// null (req.json() THROWS on an empty body — the .catch is load-bearing) → the unchanged
// quick-relaunch path (validateRelaunchOverrides(null) yields {}, so no validation runs).
// When a body IS present, every supplied field is run through the SAME validators create
// uses (confined repoPath, BRANCH_RE baseBranch, MODELS model, staging-dir images,
// unknown-key reject) — closing the create/relaunch asymmetry so an override can't reach
// worktree.create / the --model flag unguarded. Absent fields inherit the original's
// already-validated values and are NOT re-checked. Returns the overrides (null = quick
// relaunch) or a 400 Response mirroring create's body.
async function parseRelaunchOverrides(
  req: Request,
): Promise<{ overrides: RelaunchOverrides | null } | { error: Response }> {
  const rawBody = (await req.json().catch(() => null)) as unknown;
  const validated = validateRelaunchOverrides(rawBody, config.repoRoot);
  if (!validated.ok) return { error: json({ error: validated.error }, 400) };
  return { overrides: rawBody === null ? null : validated.value };
}

// Sentinel: the linked issue could not be re-resolved (gone/unreachable) → the handler
// maps it to a 502 without spawning or tearing anything down, so the original stays intact.
const RELAUNCH_ISSUE_UNRESOLVED = Symbol("relaunch-issue-unresolved");

// Decide the replacement's issueRef from the relaunch target repo. Re-resolve the linked
// issue ONLY for a same-repo relaunch (the service has no forge access). A cross-repo
// relaunch DROPS the issue (it belongs to the old repo's tracker) → undefined, so the
// original's claim is later released back to its backlog on archive (intentional,
// user-confirmed). Returns the sentinel when a same-repo re-resolve fails (gone/unreachable).
async function resolveRelaunchIssueRef(
  original: Session,
  targetRepo: string,
  deps: Ctx["deps"],
): Promise<IssueRef | undefined | typeof RELAUNCH_ISSUE_UNRESOLVED> {
  if (targetRepo !== original.repoPath) return undefined;
  const resolved = await reResolveRelaunchIssue(original, deps);
  return resolved === false ? RELAUNCH_ISSUE_UNRESOLVED : resolved;
}

// After a successful spawn: emit session:new (service.relaunch/create do not), re-stamp the
// new session's drain claim exactly like handleSessionCreate, then tear down the original.
// Returns whether the original was actually archived (teardown can fail, leaving it active).
async function finalizeRelaunch(
  original: Session,
  fresh: Session,
  issueRef: IssueRef | undefined,
  deps: Ctx["deps"],
): Promise<{ archived: boolean }> {
  const id = original.id;
  deps.events.emit("session:new", fresh);
  if (issueRef) {
    const { repoPath } = original;
    const number = issueRef.number;
    setTimeout(() => void claimLinkedIssue(deps.resolveForge?.(repoPath) ?? null, number), 0);
  }

  // Tear down the original — archiveMany auto-detects + reaps leftover subprocesses and
  // isolates teardown failures (unlike a bare archive(id)).
  const { cleared } = await deps.service.archiveMany([id]);
  const archived = cleared.includes(id);
  if (archived) {
    // Retain the original's claim ONLY when the replacement actually carries the issue
    // (issueRef truthy): then the new session owns ACTIVE_LABEL, so a relaunch isn't a
    // retire. If the issue was dropped (forge-without-getIssue fallback) or there was
    // none, do NOT retain — let drain.onArchived release the label so the issue is
    // re-queued, never left orphaned-claimed with nothing tracking it. Stamped on a
    // successful teardown and BEFORE the session:archived emit so the synchronous
    // onArchived consumes the flag. (On the not-cleared path no archived event fires, so
    // stamping there would leak a stale flag that could later mis-convert a manual abandon
    // of the still-live original into a retire.)
    if (issueRef) deps.drain?.retainClaim(id);
    deps.prCache?.drop(id);
    deps.events.emit("session:archived", { id });
  } else {
    // Teardown threw: the new task is still valid; surface the failure (no silent
    // success) — the original stays visible for manual decommission.
    console.warn(`[relaunch] teardown of original ${id} failed; left active`);
  }
  return { archived };
}

// POST /api/sessions/:id/relaunch — spawn a fresh replacement carrying the original's
// prompt + current per-task settings (re-resolving its linked issue), emit session:new,
// then decommission the original (retaining its drain claim — a relaunch is not a retire).
async function handleSessionRelaunch({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "relaunch")) return null;
  const b = firstRunBlock();
  if (b) return b;
  const id = parts[2];

  // In-flight guard: reject a concurrent second relaunch of the same id (409) before
  // anything is spawned, so no duplicate replacement is created.
  if (inFlightRelaunch.has(id))
    return json({ error: "relaunch already in progress", code: "in_progress" }, 409);
  inFlightRelaunch.add(id);
  try {
    const original = deps.store.get(id);
    if (!original) return json({ error: "not found" }, 404);
    if (original.status === "archived") return json({ error: "already archived" }, 409);

    const parsed = await parseRelaunchOverrides(req);
    if ("error" in parsed) return parsed.error;
    const { overrides } = parsed;
    const targetRepo = overrides?.repoPath ?? original.repoPath;

    // Decide the issueRef (502 on a same-repo re-resolve failure, leaving the original intact).
    const issueRef = await resolveRelaunchIssueRef(original, targetRepo, deps);
    if (issueRef === RELAUNCH_ISSUE_UNRESOLVED)
      return json({ error: "could not re-resolve linked issue", code: "issue_unresolved" }, 502);

    // Spawn the replacement. On failure the original is left fully intact (nothing torn
    // down yet — the service tears down its own partial new session).
    let fresh: Session;
    try {
      fresh = await deps.service.relaunch(id, issueRef, overrides ?? undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "relaunch failed";
      return json({ error: msg }, 502);
    }

    const { archived } = await finalizeRelaunch(original, fresh, issueRef, deps);
    return json({ session: fresh, archived }, 201);
  } finally {
    inFlightRelaunch.delete(id);
  }
}

const inFlightReplace = new Set<string>();

// POST /api/sessions/:id/replace — stop the current agent process and start a new provider/model
// in the SAME Shepherd session and worktree. This is intentionally not relaunch: no new branch,
// no new worktree, no archive event.
async function handleSessionReplace({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "replace")) return null;
  const id = parts[2];

  if (inFlightReplace.has(id))
    return json({ error: "replace already in progress", code: "in_progress" }, 409);
  inFlightReplace.add(id);
  try {
    const original = deps.store.get(id);
    if (!original) return json({ error: "not found" }, 404);
    if (original.status === "archived") return json({ error: "already archived" }, 409);

    const choice = await parseReplaceAgentChoice(req);
    if (!choice.ok) return choice.res;

    const issueRef = await reResolveRelaunchIssue(original, deps);
    if (issueRef === false)
      return json({ error: "could not re-resolve linked issue", code: "issue_unresolved" }, 502);

    let session: Session;
    try {
      session = await deps.service.replaceAgent(
        id,
        issueRef ? { ...choice.value, issueRef } : choice.value,
      );
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "replace failed" }, 502);
    }
    deps.events.emit("session:status", session);
    return json({ session }, 200);
  } finally {
    inFlightReplace.delete(id);
  }
}

// Serialize concurrent same-key calls behind a 409: add the key, run, always remove. Shared by
// the variant + compare routes (the relaunch route keeps its own copy with bespoke messaging).
async function guardInFlight(
  set: Set<string>,
  key: string,
  label: string,
  run: () => Promise<Response>,
): Promise<Response> {
  if (set.has(key))
    return json({ error: `${label} already in progress`, code: "in_progress" }, 409);
  set.add(key);
  try {
    return await run();
  } finally {
    set.delete(key);
  }
}

type ModelChoice = Extract<ReturnType<typeof validateModelChoice>, { ok: true }>["value"];
type ReplaceAgentChoice = Extract<
  ReturnType<typeof validateReplaceAgentChoice>,
  { ok: true }
>["value"];

// Parse + validate a `{ agentProvider?, model? }` body for the variant/compare routes.
async function parseModelChoice(
  req: Request,
): Promise<{ ok: true; value: ModelChoice } | { ok: false; res: Response }> {
  const body = (await req.json().catch(() => null)) as unknown;
  const choice = validateModelChoice(body);
  return choice.ok
    ? { ok: true, value: choice.value }
    : { ok: false, res: json({ error: choice.error }, 400) };
}

async function parseReplaceAgentChoice(
  req: Request,
): Promise<{ ok: true; value: ReplaceAgentChoice } | { ok: false; res: Response }> {
  const body = (await req.json().catch(() => null)) as unknown;
  const choice = validateReplaceAgentChoice(body);
  return choice.ok
    ? { ok: true, value: choice.value }
    : { ok: false, res: json({ error: choice.error }, 400) };
}

// Per-original-id guard against concurrent first-variant spawns. The experiment back-fill on the
// original is a read-modify-write; without serializing on the ORIGINAL id, two near-simultaneous
// "start variant" calls could each mint a fresh experiment id and split the group in two.
const inFlightVariant = new Set<string>();

// POST /api/sessions/:id/variant — spawn a parallel comparison VARIANT (same prompt, different
// model/CLI) of the target, leaving the original ALIVE and linking both into one experiment.
// Emits session:new for the variant and session:experiment for the (possibly back-filled) original
// so both cards live-update. Carries NO issue link (no double-claim) — see service.startVariant.
async function handleSessionVariant({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "variant")) return null;
  const id = parts[2];
  return guardInFlight(inFlightVariant, id, "variant", async () => {
    const original = deps.store.get(id);
    if (!original) return json({ error: "not found" }, 404);
    if (original.status === "archived") return json({ error: "already archived" }, 409);

    const choice = await parseModelChoice(req);
    if (!choice.ok) return choice.res;

    let result: { variant: Session; original: Session };
    try {
      result = await deps.service.startVariant(id, choice.value);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "variant failed" }, 502);
    }
    deps.events.emit("session:new", result.variant);
    deps.events.emit("session:experiment", {
      id: result.original.id,
      experimentId: result.original.experimentId,
      experimentRole: result.original.experimentRole,
    });
    return json({ session: result.variant }, 201);
  });
}

// POST /api/experiments/:id/compare — spawn the read-only comparison session for an experiment.
// Top-level (parts[1] === "experiments"), registered in the main route table.
const inFlightCompare = new Set<string>();
async function handleExperimentCompare({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[0] === "api" && parts[1] === "experiments")) return null;
  if (!(parts[2] && parts[3] === "compare")) return null;
  const experimentId = parts[2];
  return guardInFlight(inFlightCompare, experimentId, "comparison", async () => {
    const choice = await parseModelChoice(req);
    if (!choice.ok) return choice.res;

    let session: Session;
    try {
      session = await deps.service.startComparison(experimentId, choice.value);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "comparison failed" }, 502);
    }
    deps.events.emit("session:new", session);
    return json({ session }, 201);
  });
}

// POST /api/sessions/:id/restore — bring an archived session back into the active Herd.
// Re-creates the worktree (if isolated), resumes the Claude conversation, clears archivedAt.
async function handleSessionRestore({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "POST" && parts[2] && parts[3] === "restore")) return null;
  const id = parts[2];

  if (inFlightRestore.has(id))
    return json({ error: "restore already in progress", code: "in_progress" }, 409);
  inFlightRestore.add(id);
  try {
    let s: import("./types").Session | null;
    try {
      s = await deps.service.restore(id);
    } catch (e) {
      if (e instanceof RestoreError) {
        return json({ error: e.message, code: e.code }, 409);
      }
      if (e instanceof WorktreeRestoreError) {
        return json({ error: e.message, code: e.code }, 409);
      }
      throw e;
    }
    if (!s) {
      if (!deps.store.get(id)) return json({ error: "not found" }, 404);
      return json({ error: "could not restore", code: "spawn_refused" }, 409);
    }
    deps.events.emit("session:new", s);
    return json(s);
  } finally {
    inFlightRestore.delete(id);
  }
}

// POST /api/sessions/:id/relaunch-uploads — stage the original's uploaded images so a
// relaunch composer can seed them as carried-over chips. Read-only on the session: it
// copies (not moves) the originals into staging and returns { images: [{ path, name }] }.
// Distinct from /relaunch (different parts[3]) — no spawn, no decommission.
function handleRelaunchUploads({ req, parts, deps }: Ctx): Response | null {
  if (!(req.method === "POST" && parts[2] && parts[3] === "relaunch-uploads")) return null;
  const id = parts[2];
  const original = deps.store.get(id);
  if (!original) return json({ error: "not found" }, 404);
  if (original.status === "archived") return json({ error: "already archived" }, 409);
  return json({ images: deps.service.stageRelaunchImages(id) }, 200);
}

// Steer text sent to the agent when the operator approves the build queue.
// Agent-facing — plain English, not user chrome, so no i18n.
const APPROVE_STEER =
  "✅ Build queue approved by the operator. Begin now: work the steps in order, marking each step active then done via the build-queue API as you go (see the build-queue instructions in your system prompt). If you find a better approach, revise only the remaining pending steps — never rewrite completed ones.";

// PUT /api/sessions/:id/queue — replace the full step list.
async function putBuildQueue(req: Request, deps: AppDeps, id: string): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const steps = validateBuildSteps(await req.json().catch(() => null));
  if (steps === null) return json({ error: "invalid build steps" }, 400);
  const q = deps.store.replaceBuildQueue(id, steps);
  deps.events?.emit("queue:update", q);
  return json(q);
}

// POST /api/sessions/:id/queue/steps/:stepId — set a single step's status.
async function postBuildStepStatus(
  req: Request,
  deps: AppDeps,
  id: string,
  stepId: string,
): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const status = validateBuildStepStatus(await req.json().catch(() => null));
  if (status === null) return json({ error: "invalid status" }, 400);
  // Resolve the posted id (full UUID or unambiguous ≥8-char prefix) before updating, so a
  // short/abbreviated or stale id returns a clear 4xx instead of silently no-op'ing.
  const resolved = deps.store.resolveStepId(id, stepId);
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") {
      return json(
        {
          error: `ambiguous step id prefix "${stepId}" matches ${resolved.matches.length} steps — use a longer prefix or the full id`,
          matches: resolved.matches,
        },
        409,
      );
    }
    return json(
      {
        error: `step "${stepId}" not found — use a full or unambiguous (≥8-char) prefix step id from the PUT/GET response`,
      },
      404,
    );
  }
  // resolved.ok ⇒ the row exists, so setBuildStepStatus returns true; ignore its boolean.
  deps.store.setBuildStepStatus(id, resolved.id, status);
  const q = deps.store.getBuildQueue(id);
  deps.events?.emit("queue:update", q);
  return json(q);
}

// POST /api/sessions/:id/queue/approve — human gate: approve + steer the agent.
async function approveBuildQueue(deps: AppDeps, id: string): Promise<Response> {
  deps.store.setBuildQueueApproved(id, true, "operator");
  const q = deps.store.getBuildQueue(id);
  deps.events?.emit("queue:update", q);
  // Awaited so the "Begin now" steer has landed before the operator sees the approved queue, and
  // so a failed send still surfaces as a 500 (exactly as the sync throw did pre-#1567). The
  // boolean is still ignored: a dead pane must not un-approve the queue.
  await deps.service.reply(id, APPROVE_STEER);
  return json(q);
}

// /api/sessions/:id/hooks — Phase-0 push-hook ingest (issue #704).
// Returns null for any path it doesn't own so other session sub-routes fall through
// (registered before handleSessions, mirroring handleBuildQueue's ordering rationale).
//
// Deliberately NO requireJsonContentType gate (Finding 1): the POST body is authored by
// Claude Code's own http-hook client, not a Shepherd curl with an explicit
// `Content-Type: application/json`, so its Content-Type is unverified — a hard 415 could
// silently record ZERO events for the whole spike. Parse defensively instead. The handler
// does validate + record only — no file parse, no synchronous PTY/herdr read on the Bun
// loop (memory: single-loop-no-sync-exec).
async function handleSessionHooks({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "sessions" && parts[3] === "hooks")) return null;
  const id = parts[2];
  if (!id || parts[4]) return null;

  if (req.method === "GET") return json(deps.hooks?.snapshot(id) ?? []);
  if (req.method !== "POST") return null;

  const session = deps.store.get(id);
  if (!session) return json({ error: "session not found" }, 404);

  const body = await req.json().catch(() => null);
  const raw = validateHookEvent(body);
  if (!raw) return json({ error: "invalid hook event" }, 400);

  // Cross-check the untrusted body's session_id against the resolved session's
  // claudeSessionId. On mismatch we still record (for the spike's visibility) but flag
  // `match: false` so HookIngest treats it as observe-only and never forwards to signals.
  const match = raw.sessionId === session.claudeSessionId;
  deps.hooks?.record(id, { ...raw, receivedAt: Date.now(), match });
  return json({ ok: true }, 202);
}

// /api/sessions/:id/queue[/steps/:stepId | /approve]
// Returns null for any path it doesn't own so other session sub-routes fall through.
async function handleBuildQueue({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "sessions" && parts[3] === "queue")) return null;
  const id = parts[2];
  if (!id) return null;
  if (!deps.store.get(id)) return json({ error: "session not found" }, 404);

  if (req.method === "GET" && !parts[4]) return json(deps.store.getBuildQueue(id));
  if (req.method === "PUT" && !parts[4]) return putBuildQueue(req, deps, id);
  if (req.method === "POST" && parts[4] === "steps" && parts[5])
    return postBuildStepStatus(req, deps, id, parts[5]);
  if (req.method === "POST" && parts[4] === "approve") return approveBuildQueue(deps, id);
  return null;
}

// PUT /api/sessions/:id/epic-draft — author/replace the epic draft (issue #1507). Structural
// validation + semantic validation (cycles/edges) before store; emits session:epic-draft.
async function putEpicDraft(req: Request, deps: AppDeps, id: string): Promise<Response> {
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const existing = deps.store.getEpicDraft(id);
  // Only a draft may be (re)authored — a materializing or approved epic is frozen (the amend loop
  // runs before approval). Guards against a late agent re-PUT racing/overwriting a created epic.
  if (existing && existing.status !== "draft")
    return json({ error: `epic draft is ${existing.status}, not editable` }, 409);
  const content = validateEpicDraftBody(await req.json().catch(() => null));
  if (content === null) return json({ error: "invalid epic draft" }, 400);
  const semantic = validateEpicDraft(content);
  if (!semantic.ok) return json({ error: semantic.error }, 400);
  const draft = deps.store.replaceEpicDraft(id, content);
  deps.events?.emit("session:epic-draft", draft);
  return json(draft);
}

// POST /api/sessions/:id/epic-draft/approve — the HARD GATE. Materializes the draft into GitHub
// issues (children first, then the parent with an epic-dag fence, then native links), registers the
// epic run so Shepherd recognizes it immediately, and marks the draft approved. CAS-guarded against
// double-submit; resumable across a partial/failed materialize (see src/epic-author.ts).
// Resolve + guard an approve: returns an early Response (idempotent hit / 4xx) OR the validated
// context the materialize needs. Extracted so approveEpicDraft stays under the complexity gate.
function resolveApproveContext(
  deps: AppDeps,
  id: string,
):
  | { done: Response }
  | { session: Session; forge: GitForge; value: Parameters<typeof materializeEpicDraft>[1] } {
  const session = deps.store.get(id);
  if (!session) return { done: json({ error: "session not found" }, 404) };
  const draft = deps.store.getEpicDraft(id);
  if (!draft) return { done: json({ error: "no epic draft to approve" }, 404) };
  if (draft.status === "approved" && draft.parentNumber != null) {
    // Idempotent: a repeat approve returns the already-created epic's result.
    return {
      done: json({
        parentNumber: draft.parentNumber,
        parentUrl: draft.parentUrl ?? "",
        childNumbers: draft.materializedChildren,
        importResult: null,
      }),
    };
  }
  const semantic = validateEpicDraft(draft);
  if (!semantic.ok) return { done: json({ error: semantic.error }, 400) };
  const forge = deps.resolveForge?.(session.repoPath) ?? null;
  if (!forge) return { done: json({ error: "no forge for this repo" }, 400) };
  if (!forgeSupportsIssueCreation(forge))
    return { done: json({ error: "issue creation unavailable for this repo" }, 400) };
  return { session, forge, value: semantic.value };
}

async function approveEpicDraft(deps: AppDeps, id: string): Promise<Response> {
  const ctx = resolveApproveContext(deps, id);
  if ("done" in ctx) return ctx.done;
  const { session, forge, value } = ctx;
  const draft = deps.store.getEpicDraft(id)!;

  // CAS draft → materializing BEFORE the first createIssue. Loser (a concurrent approve / WS retry)
  // gets 409 — only the winner proceeds, so no duplicate issues.
  if (!deps.store.beginEpicDraftMaterialize(id))
    return json({ error: "epic materialize already in progress" }, 409);

  try {
    const result = await materializeEpicDraft(forge, value, {
      alreadyCreated: draft.materializedChildren,
      parentNumber: draft.parentNumber,
      parentUrl: draft.parentUrl,
      onChildCreated: (key, number) => deps.store.recordEpicDraftChild(id, key, number),
      onParentCreated: (number, url) => deps.store.recordEpicDraftParent(id, number, url),
    });
    // Recognition: a fence in a fresh parent body is not auto-discovered — register the epic run so
    // buildEpic assembles it (mirrors handleEpicPut). Supersedes any prior run for this repo.
    let epic: Epic | null = null;
    if (deps.drain) {
      deps.store.setEpicRun(defaultEpicRun(session.repoPath, result.parentNumber));
      epic = await deps.drain.buildEpic(session.repoPath, deps.store.getEpicRun(session.repoPath)!);
      if (epic) deps.events?.emit("epic:update", epic);
    }
    deps.store.setEpicDraftApproved(id, result.parentNumber, result.parentUrl);
    deps.events?.emit("session:epic-draft", deps.store.getEpicDraft(id));
    return json({ ...result, epic });
  } catch (e) {
    // On error revert materializing → draft (retaining the persisted partial map) so an explicit
    // retry re-wins the CAS and resumes. Never leaves the row stuck at materializing.
    deps.store.revertEpicDraftToDraft(id);
    deps.events?.emit("session:epic-draft", deps.store.getEpicDraft(id));
    return json({ error: e instanceof Error ? e.message : "epic materialize failed" }, 500);
  }
}

// /api/sessions/:id/epic-draft[/approve]
// Returns null for any path it doesn't own so other session sub-routes fall through.
async function handleEpicDraft({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "sessions" && parts[3] === "epic-draft")) return null;
  const id = parts[2];
  if (!id) return null;
  if (!deps.store.get(id)) return json({ error: "session not found" }, 404);

  if (req.method === "GET" && !parts[4]) return json(deps.store.getEpicDraft(id));
  if (req.method === "PUT" && !parts[4]) return putEpicDraft(req, deps, id);
  if (req.method === "POST" && parts[4] === "approve" && !parts[5])
    return approveEpicDraft(deps, id);
  return null;
}

// Sessions core: dispatch to the create / read / delete / reply sub-handlers,
// preserving the original inner guard order. Returns null for anything those
// don't claim (e.g. `…/git` sub-routes), so handleSessionGit can pick it up.
async function handleSessions(ctx: Ctx): Promise<Response | null> {
  const { parts } = ctx;
  if (parts[0] !== "api" || parts[1] !== "sessions") return null;
  for (const sub of [
    handleSessionsClearMerged,
    handleSessionCreate,
    handleSessionReads,
    handleSessionScratchpad,
    handleSessionScratchpadUpload,
    handleSessionWorktree,
    handleSessionDelete,
    handleSessionReply,
    handleSessionRecommend,
    handleSessionGo,
    handleSessionAnswerPlanQuestions,
    handleSessionReviewPlan,
    handleSessionReviewPr,
    handleSessionRecapRegenerate,
    handlePreviewStart,
    handlePreviewStop,
    handleSessionRename,
    handleSessionResume,
    handleSessionReady,
    handleSessionDismissStall,
    handleSessionQuotaResume,
    handleSessionQuotaDismiss,
    handleSessionAutopilot,
    handleSessionAutoMerge,
    handleSessionRelaunch,
    handleSessionReplace,
    handleSessionVariant,
    handleSessionRestore,
    handleRelaunchUploads,
  ]) {
    const res = await sub(ctx);
    if (res) return res;
  }
  return null;
}

// ── git host (forge) actions: /api/sessions/:id/git[/pr|/merge|/redeploy] ──
async function forgeOpenPr(
  forge: GitForge,
  session: Session,
  req: Request,
  deps: AppDeps,
): Promise<Response> {
  const head = session.branch ?? "";
  const body = (await req.json().catch(() => ({}))) as { title?: string; body?: string };
  const cfg = deps.store.getRepoConfig(session.repoPath);
  let status: PrStatus;
  try {
    status = await forge.openPr({
      head,
      base: session.baseBranch,
      title: body.title?.trim() || session.name,
      body: body.body ?? session.prompt,
      draft: cfg.draftMode,
    });
  } catch (err) {
    // Nothing to open a PR for (no net diff vs base) → a clean 409, not a 500.
    if (err instanceof EmptyDiffError) return json({ error: "no commits to merge" }, 409);
    throw err;
  }
  const me = (await forge.currentUser?.()) ?? null;
  const git: GitState = annotateHandoff({ kind: forge.kind, ...status }, session.repoPath, me);
  deps.prCache?.set(session.id, git);
  deps.events.emit("session:git", { id: session.id, git });
  return json(status);
}

async function forgeMerge(
  forge: GitForge,
  session: Session,
  req: Request,
  deps: AppDeps,
): Promise<Response> {
  const head = session.branch ?? "";
  const body = (await req.json().catch(() => ({}))) as {
    method?: MergeMethod;
    deleteBranch?: boolean;
  };
  const cur = await forge.prStatus(head);
  if (cur.state !== "open" || !cur.number) {
    return json({ error: "no open PR to merge" }, 409);
  }
  try {
    await forge.merge(cur.number, {
      method: body.method ?? forge.mergeMethod,
      deleteBranch: body.deleteBranch ?? true,
    });
  } catch (err) {
    if (err instanceof MergeConflictError)
      return json({ error: "merge conflict — resolve manually before merging" }, 409);
    if (err instanceof BaseCheckoutBusyError)
      return json(
        { error: "base branch checkout has uncommitted changes or moved — commit/stash and retry" },
        409,
      );
    throw err;
  }
  // Evict the repo's open-PR snapshot so the backlog PRs panel for this repo can't
  // re-list this merged PR from a still-TTL-fresh cache. No-op for incapable forges
  // (local / null slug), so it's safe on both the local and host branches below.
  deps.openPrSnapshot?.invalidate?.(forge);
  // Lightweight (local) merge happened in-tree — nobody else tears the session down (no host
  // poller path, no merge train), so the worktree/branch would leak. Settle it here, mirroring
  // AutoMergeService.doMerge's callbacks. Forge sessions keep the current behavior: a human
  // merges on the host and the poller-driven archive path handles teardown.
  if (forge.kind === "local") {
    // #1401: record epic integration BEFORE settleMergedSession (the #1037 guard reads the
    // fresh row to archive-only). LocalForge reports no PR base, so the helper's
    // base-incapable carve-out trusts session.baseBranch — same as the retire path.
    await recordEpicIntegrationIfChild(
      session,
      { number: cur.number, url: cur.url, baseRefName: cur.baseRefName },
      { store: deps.store, forge },
    );
    await settleMergedSession(session, {
      resolveForge: (repoPath) => deps.resolveForge?.(repoPath) ?? null,
      archive: (id) => deps.service.archive(id),
      dropPrCache: (id) => deps.prCache?.drop(id),
      emitArchived: (id) => deps.events.emit("session:archived", { id }),
      retainClaim: (id) => deps.drain?.retainClaim(id),
      // #1037: never close an integrated epic child out of band on the local-merge path either.
      isIntegratedEpicChild: (sess) =>
        sess.issueNumber != null &&
        deps.store.isEpicIntegratedChild(sess.repoPath, sess.issueNumber),
    });
    return json({ ...cur, state: "merged" as const });
  }
  const status = await forge.prStatus(head);
  const me = (await forge.currentUser?.()) ?? null;
  const git: GitState = annotateHandoff({ kind: forge.kind, ...status }, session.repoPath, me);
  deps.prCache?.set(session.id, git);
  deps.events.emit("session:git", { id: session.id, git });
  return json(status);
}

async function forgeRedeploy(forge: GitForge, session: Session): Promise<Response> {
  if (!forge.deployWorkflow) {
    return json({ error: "no deploy workflow configured" }, 400);
  }
  await forge.redeploy({ workflow: forge.deployWorkflow, ref: session.baseBranch });
  return json({ ok: true });
}

async function refreshSessionGit(
  forge: GitForge,
  session: Session,
  deps: AppDeps,
): Promise<GitState> {
  const me = (await forge.currentUser?.()) ?? null;
  const git: GitState = annotateHandoff(
    { kind: forge.kind, ...(await forge.prStatus(session.branch ?? "")) },
    session.repoPath,
    me,
  );
  deps.prCache?.set(session.id, git);
  deps.events.emit("session:git", { id: session.id, git });
  return git;
}

function unsignedDraftModeReadyResponse(
  session: Session,
  cur: PrStatus,
  deps: AppDeps,
): Response | null {
  const cfg = deps.store.getRepoConfig(session.repoPath);
  if (!cfg.draftMode) return null;

  const review = deps.store.getReview(session.id);
  const view: SignoffView = {
    humanApproved: cur.latestReview?.state === "approved",
    reviewDecision: review?.decision ?? null,
    findings: review?.findings ?? [],
    reviewHeadSha: review?.headSha ?? null,
    headSha: cur.headSha ?? null,
  };
  if (signedOff(cfg.signoffAuthority, view)) return null;

  return json(
    {
      code: "draft_awaiting_signoff",
      error:
        "This repo is in draft mode and the PR is still awaiting sign-off; approve it or change the sign-off setting before marking it ready for review.",
    },
    409,
  );
}

async function forgeSetDraftState(
  forge: GitForge,
  session: Session,
  draft: boolean,
  deps: AppDeps,
): Promise<Response> {
  const cur = await forge.prStatus(session.branch ?? "");
  if (cur.state !== "open" || !cur.number) {
    return json({ error: "no open PR" }, 409);
  }
  if (!draft) {
    const blocked = unsignedDraftModeReadyResponse(session, cur, deps);
    if (blocked) return blocked;
  }
  if (!!cur.isDraft !== draft) {
    const action = draft ? forge.convertToDraft : forge.markReady;
    if (!action) {
      return json({ error: "forge does not support changing draft state" }, 400);
    }
    await action.call(forge, cur.number);
  }
  return json(await refreshSessionGit(forge, session, deps));
}

async function dispatchForgeAction(
  forge: GitForge,
  session: Session,
  ctx: Ctx,
): Promise<Response | null> {
  const { req, parts, deps } = ctx;
  if (req.method === "GET") {
    if (!parts[4]) return await forgeGitStateResponse(forge, session, deps);
    return null;
  }
  if (req.method === "POST") {
    if (parts[4] === "pr") return forgeOpenPr(forge, session, req, deps);
    if (parts[4] === "merge") return forgeMerge(forge, session, req, deps);
    if (parts[4] === "redeploy") return forgeRedeploy(forge, session);
    if (parts[4] === "ready") return forgeSetDraftState(forge, session, false, deps);
    if (parts[4] === "draft") return forgeSetDraftState(forge, session, true, deps);
  }
  return null;
}

// Compute the session's live, trust-guarded PR GitState — the same trust logic the
// background poller uses (trustsTerminal): keep a genuinely-merged/closed PR when the
// session is merge-train-flagged or the cache already owned this PR, else drop a
// reused-branch-name collision to "none". Shared by the GET /git route and the
// POST /review-pr route so both observe the identical value.
async function resolveGitState(
  forge: GitForge,
  session: Session,
  deps: AppDeps,
): Promise<GitState> {
  const me = (await forge.currentUser?.()) ?? null;
  const prev = deps.prCache?.get(session.id);
  const marked = session.mergingSince != null;
  const markedNumber = session.mergingPrNumber ?? null;
  // The same trust guard the poller applies to every status result: keep a genuinely
  // merged/closed PR when merge-train-flagged or already-owned, else drop a reused
  // branch-name collision to "none".
  const guard = (raw: GitState): GitState =>
    trustsTerminal(prev, raw, marked, markedNumber)
      ? raw
      : guardStaleTerminal(raw, (headSha) => deps.ownsPr?.(session, headSha) ?? null);

  let result = guard(
    annotateHandoff(
      { kind: forge.kind, ...(await forge.prStatus(session.branch ?? "")) },
      session.repoPath,
      me,
    ),
  );
  // No PR for the stored branch: the agent may have renamed the worktree branch out
  // from under us. Adopt the live branch and retry against it — mirrors the poller's
  // statusPerSession so GitRail recognizes a renamed-branch PR the same way, and so a
  // resolved "none" is authoritative (the caller can safely clear a stale cached PR).
  if (result.state === "none") {
    const live = deps.service.syncWorktreeBranch?.(session.id) ?? null;
    if (live && live !== session.branch) {
      result = guard(
        annotateHandoff(
          { kind: forge.kind, ...(await forge.prStatus(live)) },
          session.repoPath,
          me,
        ),
      );
    }
  }
  const issueUrl = buildIssueUrl(forge.webUrl, session.issueNumber);
  if (issueUrl) result.issueUrl = issueUrl;
  return result;
}

/**
 * GET /api/sessions/:id/git — the session's current PR status, with the same trust
 * logic as the background poller (trustsTerminal): keep a genuinely-merged/closed PR
 * when the session is merge-train-flagged or the cache already owned this PR, else
 * drop a reused-branch-name collision to "none" so GitRail and the list overview agree.
 */
async function forgeGitStateResponse(
  forge: GitForge,
  session: Session,
  deps: AppDeps,
): Promise<Response> {
  const result = await resolveGitState(forge, session, deps);
  // Write-through: the git-rail's live GET is otherwise a read-only side channel the
  // session card's cache (`prCache` + `session:git`) never sees, so a PR the poller
  // hasn't cached stays invisible on the card while the detail view shows it. Feed the
  // freshly-resolved state back into the shared cache and broadcast it — bounded to a
  // genuine change (the poller's own gate), and "meaningful" so we surface a PR or clear
  // one that was really there, but never emit a no-PR `none` for a session that never had
  // one. `resolveGitState` reconciles a renamed branch first, so a `none` here is
  // authoritative enough to clear a stale cached PR.
  const prev = deps.prCache?.get(session.id);
  const meaningful = result.state !== "none" || (prev != null && prev.state !== "none");
  if (deps.prCache && meaningful && gitStateChanged(prev, result)) {
    deps.prCache.set(session.id, result);
    deps.events.emit("session:git", { id: session.id, git: result });
  }
  return json(result);
}

async function handleSessionGit(ctx: Ctx): Promise<Response | null> {
  const { parts, deps } = ctx;
  if (!(parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "git")) {
    return null;
  }
  const session = deps.store.get(parts[2]);
  if (!session) return json({ error: "not found" }, 404);
  const forge = deps.resolveForge?.(session.repoPath) ?? null;
  if (!forge) return json({ error: "no forge for this repo" }, 404);
  try {
    return await dispatchForgeAction(forge, session, ctx);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "forge error" }, 502);
  }
}

/** GET /api/usage/github — live REST + GraphQL rate-limit buckets. Extracted so the
 *  unavailable/try-catch branches don't inflate handleUsageLimits's complexity. */
async function githubRateLimitResponse(deps: AppDeps): Promise<Response> {
  if (!deps.githubRateLimit) {
    return json({ error: "github rate limit unavailable" }, 503);
  }
  try {
    return json(await deps.githubRateLimit());
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "github rate limit error" }, 502);
  }
}

// POST /api/usage/refresh — re-scrape usage and return the fresh limits. Extracted from
// handleUsageLimits so the multi-route dispatcher stays lean and this spawn-triggering path
// (blocked while first-run pending) is a single focused unit.
async function handleUsageRefresh(deps: Ctx["deps"]): Promise<Response> {
  const b = firstRunBlock();
  if (b) return b;
  // No live calibrator (tests): fall back to the current snapshot, treated as a successful read.
  const { limits, scraped } = deps.refreshUsage
    ? await deps.refreshUsage()
    : { limits: deps.usageLimits.limits(Date.now()), scraped: true };
  // Fail closed: a refresh that didn't actually re-scrape (probe failed, or skipped) must NOT
  // look like success — return non-OK so the client surfaces its retry state instead of silently
  // keeping the stale numbers. Subscription-only attempts no scrape, so it never trips.
  if (!scraped && !limits.subscriptionOnly) {
    return json({ error: "usage refresh did not re-scrape", code: "refresh_stale" }, 503);
  }
  return json(limits); // success: unwrapped bare UsageLimits (client contract unchanged)
}

async function handleUsageLimits({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "usage" &&
    parts[2] === "refresh"
  ) {
    return handleUsageRefresh(deps);
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "usage" && parts[2] === "limits") {
    const now = Date.now();
    return json({
      limits: deps.usageLimits.limits(now),
      projections: deps.usageLimits.projections(now),
    });
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "usage" && parts[2] === "github") {
    return githubRateLimitResponse(deps);
  }
  if (
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "usage" &&
    parts[2] === "history"
  ) {
    const now = Date.now();
    const since = now - USAGE_HISTORY_RETENTION_MS;
    const caps = deps.store.getCapsHistory(since);
    const credit = deps.store.getCreditHistory(since);
    const session5h = caps.filter((c) => c.window === "session5h");
    const week = caps.filter((c) => c.window === "week");
    return json({ caps: { session5h, week }, credit, since });
  }
  return null;
}

async function handleUsageBreakdown({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "usage" &&
    parts[2] === "breakdown"
  ))
    return null;
  const raw = url.searchParams.get("range") ?? "7d";
  if (raw !== "24h" && raw !== "7d" && raw !== "30d" && raw !== "all")
    return json({ error: "invalid range" }, 400);
  const breakdown = await buildUsageBreakdown({
    store: deps.store,
    range: raw,
    now: Date.now(),
    apiKey: isApiKeyMode(),
    usageRollup: deps.usageRollup,
  });
  return json(breakdown);
}

async function handleUsageTimeline({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "usage" &&
    parts[2] === "timeline"
  ))
    return null;
  const raw = url.searchParams.get("range") ?? "7d";
  if (raw !== "24h" && raw !== "7d" && raw !== "30d" && raw !== "all")
    return json({ error: "invalid range" }, 400);
  const timeline = await buildUsageTimeline({
    store: deps.store,
    range: raw,
    now: Date.now(),
    usageRollup: deps.usageRollup,
  });
  return json(timeline);
}

// ── self-update: status + trigger ──────────────────────────────────────
function updateStatus(deps: AppDeps): Response {
  return json(
    deps.updates?.current() ?? {
      behind: 0,
      current: null,
      latest: null,
      commits: [],
      checkedAt: Date.now(),
    },
  );
}

function updateApply(deps: AppDeps): Response {
  if (!deps.updates) return json({ error: "updates not available" }, 503);
  const status = deps.updates.current();
  if (!status || status.behind <= 0) return json({ error: "no update available" }, 409);
  const r = deps.updates.apply();
  if (r.started) return json({ ok: true }, 202);
  // never a bare status: carry the real reason so the UI can show it
  return json({ error: r.error ?? "could not start the update" }, 409);
}

function handleUpdate({ req, parts, deps }: Ctx): Response | null {
  if (parts[0] === "api" && parts[1] === "update" && !parts[2]) {
    if (req.method === "GET") return updateStatus(deps);
    if (req.method === "POST") return updateApply(deps);
  }
  // live state of an in-flight/failed deploy so the modal can show why it failed
  if (
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "update" &&
    parts[2] === "log" &&
    !parts[3]
  ) {
    return json(deps.updates?.applyState?.() ?? { phase: "idle", exitCode: null, log: "" });
  }
  return null;
}

const HERDR_UPDATE_IDLE = {
  current: null,
  latest: null,
  updateAvailable: false,
  notes: null,
  checkedAt: 0,
} as const;

// ── herdr update: status + (destructive) apply ─────────────────────────
function handleHerdrUpdate({ req, parts, deps }: Ctx): Response | null {
  if (!(parts[0] === "api" && parts[1] === "herdr-update" && !parts[2])) return null;
  if (req.method === "GET") {
    return json(deps.herdrUpdates?.current() ?? { ...HERDR_UPDATE_IDLE, checkedAt: Date.now() });
  }
  if (req.method !== "POST") return null;
  if (!deps.herdrUpdates) return json({ error: "herdr updates not available" }, 503);
  if (!deps.herdrUpdates.current()?.updateAvailable) {
    return json({ error: "no update available" }, 409);
  }
  const r = deps.herdrUpdates.apply();
  return json({ ok: r.started }, r.started ? 202 : 409);
}

// ── codex update: status + (non-destructive) apply ─────────────────────
function handleCodexUpdate({ req, parts, deps }: Ctx): Response | null {
  if (!(parts[0] === "api" && parts[1] === "codex-update" && !parts[2])) return null;
  if (req.method === "GET") {
    return json(deps.codexUpdates?.current() ?? { ...HERDR_UPDATE_IDLE, checkedAt: Date.now() });
  }
  if (req.method !== "POST") return null;
  if (!deps.codexUpdates) return json({ error: "codex updates not available" }, 503);
  if (!deps.codexUpdates.current()?.updateAvailable) {
    return json({ error: "no update available" }, 409);
  }
  const r = deps.codexUpdates.apply();
  return json({ ok: r.started }, r.started ? 202 : 409);
}

// ── shepherd restart: relaunch the systemd unit on demand ──────────────
// POST /api/restart `{ herdr?: boolean }` → 202 once the detached restart is
// launched. `herdr: true` runs a graceful `herdr server live-handoff` first
// (panes survive). No GET: the UI detects completion by /api/health answering
// again after the restart. Errors carry a stable code (`not_systemd` when this
// process isn't the systemd unit — e.g. a dev worktree — so a dev UI can never
// bounce the production instance).
async function handleRestart({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "restart" && !parts[2])) return null;
  if (req.method !== "POST") return null;
  if (!deps.restart) return json({ started: false, error: "not_available" }, 503);
  let herdr = false;
  try {
    const body = (await req.json()) as { herdr?: unknown };
    herdr = body?.herdr === true;
  } catch {
    // an empty/absent body is a plain shepherd-only restart
  }
  const r = deps.restart.apply({ herdr });
  if (r.started) return json({ started: true }, 202);
  return json({ started: false, error: r.error ?? "could not start the restart" }, 409);
}

// ── plugin update: status (informational) + on-demand check + in-place apply ──
//  - GET  /api/plugin-update        → PluginUpdatesStatus (cached snapshot; badge/list)
//  - POST /api/plugin-update/check  → force a fresh scan NOW, broadcast the snapshot on
//    `plugin-update:status` (like POST /api/diagnostics/fix), and return it. A POST —
//    never a side-effecting GET — because each scan runs git network work per plugin.
//  - POST /api/plugin-update/apply  `{ id }` → fetch-and-swap the new version on disk,
//    then bring it live in-process when possible (else signal a restart is owed).
async function handlePluginUpdate({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "plugin-update") return null;
  if (!parts[2] && req.method === "GET") {
    return json(
      deps.pluginUpdates?.current() ?? {
        plugins: [],
        updateAvailable: false,
        checkedAt: Date.now(),
      },
    );
  }
  if (parts[2] === "check" && !parts[3] && req.method === "POST") {
    if (!deps.pluginUpdates?.check) return json({ error: "not_available" }, 503);
    const status = await deps.pluginUpdates.check(Date.now());
    // Push to every client (badge, modal, other tabs) — the requester's own UI
    // re-renders from this same event; the response body is for the busy state.
    deps.events.emit("plugin-update:status", status);
    return json(status);
  }
  if (parts[2] === "apply" && !parts[3] && req.method === "POST") {
    return pluginUpdateApply(req, deps);
  }
  return null;
}

/** HTTP status for a failed plugin-update apply: 404 (no such plugin), 409 (nothing
 *  newer to apply), else 400 (a bad/failed apply the caller can act on). */
function pluginApplyStatus(error: string): number {
  if (error === "not_installed") return 404;
  if (error === "already_up_to_date") return 409;
  return 400;
}

/** After the new version is on disk, bring it into the live registry. A plugin that is
 *  ALREADY running can't be hot-swapped (its old module is cached) → a restart is owed;
 *  a not-yet-loaded one is activated now. `activateOne` returns `ok:true` even when the new
 *  code's `register()` throws (the record loads `errored`), so a non-`ok` health is NOT a
 *  live update — report the restart hint rather than falsely claim the plugin is running. */
async function activateAfterApply(
  registry: PluginRegistry | undefined,
  id: string,
  folder: string,
): Promise<{ restartRequired: boolean; plugin?: PluginInfo }> {
  const loaded = registry?.list().some((p) => p.id === id) ?? false;
  if (loaded || !registry) return { restartRequired: loaded };
  const act = await registry.activateOne(folder);
  if (!act.ok) return { restartRequired: true };
  return { restartRequired: act.plugin.health !== "ok", plugin: act.plugin };
}

/** POST /api/plugin-update/apply — apply an available update on disk, then re-activate
 *  the plugin in-process (or signal a restart when it was already running). */
async function pluginUpdateApply(req: Request, deps: AppDeps): Promise<Response> {
  const svc = deps.pluginUpdates;
  if (!svc?.apply) return json({ error: "not_available" }, 503);
  let body: { id?: unknown };
  try {
    body = (await req.json()) as { id?: unknown };
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return json({ error: "id_required" }, 400);

  const res = await svc.apply(id, Date.now());
  if (!res.ok) {
    // Leave a trace — a transient git/network failure is otherwise undiagnosable
    // after the fact (the UI only gets the stable code + detail).
    console.error(
      `[plugin-update] apply failed for "${id}": ${res.error}${res.detail ? ` — ${res.detail}` : ""}`,
    );
    const body = { error: res.error, ...(res.detail ? { detail: res.detail } : {}) };
    return json(body, pluginApplyStatus(res.error));
  }
  const { restartRequired, plugin } = await activateAfterApply(deps.pluginRegistry, id, res.folder);
  return json({
    ok: true,
    restartRequired,
    updatedTo: res.updatedTo,
    plugin,
    status: svc.current(),
  });
}

// Fallback snapshot when the diagnostics service isn't wired (e.g. in tests):
// an empty, all-ok payload so the UI renders a benign "nothing to flag" state.
const DIAGNOSTICS_IDLE = {
  checks: [],
  generatedAt: 0,
  overall: "ok",
} as const;

// ── environment-readiness diagnostics (issue #623) ──────────────────────────
// GET /api/diagnostics → the TTL-cached snapshot; ?refresh=1 bypasses the cache
// and forces a fresh probe run. Payload is the curated {checks,generatedAt,overall}
// — never raw stdout/tokens/identity (curated server-side in DiagnosticsService).
async function handleDiagnostics({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "diagnostics" && !parts[2])) return null;
  if (req.method !== "GET") return null;
  if (!deps.diagnostics) return json(DIAGNOSTICS_IDLE);
  const refresh = url.searchParams.get("refresh") === "1";
  const snapshot = refresh
    ? await deps.diagnostics.check(Date.now())
    : await deps.diagnostics.current(Date.now());
  return json(snapshot);
}

/** POST /api/diagnostics/fix {checkId} → run the verbatim remediation for that
 *  check server-side (operator's own user), re-probe, and return the fresh snapshot
 *  (also pushed on `diagnostics:status` so every client + the TopBar pip refresh).
 *  Fail-closed: an unknown / guidance-only check is 409; a failed/timed-out command
 *  is 502 — never a 2xx. CSRF/token already enforced by the global request guards. */
async function handleDiagnosticsFix({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "diagnostics" && parts[2] === "fix" && !parts[3])) {
    return null;
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!deps.diagnostics) return json({ error: "diagnostics unavailable" }, 503);
  const body = (await req.json().catch(() => null)) as { checkId?: string } | null;
  const checkId = body?.checkId;
  if (!checkId) return json({ error: "missing checkId" }, 400);
  let snapshot;
  try {
    snapshot = await deps.diagnostics.fix(checkId, Date.now());
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // unknown check / guidance-only ⇒ not fixable (409); anything else is a failed
    // or timed-out command (502). Never a 2xx on failure.
    if (msg.startsWith("unknown check ") || msg.startsWith("no remediation for ")) {
      return json({ error: msg }, 409);
    }
    return json({ error: "remediation failed" }, 502);
  }
  deps.events.emit("diagnostics:status", snapshot);
  return json(snapshot);
}

/** GET → current "star us on GitHub?" nudge status (safe `{shouldPrompt:false}`
 *  default when the service isn't wired). POST {action} → dismiss / snooze / star. */
function handleStarPrompt({ req, parts, deps }: Ctx): Response | Promise<Response> | null {
  if (!(parts[0] === "api" && parts[1] === "star-prompt" && !parts[2])) return null;
  const sp = deps.starPrompt;
  if (req.method === "GET") return json(sp ? sp.status() : { shouldPrompt: false, starred: false });
  if (req.method !== "POST") return null;
  if (!sp) return json({ error: "star prompt not available" }, 503);
  return runStarPromptAction(req, sp);
}

async function runStarPromptAction(
  req: Request,
  sp: NonNullable<AppDeps["starPrompt"]>,
): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  switch (body?.action) {
    case "dismiss":
      return json(sp.dismiss());
    case "snooze":
      return json(sp.snooze());
    case "star":
      try {
        return json(await sp.star());
      } catch (e) {
        // gh failed (e.g. not authenticated) — surface so the prompt can show it.
        return json({ error: e instanceof Error ? e.message : "could not star repo" }, 502);
      }
    default:
      return json({ error: "unknown action" }, 400);
  }
}

function handleUploads({ req, parts, deps }: Ctx): Promise<Response> | null {
  if (parts[0] === "api" && parts[1] === "uploads" && !parts[2]) {
    if (req.method === "POST") {
      return handleUpload(req, { store: deps.store, repoRoot: config.repoRoot });
    }
  }
  return null;
}

// HTTP status per clone-failure code; anything unlisted falls back to 422.
const CLONE_ERROR_STATUS: Record<string, number> = {
  clonerepo_failed_exists: 409,
  clonerepo_failed_outside: 400,
  clonerepo_failed_timeout: 504,
};

async function cloneRepoFromRequest(req: Request): Promise<Response> {
  const b = firstRunBlock();
  if (b) return b;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const parsed = validateCloneUrl(body?.url);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const r = cloneRepo(parsed.value.url, parsed.value.name, config.repoRoot);
  if (!r.ok) return json({ error: r.error }, CLONE_ERROR_STATUS[r.error] ?? 422);
  return json(r.entry, 201);
}

// HTTP status per fork-failure code; anything unlisted falls back to 422.
const FORK_ERROR_STATUS: Record<string, number> = {
  forkrepo_failed_url: 400,
  forkrepo_failed_outside: 400,
  forkrepo_failed_exists: 409,
  forkrepo_failed_timeout: 504,
};

async function forkRepoFromRequest(req: Request, ghRunner?: GhRunner): Promise<Response> {
  const b = firstRunBlock();
  if (b) return b;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as { target?: unknown } | null;
  const parsed = validateForkTarget(body?.target);
  if (!parsed.ok) return json({ error: parsed.error }, FORK_ERROR_STATUS[parsed.error] ?? 400);
  const r = await forkRepo(parsed.value, config.repoRoot, ghRunner);
  if (!r.ok) return json({ error: r.error }, FORK_ERROR_STATUS[r.error] ?? 422);
  return json(r.entry, 201);
}

// HTTP status per new-project-failure code; anything unlisted falls back to 422.
const PROJECT_ERROR_STATUS: Record<string, number> = {
  newproject_failed_slug: 400,
  newproject_failed_outside: 400,
  newproject_failed_exists: 409,
  newproject_failed_identity: 422,
  newproject_failed_gh_missing: 422,
  newproject_failed_gh_auth: 422,
  newproject_failed_gh_exists: 409,
  newproject_failed_remote: 502,
  newproject_failed_git: 422,
  newproject_failed_timeout: 504,
  newproject_failed_generic: 422,
};

async function createProjectFromRequest(req: Request, ghRunner?: GhRunner): Promise<Response> {
  const b = firstRunBlock();
  if (b) return b;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = validateNewProject(body, config.repoRoot);
  if (!parsed.ok) return json({ error: parsed.error }, PROJECT_ERROR_STATUS[parsed.error] ?? 400);
  const r = await createProject(parsed.value, config.repoRoot, ghRunner);
  if (!r.ok) return json({ error: r.error }, PROJECT_ERROR_STATUS[r.error] ?? 422);
  return json(r.warning ? { ...r.entry, warning: r.warning } : r.entry, 201);
}

// Window for the "recently worked on" repo shortcut: agents run per repo over the
// last N days. Single source of truth — returned by GET /api/repos so the UI labels
// the count with the same window it was computed over (no duplicated literal).
const RECENT_WINDOW_DAYS = 3;

async function handleRepos({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "repos" && !parts[2]) {
    if (req.method === "GET") {
      const lastUsed = deps.store.lastUsedByRepo();
      const recentCounts = deps.store.recentSessionCountsByRepo(
        Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const baseRepos = listRepos(config.repoRoot);
      // repo_config keys are safeRepoDir/realpath-resolved while listRepos enumerates the
      // raw join(repoRoot, name) path; reconcile the hidden set into raw space (same as the
      // backlog payload) so a persisted hide matches its repo even under a symlinked root.
      // The picker (NewTask) hides these by default but reveals them on name search.
      const hiddenSet = reconcileRealPathsToRaw(deps.store.hiddenRepoPaths(), baseRepos);
      const repos = baseRepos.map((r) => ({
        ...r,
        lastUsedAt: lastUsed[r.path],
        recentAgentCount: recentCounts[r.path],
        // Fork mode is derived from the (memoized) forge resolution, so the picker
        // can offer "Sync fork" only on fork repos. resolveForge is cached per dir
        // and shared with the backlog poller — no extra git shell on a warm cache.
        isFork: deps.resolveForge?.(r.path)?.isFork ?? false,
        hidden: hiddenSet.has(r.path),
      }));
      // Return the window alongside the repos so the picker labels the count with
      // the exact day count it was computed over — single source of truth.
      return json({ repos, recentWindowDays: RECENT_WINDOW_DAYS });
    }
    if (req.method === "POST") return cloneRepoFromRequest(req);
  }
  // POST /api/repos/fork — fork a GitHub repo under the user's account + clone it.
  if (parts[0] === "api" && parts[1] === "repos" && parts[2] === "fork" && !parts[3]) {
    if (req.method === "POST") return forkRepoFromRequest(req, deps.newProjectGhRunner);
  }
  return null;
}

// POST /api/projects — bootstrap a new git project (git init + optional GitHub remote).
async function handleProjects({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "projects" && !parts[2]) {
    if (req.method === "POST") return createProjectFromRequest(req, deps.newProjectGhRunner);
  }
  return null;
}

// GET /api/github/owners — list the owners a new repo can be created under (the
// authenticated user + their orgs). A gh failure (missing/not-authed) returns 200
// with `{ login: null, orgs: [] }` so the new-project dialog degrades to a personal
// repo without surfacing an error before the user has even opted into a remote.
async function handleGithubOwners({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "github" && parts[2] === "owners" && !parts[3])) {
    return null;
  }
  if (req.method !== "GET") return null;
  try {
    const owners = await listGithubOwners(deps.githubOwnersRunner);
    return json(owners);
  } catch {
    return json({ login: null, orgs: [] });
  }
}

// GET /api/github/repos — list every GitHub repo the user can clone (their own plus
// any reached as collaborator or org/team member), each flagged `cloned` when a local
// repo already tracks it. A gh failure (missing/not-authed) returns 200 with
// `{ repos: [], login: null, available: false }` so the clone dialog quietly degrades
// to the URL-only path.
async function handleGithubRepos({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "github" && parts[2] === "repos" && !parts[3])) {
    return null;
  }
  if (req.method !== "GET") return null;

  let listed: Awaited<ReturnType<typeof listGithubRepos>>;
  try {
    listed = await listGithubRepos(deps.githubReposRunner);
  } catch {
    return json({ repos: [], login: null, available: false });
  }
  const { login, repos } = listed;

  // Build the set of repos already cloned locally so the dialog can hide them, keyed by
  // forge slug ("owner/repo"). We deliberately do NOT fall back to the bare folder name:
  // local dir names carry no owner, so a name-only match is owner-blind and would hide a
  // not-yet-cloned repo (e.g. acme/widget) whenever any unrelated local repo happens to
  // share its name (someone-else/widget). A clone whose forge can't resolve a slug simply
  // stays listed — clicking it then fails cleanly with clonerepo_failed_exists.
  const local = listRepos(config.repoRoot);
  const clonedSlugs = new Set<string>();
  for (const r of local) {
    const slug = deps.resolveForge?.(r.path)?.slug;
    if (slug) clonedSlugs.add(slug.toLowerCase());
  }

  const withCloned = repos.map((r) => ({
    ...r,
    cloned: clonedSlugs.has(r.nameWithOwner.toLowerCase()),
  }));
  return json({ repos: withCloned, login, available: true });
}

// ── settings: verify the configured api-key authenticates end-to-end ──
// POST /api/settings/verify-key → spawns a transient verify agent (via deps.verifyKey)
// and returns ONLY {ok,reason?,detail?} — never the key or its helper path, never logged.
async function handleSettingsVerifyKey({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(
    parts[0] === "api" &&
    parts[1] === "settings" &&
    parts[2] === "verify-key" &&
    !parts[3] &&
    req.method === "POST"
  ))
    return null;
  const b = firstRunBlock();
  if (b) return b;
  if (!deps.verifyKey) return json({ error: "verify not available" }, 503);
  const r = await deps.verifyKey();
  return json({ ok: r.ok, reason: r.reason, detail: r.detail });
}

// ── settings: read/update the repo root (persisted, applied at runtime) ──
async function handleSettings({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "settings" && !parts[2])) return null;
  if (req.method === "GET") {
    return json({
      repoRoot: config.repoRoot,
      repoRootDisplay: collapseHome(config.repoRoot),
      // blocking-onboarding-picker gate: true until a repo root has been picked/detected.
      firstRunPending: firstRun.pending,
      remoteControlAtStartup: config.remoteControlAtStartup,
      reducedPushMode: config.reducedPushMode,
      sessionHousekeepingEnabled: config.sessionHousekeepingEnabled,
      prReviewCyclesCap: config.prReviewCyclesCap,
      planReviewCyclesCap: config.planReviewCyclesCap,
      // display-only: each cap's valid bounds, so the UI steppers read min/max off the
      // payload instead of hardcoding a mirror of the server constants.
      prReviewCyclesMin: PR_REVIEW_CYCLES_MIN,
      prReviewCyclesMax: PR_REVIEW_CYCLES_MAX,
      planReviewCyclesMin: PLAN_REVIEW_CYCLES_MIN,
      planReviewCyclesMax: PLAN_REVIEW_CYCLES_MAX,
      // display-only: the real retention thresholds, so the UI shows the actual numbers
      // instead of hardcoding a mirror of the server constants.
      sessionRetentionDays: SESSION_RETENTION_DAYS,
      sessionRetentionKeep: SESSION_RETENTION_KEEP,
      // display-only: the agent node's own tailnet hostname; the UI builds preview iframe
      // URLs from it when the HUD is fronted on a different host than the agent node.
      // Null when tailscale is absent → UI falls back to the operator's connection host.
      previewHost: config.previewHost,
      // raw configured default model; "auto" = unset/seed; client resolves promo itself.
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      // per-role ENVIRONMENT SETTINGs, a pair per role: `<role>Cli` ("inherit" | "claude" | "codex";
      // "inherit" follows defaultAgentProvider + defaultModel) and `<role>Model` ("default" | <alias>
      // for that CLI). The UI shows each role's effective resolved CLI · model alongside the pickers.
      criticCli: config.criticCli,
      criticModel: config.criticModel,
      criticEffort: config.criticEffort,
      plannerCli: config.plannerCli,
      plannerModel: config.plannerModel,
      plannerEffort: config.plannerEffort,
      recapCli: config.recapCli,
      recapModel: config.recapModel,
      recapEffort: config.recapEffort,
      docAgentCli: config.docAgentCli,
      docAgentModel: config.docAgentModel,
      docAgentEffort: config.docAgentEffort,
      namerCli: config.namerCli,
      namerModel: config.namerModel,
      namerEffort: config.namerEffort,
      autopilotCli: config.autopilotCli,
      autopilotModel: config.autopilotModel,
      autopilotEffort: config.autopilotEffort,
      defaultAgentProvider: config.defaultAgentProvider,
      // when true, Up Next quick-start skips the "Choose coding CLI" picker and launches
      // directly with the operator's default coding CLI.
      upnextSkipCliPicker: config.upnextSkipCliPicker,
      // account-wide extra-credit (paid overage) spend ceiling; drain pauses above it.
      // 0 = pause on ANY extra-credit spend.
      extraCreditsDrainCeiling: config.extraCreditsDrainCeiling,
      // auth footing for spawned agents; "subscription" (default) or "api-key".
      authMode: config.authMode,
      // language agents address the operator in; "en" (default) or "de".
      operatorLanguage: config.operatorLanguage,
      // whether an apiKeyHelper script is configured; NEVER expose the key or path.
      hasApiKey: config.authApiKeyHelperPath !== null,
      // usage-aware task holding
      usageHoldEnabled: config.usageHoldEnabled,
      usageHoldPct: config.usageHoldPct,
      usageHoldAutoRelease: config.usageHoldAutoRelease,
      // usage-aware model downgrade (companion to the hold): at/above downgradePct every spawn
      // runs on usageDowngradeModel instead of its configured model.
      usageDowngradeEnabled: config.usageDowngradeEnabled,
      usageDowngradePct: config.usageDowngradePct,
      usageDowngradeModel: config.usageDowngradeModel,
      // global fable availability flag; false = fable spawns reroute to opus[1m].
      fableAvailable: config.fableAvailable,
      // TUI renderer opt-in (research preview) + mouse-capture disable; apply to new/resumed sessions.
      tuiFullscreen: config.tuiFullscreen,
      tuiDisableMouse: config.tuiDisableMouse,
      // doc-agent soak flags (read-only; env-driven; no PUT patch).
      docAgentEnabled: config.docAgentEnabled,
      docAgentAct: config.docAgentAct,
      telemetryConsent: config.telemetryConsent,
      // The UI shows the consent prompt / toggle only when telemetry can actually
      // run: an App-Key is configured (host resolvable) AND DO_NOT_TRACK is unset.
      telemetryAvailable:
        !config.doNotTrack &&
        resolveAptabaseHost(config.aptabaseAppKey, config.aptabaseHostOverride) !== null,
    });
  }
  if (req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    // A standalone field patch carries exactly one setting and no repoRoot; dispatch by
    // the first matching field. Anything else is a repo-root change. One row per setting.
    if (body && body.repoRoot === undefined) {
      for (const [field, handler] of SETTING_PATCHES) {
        if (field in body) return handler(body[field], deps);
      }
    }
    return putRepoRoot(body?.repoRoot, deps);
  }
  return null;
}

// Standalone settings patches: field name → its validating handler. Each handler
// validates the value, live-updates config, and persists to the store.
const SETTING_PATCHES: [string, (value: unknown, deps: Ctx["deps"]) => Response][] = [
  ["remoteControlAtStartup", putRemoteControl],
  ["reducedPushMode", putReducedPushMode],
  ["sessionHousekeepingEnabled", putSessionHousekeeping],
  ["prReviewCyclesCap", putPrReviewCyclesCap],
  ["planReviewCyclesCap", putPlanReviewCyclesCap],
  ["defaultModel", putDefaultModel],
  ["defaultEffort", putDefaultEffort],
  ["criticCli", makeRoleCliPatch("critic")],
  ["criticModel", makeRoleModelPatch("critic")],
  ["criticEffort", makeRoleEffortPatch("critic")],
  ["plannerCli", makeRoleCliPatch("planner")],
  ["plannerModel", makeRoleModelPatch("planner")],
  ["plannerEffort", makeRoleEffortPatch("planner")],
  ["recapCli", makeRoleCliPatch("recap")],
  ["recapModel", makeRoleModelPatch("recap")],
  ["recapEffort", makeRoleEffortPatch("recap")],
  ["docAgentCli", makeRoleCliPatch("docAgent")],
  ["docAgentModel", makeRoleModelPatch("docAgent")],
  ["docAgentEffort", makeRoleEffortPatch("docAgent")],
  ["namerCli", makeRoleCliPatch("namer")],
  ["namerModel", makeRoleModelPatch("namer")],
  ["namerEffort", makeRoleEffortPatch("namer")],
  ["autopilotCli", makeRoleCliPatch("autopilot")],
  ["autopilotModel", makeRoleModelPatch("autopilot")],
  ["autopilotEffort", makeRoleEffortPatch("autopilot")],
  ["defaultAgentProvider", putDefaultAgentProvider],
  ["upnextSkipCliPicker", putUpnextSkipCliPicker],
  ["extraCreditsDrainCeiling", putExtraCreditsDrainCeiling],
  ["authMode", putAuthMode],
  ["operatorLanguage", putOperatorLanguage],
  ["anthropicApiKey", putAnthropicApiKey],
  ["usageHoldEnabled", putUsageHoldEnabled],
  ["usageHoldPct", putUsageHoldPct],
  ["usageHoldAutoRelease", putUsageHoldAutoRelease],
  ["usageDowngradeEnabled", putUsageDowngradeEnabled],
  ["usageDowngradePct", putUsageDowngradePct],
  ["usageDowngradeModel", putUsageDowngradeModel],
  ["fableAvailable", putFableAvailable],
  ["tuiFullscreen", putTuiFullscreen],
  ["tuiDisableMouse", putTuiDisableMouse],
  ["telemetryConsent", putTelemetryConsent],
];

function putRemoteControl(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "remoteControlAtStartup must be a boolean" }, 400);
  }
  config.remoteControlAtStartup = value; // live: next spawn picks it up
  deps.store.setSetting("remoteControlAtStartup", value ? "1" : "0"); // persist
  return json({ remoteControlAtStartup: config.remoteControlAtStartup });
}

function putReducedPushMode(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "reducedPushMode must be a boolean" }, 400);
  }
  config.reducedPushMode = value; // live: the push gate reads it immediately
  deps.store.setSetting("reducedPushMode", value ? "1" : "0"); // persist
  return json({ reducedPushMode: config.reducedPushMode });
}

function putSessionHousekeeping(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "sessionHousekeepingEnabled must be a boolean" }, 400);
  }
  config.sessionHousekeepingEnabled = value; // live: the next daily sweep honors it
  deps.store.setSetting("sessionHousekeepingEnabled", value ? "1" : "0"); // persist
  return json({ sessionHousekeepingEnabled: config.sessionHousekeepingEnabled });
}

function putPrReviewCyclesCap(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return json({ error: "prReviewCyclesCap must be a number" }, 400);
  }
  const cap = clampCap(value, PR_REVIEW_CYCLES_MIN, PR_REVIEW_CYCLES_MAX, config.prReviewCyclesCap); // snap into [MIN,MAX]
  config.prReviewCyclesCap = cap; // live: the next critic run reads it
  deps.store.setSetting("prReviewCyclesCap", String(cap)); // persist across restarts
  return json({ prReviewCyclesCap: config.prReviewCyclesCap });
}

function putPlanReviewCyclesCap(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return json({ error: "planReviewCyclesCap must be a number" }, 400);
  }
  const cap = clampCap(
    value,
    PLAN_REVIEW_CYCLES_MIN,
    PLAN_REVIEW_CYCLES_MAX,
    config.planReviewCyclesCap,
  ); // snap into [MIN,MAX]
  config.planReviewCyclesCap = cap; // live: the next plan-gate run reads it
  deps.store.setSetting("planReviewCyclesCap", String(cap)); // persist across restarts
  return json({ planReviewCyclesCap: config.planReviewCyclesCap });
}

// Validates via normalizeDefaultModelSetting; "auto" = unset/seed.
function putDefaultModel(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeDefaultModelSetting(value);
  if (v === null) return json({ error: "unknown model" }, 400);
  config.defaultModel = v; // live: next drain spawn picks it up
  deps.store.setSetting("defaultModel", v); // persist across restarts
  return json({ defaultModel: config.defaultModel });
}

function putDefaultEffort(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeDefaultEffortSetting(value);
  if (v === null) return json({ error: "unknown effort" }, 400);
  config.defaultEffort = v; // live: next drain spawn picks it up
  deps.store.setSetting("defaultEffort", v); // persist across restarts
  return json({ defaultEffort: config.defaultEffort });
}

// Per-role ENVIRONMENT patch handlers (critic/planner/recap/doc-agent/namer/autopilot). Each role
// is a PAIR: a `<role>Cli` ("inherit"|<provider>) and a `<role>Model` ("default"|<alias>). Both
// live-update config (the spawn-time thunks read config per spawn, so no restart) and persist.
// cli/model are validated + stored independently; resolveRoleEnvironment clamps an incoherent pair.
type RoleKey = "critic" | "planner" | "recap" | "docAgent" | "namer" | "autopilot";

function makeRoleCliPatch(role: RoleKey): (value: unknown, deps: Ctx["deps"]) => Response {
  const key = `${role}Cli` as const;
  return (value, deps) => {
    const v = normalizeRoleCli(value);
    if (v === null) return json({ error: `${key} must be "inherit", "claude", or "codex"` }, 400);
    config[key] = v; // live: next spawn's role-env thunk picks it up
    deps.store.setSetting(key, v); // persist across restarts
    return json({ [key]: config[key] });
  };
}

function makeRoleModelPatch(role: RoleKey): (value: unknown, deps: Ctx["deps"]) => Response {
  const key = `${role}Model` as const;
  return (value, deps) => {
    const v = normalizeRoleModelToken(value);
    if (v === null) return json({ error: `${key} must be "default" or a known model alias` }, 400);
    config[key] = v; // live: next spawn's role-env thunk picks it up
    deps.store.setSetting(key, v); // persist across restarts
    return json({ [key]: config[key] });
  };
}

function makeRoleEffortPatch(role: RoleKey): (value: unknown, deps: Ctx["deps"]) => Response {
  const key = `${role}Effort` as const;
  return (value, deps) => {
    const v = normalizeDefaultEffortSetting(value);
    if (v === null)
      return json({ error: `${key} must be "default" or a reasoning-effort tier` }, 400);
    config[key] = v; // live: next spawn's role-env thunk picks it up
    deps.store.setSetting(key, v); // persist across restarts
    // #1430 guardrail: the critic is a rigor role; warn when its effort resolves below `high`
    // (low/medium/default). Covers non-UI lowering paths (direct/external PATCH) — the Settings
    // UI shows an inline warning of its own. Critic-only so other roles keep the generic behavior.
    if (role === "critic" && effortBelowHigh(v)) {
      console.warn(
        `[critic-effort] critic reasoning effort set to '${v}' (resolves below 'high'); the critic is a rigor role — a reduced effort weakens PR review`,
      );
    }
    return json({ [key]: config[key] });
  };
}

function putDefaultAgentProvider(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeAgentProvider(value);
  if (v === null) return json({ error: "unknown agent provider" }, 400);
  config.defaultAgentProvider = v;
  deps.store.setSetting("defaultAgentProvider", v);
  return json({ defaultAgentProvider: config.defaultAgentProvider });
}

// Account-wide extra-credit (paid overage) spend ceiling. Requires a finite, non-negative
// number; persisted as the canonical "extra_credits_drain_ceiling" setting key and applied
// live so the next drain assembly reads it without a restart.
function putExtraCreditsDrainCeiling(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return json({ error: "extraCreditsDrainCeiling must be a non-negative number" }, 400);
  }
  config.extraCreditsDrainCeiling = value; // live: next drain assembly reads it
  deps.store.setSetting("extra_credits_drain_ceiling", String(value)); // persist across restarts
  return json({ extraCreditsDrainCeiling: config.extraCreditsDrainCeiling });
}

// Switching to api-key without a key configured is allowed; spawns fail closed until a key is supplied.
function putAuthMode(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeAuthModeSetting(value);
  if (v === null) return json({ error: "authMode must be 'subscription' or 'api-key'" }, 400);
  config.authMode = v; // live: next spawn picks it up
  deps.store.setSetting("authMode", v); // persist across restarts
  return json({ authMode: config.authMode, hasApiKey: config.authApiKeyHelperPath !== null });
}

// Language agents address the operator in; "en" (default, no-op) or "de".
function putOperatorLanguage(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeOperatorLanguage(typeof value === "string" ? value : undefined);
  if (v === null) return json({ error: "operatorLanguage must be 'en' or 'de'" }, 400);
  config.operatorLanguage = v; // live: next spawn picks it up
  deps.store.setSetting("operatorLanguage", v); // persist across restarts
  return json({ operatorLanguage: config.operatorLanguage });
}

// Consent is the only persisted telemetry state. Granting for the first time emits
// app_launched immediately so the very first opt-in records an install without waiting
// for the next boot. Denying/ungranting is silent. DO_NOT_TRACK still hard-gates emission
// downstream (TelemetryService.enabled), so a granted consent under DNT sends nothing.
function putTelemetryConsent(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeTelemetryConsent(value);
  if (v === null || v === "unset") {
    return json({ error: "telemetryConsent must be 'granted' or 'denied'" }, 400);
  }
  const wasGranted = config.telemetryConsent === "granted";
  config.telemetryConsent = v; // live: gate re-reads this
  deps.store.setSetting("telemetryConsent", v); // persist across restarts
  if (v === "granted" && !wasGranted) deps.telemetry?.event("app_launched");
  return json({ telemetryConsent: config.telemetryConsent });
}

function putAnthropicApiKey(value: unknown, deps: Ctx["deps"]): Response {
  if (value !== null && typeof value !== "string") {
    return json({ error: "anthropicApiKey must be a string or null" }, 400);
  }
  const dir = join(homedir(), ".shepherd");
  if (typeof value === "string" && value.trim().length > 0) {
    // SET — write helper, store path; NEVER echo key or path
    const path = writeApiKeyHelper(value.trim(), dir);
    config.authApiKeyHelperPath = path;
    deps.store.setSetting("authApiKeyHelperPath", path);
    return json({ hasApiKey: true });
  } else {
    // CLEAR (null or empty string)
    clearApiKeyHelper(dir);
    config.authApiKeyHelperPath = null;
    deps.store.setSetting("authApiKeyHelperPath", ""); // mark cleared
    return json({ hasApiKey: false });
  }
}

function putUsageHoldEnabled(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "usageHoldEnabled must be a boolean" }, 400);
  }
  config.usageHoldEnabled = value;
  deps.store.setSetting("usageHoldEnabled", value ? "1" : "0");
  return json({ usageHoldEnabled: config.usageHoldEnabled });
}

function putUpnextSkipCliPicker(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "upnextSkipCliPicker must be a boolean" }, 400);
  }
  config.upnextSkipCliPicker = value;
  deps.store.setSetting("upnextSkipCliPicker", value ? "1" : "0");
  return json({ upnextSkipCliPicker: config.upnextSkipCliPicker });
}

function putUsageHoldPct(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return json({ error: "usageHoldPct must be a number" }, 400);
  }
  const n = Math.min(100, Math.max(0, Math.floor(value)));
  config.usageHoldPct = n;
  deps.store.setSetting("usageHoldPct", String(n));
  return json({ usageHoldPct: config.usageHoldPct });
}

function putUsageHoldAutoRelease(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "usageHoldAutoRelease must be a boolean" }, 400);
  }
  config.usageHoldAutoRelease = value;
  deps.store.setSetting("usageHoldAutoRelease", value ? "1" : "0");
  return json({ usageHoldAutoRelease: config.usageHoldAutoRelease });
}

function putUsageDowngradeEnabled(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "usageDowngradeEnabled must be a boolean" }, 400);
  }
  config.usageDowngradeEnabled = value; // live: next spawn picks it up
  deps.store.setSetting("usageDowngradeEnabled", value ? "1" : "0");
  return json({ usageDowngradeEnabled: config.usageDowngradeEnabled });
}

function putUsageDowngradePct(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return json({ error: "usageDowngradePct must be a number" }, 400);
  }
  const n = Math.min(100, Math.max(0, Math.floor(value)));
  config.usageDowngradePct = n;
  deps.store.setSetting("usageDowngradePct", String(n));
  return json({ usageDowngradePct: config.usageDowngradePct });
}

// The downgrade target is a default-model SETTING ("auto"|"default"|<alias>); validated
// via normalizeDefaultModelSetting (no "inherit" — there is nothing for it to inherit from).
function putUsageDowngradeModel(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeDefaultModelSetting(value);
  if (v === null) return json({ error: "usageDowngradeModel must be a valid model setting" }, 400);
  config.usageDowngradeModel = v; // live: next spawn picks it up
  deps.store.setSetting("usageDowngradeModel", v);
  return json({ usageDowngradeModel: config.usageDowngradeModel });
}

function putFableAvailable(value: unknown, deps: Ctx["deps"]): Response {
  const v = normalizeFableAvailable(value);
  if (v === null) return json({ error: "fableAvailable must be a boolean" }, 400);
  config.fableAvailable = v; // live: next spawn picks it up
  deps.store.setSetting("fableAvailable", String(v)); // persist across restarts
  return json({ fableAvailable: config.fableAvailable });
}

function putTuiFullscreen(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "tuiFullscreen must be a boolean" }, 400);
  }
  config.tuiFullscreen = value; // live: next spawn/resume picks it up (renderer is fixed at process start)
  deps.store.setSetting("tuiFullscreen", value ? "1" : "0"); // persist
  return json({ tuiFullscreen: config.tuiFullscreen });
}

function putTuiDisableMouse(value: unknown, deps: Ctx["deps"]): Response {
  if (typeof value !== "boolean") {
    return json({ error: "tuiDisableMouse must be a boolean" }, 400);
  }
  config.tuiDisableMouse = value; // live: next spawn/resume picks it up
  deps.store.setSetting("tuiDisableMouse", value ? "1" : "0"); // persist
  return json({ tuiDisableMouse: config.tuiDisableMouse });
}

function putRepoRoot(value: unknown, deps: Ctx["deps"]): Response {
  const root = validateRoot(value, config.rootCeiling);
  if (!root) {
    return json({ error: "repoRoot must be an existing directory within the root" }, 400);
  }
  config.repoRoot = root; // live: every later read picks it up
  deps.store.setSetting("repoRoot", root); // persist across restarts
  // First-ever root pick: resolve the first-run gate so the deferred background herd
  // starts (startBackground() reads config.repoRoot, already assigned above).
  if (firstRun.pending) {
    deps.store.setSetting("firstRunResolved", "1");
    firstRun.resolve();
  }
  return json({ repoRoot: root, repoRootDisplay: collapseHome(root) });
}

// ── saved steers (canned prompts): list / replace ──
async function handleSteers({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "steers" && !parts[2]) {
    if (req.method === "GET") return json(loadSteers(deps.store, config.standardCommand));
    if (req.method === "PUT") {
      const ctErr = requireJsonContentType(req);
      if (ctErr) return ctErr;
      const body = await req.json().catch(() => null);
      const steers = validateSteers(body);
      if (!steers) return json({ error: "invalid steers payload" }, 400);
      saveSteers(deps.store, steers);
      return json(steers);
    }
  }
  return null;
}

// ── per-project icons: read full map / patch one entry ──
async function handleProjectIcons({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "project-icons" && !parts[2]) {
    if (req.method === "GET") return json(loadIcons(deps.store));
    if (req.method === "PUT") {
      const ctErr = requireJsonContentType(req);
      if (ctErr) return ctErr;
      const body = await req.json().catch(() => null);
      const patch = validateIconPatch(body);
      if (!patch) return json({ error: "invalid project-icon payload" }, 400);
      const map = setIcon(deps.store, patch.path, patch.emoji);
      deps.events.emit("project-icons:update", map);
      return json(map);
    }
  }
  return null;
}

// ── broadcast a steer to many sessions ──
async function handleBroadcast({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "broadcast" && !parts[2]) {
    if (req.method === "POST") {
      const ctErr = requireJsonContentType(req);
      if (ctErr) return ctErr;
      const body = await req.json().catch(() => null);
      const parsed = validateBroadcast(body);
      if (!parsed) return json({ error: "body must be {text: string, ids: string[]}" }, 400);
      return json(await deps.service.broadcast(parsed.ids, parsed.text));
    }
  }
  return null;
}

// ── /api/held — usage-hold queue management ──────────────────────────────────

function heldList(deps: AppDeps): Response {
  return json(deps.store.listHeldTasks());
}

function parseHeldSpawnProvider(body: unknown): { ok: true; value?: AgentProvider } | Response {
  if (body == null) return { ok: true };
  if (typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "body must be a non-null object" }, 400);
  }
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "agentProvider") return json({ error: `unknown key: ${key}` }, 400);
  }
  if (!("agentProvider" in obj)) return { ok: true };
  const provider = normalizeAgentProvider(obj.agentProvider);
  if (provider === null) return json({ error: "agentProvider must be one of: claude, codex" }, 400);
  return { ok: true, value: provider };
}

async function heldSpawn(id: string, deps: AppDeps, body: unknown = null): Promise<Response> {
  const h = deps.store.getHeldTask(id);
  if (!h) return json({ error: "not found" }, 404);
  const provider = parseHeldSpawnProvider(body);
  if (provider instanceof Response) return provider;
  const input = provider.value ? { ...h.input, agentProvider: provider.value } : h.input;
  let s;
  try {
    s = await deps.service.create(input);
  } catch (e) {
    return createErrorResponse(e);
  }
  deps.store.removeHeldTask(h.id);
  // service.create does not emit session:new (see finalizeRelaunch) — emit it here so the
  // new session appears in the Herd live, then decrement the held badge.
  deps.events.emit("session:new", s);
  deps.events.emit("held:changed", { count: deps.store.countHeldTasks() });
  // A human linked an issue before the task was held: stamp the drain claim now that it's
  // spawning, matching handleSessionCreate — so the board reflects it's being worked and the
  // drain won't double-spawn it. Deferred (macrotask) + best-effort: addIssueLabel shells out
  // synchronously, so setTimeout(0) lets json(s, 201) flush first.
  if (h.input.issueRef) {
    const { repoPath, issueRef } = h.input;
    setTimeout(
      () => void claimLinkedIssue(deps.resolveForge?.(repoPath) ?? null, issueRef.number),
      0,
    );
  }
  return json(s, 201);
}

function heldDiscard(id: string, deps: AppDeps): Response {
  deps.store.removeHeldTask(id);
  deps.events.emit("held:changed", { count: deps.store.countHeldTasks() });
  return json({ ok: true });
}

// PATCH /api/held/:id — replace a held task's input while it stays held. Reuses the
// New-Task create validation so an edit can't persist a malformed input that would
// later fail on spawn. Count is unchanged; held:changed still fires so any other client
// recomputing off the badge stays consistent.
async function heldUpdate(id: string, deps: AppDeps, body: unknown): Promise<Response> {
  const existing = deps.store.getHeldTask(id);
  if (!existing) return json({ error: "not found" }, 404);
  const result = validateCreate(body, config.repoRoot);
  if (!result.ok) return json({ error: result.error }, 400);
  // The edit composer round-trips every field EXCEPT merge-train membership, which has no
  // UI — so carry mergeTrainPrs forward from the held row. Otherwise editing a held
  // merge-train task would strip its participant PRs and they'd never be marked "merging".
  const value = existing.input.mergeTrainPrs?.length
    ? { ...result.value, mergeTrainPrs: existing.input.mergeTrainPrs }
    : result.value;
  deps.store.updateHeldTask(id, value);
  deps.events.emit("held:changed", { count: deps.store.countHeldTasks() });
  return json(deps.store.getHeldTask(id), 200);
}

async function handleHeld({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "held") return null;

  // GET /api/held — list held tasks FIFO
  if (req.method === "GET" && !parts[2]) return heldList(deps);

  // POST /api/held/:id/spawn — release one held task immediately
  if (req.method === "POST" && parts[2] && parts[3] === "spawn" && !parts[4]) {
    const b = firstRunBlock();
    if (b) return b;
    const body = await req.json().catch(() => null);
    return heldSpawn(parts[2], deps, body);
  }

  // PATCH /api/held/:id — edit a held task's input while it stays held
  if (req.method === "PATCH" && parts[2] && !parts[3]) {
    const ctErr = requireJsonContentType(req);
    if (ctErr) return ctErr;
    const body = await req.json().catch(() => null);
    return heldUpdate(parts[2], deps, body);
  }

  // DELETE /api/held/:id — discard a held task
  if (req.method === "DELETE" && parts[2] && !parts[3]) return heldDiscard(parts[2], deps);

  return null;
}

// ── retry usage-halted sessions ──
async function handleRetry({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "retry" && !parts[2]) {
    if (req.method === "POST") {
      const ctErr = requireJsonContentType(req);
      if (ctErr) return ctErr;
      const body = await req.json().catch(() => null);
      const parsed = validateRetry(body);
      if (!parsed) return json({ error: "body must be {text: string, ids: string[]}" }, 400);
      return json(await deps.service.retryHalted(parsed.ids, parsed.text));
    }
  }
  return null;
}

// ── halt the herd: interrupt every live working agent at once ──
async function handleHalt({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "halt" || parts[2]) return null;
  // Explicit 405 (matching handleSessionsClearMerged) rather than falling through to a
  // generic 404 — the path exists, only the verb is wrong.
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // No body: the server computes the target set (every live `working` pane) itself,
  // so there is nothing to validate. The shared auth/origin guards still apply.
  return json(await deps.service.haltAll());
}

// ── filesystem browser: list sub-directories for the root picker ──
function handleFsDirs({ req, parts, url }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "fs" && parts[2] === "dirs") {
    return json(listDirs(url.searchParams.get("path") ?? "", config.rootCeiling));
  }
  return null;
}

function handleBranches({ req, parts, url }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "branches" && !parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    return json(listBranches(dir));
  }
  return null;
}

// ── /api/branch-status ────────────────────────────────────────────────────────
// NOTE: Each call performs a bounded network git fetch (writes objects + the
// refs/remotes/origin/<branch> tracking ref). This is intended-non-idempotent,
// bounded, and rate-limited by the TTL cache below + client debounce (Task 5).

const BRANCH_STATUS_TTL_MS = 10_000;
// Single long-running server loop: bound the cache so it never grows without
// limit. On each write: prune expired entries first, then evict oldest (Map
// preserves insertion order) if the cap is still exceeded.
const BRANCH_STATUS_CACHE_MAX = 256;
type BranchStatusValue = {
  behind: number;
  ahead: number;
  diverged: boolean;
  hasUpstream: boolean;
  localExists: boolean;
};
const branchStatusCache = new Map<string, { at: number; value: BranchStatusValue }>();
// Coalesce concurrent cache misses for the same (repo, branch): each would otherwise
// spawn its own bounded git fetch against the same tracking ref. In-flight requests
// share ONE promise; the entry clears once it settles (success or failure).
const branchStatusInflight = new Map<string, Promise<BranchStatusValue>>();

function clearBranchStatusCache(): void {
  branchStatusCache.clear();
  branchStatusInflight.clear();
}

/** Clear the in-memory branch-status cache — for use in tests only. */
export function clearBranchStatusCacheForTests(): void {
  clearBranchStatusCache();
}

export async function branchStatusCached(
  repoPath: string,
  branch: string,
): Promise<BranchStatusValue> {
  const key = `${repoPath}\0${branch}`;
  const hit = branchStatusCache.get(key);
  if (hit && Date.now() - hit.at < BRANCH_STATUS_TTL_MS) return hit.value;
  // A miss already in flight for this key: join it instead of fetching again.
  const inflight = branchStatusInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const st = await upstreamStatus(repoPath, branch);
    const value: BranchStatusValue = {
      behind: st.behind,
      ahead: st.ahead,
      diverged: st.diverged,
      hasUpstream: st.hasUpstream,
      localExists: st.localExists,
    };
    const now = Date.now();
    // Prune expired entries before writing, then cap by evicting oldest.
    for (const [k, v] of branchStatusCache) {
      if (now - v.at >= BRANCH_STATUS_TTL_MS) branchStatusCache.delete(k);
    }
    while (branchStatusCache.size >= BRANCH_STATUS_CACHE_MAX) {
      branchStatusCache.delete(branchStatusCache.keys().next().value!);
    }
    branchStatusCache.set(key, { at: now, value });
    return value;
  })().finally(() => branchStatusInflight.delete(key));
  branchStatusInflight.set(key, p);
  return p;
}

async function handleBranchStatus({ req, parts, url }: Ctx): Promise<Response | null> {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "branch-status" && !parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    const branch = url.searchParams.get("branch") ?? "";
    if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(branch))
      return json({ error: "invalid branch" }, 400);
    const st = await branchStatusCached(dir, branch);
    return json(st);
  }
  return null;
}

async function handleRepoWeb({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "repo-web" || parts[2])
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  return json({
    slug: forge?.slug ?? null,
    webUrl: forge?.webUrl ?? null,
    kind: forge?.kind ?? null,
  });
}

/** Fetch a repo's open issues and, best-effort, attach each one's still-open blockers
 *  (GitHub issue dependencies) as `blockedBy`. The blocked-map fetch fails open — a missing
 *  method (Gitea/local) or a forge error yields no annotations, never a failed request. */
async function listIssuesWithBlockers(forge: GitForge): Promise<Issue[]> {
  const [issues, blockedByOpen] = await Promise.all([
    forge.listIssues(),
    Promise.resolve(forge.listBlockedByOpen?.())
      .catch(() => null)
      .then((m) => m ?? new Map<number, number[]>()),
  ]);
  for (const i of issues) {
    const b = blockedByOpen.get(i.number);
    if (b && b.length > 0) i.blockedBy = b;
  }
  return issues;
}

function initEmptyCommit(dir: string, branch: string): { branch: string } {
  if (!/^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(branch)) throw new Error("invalid branch");
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], {
      cwd: dir,
      stdio: "pipe",
    });
    return { branch };
  } catch {
    // no existing base commit; create the minimal root commit below
  }
  execFileSync("git", ["checkout", "-B", branch], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "Initial commit"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Shepherd",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "shepherd@local",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Shepherd",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "shepherd@local",
    },
    stdio: "pipe",
  });
  return { branch };
}

async function handleRepoInitEmptyCommit({ req, parts }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "repos" ||
    parts[2] !== "init-empty-commit" ||
    parts[3]
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; branch?: string };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const branch = (body.branch ?? "main").trim() || "main";
  try {
    const result = initEmptyCommit(dir, branch);
    clearBranchStatusCache();
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "initial commit failed" }, 422);
  }
}

async function handleIssues({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "issues" && !parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    const forge = deps.resolveForge?.(dir) ?? null;
    if (!forge) return json({ slug: null, webUrl: null, issues: [], viewer: null });
    try {
      const issues = await listIssuesWithBlockers(forge);
      return json({
        slug: forge.slug,
        webUrl: forge.webUrl ?? null,
        issues,
        // The operator's own login, so the UI's "mine & unassigned" filter (#824)
        // knows who "me" is. Cached in the forge, so no per-request gh cost after
        // the first call. null when the host can't resolve it (fail open → show all).
        viewer: (await forge.currentUser?.()) ?? null,
      });
    } catch {
      // missing/un-authed CLI, network error, or a rate-limited forge (gh issue
      // list runs on GitHub's GraphQL quota, which can hit 0) → empty list, but
      // flag it as a fetch failure so the UI can say "couldn't load" instead of
      // the indistinguishable "no open issues".
      return json({
        slug: forge.slug,
        webUrl: forge.webUrl ?? null,
        issues: [],
        viewer: null,
        error: "fetch_failed",
      });
    }
  }
  return null;
}

// POST /api/issues — open a new issue on a repo's forge (capture-extension
// delivery path). Coexists with handleIssues' GET on the same path.
async function handleIssueCreate({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "issues" || parts[2]) return null;
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as {
    repo?: string;
    title?: string;
    body?: string;
  } | null;
  if (!body) return json({ error: "invalid json" }, 400);
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const title = body.title;
  if (typeof title !== "string" || !title.trim() || title.length > 200) {
    return json({ error: "title must be a non-empty string ≤ 200 chars" }, 400);
  }
  const issueBody = body.body;
  if (typeof issueBody !== "string" || issueBody.length > 16000) {
    return json({ error: "body must be a string ≤ 16000 chars" }, 400);
  }
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.createIssue) return json({ error: "issues unavailable for repo" }, 400);
  try {
    const issue = await forge.createIssue({ title: title.trim(), body: issueBody });
    return json({ ...issue, slug: forge.slug }, 201);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "issue create failed" }, 502);
  }
}

/**
 * Collapse worktrees / multiple clones of the same repo: dedupe by forge identity
 * (kind + owner/repo slug) so each repo appears once, not once per directory.
 * Repos without a slug can't be matched, so each stays distinct (keyed by path).
 * For each group keep the most-recently-used directory; tie-break on shorter then
 * lexicographically smaller path, which favors the canonical checkout (e.g.
 * `epamano-shopify`) over a long-named worktree.
 */
function dedupeReposByForge<T extends { path: string; forge: GitForge }>(
  repos: T[],
  lastUsed: Record<string, number>,
): T[] {
  const key = (r: T) => (r.forge.slug ? `${r.forge.kind} ${r.forge.slug}` : `path ${r.path}`);
  const byRepo = new Map<string, T>();
  for (const r of repos) {
    const k = key(r);
    const cur = byRepo.get(k);
    if (!cur) {
      byRepo.set(k, r);
      continue;
    }
    const ru = lastUsed[r.path] ?? -1;
    const cu = lastUsed[cur.path] ?? -1;
    const better =
      ru !== cu
        ? ru > cu
        : r.path.length !== cur.path.length
          ? r.path.length < cur.path.length
          : r.path < cur.path;
    if (better) byRepo.set(k, r);
  }
  return [...byRepo.values()];
}

// GET /api/prs?repo= — open PRs for one repo (backlog PRs-tab detail pane).
async function handlePrsList({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "prs" || parts[2]) return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge) return json({ slug: null, webUrl: null, prs: [] });
  try {
    const snap = deps.openPrSnapshot ? await deps.openPrSnapshot.get(forge) : null;
    const prs = snap ? snap.prs : await forge.listPullRequests();
    return json({ slug: forge.slug, webUrl: forge.webUrl ?? null, prs });
  } catch {
    // missing/un-authed CLI or network error → graceful empty (matches issues path)
    return json({ slug: forge.slug, webUrl: forge.webUrl ?? null, prs: [] });
  }
}

/** Builds the uniform actions-endpoint payload; safe for all three branches. */
function actionsPayload(
  forge: GitForge | null,
  runs: WorkflowRun[],
  caps: { supportsActions: boolean; canRerun: boolean; canCancel: boolean },
) {
  return {
    slug: forge?.slug ?? null,
    webUrl: forge?.webUrl ?? null,
    kind: forge?.kind ?? null,
    runs,
    ...caps,
  };
}

// GET /api/actions?repo= — latest Actions run per workflow on the default branch
// (backlog Actions-tab detail pane). Alongside the runs it reports three capability
// flags (supportsActions / canRerun / canCancel) derived from which optional forge
// methods exist, so the UI can gate the empty-state and rerun/cancel buttons
// forge-agnostically rather than hardcoding `kind`. Forges without an Actions API
// (e.g. Gitea lacks rerun/cancel) report no runs / the relevant flag false.
async function handleActionsList({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "actions" || parts[2]) return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  const caps = {
    supportsActions: Boolean(forge?.listWorkflowRuns),
    canRerun: Boolean(forge?.rerunWorkflowRun),
    canCancel: Boolean(forge?.cancelWorkflowRun),
  };
  if (!forge?.listWorkflowRuns) return json(actionsPayload(forge, [], caps));
  try {
    return json(actionsPayload(forge, await forge.listWorkflowRuns(), caps));
  } catch {
    // missing/un-authed CLI or network error → graceful empty (matches PRs path)
    return json(actionsPayload(forge, [], caps));
  }
}

// POST /api/actions/rerun — re-run a GitHub Actions run by repo + runId. When the
// run failed, `failedOnly` retries just the broken jobs; otherwise the whole run.
// GitHub only; other forges lack the method → 400 (the tab hides the button anyway).
async function handleActionsRerun({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "actions" || parts[2] !== "rerun")
    return null;
  const body = (await req.json().catch(() => ({}))) as {
    repo?: string;
    runId?: number;
    failedOnly?: boolean;
  };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.runId !== "number") return json({ error: "runId required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.rerunWorkflowRun) return json({ error: "no actions for repo" }, 400);
  try {
    await forge.rerunWorkflowRun(body.runId, { failedOnly: body.failedOnly ?? false });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "rerun failed" }, 502);
  }
}

// POST /api/actions/retry-ci — one-click "Retry CI" for a ci-red hold. The hold carries only the
// PR number, so resolve the PR head's latest FAILED run here, then rerun its failed jobs. GitHub
// only. Expected outcomes return 200 with a typed reason (unsupported forge / no failed run); a
// genuine forge error is a 502 (the client throws on non-2xx and toasts generically).
async function handleActionsRetryCi({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "retry-ci"
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; pr?: number };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.pr !== "number") return json({ error: "pr required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.rerunWorkflowRun || !forge.latestFailedRunForPr)
    return json({ ok: false, reason: "unsupported" });
  try {
    const runId = await forge.latestFailedRunForPr(body.pr);
    if (runId == null) return json({ ok: false, reason: "no-run" });
    await forge.rerunWorkflowRun(runId, { failedOnly: true });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "retry failed" }, 502);
  }
}

// POST /api/actions/cancel — cancel an in-progress GitHub Actions run by repo + runId.
async function handleActionsCancel({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "cancel"
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; runId?: number };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.runId !== "number") return json({ error: "runId required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.cancelWorkflowRun) return json({ error: "no actions for repo" }, 400);
  try {
    await forge.cancelWorkflowRun(body.runId);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "cancel failed" }, 502);
  }
}

// GET /api/actions/history?repo=&workflowId=&limit= — prior runs of one workflow
// on the default branch (summary rows, jobs empty; lazy-loaded history). GitHub
// only; other forges lack the method → empty. limit defaults to 10, clamped 1..50.
async function handleActionsHistory({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "GET" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "history"
  )
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const wfRaw = url.searchParams.get("workflowId");
  const workflowId = Number(wfRaw);
  if (!wfRaw || !Number.isFinite(workflowId)) return json({ error: "workflowId required" }, 400);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 10), 50);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.listWorkflowRunHistory) return json({ runs: [] });
  try {
    return json({ runs: await forge.listWorkflowRunHistory(workflowId, { limit }) });
  } catch {
    // missing/un-authed CLI or network error → graceful empty (matches list path)
    return json({ runs: [] });
  }
}

// GET /api/actions/run-jobs?repo=&runId= — per-job breakdown for a single run,
// lazy-loaded when a history row is expanded. GitHub only; others → empty.
async function handleActionsRunJobs({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "GET" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "run-jobs"
  )
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const runRaw = url.searchParams.get("runId");
  const runId = Number(runRaw);
  if (!runRaw || !Number.isFinite(runId)) return json({ error: "runId required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.listRunJobs) return json({ jobs: [] });
  try {
    return json({ jobs: await forge.listRunJobs(runId) });
  } catch {
    return json({ jobs: [] });
  }
}

// POST /api/prs/merge — merge a backlog PR by repo + number (no session involved).
async function handlePrMerge({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "prs" || parts[2] !== "merge")
    return null;
  const body = (await req.json().catch(() => ({}))) as {
    repo?: string;
    number?: number;
    method?: MergeMethod;
    deleteBranch?: boolean;
  };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.number !== "number") return json({ error: "number required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge) return json({ error: "no forge for repo" }, 400);
  try {
    await forge.merge(body.number, {
      method: body.method ?? forge.mergeMethod,
      deleteBranch: body.deleteBranch ?? true,
    });
    // Evict the open-PR snapshot for this repo so the panel's silent refetch
    // (GET /api/prs, right after this 200) misses the cache and fetches fresh —
    // otherwise the still-TTL-fresh snapshot re-lists the just-merged PR. Sync,
    // before the response, so the refetch can't race a cache that still has it.
    deps.openPrSnapshot?.invalidate?.(forge);
    // Detached, best-effort: the merge already succeeded, so a refresh/broadcast
    // hiccup must not fail the response, and the GraphQL refetch must not delay the
    // "merged" feedback. Pushes the merged PR (and any auto-closed linked issue) out
    // of the backlog counters + headline now; the warm poller reconciles regardless.
    void deps.refreshBacklog?.(dir).catch(() => {});
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "merge failed" }, 502);
  }
}

// POST /api/repos/pull — fast-forward the local default-branch checkout of a repo
// to its remote tip (e.g. after a PR merge), so the canonical clone doesn't drift.
// Resolves the default branch (validated client hint → local origin/HEAD → forge)
// then attempts a strict fail-closed fast-forward. 200 on success; 409 for the
// client-correctable fail-closed states (wrong_branch/dirty/diverged); 502 on a
// resolution/exec error.
async function handleRepoPull({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "repos" || parts[2] !== "pull")
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; branch?: string };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  const branch = await resolveDefaultBranch(dir, {
    hint: body.branch,
    forgeDefault: forge ? () => forge.defaultBranch().catch(() => null) : undefined,
  });
  if (!branch) return json({ ok: false, reason: "error" }, 502);
  const result = await fastForwardDefaultBranch(dir, branch);
  const status = result.ok ? 200 : result.reason === "error" ? 502 : 409;
  return json(result, status);
}

// Map a `gh repo sync` failure to a stable `syncfork_failed_*` code (mirrors the
// fork-create classifier). Diverged = the fork's default branch carries commits
// not on upstream, so gh refuses a non-fast-forward — client-correctable, hence 409.
function classifySyncForkError(e: unknown): { code: string; status: number } {
  const s = String(
    (e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? "",
  ).toLowerCase();
  if (s.includes("command not found") || (e as { code?: string }).code === "ENOENT")
    return { code: "syncfork_failed_gh_missing", status: 502 };
  if (
    s.includes("not logged") ||
    s.includes("gh auth login") ||
    s.includes("authentication") ||
    s.includes("403")
  )
    return { code: "syncfork_failed_auth", status: 502 };
  if (s.includes("diverg") || s.includes("fast forward") || s.includes("fast-forward"))
    return { code: "syncfork_failed_diverged", status: 409 };
  return { code: "syncfork_failed_generic", status: 502 };
}

// POST /api/repos/sync-fork — bring a fork current with its upstream. Runs
// `gh repo sync` on the host (updates the fork's default branch from upstream),
// then fast-forwards the local default-branch checkout so the canonical clone
// matches. Fork repos only: a non-fork forge (no `syncFork`) 400s and the UI never
// offers the action. 200 on success; 4xx/502 with a `syncfork_failed_*` code on failure.
async function handleSyncFork({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "repos" ||
    parts[2] !== "sync-fork"
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.syncFork || !forge.isFork) return json({ error: "syncfork_failed_not_fork" }, 400);
  try {
    await forge.syncFork();
  } catch (e) {
    const { code, status } = classifySyncForkError(e);
    return json({ error: code }, status);
  }
  // Best-effort: fast-forward the local default-branch checkout to the freshly
  // synced fork tip. A fail-closed FF state (dirty/diverged local tree) is NOT a
  // sync failure — the remote fork is already current — so we still report ok.
  const branch = await resolveDefaultBranch(dir, {
    forgeDefault: () => forge.defaultBranch().catch(() => null),
  });
  if (branch) await fastForwardDefaultBranch(dir, branch).catch(() => undefined);
  return json({ ok: true, branch: branch ?? undefined });
}

// POST /api/prs/dependabot-rebase — post the opt-in "@dependabot rebase" command on
// a stuck Dependabot PR by repo + number. The body is fixed server-side. GitHub
// only (forge must expose `comment`); other forges 400 and the UI never offers it.
async function handleDependabotRebase({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "POST" ||
    parts[0] !== "api" ||
    parts[1] !== "prs" ||
    parts[2] !== "dependabot-rebase"
  )
    return null;
  const body = (await req.json().catch(() => ({}))) as { repo?: string; number?: number };
  const dir = safeRepoDir(body.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (typeof body.number !== "number") return json({ error: "number required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.comment) return json({ error: "no comment support" }, 400);
  try {
    await forge.comment(body.number, DEPENDABOT_REBASE_COMMAND);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "comment failed" }, 502);
  }
}

/** Per-repo row in the backlog overview. */
export interface BacklogProject {
  path: string;
  display: string;
  slug: string | null;
  kind: string;
  lastUsedAt: number | null;
  /** Agents run on this repo in the last {@link RECENT_WINDOW_DAYS} days — same
   *  metric the New Task repo picker pins its "recently worked on" group by. */
  recentAgentCount: number | null;
  openIssues: number | null;
  openPRs: number | null;
  /** Open-PR breakdown by kind for the repo-list row; null for non-GitHub forges. */
  prKinds: { release: number; dependabot: number; regular: number } | null;
  /** Workflows defined under .github/workflows; null for non-GitHub forges. */
  workflows: number | null;
  /** Default-branch CI rollup state for the Actions tab marker; null = unknown / non-GitHub. */
  ciStatus: "success" | "failure" | "pending" | null;
  /** Hidden from the repos panel (list-only declutter). The client filters on this. */
  hidden: boolean;
}
export interface BacklogPayload {
  pinnedPath: string | null;
  projects: BacklogProject[];
  totals: { openIssues: number; openPRs: number };
}

/** What an empty/unconfigured backlog looks like — also the no-forge fast path. */
const EMPTY_BACKLOG: BacklogPayload = {
  pinnedPath: null,
  projects: [],
  totals: { openIssues: 0, openPRs: 0 },
};

/** Inputs for {@link buildBacklogPayload} — kept narrow so both the request path
 *  (AppDeps) and the background poller (index.ts locals) can supply them. */
export interface BacklogPayloadInputs {
  counts: (repoDir: string) => Promise<RepoCounts>;
  resolveForge: (repoDir: string) => GitForge | null;
  lastUsedByRepo: () => Record<string, number>;
  /** repoPath → agents run since `since` (ms epoch) — store.recentSessionCountsByRepo. */
  recentCountsByRepo: (since: number) => Record<string, number>;
  /** repoPaths flagged hidden from the repos panel — store.hiddenRepoPaths(). */
  hiddenRepoPaths: () => Set<string>;
  repoRoot: string;
}

/**
 * Build the backlog overview payload: every repo under `repoRoot`, deduped by
 * forge slug (forge-backed) or path (forge-less), with open issue/PR counts, a
 * pinned project, and totals. Forge-less repos (no detectable remote) and
 * lightweight repos (LocalForge) appear with `kind:"local"`, null slug, and
 * empty counts so their per-repo settings stay reachable without launching a
 * task. Shared by GET /api/backlog and the poller's `backlog:update` broadcast
 * so both emit byte-identical snapshots.
 */
export async function buildBacklogPayload(inputs: BacklogPayloadInputs): Promise<BacklogPayload> {
  const repos = listRepos(inputs.repoRoot);
  const lastUsed = inputs.lastUsedByRepo();
  // Same window the repo picker's "recently worked on" group is computed over,
  // so the backlog's recent-repos group ranks by identical criteria.
  const recentCounts = inputs.recentCountsByRepo(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  // repo_config keys are safeRepoDir/realpath-resolved, but listRepos enumerates the
  // raw join(repoRoot, name) path that each project's `r.path` carries. Under a
  // symlinked repoRoot/repo those diverge, so reconcile the hidden set back into
  // listRepos' raw space — else a persisted hide wouldn't match its project and would
  // silently reappear on reload. Reuses the `repos` enumeration above so the realpath
  // map is built once (not re-readdir'd per hidden repo).
  const hiddenSet = reconcileRealPathsToRaw(inputs.hiddenRepoPaths(), repos);

  const resolved = repos.map((r) => ({ ...r, forge: inputs.resolveForge(r.path) }));

  // Forge-backed repos (incl. lightweight repos, which resolve to a LocalForge):
  // collapse worktrees/clones of the same repo so each appears once (see helper).
  const forgeRepos = dedupeReposByForge(
    resolved.filter((r): r is typeof r & { forge: GitForge } => r.forge !== null),
    lastUsed,
  );

  // Forge-less repos (no detectable remote, still in forge mode) are kept too, so
  // their per-repo settings stay reachable in the Backlog drill-down without
  // launching a task. They carry no slug to collapse by, so dedupe by path
  // (listRepos paths are already unique — the Map is belt-and-suspenders).
  const localRepos = [
    ...new Map(resolved.filter((r) => r.forge === null).map((r) => [r.path, r])).values(),
  ];

  const uniqueRepos = [...forgeRepos, ...localRepos];

  // Fetch counts for the deduped repos in parallel
  const countsArr = await Promise.all(uniqueRepos.map((r) => inputs.counts(r.path)));

  const projects: BacklogProject[] = uniqueRepos.map((r, i) => {
    const counts = countsArr[i]!;
    return {
      path: r.path,
      display: r.display,
      slug: r.forge?.slug ?? null,
      kind: r.forge?.kind ?? "local",
      lastUsedAt: lastUsed[r.path] ?? null,
      recentAgentCount: recentCounts[r.path] ?? null,
      openIssues: counts.openIssues,
      openPRs: counts.openPRs,
      prKinds: counts.prKinds,
      // GitHub-only: the Actions panel is github-gated, so other forges get null
      // (plain "Actions" label) rather than a count that has no panel behind it.
      workflows: r.forge?.kind === "github" ? countDefinedWorkflows(r.path) : null,
      ciStatus: counts.ciStatus,
      hidden: hiddenSet.has(r.path),
    };
  });

  // Sort: descending openIssues (null → -1), tie-break path ascending
  projects.sort((a, b) => {
    const ai = a.openIssues ?? -1;
    const bi = b.openIssues ?? -1;
    if (bi !== ai) return bi - ai;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  // Pin: project with max lastUsedAt; tie-break lowest path; if none have lastUsedAt → first after sort
  let pinnedPath: string | null = null;
  if (projects.length > 0) {
    const withUsed = projects.filter((p) => p.lastUsedAt !== null);
    if (withUsed.length > 0) {
      const pinned = withUsed.reduce((best, cur) => {
        if (cur.lastUsedAt! > best.lastUsedAt!) return cur;
        if (cur.lastUsedAt! === best.lastUsedAt! && cur.path < best.path) return cur;
        return best;
      });
      pinnedPath = pinned.path;
    } else {
      pinnedPath = projects[0]!.path;
    }
  }

  // Totals: sum non-null values
  let totalIssues = 0;
  let totalPRs = 0;
  for (const p of projects) {
    if (p.openIssues !== null) totalIssues += p.openIssues;
    if (p.openPRs !== null) totalPRs += p.openPRs;
  }

  return { pinnedPath, projects, totals: { openIssues: totalIssues, openPRs: totalPRs } };
}

// AI-readiness scorecard for one repo (Backlog "Readiness" mode). Deterministic
// guardrail scan only — never executes the target repo's code.
async function handleReadiness({ req, parts, url }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "readiness" || parts[2])
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  return json(analyzeReadiness(dir));
}

// POST /api/adopt-gitignore?repo= — open a PR adding the managed .shepherd-* ignore
// block to the repo's committed .gitignore. Modelled on the promote route.
async function handleAdoptGitignore({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "adopt-gitignore" || parts[2]) return null;
  if (req.method !== "POST") return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (!deps.gitignoreAdopter) return json({ error: "adopt unavailable" }, 503);
  const res = await deps.gitignoreAdopter.adopt(dir);
  if (res.ok) {
    return res.status === "applied"
      ? json({ status: "applied", prUrl: res.url })
      : json({ status: "already" });
  }
  // Expected non-error outcomes (no-forge / no-access): a 200 status the UI maps
  // to an info toast, not a retryable error.
  if ("reason" in res) return json({ status: res.reason });
  return json({ error: res.error }, res.status);
}

async function handleBacklog({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "backlog" || parts[2]) return null;
  if (!deps.backlog) return json(EMPTY_BACKLOG);
  const backlog = deps.backlog;
  return json(
    await buildBacklogPayload({
      counts: (p) => backlog.counts(p),
      resolveForge: (p) => deps.resolveForge?.(p) ?? null,
      lastUsedByRepo: () => deps.store.lastUsedByRepo(),
      recentCountsByRepo: (since) => deps.store.recentSessionCountsByRepo(since),
      hiddenRepoPaths: () => deps.store.hiddenRepoPaths(),
      repoRoot: config.repoRoot,
    }),
  );
}

function todoRead(repoParam: string): Response {
  const r = readTodo(repoParam, config.repoRoot);
  if (!r.ok) return json({ error: "invalid repo path" }, 400);
  return json(r);
}

async function todoWrite(repoParam: string, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (
    body === null ||
    typeof body !== "object" ||
    typeof (body as { content?: unknown }).content !== "string"
  ) {
    return json({ error: "body must be {content: string}" }, 400);
  }
  const ok = writeTodo(repoParam, config.repoRoot, (body as { content: string }).content);
  if (!ok) return json({ error: "invalid repo path or content too large" }, 400);
  return json({ ok: true });
}

// ── installed slash commands: skills + command files for the New Task picker ──
function handleCommands({ req, parts, url }: Ctx): Response | null {
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "commands" && !parts[2]) {
    // invalid/absent repo → null dir → user-scope commands only (still useful)
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    return json({ commands: listCommands(dir, join(homedir(), ".claude")) });
  }
  return null;
}

async function handleTodo({ req, parts, url }: Ctx): Promise<Response | null> {
  if (parts[0] === "api" && parts[1] === "todo" && !parts[2]) {
    const repoParam = url.searchParams.get("repo") ?? "";
    if (req.method === "GET") return todoRead(repoParam);
    if (req.method === "PUT") return todoWrite(repoParam, req);
  }
  return null;
}

// ── reachability probe: lets the Capture extension verify connection (auth +
// origin-allowlist) before first capture. Pure no-op — rides the global
// checkAuth→checkOrigin guards, so a bad token 401s and a disallowed origin
// 403s exactly as a real capture POST would; only 200s when both pass. MUST be
// POST: checkOrigin skips GET/HEAD, so a GET ping couldn't reproduce the 403.
function handlePing({ req, parts }: Ctx): Response | null {
  if (req.method !== "POST" || parts[0] !== "api" || parts[1] !== "ping" || parts[2]) return null;
  return json({ ok: true });
}

// Public liveness probe (issue #1112) — DISTINCT from handlePing on purpose. `handlePing`
// is a POST behind checkAuth + checkOrigin (CSRF): a probe for an already-logged-in client.
// This is the opposite: an un-credentialed GET/HEAD that answers BEFORE login, so deploy/update.sh's
// health check and the onboarding harness's boot poll can confirm the server serves HTTP
// without a cookie/token (isPublicRequest exempts exactly this method+path). Discloses nothing.
// Answers HEAD as well as GET — isPublicRequest exempts both, so a HEAD must not fall through
// to the /api 404 (a liveness monitor probing with HEAD expects a bodyless 200).
/** Server-side plugin routes (issue #1124):
 *  - `GET /api/plugins` → the status-panel listing (empty array when no registry / no
 *    plugins, so the UI hides the section; a fresh public clone behaves as today).
 *  - `/api/plugins/<id>/<sub…>` → a plugin-registered route (any method). Unknown
 *    plugin/route → null (falls through to the standard `/api` 404). All of these sit
 *    behind the operator auth gate in makeApp (checkAuth runs before ROUTE_HANDLERS). */
/** Plugin MANAGEMENT routes (install-from-URL / uninstall / on-disk scan) — the
 *  Settings → Plugins manager. Reserved segment `manage` under `/api/plugins`, matched
 *  BEFORE `handlePluginRoutes` (registered ahead of it) so it can never be shadowed by, nor
 *  shadow, a plugin's own `/api/plugins/<id>/*` routes. `manage` is a reserved plugin id
 *  (install rejects it). All behind operator auth + the CSRF origin check (both run before
 *  ROUTE_HANDLERS). Falls through (null) when `pluginsDir` isn't wired (tests).
 *  - `GET    /api/plugins/manage/installed`          → `{ installed: InstalledPlugin[] }`
 *  - `POST   /api/plugins/manage/install`  `{ url }` → `{ plugin }` | 400 `{ error }`
 *  - `POST   /api/plugins/manage/activate` `{ folder }` → `{ plugin }` | 400/409 `{ error }`
 *  - `DELETE /api/plugins/manage/installed/<folder>` → `{ ok:true }` | 400/404 `{ error }` */
/** POST /api/plugins/manage/install — validate + clone. Body errors → 400. */
async function pluginInstall(
  req: Request,
  pluginsDir: string,
  loadedIds: Set<string>,
): Promise<Response> {
  let body: { url?: unknown };
  try {
    body = (await req.json()) as { url?: unknown };
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return json({ error: "url_required" }, 400);
  const result = await installPlugin(pluginsDir, url, loadedIds);
  return result.ok ? json({ plugin: result.plugin }) : json({ error: result.error }, 400);
}

/** DELETE /api/plugins/manage/installed/<folder> — remove a plugin folder. */
async function pluginUninstall(pluginsDir: string, folder: string): Promise<Response> {
  const result = await uninstallPlugin(pluginsDir, decodeURIComponent(folder));
  if (result.ok) return json({ ok: true });
  return json({ error: result.error }, result.error === "not_found" ? 404 : 400);
}

/** POST /api/plugins/manage/activate — load an installed folder in-process (no restart).
 *  Returns the resulting `PluginInfo` (health `ok` OR `errored` + lastError) so the UI can
 *  reflect a failed register()/deps activation instead of falsely claiming the plugin is live. */
async function pluginActivate(req: Request, registry: PluginRegistry): Promise<Response> {
  let body: { folder?: unknown };
  try {
    body = (await req.json()) as { folder?: unknown };
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const folder = typeof body.folder === "string" ? body.folder.trim() : "";
  if (!folder) return json({ error: "folder_required" }, 400);
  const result = await registry.activateOne(folder);
  return result.ok ? json({ plugin: result.plugin }) : json({ error: result.error }, 400);
}

async function handlePluginManagement({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "plugins" || parts[2] !== "manage") return null;
  const pluginsDir = deps.pluginsDir;
  if (!pluginsDir) return null;
  // Loaded ids for cross-referencing / collision checks; null-registry-safe (fresh clone).
  const loadedIds = new Set((deps.pluginRegistry?.list() ?? []).map((p) => p.id));
  const [seg, folder] = [parts[3], parts[4]];

  if (seg === "installed" && !folder && req.method === "GET") {
    return json({ installed: await scanInstalled(pluginsDir, loadedIds) });
  }
  if (seg === "install" && !folder && req.method === "POST") {
    return pluginInstall(req, pluginsDir, loadedIds);
  }
  if (seg === "activate" && !folder && req.method === "POST") {
    if (!deps.pluginRegistry) return json({ error: "no_registry" }, 409);
    return pluginActivate(req, deps.pluginRegistry);
  }
  if (seg === "installed" && folder && !parts[5] && req.method === "DELETE") {
    return pluginUninstall(pluginsDir, folder);
  }
  return null;
}

async function handlePluginRoutes({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "plugins") return null;
  if (!parts[2]) {
    if (req.method !== "GET") return null;
    return json({ plugins: deps.pluginRegistry?.list() ?? [] });
  }
  const registry = deps.pluginRegistry;
  if (!registry) return null;
  const subPath = parts.slice(3).join("/");
  if (!subPath) return null; // /api/plugins/<id> with no sub-route → 404
  return registry.handleRoute(req.method, parts[2], subPath, req);
}

function handleHealth({ req, parts }: Ctx): Response | null {
  if (
    (req.method !== "GET" && req.method !== "HEAD") ||
    parts[0] !== "api" ||
    parts[1] !== "health" ||
    parts[2]
  ) {
    return null;
  }
  return req.method === "HEAD" ? new Response(null, { status: 200 }) : json({ ok: true });
}

/** Authenticated (unlike handleHealth) — reports the herdr socket terminal transport's flag
 *  state, live-active status, and per-boot attach/fallback counters. */
function handleTerminalTransport({ req, parts, deps }: Ctx): Response | null {
  if (req.method !== "GET" || parts[0] !== "api" || parts[1] !== "terminal-transport" || parts[2])
    return null;
  return json({
    flagActive: config.herdrSocket,
    socketActive: deps.herdrSocketActive ?? false,
    ...terminalTransportMetrics(),
  });
}

// ── Epic API routes ──────────────────────────────────────────────────────────

/** Build a default EpicRun from repo + parent when no stored run exists. */
function defaultEpicRun(repoPath: string, parentIssueNumber: number): EpicRun {
  return {
    repoPath,
    parentIssueNumber,
    mode: "auto",
    status: "idle",
    agentProvider: null,
    model: null,
    effort: null,
  };
}

function patchHas<K extends keyof EpicRunPatch>(patch: EpicRunPatch, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function mergedEpicRunAgentProvider(base: EpicRun, patch: EpicRunPatch): AgentProvider | null {
  return patchHas(patch, "agentProvider")
    ? (patch.agentProvider ?? null)
    : (base.agentProvider ?? null);
}

function inheritedEpicProviderSettings(
  patch: EpicRunPatch,
): Pick<EpicRun, "agentProvider" | "model" | "effort"> | null {
  const explicitModel = patchHas(patch, "model") && patch.model !== null;
  const explicitEffort = patchHas(patch, "effort") && patch.effort !== null;
  return explicitModel || explicitEffort
    ? null
    : { agentProvider: null, model: null, effort: null };
}

function normalizeEpicRunModel(
  agentProvider: AgentProvider,
  model: string | null,
  patch: EpicRunPatch,
): string | null | false {
  if (model === null || modelCompatibleWithProvider(model, agentProvider)) return model;
  return patchHas(patch, "agentProvider") && !patchHas(patch, "model") ? null : false;
}

function normalizeEpicRunProviderSettings(
  base: EpicRun,
  patch: EpicRunPatch,
): Pick<EpicRun, "agentProvider" | "model" | "effort"> | null {
  const agentProvider = mergedEpicRunAgentProvider(base, patch);
  const model = patchHas(patch, "model") ? (patch.model ?? null) : (base.model ?? null);
  const effort = patchHas(patch, "effort") ? (patch.effort ?? null) : (base.effort ?? null);

  if (agentProvider === null) return inheritedEpicProviderSettings(patch);
  const normalizedModel = normalizeEpicRunModel(agentProvider, model, patch);
  if (normalizedModel === false) return null;

  return { agentProvider, model: normalizedModel, effort };
}

function mergeEpicRunPatch(
  base: EpicRun,
  patch: ReturnType<typeof validateEpicRunPatch>,
): EpicRun | null {
  if (patch === null) return null;
  const providerSettings = normalizeEpicRunProviderSettings(base, patch);
  if (providerSettings === null) return null;
  return {
    ...base,
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...providerSettings,
  };
}

// GET /api/epics?repo= — list epic parent issues for a repo.
// Pre-filters candidates cheaply (free string parse) before any network call:
// an issue is a candidate iff its body has a non-empty markdown member list OR
// it is the repo's stored epic_run parent. Counts are computed directly —
// no buildEpic (which would add per-child blocked_by calls).
// Probe strategy: when the open-issue list is complete (<200 items) and the
// candidate has markdown members, counts are derived from markdown alone —
// absent-from-open-set == closed, no cap risk, no network call. When the open
// list is truncated (>=200) OR the candidate has no markdown body, a native
// listSubIssues call is made to avoid undercounting capped issues.

// `assignees`/`author` ride along from the full `Issue` objects `listIssues()` already
// returns (this type just narrows them) — exposing them here is pure type-plumbing at zero
// network cost, so the epic-summary route can flag an epic as "someone else's": parent
// assigned to a non-viewer, or authored by a non-viewer (the tell for a freshly-created
// epic that has no child PRs yet). Both optional — candidates outside the open-issue window
// carry no hint and simply lack these signals.
type IssueHint = {
  body?: string;
  title?: string;
  number?: number;
  assignees?: string[];
  author?: string;
};

/** Collect epic-candidate map from open issues + any stored run parent.
 *  Keys are parent issue numbers; values are the issue hint (may be undefined
 *  when the stored-run parent isn't in the open list). */
function collectEpicCandidates(
  openIssues: IssueHint[],
  storedRunParent: number | null,
): Map<number, IssueHint | undefined> {
  const issueByNumber = new Map(openIssues.map((i) => [i.number!, i]));
  const candidates = new Map<number, IssueHint | undefined>();
  for (const issue of openIssues) {
    if (parseEpicBody(issue.body ?? "").members.length > 0) candidates.set(issue.number!, issue);
  }
  // Stored-run parent may be closed / beyond the page cap — include it anyway.
  if (storedRunParent !== null && !candidates.has(storedRunParent)) {
    candidates.set(storedRunParent, issueByNumber.get(storedRunParent));
  }
  return candidates;
}

/** Compute markdown-only counts for a candidate (fast, no network call). */
function markdownCounts(
  issueHint: IssueHint | undefined,
  openNumbers: Set<number>,
): { total: number; merged: number } {
  const members = parseEpicBody(issueHint?.body ?? "").members;
  return { total: members.length, merged: members.filter((m) => !openNumbers.has(m)).length };
}

/** Probe native sub_issues API for a candidate. Returns counts when non-empty,
 *  null when the API throws (caller should skip the candidate). */
async function probeNative(
  forge: GitForge,
  parentNumber: number,
): Promise<{ total: number; merged: number } | "empty" | null> {
  if (!forge.listSubIssues) return "empty";
  try {
    const subs = await forge.listSubIssues(parentNumber);
    if (subs.length === 0) return "empty";
    return { total: subs.length, merged: subs.filter((s) => s.closed).length };
  } catch {
    // one failure skips this candidate, not the whole route
    return null;
  }
}

/** Resolve total/merged counts for one epic candidate (the backlog badge summary only).
 *  Accepts pre-parsed `mdMembers` (from `parseEpicBody`) to avoid a redundant re-parse
 *  at the call site.
 *  When the open-issue list is complete (!openTruncated) and the candidate has
 *  markdown members, counts are derived from markdown alone — no network call.
 *  Otherwise a native listSubIssues probe is made; on empty result, markdown
 *  fallback is used.
 *  Returns null when the native probe throws (caller skips the candidate).
 *
 *  NOTE: in that fast path the markdown count takes precedence over the native
 *  sub-issue count, so this summary can diverge from `GET /api/epic`'s buildEpic
 *  (which is always native-first/authoritative) if a parent's markdown checklist
 *  and its native sub-issue links disagree (e.g. a stale checklist body). This is
 *  an intentional cost/accuracy trade for the list badge: it stays cap-safe (the
 *  fast path only runs when the open list is complete, so markdown==native counts
 *  for well-maintained bodies) and free, while the per-epic view shows the
 *  authoritative native state. */
async function summarizeEpicCandidate(
  forge: GitForge,
  mdMembers: number[],
  issueHint: IssueHint | undefined,
  parentNumber: number,
  openNumbers: Set<number>,
  openTruncated: boolean,
): Promise<{ total: number; merged: number } | null> {
  const hasMarkdown = mdMembers.length > 0;

  // Fast path: open list is complete + candidate has markdown — no network call needed.
  if (hasMarkdown && !openTruncated) {
    return { total: mdMembers.length, merged: mdMembers.filter((m) => !openNumbers.has(m)).length };
  }

  // Probe native: truncated list or no markdown body.
  const native = await probeNative(forge, parentNumber);
  if (native === null) return null; // forge threw — skip candidate
  if (native !== "empty") return native; // native counts available

  // Native returned nothing — fall back to markdown if available.
  return markdownCounts(issueHint, openNumbers);
}

/** Per-parent native sub-issue counts keyed by parent issue number (from listSubIssueSummaries). */
type NativeSummaryMap = Map<number, { total: number; completed: number }>;

/** Best-effort fetch of native sub-issue summaries (GitHub only; one bounded forge call that
 *  internally pages up to MAX_SUMMARY_PAGES GraphQL requests). Returns an empty map on any error
 *  so discovery degrades to markdown-only. Also surfaces native sub-issue child numbers. */
async function fetchNativeSummaries(forge: GitForge): Promise<{
  summaries: NativeSummaryMap;
  subIssueNumbers: number[];
  childrenByParent: Map<number, number[]>;
}> {
  try {
    // The method catches internally today; this guard keeps discovery alive if that changes.
    const r = await forge.listSubIssueSummaries?.();
    return {
      summaries: r?.summaries ?? new Map(),
      subIssueNumbers: r?.subIssueNumbers ?? [],
      childrenByParent: r?.childrenByParent ?? new Map(),
    };
  } catch {
    return { summaries: new Map(), subIssueNumbers: [], childrenByParent: new Map() };
  }
}

/** Resolve a candidate's badge source + merged/total counts (null when the markdown probe
 *  threw → skip the candidate).
 *
 *  Source is markdown-first BY DESIGN — the intentional INVERSE of assembleEpic's
 *  native-first Epic.source (src/epic-model.ts:126): a both-present parent reads
 *  source:"markdown" here (the list badge follows the declared-epic-first convention) but
 *  source:"native" on the assembled Epic (native structure is authoritative for execution).
 *  Native counts come straight from the summary map — no per-candidate listSubIssues probe;
 *  markdown counts go through summarizeEpicCandidate. */
async function resolveEpicSummary(
  forge: GitForge,
  parentNumber: number,
  issueHint: IssueHint | undefined,
  nativeSummaries: NativeSummaryMap,
  openNumbers: Set<number>,
  openTruncated: boolean,
): Promise<{ counts: { total: number; merged: number }; source: EpicSource } | null> {
  const mdMembers = parseEpicBody(issueHint?.body ?? "").members;
  // Native-only candidate: counts straight from the summary, no probe.
  if (mdMembers.length === 0) {
    const native = nativeSummaries.get(parentNumber);
    if (native)
      return { counts: { total: native.total, merged: native.completed }, source: "native" };
  }
  // Markdown candidate, both-present (markdown precedence), or stored-run-only fallback.
  const counts = await summarizeEpicCandidate(
    forge,
    mdMembers,
    issueHint,
    parentNumber,
    openNumbers,
    openTruncated,
  );
  return counts && { counts, source: "markdown" };
}

/** Build the epic-candidate map: markdown + stored-run candidates (from collectEpicCandidates),
 *  plus any *visible* open issue that has native sub-issues but no markdown body. Native parents
 *  are gated to the visible listIssues set on purpose: IssuesPanel renders an epic badge only by
 *  matching a summary to a rendered issue row (by number), so a native parent beyond the ≤200
 *  listIssues window could never be displayed — surfacing it would only emit an unused row. A
 *  visible native parent already carries its real IssueHint (title + body) from listIssues. */
function buildEpicCandidates(
  openIssues: IssueHint[],
  storedRunParent: number | null,
  nativeSummaries: NativeSummaryMap,
): Map<number, IssueHint | undefined> {
  const candidates = collectEpicCandidates(openIssues, storedRunParent);
  const openByNumber = new Map(openIssues.map((i) => [i.number!, i]));
  for (const n of nativeSummaries.keys()) {
    const hint = openByNumber.get(n);
    if (hint && !candidates.has(n)) candidates.set(n, hint);
  }
  return candidates;
}

/** Resolve every candidate into a backlog epic-summary row (skipping any whose markdown
 *  probe threw). */
async function buildEpicSummaries(
  forge: GitForge,
  candidates: Map<number, IssueHint | undefined>,
  nativeSummaries: NativeSummaryMap,
  storedRun: EpicRun | null,
  openNumbers: Set<number>,
  openTruncated: boolean,
  childrenByParent: Map<number, number[]>,
  linked: Map<number, LinkedPr[]>,
  viewer: string | null,
) {
  const result = [];
  for (const [parentNumber, issueHint] of candidates) {
    const resolved = await resolveEpicSummary(
      forge,
      parentNumber,
      issueHint,
      nativeSummaries,
      openNumbers,
      openTruncated,
    );
    if (!resolved) continue; // markdown probe threw — skip this candidate
    const status = storedRun?.parentIssueNumber === parentNumber ? storedRun.status : "idle";
    // "Someone else is working this" flags. Child numbers = markdown members ∪ native children
    // (either source may be empty); computeEpicOthersFlags excludes the viewer's own PRs.
    const childNumbers = [
      ...parseEpicBody(issueHint?.body ?? "").members,
      ...(childrenByParent.get(parentNumber) ?? []),
    ];
    const flags = computeEpicOthersFlags({
      childNumbers,
      linked,
      assignees: issueHint?.assignees ?? [],
      author: issueHint?.author ?? null,
      viewer,
    });
    result.push({
      parentIssueNumber: parentNumber,
      parentTitle: issueHint?.title ?? `#${parentNumber}`,
      ...resolved.counts,
      status,
      source: resolved.source,
      ...flags,
    });
  }
  return result;
}

/** Issue numbers the backlog "hide sub-issues" filter should hide: native sub-issues plus the
 *  open markdown (epic-dag) members of every candidate. Markdown epics have no GitHub-native
 *  parent links, so their children never appear in `nativeSubIssues` — fold them in here. A
 *  mid-level epic that is also a member stays visible (the UI guards hiding on epicParents). */
function collectSubIssueNumbers(
  candidates: Map<number, IssueHint | undefined>,
  nativeSubIssues: number[],
  openNumbers: Set<number>,
): number[] {
  const subIssues = new Set(nativeSubIssues);
  for (const hint of candidates.values()) {
    for (const m of parseEpicBody(hint?.body ?? "").members) {
      if (openNumbers.has(m)) subIssues.add(m);
    }
  }
  return [...subIssues];
}

async function handleEpicsList({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "GET" && parts[0] === "api" && parts[1] === "epics" && !parts[2]))
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  if (!deps.drain) return json({ epics: [], subIssues: [] });
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge) return json({ epics: [], subIssues: [] });

  const storedRun = deps.store.getEpicRun(dir);
  let openIssues: Awaited<ReturnType<typeof forge.listIssues>>;
  try {
    openIssues = await forge.listIssues();
  } catch {
    // forge/network error → graceful empty (matches handleIssues/handlePrsList convention)
    return json({ epics: [], subIssues: [] });
  }

  // Fetch native sub-issue summaries cheaply (one bounded forge call, ≤2 GraphQL pages, GitHub only).
  const {
    summaries: nativeSummaries,
    subIssueNumbers,
    childrenByParent,
  } = await fetchNativeSummaries(forge);
  // Open-PR→author map (TTL-cached; +1 bounded call/repo) + the viewer, for the "someone else
  // is working this" pill. Both best-effort: an empty map / null viewer just softens the pill.
  const linked = await cachedLinkedPrs(dir, forge);
  const viewer = (await forge.currentUser?.()) ?? null;

  // openNumbers: a member absent from the open set is considered closed (markdown fallback).
  // openTruncated: listIssues caps at 200; when true the open set may be incomplete so
  // markdown-only counting could undercount, and native probes are needed.
  const openNumbers = new Set(openIssues.map((i) => i.number));
  const openTruncated = openIssues.length >= 200;
  const candidates = buildEpicCandidates(
    openIssues,
    storedRun?.parentIssueNumber ?? null,
    nativeSummaries,
  );
  const result = await buildEpicSummaries(
    forge,
    candidates,
    nativeSummaries,
    storedRun,
    openNumbers,
    openTruncated,
    childrenByParent,
    linked,
    viewer,
  );
  const subIssues = collectSubIssueNumbers(candidates, subIssueNumbers, openNumbers);
  return json({ epics: result, subIssues });
}

// GET /api/epic?repo=&parent= — assemble the Epic for a single parent issue.
async function handleEpicGet({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "GET" && parts[0] === "api" && parts[1] === "epic" && !parts[2]))
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const parentRaw = url.searchParams.get("parent");
  const parentNumber = parseInt(parentRaw ?? "", 10);
  if (!Number.isInteger(parentNumber) || parentNumber <= 0)
    return json({ error: "parent must be a positive integer" }, 400);
  if (!deps.drain) return json({ error: "drain unavailable" }, 503);
  // One epic per repo; ?parent selects/supersedes: use stored run only when it matches the requested parent.
  const stored = deps.store.getEpicRun(dir);
  const run =
    stored && stored.parentIssueNumber === parentNumber
      ? stored
      : defaultEpicRun(dir, parentNumber);
  const epic = await deps.drain.buildEpic(dir, run);
  if (!epic) return json({ error: "not found" }, 404);
  return json(epic);
}

// GET /api/epic/diagnose?repo=&parent= — structural diagnosis for one epic parent.
async function handleEpicDiagnose({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "epic" &&
    parts[2] === "diagnose" &&
    !parts[3]
  ))
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const parentRaw = url.searchParams.get("parent");
  const parentNumber = parseInt(parentRaw ?? "", 10);
  if (!Number.isInteger(parentNumber) || parentNumber <= 0)
    return json({ error: "parent must be a positive integer" }, 400);
  if (!deps.drain) return json({ error: "drain unavailable" }, 503);
  // One epic per repo; ?parent selects/supersedes: use stored run only when it matches the requested parent.
  const stored = deps.store.getEpicRun(dir);
  const run =
    stored && stored.parentIssueNumber === parentNumber
      ? stored
      : defaultEpicRun(dir, parentNumber);
  const diagnosis = await deps.drain.diagnoseEpic(dir, run);
  if (!diagnosis) return json({ error: "not found" }, 404);
  return json(diagnosis);
}

// Kick the drain immediately on epic Start so the first sub-issue session spawns
// at once and surfaces live in the (push-only) Herd via doSpawn's session:new
// emit — without this it only appears on the next ~30s sweep. Fire-and-forget,
// DELIBERATELY unlike approve-next which `await`s tick(): the EpicPanel discards
// the PUT response and gets session:new + epic:update over the WS, so awaiting
// tick() (which pumps ALL repos with forge I/O) would only add Start latency with
// no payoff. The .catch keeps a throwing/slow tick from turning Start into a
// 500 — the periodic sweep remains the safety net.
function kickDrainOnEpicStart(
  drain: NonNullable<AppDeps["drain"]>,
  status: EpicRun["status"],
): void {
  if (status !== "running") return;
  void drain.tick().catch((err) => console.warn("[epic] start tick:", err));
}

// PUT /api/epic?repo=&parent= — patch the EpicRun settings, re-assemble, emit.
async function handleEpicPut({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(req.method === "PUT" && parts[0] === "api" && parts[1] === "epic" && !parts[2]))
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const parentRaw = url.searchParams.get("parent");
  const parentNumber = parseInt(parentRaw ?? "", 10);
  if (!Number.isInteger(parentNumber) || parentNumber <= 0)
    return json({ error: "parent must be a positive integer" }, 400);
  if (!deps.drain) return json({ error: "drain unavailable" }, 503);
  const body = await req.json().catch(() => null);
  const patch = validateEpicRunPatch(body);
  if (patch === null) return json({ error: "invalid epic run patch" }, 400);
  // One epic per repo; ?parent selects/supersedes: use stored run only when it matches the requested parent.
  const storedForPut = deps.store.getEpicRun(dir);
  const base =
    storedForPut && storedForPut.parentIssueNumber === parentNumber
      ? storedForPut
      : defaultEpicRun(dir, parentNumber);
  const effectiveProvider = mergedEpicRunAgentProvider(base, patch);
  if (
    patchHas(patch, "model") &&
    typeof patch.model === "string" &&
    effectiveProvider === "codex" &&
    clampCodexModelForAuth(
      patch.model,
      effectiveProvider,
      deps.readCodexAuthMode?.() ?? readCodexAuthMode(),
    ) === null
  )
    return json(
      {
        error: `model "${patch.model}" is not supported when using Codex with a ChatGPT account`,
      },
      400,
    );
  const merged = mergeEpicRunPatch(base, patch);
  if (merged === null) return json({ error: "invalid epic run patch" }, 400);
  deps.store.setEpicRun(merged);
  kickDrainOnEpicStart(deps.drain, merged.status);
  const epic = await deps.drain.buildEpic(dir, merged);
  if (epic) deps.events?.emit("epic:update", epic);
  return json(epic ?? { ok: true });
}

// POST /api/epic/approve-next?repo=&parent= — approve the next attended epic spawn.
async function handleEpicApproveNext({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "epic" &&
    parts[2] === "approve-next"
  ))
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const parentRaw = url.searchParams.get("parent");
  const parentNumber = parseInt(parentRaw ?? "", 10);
  if (!Number.isInteger(parentNumber) || parentNumber <= 0)
    return json({ error: "parent must be a positive integer" }, 400);
  if (!deps.drain) return json({ error: "drain unavailable" }, 503);
  deps.drain.approveEpicNext(dir);
  await deps.drain.tick();
  // One epic per repo; ?parent selects/supersedes: use stored run only when it matches the requested parent.
  const storedAfterTick = deps.store.getEpicRun(dir);
  const run =
    storedAfterTick && storedAfterTick.parentIssueNumber === parentNumber
      ? storedAfterTick
      : defaultEpicRun(dir, parentNumber);
  const epic = await deps.drain.buildEpic(dir, run);
  if (epic) deps.events?.emit("epic:update", epic);
  return json(epic ?? { ok: true });
}

// POST /api/epic/import?repo=&parent= — import markdown epic links as native sub-issues.
async function handleEpicImport({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "epic" &&
    parts[2] === "import"
  ))
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const parentRaw = url.searchParams.get("parent");
  const parentNumber = parseInt(parentRaw ?? "", 10);
  if (!Number.isInteger(parentNumber) || parentNumber <= 0)
    return json({ error: "parent must be a positive integer" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge) return json({ error: "no forge for this repo" }, 404);
  const issue = await forge.getIssue?.(parentNumber);
  if (!issue) return json({ error: "parent issue not found" }, 404);
  let result: ImportResult;
  try {
    result = await importEpicLinks(forge, parentNumber, issue.body);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "import failed" }, 400);
  }
  return json(result);
}

// Short-TTL per-repo cache around forge.listIssues(), shared by the completed-epics
// band reconcile. Coalesces the concurrent band fetches a UI poll can fan out into one
// forge round-trip per repo. The /api/epics route still calls listIssues() uncached, so
// this is the same network cost — just deduplicated within the TTL window.
const COMPLETED_EPICS_LIST_TTL_MS = 10_000;
const completedEpicsIssueCache = new Map<
  string,
  { issues: Awaited<ReturnType<GitForge["listIssues"]>>; ts: number }
>();

async function cachedListIssues(
  repo: string,
  forge: GitForge,
): Promise<Awaited<ReturnType<GitForge["listIssues"]>>> {
  const hit = completedEpicsIssueCache.get(repo);
  const now = Date.now();
  if (hit && now - hit.ts < COMPLETED_EPICS_LIST_TTL_MS) return hit.issues;
  const issues = await forge.listIssues();
  completedEpicsIssueCache.set(repo, { issues, ts: now });
  return issues;
}

// Short-TTL per-repo cache for the open-PR→{prNumber,author} map that feeds the epic-summary
// "in progress" pill. Unlike Up Next's 15-min amortized cycle, /api/epics is uncached and
// recomputed on every overview/backlog poll, so without this the extra GraphQL call would land
// on each poll; the TTL mirrors COMPLETED_EPICS_LIST_TTL_MS. Best-effort — a forge without the
// method (Gitea/Local) or a failure caches an empty map and the pill degrades to the
// assignee/author signals.
const epicLinkedPrCache = new Map<string, { linked: Map<number, LinkedPr[]>; ts: number }>();

async function cachedLinkedPrs(repo: string, forge: GitForge): Promise<Map<number, LinkedPr[]>> {
  const hit = epicLinkedPrCache.get(repo);
  const now = Date.now();
  if (hit && now - hit.ts < COMPLETED_EPICS_LIST_TTL_MS) return hit.linked;
  const linked = (await forge.listOpenPrLinkedIssues?.().catch(() => null)) ?? new Map();
  epicLinkedPrCache.set(repo, { linked, ts: now });
  return linked;
}

// Auto-dismiss: a completed epic whose parent is confidently closed (absent from a complete
// open set) gets cleared + emitted. openTruncated → can't be confident, so this is a no-op.
function autoDismissClosed(
  deps: AppDeps,
  repo: string,
  openNumbers: Set<number>,
  openTruncated: boolean,
): void {
  if (openTruncated) return;
  for (const row of deps.store.listEpicCompleted(repo)) {
    if (!openNumbers.has(row.parentIssueNumber)) {
      deps.store.dismissEpicCompleted(repo, row.parentIssueNumber);
      deps.events?.emit("epic:completed-cleared", {
        repoPath: repo,
        parentIssueNumber: row.parentIssueNumber,
      });
    }
  }
}

// Backfill: an idle run whose all-merged epic never got recorded (e.g. completion happened
// across a restart). Needs buildEpic — no-op when drain is absent. Records the completed epic
// when all children are merged; otherwise logs a visible skip (never silently dropped).
async function backfillIdleEpic(
  deps: AppDeps,
  repo: string,
  openNumbers: Set<number>,
  openTruncated: boolean,
): Promise<void> {
  if (!deps.drain) return;
  const run = deps.store.getEpicRun(repo);
  if (run?.status !== "idle") return;
  // hasEpicCompleted ignores dismissedAt, so a dismissed-but-idle run counts as recorded
  // and never re-fires buildEpic (a forge round-trip) on every GET.
  if (deps.store.hasEpicCompleted(repo, run.parentIssueNumber)) return;
  // Parent confidently still open? If we have a complete open set and the parent is absent,
  // it's about to be auto-dismissed anyway — skip the flash of recording it.
  if (!openTruncated && !openNumbers.has(run.parentIssueNumber)) return;

  const epic = await deps.drain.buildEpic(repo, run);
  if (!epic || epic.children.length === 0) return;
  if (epic.children.every((c) => c.state === "merged")) {
    const rollup = buildRollup(
      epic.children,
      deps.store.listEpicIntegratedDetails(repo, run.parentIssueNumber),
    );
    // completedAt: latest non-null child mergedAt, else now (not in the sync pump → Date.now OK).
    const mergedAts = rollup.map((c) => c.mergedAt).filter((m): m is number => m !== null);
    const completedAt = mergedAts.length > 0 ? Math.max(...mergedAts) : Date.now();
    const completed: CompletedEpic = {
      repoPath: repo,
      parentIssueNumber: run.parentIssueNumber,
      parentTitle: epic.parentTitle,
      completedAt,
      children: rollup,
      // A backfilled completion (e.g. across a restart) is recorded as pending — its final
      // state here; the autonomous drain tick (ensureLandingPrsForRepo) opens the landing PR.
      landingPrNumber: null,
      landingPrUrl: null,
      landingState: "pending",
      migrationPaths: [],
      migrationsAckedAt: null,
      landingRebasePauseReason: null,
      landingRepairCount: 0,
      landingRepairHead: null,
    };
    deps.store.recordEpicCompleted({
      repoPath: completed.repoPath,
      parentIssueNumber: completed.parentIssueNumber,
      parentTitle: completed.parentTitle,
      completedAt: completed.completedAt,
      childrenJson: JSON.stringify(rollup),
    });
  } else {
    // Visible skip — never silently drop a backfill candidate.
    const pending = epic.children.filter((c) => c.state !== "merged").map((c) => c.number);
    console.warn(
      `[server] completed-epics backfill skipped for ${repo}#${run.parentIssueNumber}: ` +
        `children not all merged (pending: ${pending.join(", ")})`,
    );
  }
}

// Bounded, best-effort, fail-safe per-repo reconcile: resolve the forge (skip if none), fetch
// the open set (forge throw → skip this repo, route still serves DB rows), then auto-dismiss
// confidently-closed parents + backfill an all-merged idle run that never got recorded.
async function reconcileCompletedEpicsForRepo(deps: AppDeps, repo: string): Promise<void> {
  const forge = deps.resolveForge?.(repo);
  if (!forge) return; // no forge → skip reconcile for this repo (its DB rows are still served)

  let open: Awaited<ReturnType<GitForge["listIssues"]>>;
  try {
    open = await cachedListIssues(repo, forge);
  } catch {
    return; // forge/network error → skip this repo's reconcile (fail-safe)
  }
  const openNumbers = new Set(open.map((i) => i.number));
  const openTruncated = open.length >= 200;

  autoDismissClosed(deps, repo, openNumbers, openTruncated);
  await backfillIdleEpic(deps, repo, openNumbers, openTruncated);
}

// GET /api/epics/completed[?repo=] — durable completed-epics band. Primarily pure-DB; also
// runs a bounded, best-effort, fail-safe reconcile (auto-dismiss confidently-closed parents +
// backfill an all-merged idle run that never got recorded). Always serves DB rows; never 500s
// on forge/network failure and never 503s just because drain is absent.
async function handleEpicsCompletedList({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "epics" &&
    parts[2] === "completed" &&
    !parts[3]
  ))
    return null;

  const repoParam = url.searchParams.get("repo");
  let repoFilter: string | undefined;
  if (repoParam !== null) {
    const dir = safeRepoDir(repoParam, config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    repoFilter = dir;
  }

  // scopeRepos: ?repo → just that repo; else the union of repos with a DB completed-epic row
  // and repos with an idle epic_run (the backfill source). One entry per repo — bounded.
  const scopeRepos: string[] = repoFilter
    ? [repoFilter]
    : [
        ...new Set([
          ...deps.store.listEpicCompleted().map((r) => r.repoPath),
          ...deps.store
            .listEpicRuns()
            .filter((r) => r.status === "idle")
            .map((r) => r.repoPath),
        ]),
      ];

  for (const repo of scopeRepos) await reconcileCompletedEpicsForRepo(deps, repo);

  // Re-query post-reconcile so the response reflects dismiss + backfill.
  const dbRows = deps.store.listEpicCompleted(repoFilter);
  const baseRows: Array<
    CompletedEpic & { repoPath: string; parentIssueNumber: number; completedAt: number }
  > = dbRows.map((row) => {
    // landingAttempts, landingRebaseCount, landingRebaseDriverMisses are internal counters,
    // not part of the CompletedEpic response. landingRebasePauseReason is API-facing and passes through.
    const {
      childrenJson,
      landingAttempts,
      landingRebaseCount,
      landingRebaseDriverMisses,
      ...rest
    } = row;
    void landingAttempts;
    void landingRebaseCount;
    void landingRebaseDriverMisses;
    return { ...rest, children: JSON.parse(childrenJson) as CompletedEpic["children"] };
  });

  // Enrich open-landing rows with live gate signals (best-effort, fail-safe — forge/network
  // errors must NOT 500 this route; just omit the live fields for that row). Shared helper so the
  // rundown's landing-ready accessor (#1045) computes readiness identically.
  const nowMs = Date.now();
  await enrichLandingEpics(baseRows, {
    getEpicIntegrationBranch: (repoPath, parent) =>
      deps.store.getEpicIntegrationBranch(repoPath, parent),
    resolveForge: (repoPath) => deps.resolveForge?.(repoPath),
    hasLiveRepairSession: (repoPath, integrationBranch) =>
      anyLiveRepairSession(deps.store.list(), repoPath, integrationBranch, nowMs),
    now: nowMs,
  });

  return json(baseRows);
}

// POST /api/epics/completed/dismiss — body { repo, parent }. Dismiss one completed epic + emit.
async function handleEpicsCompletedDismiss({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "epics" &&
    parts[2] === "completed" &&
    parts[3] === "dismiss"
  ))
    return null;
  const body = (await req.json().catch(() => null)) as { repo?: string; parent?: number } | null;
  const dir = safeRepoDir(body?.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const parent = body?.parent;
  if (typeof parent !== "number" || !Number.isInteger(parent) || parent <= 0)
    return json({ error: "parent must be a positive integer" }, 400);
  deps.store.dismissEpicCompleted(dir, parent);
  deps.events?.emit("epic:completed-cleared", { repoPath: dir, parentIssueNumber: parent });
  return json({ ok: true });
}

// POST /api/epics/completed/ack-migrations — body { repo, parent }. Acknowledge the landing PR's
// detected migrations (#645): stamps migrationsAckedAt + dismisses the row (one operator action,
// clears the band). Mirrors the dismiss handler's validation + clear emit.
async function handleEpicsCompletedAckMigrations({
  req,
  parts,
  deps,
}: Ctx): Promise<Response | null> {
  if (!(
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "epics" &&
    parts[2] === "completed" &&
    parts[3] === "ack-migrations"
  ))
    return null;
  const body = (await req.json().catch(() => null)) as { repo?: string; parent?: number } | null;
  const dir = safeRepoDir(body?.repo ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const parent = body?.parent;
  if (typeof parent !== "number" || !Number.isInteger(parent) || parent <= 0)
    return json({ error: "parent must be a positive integer" }, 400);
  deps.store.ackEpicMigrations(dir, parent);
  deps.events?.emit("epic:completed-cleared", { repoPath: dir, parentIssueNumber: parent });
  return json({ ok: true });
}

// POST /api/sessions/:id/ack-manual-steps — acknowledge a session's manual operator steps (#1060):
// stamps manualStepsAckedAt, clearing the auto-merge gate. Ack = "operator owns these"
// (acknowledged-will-do, mirrors handleEpicsCompletedAckMigrations) — NOT an assertion the steps
// are done. Idempotent (store.ackManualSteps COALESCEs the first ack time). Emits
// session:manual-steps (with the fresh ackedAt) so the live hold + chip + CTA recompute on every
// client.
async function handleSessionsAckManualSteps({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "sessions" && parts[3] === "ack-manual-steps"))
    return null;
  const id = parts[2];
  if (!id || parts[4]) return null;
  if (req.method !== "POST") return null;
  const session = deps.store.get(id);
  if (!session) return json({ error: "session not found" }, 404);
  deps.store.ackManualSteps(id);
  const updated = deps.store.get(id);
  deps.events?.emit("session:manual-steps", {
    id,
    manualSteps: updated?.manualSteps ?? session.manualSteps,
    manualStepsAckedAt: updated?.manualStepsAckedAt ?? null,
  });
  return json({ ok: true });
}

// Validate + resolve everything needed to perform a land merge. Returns { error: Response } on any
// failure (wrong body, missing row, wrong state, no forge, no branch, prStatus throw, not ready),
// or the resolved targets on success. Extracted to keep handleEpicsCompletedLand below the
// cyclomatic/cognitive thresholds.
type LandTarget = {
  dir: string;
  parent: number;
  row: ReturnType<AppDeps["store"]["listEpicCompleted"]>[number];
  forge: GitForge;
  branch: string;
  pr: PrStatus;
};
async function resolveLandTarget(
  deps: AppDeps,
  body: { repo?: string; parent?: number } | null,
): Promise<{ error: Response } | LandTarget> {
  const dir = safeRepoDir(body?.repo ?? "", config.repoRoot);
  if (!dir) return { error: json({ error: "invalid repo" }, 400) };
  const parent = body?.parent;
  if (typeof parent !== "number" || !Number.isInteger(parent) || parent <= 0)
    return { error: json({ error: "parent must be a positive integer" }, 400) };

  const row = deps.store.listEpicCompleted(dir).find((r) => r.parentIssueNumber === parent);
  if (!row) return { error: json({ error: "no completed epic" }, 409) };
  if (row.landingState !== "open" || row.landingPrNumber == null)
    return { error: json({ error: "landing not open" }, 409) };

  const forge = deps.resolveForge?.(dir);
  if (!forge) return { error: json({ error: "no forge" }, 409) };

  const branch = deps.store.getEpicIntegrationBranch(dir, parent);
  if (branch === null) return { error: json({ error: "no integration branch" }, 409) };

  let pr: PrStatus;
  try {
    pr = await forge.prStatus(branch);
  } catch (err) {
    // Log the forge error server-side; return a generic message so raw error/stack text
    // never reaches the client (CodeQL js/stack-trace-exposure #14).
    console.error("[epic-land] landing PR status check failed:", err);
    return { error: json({ error: "landing PR status check failed" }, 502) };
  }

  if (!computeLandingReady(pr, repoHasNoCiCached(forge.kind, dir)))
    return { error: json({ error: "landing PR not ready" }, 409) };

  return { dir, parent, row, forge, branch, pr };
}

// POST /api/epics/completed/land — body { repo, parent }. Merge the open landing PR using the
// host-configured merge method (same as AutoMergeService + the other merge routes), so the feature
// works on squash-only repos too. Fail-closed: only merges when computeLandingReady confirms green.
async function handleEpicsCompletedLand({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(
    req.method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "epics" &&
    parts[2] === "completed" &&
    parts[3] === "land"
  ))
    return null;
  const body = (await req.json().catch(() => null)) as { repo?: string; parent?: number } | null;
  const r = await resolveLandTarget(deps, body);
  if ("error" in r) return r.error;
  const { dir, parent, row, forge } = r;

  try {
    // Use the host-configured merge method (mirrors AutoMergeService + the other merge routes) so
    // the merge respects whatever the repo actually allows. Hardcoding "merge" would 405 on a
    // squash-only repo even though computeLandingReady reports ready (mergeStateStatus reflects
    // branch state, not method availability), making the CTA fire a doomed merge there.
    await forge.merge(row.landingPrNumber!, { method: forge.mergeMethod, deleteBranch: true });
  } catch (err) {
    // Log the merge error server-side; return a generic message so raw error/stack text
    // never reaches the client (CodeQL js/stack-trace-exposure #14).
    console.error("[epic-land] landing merge failed:", err);
    return json({ error: "landing merge failed" }, 502);
  }

  deps.store.setEpicLandingPr(dir, parent, {
    state: "merged",
    prNumber: row.landingPrNumber!,
    prUrl: row.landingPrUrl,
    attempts: row.landingAttempts,
  });

  // Re-read the row and emit updated CompletedEpic (mirrors emitCompleted in drain.ts).
  const updatedRow = deps.store.listEpicCompleted(dir).find((r) => r.parentIssueNumber === parent);
  if (updatedRow) {
    try {
      const children = JSON.parse(updatedRow.childrenJson) as CompletedEpic["children"];
      const completed: CompletedEpic = {
        repoPath: dir,
        parentIssueNumber: parent,
        parentTitle: updatedRow.parentTitle,
        completedAt: updatedRow.completedAt,
        children,
        landingPrNumber: updatedRow.landingPrNumber,
        landingPrUrl: updatedRow.landingPrUrl,
        landingState: updatedRow.landingState,
        migrationPaths: updatedRow.migrationPaths,
        migrationsAckedAt: updatedRow.migrationsAckedAt,
        landingRebasePauseReason: updatedRow.landingRebasePauseReason,
        landingRepairCount: updatedRow.landingRepairCount,
        landingRepairHead: updatedRow.landingRepairHead,
      };
      deps.events?.emit("epic:completed", completed);
    } catch {
      // best-effort emit; a bad childrenJson must not fail the land endpoint
    }
  }

  return json({ ok: true });
}

// Ordered dispatch chain — preserves the original guard sequence verbatim.
const ROUTE_HANDLERS = [
  handleLogin,
  handleLogout,
  handleMe,
  handlePing,
  handleHealth,
  handleTerminalTransport,
  handlePluginManagement,
  handlePluginRoutes,
  handleGitSnapshot,
  handleActivitySnapshot,
  handleClaudeAliveSnapshot,
  handleWorkingBlockedSnapshot,
  handleBlocksSnapshot,
  handleHoldsSnapshot,
  handleSubagentsSnapshot,
  handlePreviewSnapshot,
  handleQueuesSnapshot,
  handleReviews,
  handlePlanGates,
  handleRecaps,
  handleHerdDigest,
  handleUpNext,
  handleDrain,
  handleAutoMerge,
  handleEpicsList,
  handleEpicsCompletedDismiss,
  handleEpicsCompletedAckMigrations,
  handleSessionsAckManualSteps,
  handleManualSteps,
  handleEpicsCompletedLand,
  handleEpicsCompletedList,
  handleEpicApproveNext,
  handleEpicImport,
  handleEpicGet,
  handleEpicDiagnose,
  handleEpicPut,
  handleRepoConfig,
  handleRepoRoles,
  handleRepoCollaborators,
  handleLearnings,
  handleDocAgent,
  handleDocAgentRuns,
  handlePush,
  handleSessionHooks,
  handleBuildQueue,
  handleEpicDraft,
  handleSessions,
  handleExperimentCompare,
  handleSessionGit,
  handleUsageLimits,
  handleUsageBreakdown,
  handleUsageTimeline,
  handleUpdate,
  handleHerdrUpdate,
  handleCodexUpdate,
  handlePluginUpdate,
  handleRestart,
  handleDiagnostics,
  handleDiagnosticsFix,
  handleStarPrompt,
  handleUploads,
  handleRepos,
  handleProjects,
  handleGithubOwners,
  handleGithubRepos,
  handleSettingsVerifyKey,
  handleSettings,
  handleSteers,
  handleProjectIcons,
  handleBroadcast,
  handleHeld,
  handleRetry,
  handleHalt,
  handleFsDirs,
  handleBranches,
  handleBranchStatus,
  handleRepoWeb,
  handleRepoInitEmptyCommit,
  handleIssues,
  handleIssueCreate,
  handlePrsList,
  handleActionsList,
  handleActionsRerun,
  handleActionsRetryCi,
  handleActionsCancel,
  handleActionsHistory,
  handleActionsRunJobs,
  handlePrMerge,
  handleRepoPull,
  handleSyncFork,
  handleDependabotRebase,
  handleReadiness,
  handleAdoptGitignore,
  handleBacklog,
  handleTodo,
  handleCommands,
] as const;

/**
 * Returns an object with a `fetch(Request)` method — unit-testable without a port.
 *
 * `skipAuth` bypasses the human cookie/token gate (issue #1079) — used ONLY by the loopback
 * agent-ingress listener (makeAgentIngressApp), whose loopback bind + route allowlist + per-session
 * UUID IS the agent's auth. The `Origin` (CSRF) check still applies. The main server never sets it.
 */
export function makeApp(deps: AppDeps, opts: { skipAuth?: boolean } = {}) {
  const app = {
    async fetch(req: Request): Promise<Response> {
      if (!opts.skipAuth) {
        const authErr = checkAuth(req);
        if (authErr) return authErr;
      }

      const originErr = checkOrigin(req);
      if (originErr) return originErr;

      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean); // ["api","sessions",":id"]
      const ctx: Ctx = { req, parts, url, deps };

      for (const handle of ROUTE_HANDLERS) {
        const res = await handle(ctx);
        if (res) return res;
      }

      if (url.pathname.startsWith("/api")) return json({ error: "not found" }, 404);
      if (req.method === "GET" || req.method === "HEAD") {
        const res = await serveStatic(url.pathname);
        // HEAD: same status/headers as GET, but no body
        return req.method === "HEAD"
          ? new Response(null, { status: res.status, headers: res.headers })
          : res;
      }
      return json({ error: "not found" }, 404);
    },
  };
  // Any unhandled throw (e.g. `service.create` when herdr rejects a command) would
  // otherwise bubble out as Bun's HTML error page — which the UI can't parse, so it
  // only sees a bare status code. Convert it to a JSON 500 carrying the real message.
  return {
    fetch: (req: Request): Promise<Response> =>
      app
        .fetch(req)
        // Sliding re-stamp at this single HTTP seam (never on the skipAuth ingress app — agents
        // carry no cookie — and never on WS upgrades, which return before reaching makeApp).
        .then((res) => (opts.skipAuth ? res : maybeRestamp(req, res)))
        .catch((e) => json({ error: e instanceof Error ? e.message : "internal error" }, 500)),
  };
}

/** Method+path allowlist for the restricted agent-ingress listener: EXACTLY the agent→server
 *  control-plane routes the spawn directives instruct the agent to call. `parts` is
 *  url.pathname.split("/").filter(Boolean), e.g. ["api","sessions","<id>","hooks"]. The session id
 *  segment is an unguessable per-session UUID the agent only knows for its own session, so it is the
 *  de-facto per-session capability; the listener exposes no enumeration route. NOTE: /queue/approve
 *  is deliberately EXCLUDED — it is the human/autopilot gate, not an agent action. */
export function isAgentIngressRoute(method: string, parts: string[]): boolean {
  if (!(parts[0] === "api" && parts[1] === "sessions" && parts[2])) return false;
  // POST /api/sessions/<id>/hooks
  if (method === "POST" && parts[3] === "hooks" && !parts[4]) return true;
  // PUT /api/sessions/<id>/queue (author/replace) + GET (the directive's "inspect the current
  // queue" / re-GET-for-ids path — read-only, strictly weaker than the PUT already allowed).
  if ((method === "PUT" || method === "GET") && parts[3] === "queue" && !parts[4]) return true;
  // POST /api/sessions/<id>/queue/steps/<stepId>
  if (method === "POST" && parts[3] === "queue" && parts[4] === "steps" && parts[5] && !parts[6]) {
    return true;
  }
  // PUT /api/sessions/<id>/epic-draft (author/replace the epic draft) + GET (inspect). Like queue,
  // /epic-draft/approve is deliberately EXCLUDED — it is the human write-gate, not an agent action
  // (the whole point of #1507 is that the agent never triggers the GitHub writes).
  if ((method === "PUT" || method === "GET") && parts[3] === "epic-draft" && !parts[4]) return true;
  return false;
}

/** Restricted ingress app: 404 unless the request is an allowlisted agent→server route; otherwise
 *  DELEGATE to the full app. Built with `skipAuth` (issue #1079): spawned agents carry neither a
 *  human session cookie nor (by default) a bearer token — autonomous agents run under `--clearenv`
 *  which strips any env var — so the human gate must NOT apply here. The ingress's loopback-only
 *  bind + isAgentIngressRoute allowlist + unguessable per-session UUID IS the agent's auth. The
 *  `checkOrigin` (CSRF) guard still applies (agents send no Origin → allowed). This preserves the
 *  pre-#1079 effective behaviour (token-null ⇒ checkAuth was already a no-op here). */
export function makeAgentIngressApp(deps: AppDeps) {
  const app = makeApp(deps, { skipAuth: true });
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (!isAgentIngressRoute(req.method, parts)) return json({ error: "not found" }, 404);
      return app.fetch(req); // delegate — preserves checkOrigin (CSRF) + the real handlers
    },
  };
}

/** Start the agent-ingress listener bound to LOOPBACK ONLY (never config.host, which may be 0.0.0.0).
 *  slirp maps the netns's 10.0.2.2 to the host's 127.0.0.1, so loopback is the correct + safest bind.
 *  The `port` is PINNED (config.agentIngressPort) so the URL baked into a live agent's --settings argv
 *  survives a restart/deploy (issue #1083); `0` falls back to an ephemeral port. We rely on Bun's
 *  default SO_REUSEADDR for clean-restart rebind and deliberately do NOT set reusePort (SO_REUSEPORT) —
 *  that is concurrent co-binding, which on this auth-exempt listener would let any same-UID local
 *  process co-bind the port and skim agent hook/queue traffic. A genuine bind conflict throws
 *  (fail-fast). Returns the Bun server (read `.port` — the actually-bound port). */
export function serveAgentIngress(deps: AppDeps, port = 0) {
  const app = makeAgentIngressApp(deps);
  return Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) });
}

type WsData =
  | { kind: "events"; unsub?: () => void }
  | {
      kind: "pty";
      id: string;
      terminalId: string;
      cols: number;
      rows: number;
      bridge?: PtyBridge | SocketPtyBridge;
      pendingInput?: string[];
      awaitingFirstFrame?: boolean;
    };

// A pty WS closed with this code means "a newer client took over this terminal".
// The client parks (shows a take-over prompt) instead of reconnecting — without
// it, two devices on the same session ping-pong herdr's --takeover forever.
// Keep in sync with PTY_SUPERSEDED_CODE in ui/src/lib/pty.ts.
const PTY_SUPERSEDED_CODE = 4000;

// A pty WS closed with this code means "this session has ended" — its herdr
// agent is gone (the user quit claude / ctrl-c'd). The client stops reconnecting
// and shows an ended state instead of looping on herdr's agent_not_found.
// Keep in sync with PTY_GONE_CODE in ui/src/lib/pty.ts.
export const PTY_GONE_CODE = 4001;

export interface LivePtyAttach {
  terminalId: string;
  paneTarget?: string;
}

/**
 * Resolve a session to its live attach target, or null when the session's herdr agent is
 * truly gone (caller should close the socket). Resolves by STABLE key (cwd) so a herdr
 * restart that reassigned terminalIds doesn't strand the attach on the stored-at-upgrade id.
 * Preserves the old hiccup semantics: a herdr CLI hiccup (list throws) or no herdr at all
 * falls back to the stored id (node-pty attach, no paneTarget) rather than closing a live
 * session.
 */
export function livePtyAttach(
  cur: Session,
  herdr: Pick<HerdrDriver, "list"> | undefined,
): LivePtyAttach | null {
  if (!herdr) return { terminalId: cur.herdrAgentId };
  try {
    const a = matchAgent(cur, herdr.list());
    if (!a) return null; // truly gone → caller closes PTY_GONE
    const paneTarget = a.paneId.includes(":") ? a.paneId : `${a.workspaceId}:${a.paneId}`;
    return { terminalId: a.terminalId, paneTarget };
  } catch {
    return { terminalId: cur.herdrAgentId }; // herdr hiccup → optimistic node-pty attach, no paneTarget
  }
}

const SOCKET_TERMINAL_FAILURE_TTL_MS = 30_000;

/** True when `id` had a socket-terminal failure recorded within the last `ttl` ms. */
export function recentlyFailed(
  m: Map<string, number>,
  id: string,
  now: number,
  ttl = SOCKET_TERMINAL_FAILURE_TTL_MS,
): boolean {
  const t = m.get(id);
  return t !== undefined && now - t < ttl;
}

/** Past-TTL sweep. KEEPS entries within ttl (incl. the current terminal's just-stamped one). */
export function pruneSocketTerminalFailures(
  m: Map<string, number>,
  now: number,
  ttl = SOCKET_TERMINAL_FAILURE_TTL_MS,
): void {
  for (const [id, t] of m) if (now - t >= ttl) m.delete(id);
}

/** Picks the socket bridge only when the terminal sub-flag is on (interim gate — see
 *  `config.herdrSocketTerminal`), the driver is active, a pane target resolved, and this terminal
 *  hasn't recently failed over the socket path. With the sub-flag off the terminal stays on
 *  node-pty (scrollable) even while the socket driver runs everything else. */
export function pickTerminalBridgeKind(opts: {
  herdrSocketTerminal?: boolean;
  herdrSocketActive?: boolean;
  paneTarget?: string;
  recentlyFailed: boolean;
}): "socket" | "node-pty" {
  return opts.herdrSocketTerminal &&
    opts.herdrSocketActive &&
    opts.paneTarget &&
    !opts.recentlyFailed
    ? "socket"
    : "node-pty";
}

/** The /usage refresh handler drives a multi-second ephemeral `claude` scrape and needs a longer
 *  idle window than Bun's 10s default (see the fetch handler). */
const isSlowScrapeRequest = (req: Request, url: URL): boolean =>
  req.method === "POST" && url.pathname === "/api/usage/refresh";

export function serve(deps: AppDeps, port: number) {
  const app = makeApp(deps);
  // current owning socket per terminal — a single owner avoids the takeover war
  const ptyOwners = new Map<string, ServerWebSocket<WsData>>();
  // last time the operator typed into each session's live PTY (issue #1022 seam).
  // In-memory + throttled; pruned in the pty close() handler. Consumed by nothing
  // yet — a future stage-and-apply guard reads it via getLastOperatorKeystrokeAt.
  const operatorKeystrokes = new Map<string, number>();
  // terminals that recently fell off the socket path — memo so a reconnect within the
  // TTL retries node-pty directly instead of re-attempting (and re-failing) the socket.
  const socketTerminalFailures = new Map<string, number>();
  return Bun.serve<WsData>({
    port,
    hostname: config.host,
    fetch(req, server) {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      const originErr = checkOrigin(req);
      if (originErr) return originErr;

      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const origin = req.headers.get("Origin");
        if (
          !originAllowed(origin, config.allowedOriginHosts, {
            base: config.previewPortBase,
            count: config.previewPortCount,
          })
        ) {
          return new Response("forbidden: origin not allowed", { status: 403 });
        }
        return server.upgrade(req, { data: { kind: "events" } })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      const m = url.pathname.match(/^\/pty\/([^/]+)$/);
      if (m) {
        const origin = req.headers.get("Origin");
        if (
          !originAllowed(origin, config.allowedOriginHosts, {
            base: config.previewPortBase,
            count: config.previewPortCount,
          })
        ) {
          return new Response("forbidden: origin not allowed", { status: 403 });
        }
        const s = deps.store.get(m[1]!);
        if (!s) return new Response("no session", { status: 404 });
        // attach at the client's actual terminal size so the very first paint
        // matches; otherwise herdr renders the pane at the default 100×30 and the
        // view stays mis-sized until a follow-up resize forces a TUI repaint.
        const { cols, rows } = parseTermDims(
          url.searchParams.get("cols"),
          url.searchParams.get("rows"),
        );
        return server.upgrade(req, {
          data: { kind: "pty", id: s.id, terminalId: s.herdrAgentId, cols, rows },
        })
          ? undefined
          : new Response("upgrade failed", { status: 500 });
      }
      // /usage refresh drives an ephemeral claude scrape (~24s worst case: boot + week wait +
      // credits grace); lift Bun's 10s idle timeout for just this request so a slow scrape can't
      // reset the connection into a false "Retry" on the gauge. Insurance — other endpoints unchanged.
      if (isSlowScrapeRequest(req, url)) server.timeout(req, 60);
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "events") {
          const unsub = deps.events.subscribe((event, data) =>
            ws.send(JSON.stringify({ event, data })),
          );
          ws.data.unsub = unsub;
          // A live /events socket = a dashboard is open (regardless of focus), so
          // background pollers should run warm. `close` drops it again.
          deps.presence?.connect(ws);
        } else {
          // Don't attach a terminal whose herdr agent is gone: attaching would make
          // herdr reply agent_not_found and the client would reconnect-loop on it.
          // A "done" status only means the agent finished its turn (idle at the
          // prompt) — its herdr pane may still be alive and attachable. So gate on
          // herdr LIVENESS, not on status: block only when the session is missing,
          // archived, or its herdr agent is no longer listed by `herdr agent list`.
          const cur = deps.store.get(ws.data.id);
          if (!cur || cur.status === "archived") {
            ws.close(PTY_GONE_CODE, "ended");
            return;
          }
          // Resolve the live agent by STABLE key (cwd), not the id captured at upgrade:
          // a herdr restart reassigns terminalIds, so the stored one can be briefly stale.
          const attach = livePtyAttach(cur, deps.herdr);
          if (attach === null) {
            ws.close(PTY_GONE_CODE, "ended");
            return;
          }
          const tid = attach.terminalId;
          ws.data.terminalId = tid; // keep close()'s ptyOwners cleanup keyed on the same id
          // single owner per terminal: claim it, then bump the previous owner
          // with a "superseded" close so it parks instead of fighting back.
          const prev = ptyOwners.get(tid);
          ptyOwners.set(tid, ws);
          if (prev && prev !== ws) prev.close(PTY_SUPERSEDED_CODE, "superseded");
          const sock = { send: (d: string | Uint8Array) => ws.send(d), close: () => ws.close() };
          const kind = pickTerminalBridgeKind({
            herdrSocketTerminal: config.herdrSocketTerminal,
            herdrSocketActive: deps.herdrSocketActive,
            paneTarget: attach.paneTarget,
            recentlyFailed: recentlyFailed(socketTerminalFailures, tid, Date.now()),
          });
          // Narrowed alias: the hook closures below run asynchronously, after which TS can no
          // longer see that `ws.data.kind === "pty"` still holds (it never changes, but control
          // flow narrowing doesn't survive a closure boundary) — `data` keeps them type-checked.
          const data = ws.data as Extract<WsData, { kind: "pty" }>;
          if (kind === "node-pty") {
            const b = new PtyBridge(tid, sock);
            data.bridge = b;
            b.open(data.cols, data.rows);
          } else {
            data.awaitingFirstFrame = true;
            data.pendingInput = [];
            const flushPending = (b: PtyBridge | SocketPtyBridge) => {
              for (const f of data.pendingInput ?? []) b.write(f);
              data.pendingInput = [];
            };
            const sb = new SocketPtyBridge(attach.paneTarget!, sock, {
              onFirstFrame: () => {
                recordSocketAttach();
                console.info(`[herdr] socket terminal attached ${tid}`);
                data.awaitingFirstFrame = false;
                flushPending(data.bridge!);
              },
              onFallback: () => {
                recordFallback();
                console.info(`[herdr] socket terminal → node-pty fallback ${tid}`);
                socketTerminalFailures.set(tid, Date.now());
                const nb = new PtyBridge(tid, sock);
                data.bridge = nb;
                data.awaitingFirstFrame = false;
                nb.open(data.cols, data.rows);
                flushPending(nb);
              },
              onGone: () => {
                ws.close(PTY_GONE_CODE, "ended");
              },
              onAbnormalExit: () => {
                socketTerminalFailures.set(tid, Date.now());
              },
            });
            data.bridge = sb;
            sb.open(data.cols, data.rows);
          }
        }
      },
      message(ws, msg) {
        if (ws.data.kind === "events") {
          // Presence frame: the page reports focus+visibility so push delivery
          // can suppress OS banners while a window is actively in use.
          try {
            const m = JSON.parse(typeof msg === "string" ? msg : msg.toString());
            if (m?.type === "presence") deps.presence?.set(ws, !!m.active);
          } catch {
            /* ignore malformed frames */
          }
          return;
        }
        markPtyEvent("in");
        const frame = typeof msg === "string" ? msg : msg.toString();
        // Stamp the operator-activity seam only for genuine keystrokes — the same
        // stream carries \x00resize: control frames that storm on mobile (#1022).
        if (isOperatorKeystroke(frame))
          stampOperatorKeystroke(operatorKeystrokes, ws.data.id, Date.now());
        if (ws.data.awaitingFirstFrame) (ws.data.pendingInput ??= []).push(frame);
        else ws.data.bridge?.write(frame);
      },
      close(ws) {
        if (ws.data.kind === "events") {
          ws.data.unsub?.();
          deps.presence?.drop(ws);
        } else {
          // only drop ownership if we're still the owner (a newer client may have
          // already claimed this terminal before our close fired)
          if (ptyOwners.get(ws.data.terminalId) === ws) ptyOwners.delete(ws.data.terminalId);
          operatorKeystrokes.delete(ws.data.id); // don't let the seam map grow unbounded
          pruneSocketTerminalFailures(socketTerminalFailures, Date.now());
          ws.data.bridge?.close();
        }
      },
    },
  });
}
