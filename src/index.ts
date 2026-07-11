import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  config,
  SESSION_RETENTION_MS,
  SESSION_RETENTION_KEEP,
  REVIEWER_SPAWN_RETENTION_MS,
  USAGE_HISTORY_RETENTION_MS,
  clampCap,
  PR_REVIEW_CYCLES_MIN,
  PR_REVIEW_CYCLES_MAX,
  PLAN_REVIEW_CYCLES_MIN,
  PLAN_REVIEW_CYCLES_MAX,
  DIAGNOSTICS_INTERVAL_MS,
  DIAGNOSTICS_RECHECK_INTERVAL_MS,
  findServedPort,
  validatePreviewPortRange,
  validateAgentIngressPort,
  addOwnHostToAllowlist,
  addServedHostsToAllowlist,
} from "./config";
import { SessionStore } from "./store";
import type {
  Session,
  SessionPreviewEvent,
  SessionPreviewServeEvent,
  RundownEpicItem,
} from "./types";
import { WorktreeMgr } from "./worktree";
import { matchAgent, type IHerdrDriver } from "./herdr";
import { selectHerdrDriver, SocketHerdrDriver } from "./herdr-socket-driver";
import { startTerminalTransportSelfCheck } from "./terminal-transport-metrics";
import { generateName } from "./namer";
import { llmName } from "./namer-llm";
import { EventHub } from "./events";
import { SessionService } from "./service";
import { LearningsService } from "./learnings-service";
import { RepoConfigService } from "./repo-config-service";
import { StatusPoller } from "./poller";
import { PrPoller } from "./pr-poller";
import { resolveDiffBase } from "./diff-base";
import { BranchPruner } from "./branch-pruner";
import { reconcile } from "./reconcile";
import { reapOrphanTabs, reapStaleReviewWorktrees } from "./tab-reaper";
import { reapTransientByLabel } from "./transient-tab-reaper";
import { scanClaudeAliveByWorktree } from "./process-reaper";
import { serve, serveAgentIngress, buildBacklogPayload, type AppDeps } from "./server";
import { PluginRegistry } from "./plugins/loader";
import { makeProductionForgeResolver } from "./forge/resolve";
import { EmptyDiffError, type GitState } from "./forge/types";
import { parseManualSteps } from "./manual-steps";
import { annotateHandoff } from "./repo-roles";
import { AccountUsageIndex, SessionUsageRollup } from "./usage";
import { UsageLimitsService, calibrateDelay, type UsageLimits } from "./usage-limits";
import { CodexUsageProvider } from "./codex-usage";
import { singleFlight } from "./single-flight";
import { HerdrUsageProbe } from "./usage-probe";
import { sweepStaging, STAGING_TTL_MS } from "./uploads";
import { validateRoot } from "./dirs";
import { bootstrapAuth } from "./operator-auth";
import { backupConfiguredMarker, lastSuccessMarker } from "./backup-paths";
import { UpdateService } from "./update";
import { HerdrUpdateService } from "./herdr-update";
import { CodexUpdateService } from "./codex-update";
import { PluginUpdateService } from "./plugin-update";
import { RestartService } from "./restart";
import { DiagnosticsService, nextDiagnosticsDelay } from "./diagnostics";
import { TelemetryService } from "./telemetry";
import { normalizeTelemetryConsent } from "./telemetry-consent";
import { wirePrOpenedTelemetry } from "./pr-opened-telemetry";
import { wireCodexPrFlag } from "./codex-pr-flag";
import { StarPromptService } from "./star-prompt";
import {
  PushService,
  attachPush,
  attachReviewPush,
  attachGitPush,
  attachMergePush,
  attachUsagePush,
  attachCreditsPush,
} from "./push";
import { ReadyNotifier } from "./ready-notify";
import { Presence } from "./presence";
import { ReviewService } from "./review";
import { StandalonePrCriticService } from "./standalone-critic";
import { createIssueLogger } from "./issue-log";
import { PlanGateService, shouldConsiderOnSettle } from "./plan-gate";
import { AutopilotService } from "./autopilot";
import { DrainService } from "./drain";
import { SessionRouter, type SessionConsumer } from "./session-router";
import { AutoMergeService } from "./automerge";
import { DraftReconcileService } from "./draft-reconcile";
import { isFullAuto } from "./full-auto";
import { classifyStop } from "./autopilot-llm";
import { tailLines } from "./blocked";
import { recommendPrompt } from "./prompt-recommend";
import { CountsService } from "./backlog";
import { OpenPrSnapshotService } from "./open-pr-snapshot";
import { BacklogPoller } from "./backlog-poller";
import { UpNextService, buildUpNextRepos } from "./up-next";
import { ProcessReaper, reapDeletedWorktreeOrphans } from "./process-reaper";
import {
  sweepClaudeTmp,
  compileCacheDir,
  reapFallowCaches,
  pruneRepoWorktrees,
  scratchpadHasFiles,
} from "./tmp-sweep";
import { runSessionUsageBackfill } from "./usage-backfill";
import { PreviewService } from "./preview";
import { listRepos, listReposPathForReal, reconcileRealPathsToRaw } from "./repos";
import { enrichLandingEpics, type CompletedEpic } from "./completed-epic";
import { DistillerService, defaultScratch } from "./distiller";
import { OptimizerService, defaultOptimizerScratch } from "./optimizer";
import { MergeSuggestionService, defaultMergeScratch } from "./merge-suggest";
import {
  runAutoRetire,
  runAutoTrial,
  runAutoExpire,
  runReapStaleTrials,
} from "./learnings-lifecycle";
import { Promoter } from "./promote";
import { DocAgentService } from "./doc-agent";
import { GitignoreAdopter } from "./gitignore-adopt";
import { attachSignalCapture } from "./signals";
import { HookIngest } from "./hooks-ingest";
import { maintenance } from "./maintenance";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startLoopLagSampler, logRemainingOnLoopBlockers, execFileSync } from "./instrument";
import { firstRun } from "./first-run";
import { preflightHerdr } from "./preflight";
import { resolveNodeHost, TailscaleServeService } from "./tailscale";
import {
  drainSpawnModel,
  normalizeDefaultModelSetting,
  normalizeFableAvailable,
  normalizeRoleCli,
  normalizeRoleModelToken,
  resolveRoleEnvironment,
  spawnModelForAvailability,
  type RoleEnvironment,
} from "./default-model";
import { normalizeDefaultEffortSetting } from "./default-effort";
import { shouldDowngrade } from "./usage-downgrade";
import { normalizeAgentProvider } from "./agent-provider";
import { normalizeAuthModeSetting } from "./auth-mode";
import { normalizeOperatorLanguage } from "./operator-language";
import { EgressWatcher } from "./egress-watch";
import { detectEgressHostLoopback } from "./egress";
import { RecapService, type LandedWorkEvidence } from "./recap";
import { PostMergeStepsService } from "./post-merge-steps";
import { BuildQueueReminderService } from "./build-queue-reminder";
import { HerdDigestService } from "./herd-digest";
import { readSnapshot, isStalled, DEFAULT_STALL } from "./stall";
import { jsonlPathFor } from "./usage";
import { detectPendingAuthUrl, detectLoginAuthUrl } from "./auth-url";
import { readTranscriptTail } from "./activity";
import { verifyApiKey } from "./verify-key";
import { releaseHeldTasks } from "./held-release";
import { snapshotSessionUsage } from "./usage-snapshot";
import { hasCommittedChanges } from "./diff";
import { HoldReasonService } from "./hold-service";
import {
  graphRateLimit,
  isGraphqlBucketCall,
  isRateLimitError,
  parseRetryAfter,
} from "./forge/rate-limit";
import { fetchGithubRateLimit } from "./forge/github-rate-limit";

const execFileAsync = promisify(execFile);

startLoopLagSampler(); // no-op unless SHEPHERD_PROFILE_LOOP=1
logRemainingOnLoopBlockers(); // one-time operator map of intentionally-sync calls

// Fail fast with one actionable banner (and exit 78) when the `herdr` binary is not
// resolvable — nothing in Shepherd works without it. Runs BEFORE the store/auth and any
// herdr call. Present-but-broken fails open (see preflight.ts). Injected deps keep it testable.
preflightHerdr({
  runVersion: () =>
    execFileSync(config.herdrBin, ["--version"], { encoding: "utf8", timeout: 10_000 }),
  log: (m) => console.error(m),
  exit: process.exit,
});

mkdirSync(dirname(config.dbPath), { recursive: true });

const store = new SessionStore(config.dbPath);
// a repo root chosen in the UI (persisted) overrides the env var / default — but
// only if it still sits within the immutable ceiling; a stale/escaping value is
// ignored so the active root can never climb above the ceiling across restarts.
const savedRoot = store.getSetting("repoRoot");
if (savedRoot) {
  const clamped = validateRoot(savedRoot, config.rootCeiling);
  if (clamped) config.repoRoot = clamped;
}
// An env-configured install (SHEPHERD_REPO_ROOT set at boot) is established by definition — stamp
// the gate resolved once so it can NEVER re-show the onboarding pick. Without this, an install
// that only ever supplied its root via the env var on a fresh DB is never marked resolved (the
// run-once migration sees no pre-existing markers, and the env root isn't persisted); a later
// boot that drops the env var would flip `firstRun.pending` true again and re-block an already
// established install. Idempotent — skipped once the flag exists.
if (process.env.SHEPHERD_REPO_ROOT && !store.getSetting("firstRunResolved")) {
  store.setSetting("firstRunResolved", "1");
}
// First-run gate (#): a fresh install with no repo root yet must serve the onboarding UI but
// start NOTHING that polls/reaps/prunes/spawns until a root is picked. The run-once store
// migration (SessionStore#migrateFirstRunMarker) already stamped `firstRunResolved` for any
// pre-existing install (and the env-root stamp just above covers SHEPHERD_REPO_ROOT installs), so
// this is a pure settings read. server.ts flips it via firstRun.resolve() on the first root-pick,
// which runs the deferred background starter registered below.
firstRun.pending =
  !process.env.SHEPHERD_REPO_ROOT &&
  !store.getSetting("repoRoot") &&
  !store.getSetting("firstRunResolved");
// a UI-chosen Remote Control auto-start preference (persisted) overrides the
// env default; absent → keep the config default. Stored as "1"/"0".
const savedRc = store.getSetting("remoteControlAtStartup");
if (savedRc !== null) config.remoteControlAtStartup = savedRc === "1";
const savedRpm = store.getSetting("reducedPushMode");
if (savedRpm !== null) config.reducedPushMode = savedRpm === "1";
// a UI-chosen session-housekeeping preference (persisted) overrides the env default;
// absent → keep the config default (on). Stored as "1"/"0".
const savedHk = store.getSetting("sessionHousekeepingEnabled");
if (savedHk !== null) config.sessionHousekeepingEnabled = savedHk === "1";
// a UI-chosen PR-review cap (persisted) overrides the env seed; absent → keep the config
// default. Clamped on read so a hand-edited/out-of-range DB value can't escape. Falls
// back to the legacy single-cap key `reviewCyclesCap` for migration: an existing install
// keeps its prior value as the PR cap. Only override when a value is actually persisted —
// clamping an absent (untuned) cap would snap it to MIN and discard the env/default seed.
const savedPr = store.getSetting("prReviewCyclesCap") ?? store.getSetting("reviewCyclesCap");
if (savedPr !== null)
  config.prReviewCyclesCap = clampCap(
    Number(savedPr),
    PR_REVIEW_CYCLES_MIN,
    PR_REVIEW_CYCLES_MAX,
    config.prReviewCyclesCap,
  );
// a UI-chosen plan-review cap (persisted) overrides the env seed; absent → keep the
// config default. Clamped on read; same presence guard as above.
const savedPlan = store.getSetting("planReviewCyclesCap");
if (savedPlan !== null)
  config.planReviewCyclesCap = clampCap(
    Number(savedPlan),
    PLAN_REVIEW_CYCLES_MIN,
    PLAN_REVIEW_CYCLES_MAX,
    config.planReviewCyclesCap,
  );
// a UI-chosen default model (persisted) overrides the env seed; absent → keep the
// config default. Corrupt/unknown values are ignored (keep the seed rather than clobber).
const savedDm = store.getSetting("defaultModel");
if (savedDm !== null) {
  const v = normalizeDefaultModelSetting(savedDm);
  if (v !== null) config.defaultModel = v;
}
const savedDe = store.getSetting("defaultEffort");
if (savedDe !== null) {
  const v = normalizeDefaultEffortSetting(savedDe);
  if (v !== null) config.defaultEffort = v;
}
// Per-role ENVIRONMENT settings (persisted) override the env/seed defaults; corrupt/unknown values
// are ignored (keep the seed rather than clobber). Each role is a PAIR: a `<role>Cli`
// ("inherit"|<provider>) + a `<role>Model` ("default"|<alias>), resolved to a spawn environment via
// resolveRoleEnvironment at wiring/spawn time.
for (const role of ["critic", "planner", "recap", "docAgent", "namer", "autopilot"] as const) {
  const savedCli = store.getSetting(`${role}Cli`);
  if (savedCli !== null) {
    const v = normalizeRoleCli(savedCli);
    if (v !== null) config[`${role}Cli`] = v;
  }
  const savedModel = store.getSetting(`${role}Model`);
  if (savedModel !== null) {
    const v = normalizeRoleModelToken(savedModel);
    if (v !== null) config[`${role}Model`] = v;
  }
  const savedEffort = store.getSetting(`${role}Effort`);
  if (savedEffort !== null) {
    const v = normalizeDefaultEffortSetting(savedEffort);
    if (v !== null) config[`${role}Effort`] = v;
  }
}
const savedProvider = store.getSetting("defaultAgentProvider");
if (savedProvider !== null) {
  const v = normalizeAgentProvider(savedProvider);
  if (v !== null) config.defaultAgentProvider = v;
}
// a UI-set fableAvailable flag (persisted) overrides the env seed; absent or unrecognised → keep default.
const savedFa = store.getSetting("fableAvailable");
if (savedFa !== null) {
  const v = normalizeFableAvailable(savedFa);
  if (v !== null) config.fableAvailable = v;
}
// a UI-chosen fullscreen-renderer opt-in (persisted) overrides the env default; absent → keep
// the config default (off). Stored as "1"/"0".
const savedTuiFs = store.getSetting("tuiFullscreen");
if (savedTuiFs !== null) config.tuiFullscreen = savedTuiFs === "1";
const savedTuiMouse = store.getSetting("tuiDisableMouse");
if (savedTuiMouse !== null) config.tuiDisableMouse = savedTuiMouse === "1";
// a UI-chosen auth mode (persisted) overrides the env seed; absent or unrecognised → keep default.
const savedAm = store.getSetting("authMode");
if (savedAm !== null) {
  const v = normalizeAuthModeSetting(savedAm);
  if (v !== null) config.authMode = v;
}
// a UI-chosen operator language (persisted) overrides the env seed; absent or unrecognised → keep default.
const savedOl = store.getSetting("operatorLanguage");
if (savedOl !== null) {
  const v = normalizeOperatorLanguage(savedOl);
  if (v !== null) config.operatorLanguage = v;
}
// a UI-set telemetry consent (persisted) overrides the env seed; absent or unrecognised → keep default.
const savedTc = store.getSetting("telemetryConsent");
if (savedTc !== null) {
  const v = normalizeTelemetryConsent(savedTc);
  if (v !== null) config.telemetryConsent = v;
}
// restore the apiKeyHelper path if the file still exists on disk; self-heal if it was deleted.
const savedHelperPath = store.getSetting("authApiKeyHelperPath");
if (savedHelperPath !== null && savedHelperPath !== "") {
  if (existsSync(savedHelperPath)) {
    config.authApiKeyHelperPath = savedHelperPath;
  }
  // if the file is gone, leave config null — dangling path self-heals silently
}

// A UI-set extra-credit drain ceiling (persisted) overrides the env seed; a missing
// or invalid row keeps the seeded default. Parsed to a non-negative number.
const savedEcc = store.getSetting("extra_credits_drain_ceiling");
if (savedEcc !== null) {
  const n = Number(savedEcc);
  if (Number.isFinite(n) && n >= 0) config.extraCreditsDrainCeiling = n;
}

// Usage-aware task holding: restore persisted operator overrides on restart.
const savedUhe = store.getSetting("usageHoldEnabled");
if (savedUhe !== null) config.usageHoldEnabled = savedUhe === "1";
// Up Next picker skip: restore persisted operator override on restart.
const savedUscp = store.getSetting("upnextSkipCliPicker");
if (savedUscp !== null) config.upnextSkipCliPicker = savedUscp === "1";
const savedUhp = store.getSetting("usageHoldPct");
if (savedUhp !== null) {
  const n = Number(savedUhp);
  if (Number.isFinite(n)) config.usageHoldPct = Math.min(100, Math.max(0, Math.floor(n)));
}
const savedUhar = store.getSetting("usageHoldAutoRelease");
if (savedUhar !== null) config.usageHoldAutoRelease = savedUhar === "1";

// Usage-aware model downgrade: restore persisted operator overrides on restart.
const savedUde = store.getSetting("usageDowngradeEnabled");
if (savedUde !== null) config.usageDowngradeEnabled = savedUde === "1";
const savedUdp = store.getSetting("usageDowngradePct");
if (savedUdp !== null) {
  const n = Number(savedUdp);
  if (Number.isFinite(n)) config.usageDowngradePct = Math.min(100, Math.max(0, Math.floor(n)));
}
const savedUdm = normalizeDefaultModelSetting(store.getSetting("usageDowngradeModel"));
if (savedUdm !== null) config.usageDowngradeModel = savedUdm;

// ── single-operator auth (issue #1079): fail-closed bootstrap ───────────────
// Resolve the argon2id password hash + HMAC cookie-signing secret before serving, so the gate
// (checkAuth) is never silently open. SHEPHERD_PASSWORD wins (re-seeds the hash each boot); else
// the persisted hash is reused; else a strong password is generated, hashed, persisted, and
// printed ONCE with a CHANGE-THIS banner. No agent token is provisioned — spawned agents reach
// the server through the loopback ingress listener (serveAgentIngress), which is exempt from this
// gate; config.token stays an optional operator CLI/curl bearer.
// Hoisted so the consolidated CHANGE-THIS credentials banner can fire LAST (after serve() is
// listening), not mid-boot. bootstrapAuth formats the banner (box + the one-time password) and
// hands it over through its `log` callback, which we buffer here; null when no password was
// generated. Routing the secret through the callback — instead of interpolating the returned
// `generatedPassword` straight into console.log below — keeps it off the clear-text-logging taint
// path CodeQL flags (js/clear-text-logging): the callback boundary launders it, exactly as
// bootstrapAuth's own internal `log(...)` stays clean today.
let credentialBanner: string | null = null;
{
  const auth = await bootstrapAuth({
    store,
    envPassword: config.password,
    envCookieSecret: config.cookieSecret,
    log: (m) => {
      credentialBanner = m;
    },
  });
  config.passwordHash = auth.passwordHash;
  config.cookieSecret = auth.cookieSecret;
}

// ── preview port range startup validation (hard-fail) ──────────────────────
// Discover the public served port AND every served host front from a single
// `tailscale serve status --json` call; default to 443 / no extra hosts when
// tailscale is unavailable or no mapping is found. The parsers are pure and
// injected here so they're testable without tailscale.
// Also resolve this node's tailnet hostname for split-front preview URL construction.
{
  let servedPort = 443;
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], {
      timeout: 5000,
    }));
    const parsed = findServedPort(stdout, config.port);
    if (parsed !== null) servedPort = parsed;
  } catch {
    // tailscale not available or not set up — default to 443, no served hosts
  }
  // Resolve the node's own tailnet hostname (null when tailscale is absent).
  config.previewHost = await resolveNodeHost();
  // Fold the node's own tailnet host into the CSRF origin allowlist so a same-node HUD
  // (direct `tailscale serve`, served front host == this node's DNSName) is trusted out of
  // the box — no manual SHEPHERD_ALLOWED_HOSTS. Preview-port origins stay rejected (the
  // guard's preview-range check runs first, independent of hostname) and foreign origins
  // stay blocked. Issue #1645 Fix 2.
  addOwnHostToAllowlist(config.allowedOriginHosts, config.previewHost);
  // Fold every Tailscale-served host front for this HUD's port — including a Service
  // front (e.g. `svc:shepherd` → `shepherd.ts.net`), served under a DIFFERENT DNS name
  // than the node's own — into the allowlist too. Only a non-Tailscale reverse proxy /
  // custom-DNS front still needs a manual SHEPHERD_ALLOWED_HOSTS entry (see
  // deploy/shepherd.service). Issue #1645 Fix 2/3.
  addServedHostsToAllowlist(config.allowedOriginHosts, stdout, config.port);
  validatePreviewPortRange({
    previewPortBase: config.previewPortBase,
    previewPortCount: config.previewPortCount,
    localPort: config.port,
    servedPort,
  });
  // The pinned agent-ingress port (issue #1083) must not collide with the main port,
  // the served origin, or the preview range. Reuse the servedPort resolved above.
  validateAgentIngressPort({
    agentIngressPort: config.agentIngressPort,
    mainPort: config.port,
    previewPortBase: config.previewPortBase,
    previewPortCount: config.previewPortCount,
    servedPort,
  });
  if (config.previewAutoServe && !config.previewHost) {
    console.warn(
      "[preview] dynamic tailscale serve registration is enabled but the node's tailnet host could not be resolved (is tailscale running?); previews won't be tailnet-reachable.",
    );
  }
}

// Background subsystems are collected here and only started once a repo root is picked
// (first-run gate). Nothing in this list runs while firstRun.pending — each site below wraps its
// original statement in `deferredStarts.push(() => { … })`; the closure captures the same variables
// by reference and runs later, so registration order = original order and every referenced const
// exists by the time startBackground() runs. On an already-onboarded boot startBackground() runs at
// the end of boot; on a first-run boot it's registered via firstRun.onResolve and fires on root-pick.
const deferredStarts: Array<() => void> = [];
function startBackground(): void {
  for (const start of deferredStarts) start();
}

// drop abandoned staged uploads (New-Task or relaunch carry, never submitted) past the TTL
deferredStarts.push(() => {
  sweepStaging(config.repoRoot, STAGING_TTL_MS, Date.now());
});
const herdr: IHerdrDriver = await selectHerdrDriver();
const herdrSocketActive = herdr instanceof SocketHerdrDriver;
deferredStarts.push(() => {
  startTerminalTransportSelfCheck(herdrSocketActive);
});
const worktree = new WorktreeMgr();
const events = new EventHub();
const onSessionGit = (listener: (input: { id: string; git: GitState }) => void): void => {
  events.subscribe((event, data) => {
    if (event !== "session:git") return;
    listener(data as { id: string; git: GitState });
  });
};
const previewService = new PreviewService({
  base: config.previewPortBase,
  count: config.previewPortCount,
  onChange: (id, previewPort) =>
    events.emit("session:preview", { id, previewPort } satisfies SessionPreviewEvent),
});
const egressWatcher = new EgressWatcher({
  addSignal: (input) => store.addSignal(input),
  emit: (event, data) => events.emit(event, data),
});

const autoMergedRecapEvidence = new Map<string, { prNumber: number; headSha: string | null }>();

// Session recap (#XXX): generates a plain-language summary of each settled-idle session
// so the operator can skim what happened without reading the transcript. Mirrors planGate's
// deps/onChange wiring; model defaults to "sonnet" inside the service. Constructed BEFORE
// SessionService so its pre-teardown hook (beforeArchive) can be wired into the service.
// Explicit type annotation breaks the type-inference cycle the resolveBase closure introduces
// (recapService → prPoller/resolveForge → service → recapService via beforeArchive). The closure
// only runs at recap time (well after init), so the forward references are safe at runtime.
const recapService: RecapService = new RecapService({
  store,
  herdr,
  // Per-role model thunk (read per spawn so a settings change applies without restart).
  env: () => roleEnv(config.recapCli, config.recapModel, config.recapEffort),
  // Live operator-language setting, read per spawn (#1586).
  operatorLanguage: () => config.operatorLanguage,
  onChange: (id, recap) => events.emit("session:recap", { id, recap }),
  // Resolve the PR's real base so the recap diff matches the PR. prPoller + resolveForge are
  // declared below; this closure only runs at recap time (well after init), like refreshPr above.
  resolveBase: (s) => resolveDiffBase(s, prPoller, resolveForge),
  landedWorkEvidence: (s, head): LandedWorkEvidence | null => {
    const autoMerged = autoMergedRecapEvidence.get(s.id);
    if (autoMerged && (autoMerged.headSha == null || autoMerged.headSha === head)) {
      return {
        kind: "merged_pr",
        summary: `automerge merged PR #${autoMerged.prNumber}`,
        pr: autoMerged.prNumber,
      };
    }
    const git = prPoller.snapshot()[s.id];
    if (git?.state === "merged" && (git.headSha == null || git.headSha === head)) {
      return {
        kind: "merged_pr",
        summary: `merged PR${git.number ? ` #${git.number}` : ""}`,
        ...(git.number ? { pr: git.number } : {}),
      };
    }
    const review = store.getReview(s.id);
    if (review?.headSha === head) {
      return { kind: "review", summary: "PR review recorded for this head" };
    }
    const recap = store.getRecap(s.id);
    if (recap?.headSha === head && recap.changedFiles.length > 0) {
      return { kind: "existing_recap", summary: "existing recap recorded changed files" };
    }
    return null;
  },
});

// Lazy holder for the restricted agent-ingress listener's ephemeral port. The listener is started
// AFTER SessionService is constructed (it needs the same AppDeps), so the port is unknown here;
// spawns only happen after startup completes, so the accessor returns the real port by the time
// resolveSpawnBaseUrl/prepareSpawn read it. A holder object (mutated, not reassigned) avoids the
// forward-reference `let`.
const agentIngressState: { port: number | undefined } = { port: undefined };

// Mode-aware forge resolution: lightweight repos get a LocalForge; forge repos
// get the memoized detectForge result (git shell-out). repoMode is read per call
// (cheap PK lookup) so a runtime toggle takes effect without a restart. Defined before
// the service so create() can pull an attached issue's comments at spawn (composePromptArg).
const resolveForge = makeProductionForgeResolver(store, config.forges);

// Server-side plugin registry (issue #1124). Constructed before SessionService so the
// spawn path can call its hook runner; plugins are actually loaded (register(ctx)) later,
// after ALL core services exist and just before serve() — runSpawnHooks is a safe no-op
// until then (no spawn can be requested over HTTP before the server boots).
const pluginRegistry = new PluginRegistry({ pluginsDir: config.pluginsDir, store, events });

// Usage-aware model downgrade: the cheap model to force on a spawn when live usage has crossed the
// downgrade threshold, or null (leave the configured model). Hoisted so both the main-session path
// (service.usageDowngrade) and the role path (roleEnv) share one definition; reads usageLimits
// (declared below) + live config at call time, never at module load.
function usageDowngradeModel(): string | null {
  if (!config.usageDowngradeEnabled) return null;
  const lim = usageLimits.limits(Date.now());
  if (
    !shouldDowngrade({
      enabled: config.usageDowngradeEnabled,
      downgradePct: config.usageDowngradePct,
      session5hPct: lim.session5h?.pct ?? 0,
      weekPct: lim.week?.pct ?? 0,
    })
  )
    return null;
  return spawnModelForAvailability(
    drainSpawnModel(config.usageDowngradeModel),
    config.fableAvailable,
  );
}

// Resolve a per-role spawn ENVIRONMENT (CLI + model) from its persisted cli/model pair, then fold
// in the usage-downgrade so role agents are covered too (they bypass service.create/pushModelFlag).
// The downgrade target is a Claude model setting, so it only overrides a Claude-resolved role.
function roleEnv(cli: string, model: string, effort: string): RoleEnvironment {
  const env = resolveRoleEnvironment(
    cli,
    model,
    config.defaultAgentProvider,
    config.defaultModel,
    config.fableAvailable,
    effort,
  );
  const dg = usageDowngradeModel();
  if (dg !== null && env.provider === "claude")
    return { provider: "claude", model: dg, effort: env.effort };
  return env;
}

// Anonymous product telemetry (Aptabase). No-op unless the operator has explicitly
// granted consent (config.telemetryConsent === "granted") and DO_NOT_TRACK isn't set.
const telemetry = new TelemetryService({
  appKey: config.aptabaseAppKey,
  hostOverride: config.aptabaseHostOverride,
  enabled: () => config.telemetryConsent === "granted" && !config.doNotTrack,
});

const service = new SessionService({
  store,
  worktree,
  herdr,
  resolveForge,
  // Plugin onSpawn hooks fire from prepareSpawn (create + resume); no-op until loadAll.
  runSpawnHooks: (d) => pluginRegistry.runSpawnHooks(d),
  agentIngressPort: () => agentIngressState.port,
  // Usage-aware model downgrade (#825 companion): once live usage crosses the (lower) downgrade
  // threshold, every spawn that flows through pushModelFlag — Claude main task agents (here) and the
  // role agents (via roleEnv) — runs on the cheap usageDowngradeModel instead of its configured
  // model, so work keeps flowing before the higher hold threshold pauses it. Codex main sessions
  // build their own argv and bypass pushModelFlag, so they are not downgraded. See pushModelFlag in
  // service.ts + roleEnv below.
  usageDowngrade: () => usageDowngradeModel(),
  detectEgressHostLoopback,
  namer: generateName,
  refineName: config.llmNaming
    ? ({ taskText, label }) => {
        const env = roleEnv(config.namerCli, config.namerModel, config.namerEffort);
        return llmName(
          taskText,
          { herdr, provider: env.provider, model: env.model, effort: env.effort },
          label,
        );
      }
    : undefined,
  events,
  reaper: new ProcessReaper(),
  preview: previewService,
  // Fast-poll a queue member to surface its merge promptly when the train session
  // archives before the 120s PR sweep credits it (the merge-train completion race).
  // prPoller is defined below; this closure is only invoked at runtime, after init.
  refreshPr: (id) => prPoller.pollSession(id),
  // Live PR snapshot for server-derived merge-train participant marking; lazy (prPoller
  // defined below). reconcileTrainMarks reads this to mark sessions whose PR is open.
  prSnapshot: (): Record<string, import("./forge/types").GitState> => prPoller.snapshot(),
  egressWatcher,
  // Best-effort pre-teardown recap: generate a durable recap while the worktree still
  // exists (the generator reads it to build its prompt). Bounded + swallowed inside
  // archive() so it can never block teardown / the merge train.
  beforeArchive: (s) =>
    Promise.all([recapService.considerForArchive(s), snapshotSessionUsage(s, store)]).then(
      () => {},
    ),
  telemetry,
});

// Deep modules for the learnings + repo-config route seams (#1092). Singletons so every
// route + every background onChange below emit through the SAME instance; the server's
// total accessors return these when injected via appDeps.
const learningsSvc = new LearningsService(store, events);
const repoConfigSvc = new RepoConfigService(store);

// Build-queue reconciliation nudge: settled-idle backstop to the forward-fill cascade in
// store.setBuildStepStatus. Steers a drifted, settled-idle session to post its progress.
const buildQueueReminder = new BuildQueueReminderService({
  store,
  steer: (id, text) => service.reply(id, text),
});

const accountIndex = new AccountUsageIndex();
const usageRollup = new SessionUsageRollup();
const usageLimits = new UsageLimitsService(
  accountIndex,
  store,
  new HerdrUsageProbe(herdr),
  store,
  store,
  [new CodexUsageProvider()],
);

deferredStarts.push(() => {
  reconcile(store, herdr);
});

// Reconcile orphaned per-session egress temp dirs (config + dns.log) from sessions
// whose teardown removal was missed across a crash/restart. Live sessions' dirs are
// preserved. Best-effort — never throws.
deferredStarts.push(() => {
  try {
    service.sweepEgressTmp();
  } catch (err) {
    console.warn("[egress] startup temp-dir sweep failed:", err);
  }
});

// Ensure the disk-backed compile-cache dir exists so spawns can point NODE_COMPILE_CACHE
// at it (keeps the V8 compile cache off the /tmp tmpfs).
try {
  mkdirSync(compileCacheDir(), { recursive: true });
} catch (err) {
  console.warn("[tmp-sweep] could not create compile-cache dir:", err);
}

// Inode-guard sweep: drops the compile cache + stale scratch once /tmp inode pressure
// crosses the threshold. Also unconditionally reaps stale fallow caches and prunes
// orphaned git worktree records. Fire-and-forget — none of these ever reject;
// runDailySweep is synchronous, so the daily caller must not await them either.
const fireTmpSweep = (phase: "boot" | "daily") => {
  void sweepClaudeTmp()
    .then((r) => {
      if (r.swept)
        console.warn(
          `[tmp-sweep] ${phase}: ${r.reason}, removed ${r.removed} entr${r.removed === 1 ? "y" : "ies"}`,
        );
    })
    .catch((err) => console.warn(`[tmp-sweep] ${phase} sweep failed:`, err));

  void reapFallowCaches()
    .then(({ removed }) =>
      pruneRepoWorktrees(listRepos(config.repoRoot).map((r) => r.path)).then(
        ({ pruned, failed }) => {
          console.warn(
            `[tmp-sweep] ${phase}: fallow reap removed ${removed}, worktree prune ran on ${pruned} repo(s)${failed ? `, failed ${failed}` : ""}`,
          );
        },
      ),
    )
    .catch((err) => console.warn(`[tmp-sweep] ${phase} fallow/prune failed:`, err));

  // Safety net for #1133: reap detached PPID-1 orphans (leaked `yes`/load-gen busy-loops)
  // whose cwd is an already-deleted shepherd worktree — leaks the teardown sweep missed
  // (pre-fix, or a removal path that didn't run it). Deferred off the synchronous boot
  // path; never throws onto the loop.
  void Promise.resolve()
    .then(() => {
      const { reaped } = reapDeletedWorktreeOrphans();
      if (reaped > 0)
        console.warn(`[tmp-sweep] ${phase}: reaped ${reaped} deleted-worktree orphan(s)`);
    })
    .catch((err) => console.warn(`[tmp-sweep] ${phase} orphan reap failed:`, err));
};

deferredStarts.push(() => {
  fireTmpSweep("boot");
});

// Reap orphaned helper tabs (usage-probe / review husks no live agent backs). The
// teardown paths close these at the source; this sweep is the safety net for husks
// they miss — agents that crashed out of `agent list`, or anything left over after a
// shepherd restart cleared the in-memory review tracking. Run once on boot, then hourly.
// Debounce state for reapOrphanTabs' two-sweep husk confirmation (#721): the shell-only
// tabIds seen last sweep, threaded back in as `prevShellOnly` so a husk is only reaped when
// it read shell-only on two consecutive sweeps (avoids reaping an agent's pre-`exec` window).
let shellOnlyTabs = new Set<string>();
const sweepOrphanTabs = () => {
  if (maintenance.active) return;
  void reapOrphanTabs(herdr, shellOnlyTabs)
    .then((r) => {
      shellOnlyTabs = r.shellOnly;
      if (r.closed.length || r.sparedError)
        console.warn(
          `[tabs] reaped ${r.closed.length} husk tab(s); spared ${r.sparedLive} live, ${r.sparedError} undetermined`,
        );
    })
    .catch((err) => console.warn("[tabs] orphan sweep failed:", err));
};
// Boot + a confirming pass @45s so pre-existing husks clear despite the two-sweep debounce,
// then hourly.
deferredStarts.push(() => {
  setTimeout(sweepOrphanTabs, 5_000);
  setTimeout(sweepOrphanTabs, 45_000);
  setInterval(sweepOrphanTabs, 60 * 60 * 1000);
});

const tailscaleServe = new TailscaleServeService({
  base: config.previewPortBase,
  count: config.previewPortCount,
  enabled: config.previewAutoServe && config.previewHost != null,
  onChange: (id, _previewPort, serve) =>
    events.emit("session:preview-serve", { id, serve } satisfies SessionPreviewServeEvent),
});

// Phase-0 push-hook ingest (issue #704), constructed BEFORE the poller so the poller's
// `pruneHooks` callback can drop dead sessions' ring buffers. Observe-only until the
// Phase-1 sink is wired below (only when `config.hooksSignals` is on).
const hookIngest = new HookIngest();

const poller = new StatusPoller(
  store,
  herdr,
  (id, status) => {
    // On turn-end transitions (idle/done — when the agent has finished writing files), fold a
    // fresh scratchpad-non-empty flag into the status push so the UI's Files tab appears/hides
    // without a second poll (#1164). Computed only here, not on every running↔idle flap, to keep
    // a readdir off the hot poll path. Other transitions emit the bare {id, status}; the UI merge
    // guards against undefined so a status-only push never clobbers the live flag.
    if (status === "idle" || status === "done") {
      const s = store.get(id);
      if (s) {
        void scratchpadHasFiles(s.worktreePath, s.claudeSessionId)
          .then((hasScratchpadFiles) =>
            events.emit("session:status", { id, status, hasScratchpadFiles }),
          )
          .catch(() => events.emit("session:status", { id, status }));
        return;
      }
    }
    events.emit("session:status", { id, status });
  },
  (id, block) => events.emit("session:block", { id, block }),
  undefined, // intervalMs
  undefined, // reclassifyMs
  undefined, // classify
  undefined, // now
  undefined, // probe
  undefined, // stallCfg
  undefined, // probeCheckMs
  (id, ready) => events.emit("session:ready", { id, ready }),
  (id, activity) => events.emit("session:activity", { id, activity }),
  {
    service: previewService,
    sweepMs: config.previewSweepMs,
    idleStop: {
      idleMs: config.previewIdleStopMs,
      stop: (id, signal) => service.stopPreview(id, signal),
    },
  }, // preview sweep wiring
  // claude-liveness sweep wiring: lets the UI gate its Resume affordance on the
  // claude process actually being gone instead of offering it on every idle/done.
  { onChange: (id, claudeAlive) => events.emit("session:claude-alive", { id, claudeAlive }) },
  // working-while-blocked display flag: herdr latched "blocked" but the TUI shows a
  // live turn spinner — the UI keeps working chrome instead of a false "needs you".
  (id, working) => events.emit("session:working-blocked", { id, working }),
  // Phase-1 (issue #704): prune dead sessions' hook ring buffers from the poller's
  // pruneInactive (so they don't grow unbounded by session count).
  (ids) => hookIngest.prune(ids),
  undefined, // onStopWindow — use default logger
  // onHalt: a session's halt flag changed (usage-limit detected, or cleared on resume)
  // → push live so the UI updates the RetryDialog/chip/badge without a full refresh.
  (id: string, haltReason: string | null, haltedAt: number | null) =>
    events.emit("session:halt", { id, haltReason, haltedAt }),
  // usageLimits: corroborates the transcript-tail match against measured pct windows.
  usageLimits,
);

// Proactively re-drive a herdr-restored plugin/account pane (herdr's bare `claude --resume` lost the
// account's CLAUDE_CONFIG_DIR). Fire-and-forget; reDriveAccount is per-session guarded + bounded.
// Swallow rejections so an unexpected internal throw can't surface as an unhandled rejection off the
// 1s poll path (the expected refusals already resolve to "refused", never reject).
poller.reDrive = (id) =>
  void service.reDriveAccount(id).catch((err) => {
    console.warn(`[poller] account re-drive failed for ${id}:`, err);
  });

// Best-effort: seed a running isolated Codex session's provider-native id from its rollout header, so
// restore (and #1087/#1160) has the id available. Synchronous + internally guarded/never-throws.
poller.captureCodexSessionId = (s) => service.captureCodexSessionId(s);

// Phase-1 push-hook signal wiring (issue #704): feed received hook events into the
// poller (the single owner of per-session signal dedup + state). Only when
// `config.hooksSignals` is on AND ingest is too — with ingest off no events ever
// arrive, so signals-without-ingest is meaningless (warn once, behave as off). When
// off, the sink stays unset → pure observe-only (Phase-0 behaviour), poller untouched.
if (config.hooksSignals && !config.hooksIngest) {
  console.warn(
    "[hooks] SHEPHERD_HOOKS_SIGNALS is set but SHEPHERD_HOOKS_INGEST is off — no events " +
      "will arrive to feed the poller; treating signals as off. Enable ingest first.",
  );
} else if (config.hooksSignals) {
  hookIngest.setSink((id, ev) => {
    if (ev.event === "PostToolUse" || ev.event === "PostToolUseFailure") {
      poller.ingestActivity(id, { toolName: ev.toolName, status: ev.status, ts: ev.receivedAt });
    } else if (ev.event === "Notification") {
      poller.ingestNotification(id, ev.notificationType ?? "");
    } else if (ev.event === "SessionStart") {
      poller.ingestSessionStart(id);
    } else if (ev.event === "Stop") {
      poller.ingestStopMeasure(id, ev.receivedAt);
    }
    // Stop now feeds an observe-only window MEASUREMENT (no status mutation): the offset
    // between the Stop hook and herdr's done flip (issue #713). SessionEnd stays observe-only
    // (measured: reason always `other`, n=6, validator retained). record() ring-buffers +
    // logs both regardless of the sink, so they remain measurable.
  });
}
// Phase-3 sub-agent fan-out push (issue #710): every roster mutation pushes the session's
// updated roster over the WS as `session:subagents`. Gated only by `config.hooksIngest`
// (independent of `hooksSignals`) — the roster is its own state, maintained by record()
// whenever Subagent* events arrive, so the fan-out lives wherever ingest does.
if (config.hooksIngest) {
  hookIngest.setSubagentSink((id, roster) =>
    events.emit("session:subagents", { id, subagents: roster }),
  );
}
// Clear stale mappings left by a crashed prior run. Fire void, NOT await: the service's
// single FIFO queue already guarantees this op completes before any register/unregister
// enqueued after poller.start(), so awaiting only risks stalling boot up to count×5s
// (16 ports × 5s timeout ≈ 80s) when tailscaled is unresponsive. Reconcile swallows its
// own per-port failures; the .catch is a belt-and-suspenders guard on the queue chain.
deferredStarts.push(() => {
  void tailscaleServe
    .reconcileStartup()
    .catch((err) => console.warn("[tailscale-serve] startup reconcile failed:", err));
  poller.start();
});

// background Web Push: turn F3 state events into notifications for subscribed devices.
// Suppress while any window is actively in use — clients report focus/visibility
// over /events into `presence`, and the push gate reads it.
// When the first dashboard connects after a quiet spell, kick one immediate
// catch-up sweep so it doesn't sit a full interval behind reality. Debounced
// (~1.5s) so connect/disconnect flapping coalesces into a single catch-up. The
// closure references `prPoller`/`backlogPoller` declared further down — fine, it
// only runs at runtime when a socket actually opens, never during module init.
let presenceCatchUp: ReturnType<typeof setTimeout> | null = null;
const presence = new Presence(() => {
  if (presenceCatchUp) clearTimeout(presenceCatchUp);
  presenceCatchUp = setTimeout(() => {
    presenceCatchUp = null;
    if (firstRun.pending) return; // no background ticks until a root is picked
    void prPoller.fastTick();
    void backlogPoller.tick();
  }, 1_500);
});
const push = new PushService(store, undefined, undefined, undefined, () => presence.isActive());
attachPush(events, store, push);

// poll PR status for active sessions every 120s; push session:git on change so
// the list overview badges stay current without opening each session's detail.
// reject a merged/closed PR that `gh pr list --head <name>` matched only by a
// reused branch name — its head commit won't be reachable from this branch's tip.
// Shared by the background poller and the on-demand git endpoint so they agree.
const ownsPr = (s: Session, headSha: string) => worktree.containsCommit(s.worktreePath, headSha);

// ── Poller cadence gate (#1230) ───────────────────────────────────────────────
// The background pollers + critic sweep run at full cadence only while *warm*;
// when truly idle they throttle/pause to spare the GraphQL bucket. Warmth is:
//   warm() = a dashboard is open  ||  autonomous merge work is in flight
// The second disjunct keeps a headless full-auto merge train moving even when
// nobody is watching, so reducing polling never stalls autonomous work.
//
// `autonomousWorkInFlight` is a *hoisted function declaration* on purpose: it
// references `service`, `mergeErrorSessions` (defined ~700 lines below) and
// `store`, but only reads them when CALLED at runtime (a timer firing), never
// during module init — so the forward reference is safe.
function autonomousWorkInFlight(): boolean {
  if (service.liveTrainPrs().length > 0) return true; // a live merge train
  if (mergeErrorSessions.size > 0) return true; // train blocked/retrying — still working
  // any non-archived full-auto session: the train may act on it without a watcher
  return store
    .list()
    .some((s) => s.status !== "archived" && isFullAuto(s, store.getRepoConfig(s.repoPath)));
}
const warm = (): boolean => presence.hasClients() || autonomousWorkInFlight();

const openPrSnapshot = new OpenPrSnapshotService();
const prPoller = new PrPoller(
  store,
  resolveForge,
  (id, git) => events.emit("session:git", { id, git }),
  undefined,
  undefined,
  // on a "no PR" miss, adopt the agent's renamed worktree branch so its open PR
  // is recognized instead of staying invisible against the stale stored branch
  (s) => service.syncWorktreeBranch(s.id),
  undefined,
  ownsPr,
  warm, // full cadence only while warm; cold → fast sweep pauses, full sweep throttles
  () => graphRateLimit.blocked(), // skip every sweep while the GraphQL bucket is exhausted
  undefined, // idleIntervalMs (default 300s coarse full-sweep cadence while cold)
  undefined, // transientMaxMs (default)
  undefined, // batchOpenRatio (default)
  undefined, // noneRecheckMs (default)
  openPrSnapshot, // shared per-repo open-PR snapshot cache (PRs tab reuses the poller's fetch)
);
deferredStarts.push(() => {
  setTimeout(() => void prPoller.tick(), 3_000); // warm the cache shortly after boot
  prPoller.start();
});
// when an agent settles (finished a turn / paused) it has most likely just run
// `gh pr create`; poll that one session right away so the badge shows the PR
// number within seconds instead of on the next full sweep.
events.subscribe((event, data) => {
  if (event !== "session:status") return;
  const { id, status } = data as { id: string; status: string };
  if (status !== "running") prPoller.pollSession(id);
});

// Build-queue reconcile backstop (#1617): arm the reminder's evidence gate from the poller's 1 Hz
// `running` transitions, not the reminder's own coarse 15s sweep. A herdr-`working` burst that
// starts and finishes between two sweeps would otherwise never set `sawRunning` (status is a
// point-in-time level, not a "recently-active" latch), so a bursty agent's drift would never nudge.
// Gate to a running transition on an approved, non-empty queue OUTSIDE the plan gate — mirroring the
// sweep's own guards; arming only on observed-running keeps the worked-vs-never-started discriminator.
events.subscribe((event, data) => {
  if (event !== "session:status") return;
  const { id, status } = data as { id: string; status: string };
  if (status !== "running") return;
  const s = store.get(id);
  if (!s || s.planPhase === "planning") return;
  const q = store.getBuildQueue(id);
  if (!q.approved || q.steps.length === 0) return;
  buildQueueReminder.markRan(id);
});

// Manual operator steps (#1059): when a session's PR body is (re)fetched, parse any
// shepherd:manual-steps carrier + `Manual-Step:` trailers and persist them on the session, so the
// backlog chip + Done recap surface them. Throttled on head SHA so we don't re-`gh pr view` on
// every CI/review transition (`session:git` fires on each one) — mirrors drain.ts's
// ≤1/child/~60s prReviewMeta throttle. In-memory marker → at most one re-fetch per session after
// a restart. Persist + push only when the parsed steps differ from what's stored.
const manualStepsHeadSeen = new Map<string, string>();
const detectAndPersistManualSteps = async (id: string, prNumber: number): Promise<void> => {
  const s = store.get(id);
  if (!s) return;
  const forge = resolveForge(s.repoPath);
  if (!forge?.prReviewMeta) return; // no forge / host without a PR-body API (e.g. Gitea) — skip
  try {
    const meta = await forge.prReviewMeta(prNumber);
    if (!meta) return;
    const steps = parseManualSteps(meta.body);
    if (JSON.stringify(steps) === JSON.stringify(s.manualSteps)) return;
    store.setSessionManualSteps(id, steps);
    events.emit("session:manual-steps", { id, manualSteps: steps });
  } catch (err) {
    console.warn(`[manual-steps] detection for ${id} pr#${prNumber} failed:`, err);
  }
};
onSessionGit(({ id, git }) => {
  if (git.number == null || (git.state !== "open" && git.state !== "merged")) return;
  const headSha = git.headSha ?? "";
  if (manualStepsHeadSeen.get(id) === headSha) return; // unchanged head — skip the fetch
  manualStepsHeadSeen.set(id, headSha);
  void detectAndPersistManualSteps(id, git.number);
});

// Anonymous product telemetry: emit `pr_opened` the first time a session's tracked PR
// transitions to open (see src/pr-opened-telemetry.ts for the transition/dedup design).
wirePrOpenedTelemetry({ events, store, telemetry });

// Flag Codex-authored session PRs with the `codex-authored` label (server-side off
// `agentProvider`, the only reliable signal — see src/codex-pr-flag.ts).
wireCodexPrFlag({ events, store, resolveForge });

// Drive tailscale serve mappings: register when a preview port binds, unregister
// on teardown. Listens on session:preview (NOT session:preview-serve to avoid
// feedback loops). No-op when previewAutoServe disabled or previewHost unresolved.
events.subscribe((event, data) => {
  if (event !== "session:preview") return;
  const { id, previewPort } = data as SessionPreviewEvent;
  const op =
    previewPort != null ? tailscaleServe.register(id, previewPort) : tailscaleServe.unregister(id);
  void op.catch((err) => console.warn("[tailscale-serve] (un)register failed:", err));
});

// A PR in a merge train just landed (or was closed) → drop its "Merging" mark
// so the row resolves out of the Merging group one-by-one as the train works.
// session:git fires on any git change; resolveMerging clears the mark and
// credits the train tracker, no-opping when the session isn't marked / untracked.
onSessionGit(({ id, git }) => {
  if (git.state === "merged" || git.state === "closed")
    service.resolveMerging(id, git.state === "merged");
  // A participant's PR may flip to "open" only after the train launched (cold poller
  // cache at create time). Re-reconcile all live trains on every git change so it gets
  // marked. Cheap no-op when no train is live (#liveTrains empty).
  service.reconcileTrainMarks();
});

// Startup rebuild: repopulate #liveTrains from persisted train sessions so their marks
// survive a restart. Must run BEFORE the first sweepStaleMerging (below) — an empty
// #liveTrains would otherwise sweep all persisted marks. Safe with a cold snapshot:
// registerTrain just seeds the map; reconcile re-marks as the poller warms up.
for (const s of store.list({ activeOnly: true })) {
  if (s.mergeTrainPrs && s.mergeTrainPrs.length > 0)
    service.registerTrain(s.id, s.repoPath, s.mergeTrainPrs);
}

// The train session itself was archived → clear any of its PRs still marked
// (e.g. ones it held back / rejected and never merged). Keyed on archive (a
// terminal state), NOT done/idle — a Claude pane reports done at the train's
// approval gate, where clearing would wipe the marks mid-train.
events.subscribe((event, data) => {
  if (event !== "session:archived") return;
  service.clearMergingForTrain((data as { id: string }).id);
});

// Backstop sweep: release a mark once its train is no longer live and reclaim
// stale tracker entries. A PR the train holds back (never merged, train not yet
// archived) keeps the amber MERGING badge for the LIFE of the train session — it
// clears when the operator archives the train (clearMergingForTrain), or, for a
// train that died without ever emitting session:archived, at the
// TRAIN_TRACKER_MAX_MS liveness ceiling. There is no per-PR "rejected" signal —
// an accepted cosmetic trade-off, fine while held-back PRs are rare.
deferredStarts.push(() => {
  setInterval(() => service.sweepStaleMerging(), 60_000);
});

// Hourly: delete local shepherd/* branches whose PR has merged. The merge train
// squash-merges, so the at-archive ancestry prune (worktree.ts) never catches
// them and they pile up — and at merge time the session still holds the worktree
// so they can't be cleaned then anyway. Orphan branches only: never a checked-out
// or active-session branch. Disable with setting branchPruneEnabled="0".
// Pass the configured repo root as a durable repo source so housekeeping-pruned
// idle repos still get their leftover shepherd/* branches swept. Boundary: a repo
// whose archived sessions lived OUTSIDE repoRoot isn't covered here — once
// housekeeping prunes its last row it leaves branch-pruner scope (acceptable; such
// repos are outside the configured working area anyway).
const branchPruner = new BranchPruner(store, resolveForge, () =>
  listRepos(config.repoRoot).map((r) => r.path),
);
deferredStarts.push(() => {
  setTimeout(() => void branchPruner.tick(), 30_000); // first sweep shortly after boot
  branchPruner.start();
});

// PR-gated AI doc agent (issue #882, epic #875 Phase 3). Opt-in, default-off
// (config.docAgentEnabled / SHEPHERD_DOC_AGENT). Manual trigger only; the boot orphan-sweep +
// 15s finalize tick below are gated on the flag so the feature is fully inert when off.
const docAgent = new DocAgentService({
  herdr,
  worktree,
  resolveForge,
  // Plugin onSpawn hooks fire for the doc-agent spawn too (issue #1205); no-op until loadAll.
  runSpawnHooks: (d) => pluginRegistry.runSpawnHooks(d),
  repos: () => listRepos(config.repoRoot).map((r) => r.path),
  store,
  gitState: (id) => prPoller.get(id),
  nightlyHour: config.docAgentNightlyHour,
  // Per-role model thunk (read per spawn so a settings change applies without restart).
  env: () => roleEnv(config.docAgentCli, config.docAgentModel, config.docAgentEffort),
  act: config.docAgentAct,
  onChange: (f) => events.emit("doc-agent:done", f),
});
if (config.docAgentEnabled) {
  // Boot reconcile: re-adopt a finished/in-progress interrupted run (its SENTINEL edits are the
  // deliverable), prune dead ones + husk tabs + dangling cost rows, and reap orphan remote
  // docs-update-* branches with no PR. Best-effort (not awaited): the per-repo `starting` claim is
  // the load-bearing double-spawn guard, and a merged trigger lost during this brief reconcile
  // window is recovered by the nightly catch-all. Works even if the herdr daemon also restarted.
  deferredStarts.push(() => {
    void docAgent.reapOrphans().catch((err) => console.warn("[doc-agent] reapOrphans:", err));
  });
}

const reviewService = new ReviewService({
  store,
  herdr,
  worktree,
  resolveForge,
  // Plugin onSpawn hooks fire for reviewer-style aux spawns too (issue #1205); no-op until loadAll.
  runSpawnHooks: (d) => pluginRegistry.runSpawnHooks(d),
  // Per-role critic environment thunk (read per spawn so a settings change applies without restart).
  env: () => roleEnv(config.criticCli, config.criticModel, config.criticEffort),
  onChange: (id, verdict) => events.emit("session:review", { id, review: verdict }),
  onReviewing: (id, reviewing) => events.emit("session:reviewing", { id, reviewing }),
  onActivity: (id, summary) => events.emit("session:critic-activity", { id, summary }),
  // auto-address: steer critic findings straight into the task agent's PTY (same path
  // as a human "send review to agent"). Gated per-repo by autoAddressEnabled; the
  // round cap below stops it ping-ponging forever.
  // Defer while a herdr-restored account pane still needs a re-drive: return false (round holds,
  // retries next cycle) rather than steer findings into the wrong-account husk. The poller heals it
  // within ~1 tick (Locus A); shouldDeferSteer goes false once healed or bounded-out (degraded).
  autoAddress: async (id, text) =>
    service.shouldDeferSteer(id) ? false : await service.reply(id, text),
  // global, UI-configurable max auto-address rounds before escalating to the human.
  // A thunk so a settings change takes effect on the next critic run, no restart.
  cap: () => config.prReviewCyclesCap,
});

// Standalone repo-level PR critic (#596): the session-LESS twin of reviewService.
// Where reviewService reacts to a managed session's PR, this enumerates EVERY open,
// CI-green PR in a `criticAllPrs` repo (human PRs, other agents', forks) on a timer and
// posts comment-only reviews. Shares reviewService's primitives + the same per-role
// `criticModel` setting; concurrency/timeout stay at service defaults.
const standaloneCritic = new StandalonePrCriticService({
  store,
  herdr,
  worktree,
  resolveForge,
  // Plugin onSpawn hooks fire for reviewer-style aux spawns too (issue #1205); no-op until loadAll.
  runSpawnHooks: (d) => pluginRegistry.runSpawnHooks(d),
  // Same per-role critic environment as reviewService (read per spawn → live settings).
  env: () => roleEnv(config.criticCli, config.criticModel, config.criticEffort),
  repos: () => listRepos(config.repoRoot).map((r) => r.path),
  // Fresh per-sweep thunk (the service calls it each sweep, never caches) — branches
  // owned by a LIVE session, so a session-critic-owned PR is skipped when criticEnabled.
  managedBranches: (repoPath) =>
    new Set(
      store
        .list({ activeOnly: true })
        .filter((s) => s.repoPath === repoPath && s.branch)
        .map((s) => s.branch!),
    ),
});
deferredStarts.push(() => {
  standaloneCritic.reapOrphans(); // issue #1136: close orphaned pr-critic tabs left by a prior lifetime
});

// Pre-execution plan gate (#348): the planning-phase twin of the PR critic. An
// adversarial reviewer reads the agent's `.shepherd-plan.md` BEFORE it writes code;
// request-changes steers findings back into the planning PTY (same auto-address loop
// as the critic), approve clears the gate (auto sessions release straight into
// execution; interactive ones wait for the operator's explicit Go). Mirrors
// reviewService's deps, cap thunk, and model source.
const planGate = new PlanGateService({
  store,
  herdr,
  worktree,
  resolveForge,
  // Plugin onSpawn hooks fire for reviewer-style aux spawns too (issue #1205); no-op until loadAll.
  runSpawnHooks: (d) => pluginRegistry.runSpawnHooks(d),
  // Defer while a herdr-restored account pane still needs a re-drive: return false so the plan-gate
  // round holds (retries next cycle) instead of steering findings into the wrong-account husk. The
  // poller heals it within ~1 tick (Locus A); shouldDeferSteer clears once healed or degraded.
  reply: async (id, text) => (service.shouldDeferSteer(id) ? false : await service.reply(id, text)),
  // Discards releasePlanGate's boolean: the plan-gate DI contract is "release it", not "was it
  // releasable" — a no-op release (not planning / not approved) is not an error here.
  release: async (id) => {
    await service.releasePlanGate(id);
  },
  // Per-role plan-reviewer model thunk (read per spawn → live settings).
  env: () => roleEnv(config.plannerCli, config.plannerModel, config.plannerEffort),
  operatorLanguage: () => config.operatorLanguage,
  onChange: (id, gate) => events.emit("session:plangate", { id, gate }),
  onReviewing: (id, reviewing) => events.emit("session:plangate-reviewing", { id, reviewing }),
  onActivity: (id, summary) => events.emit("session:plangate-activity", { id, summary }),
  cap: () => config.planReviewCyclesCap,
});
// Grace window for a recent uncompleted reviewer_spawns row: spares a recently-spawned reviewer
// whose path is not currently in `inflight` (e.g. a restart-orphan before re-adoption). It does
// NOT cover the pre-`inflight` begin() window — recordReviewerSpawn runs AFTER inflight.set — so
// that window is covered instead by the directory-age guard in reapStaleReviewWorktrees, which
// reuses this same value as the dir-age threshold.
const REVIEW_WORKTREE_GRACE_MS = 15 * 60 * 1000;

// Disk-driven stale reviewer-worktree sweep (#721): reaps `*-review-*` checkouts under each
// `.shepherd-worktrees` dir whose teardown was missed (crash / restart / foreign-era basename).
// COMPLEMENTS planGate.gcStaleReviewWorktrees (store-driven) — see tab-reaper.ts. Spares any
// path a reviewer service currently holds (protectedPaths, the #631 guard — load-bearing that
// adoptOrphans has repopulated `inflight` before the boot call), any live session path, any
// recent uncompleted spawn, and any worktree hosting a live `claude`.
const sweepStaleReviewWorktrees = () => {
  if (maintenance.active) return; // a sync /proc+git sweep must not run mid-update
  try {
    const protectedPaths = new Set([
      ...planGate.inflightWorktrees(),
      ...reviewService.inflightWorktrees(),
      ...standaloneCritic.inflightWorktrees(),
    ]);
    const sessions = store.list();
    const sessionWorktreePaths = new Set(sessions.map((s) => s.worktreePath));
    const parents = new Set<string>();
    for (const s of sessions) parents.add(join(dirname(s.repoPath), ".shepherd-worktrees"));
    for (const row of store.listReviewerSpawns()) parents.add(dirname(row.worktreePath));
    const r = reapStaleReviewWorktrees({
      parents: [...parents],
      listDir: (parent) => {
        try {
          return readdirSync(parent);
        } catch {
          return [];
        }
      },
      protectedPaths,
      sessionWorktreePaths,
      scanAlive: scanClaudeAliveByWorktree,
      listReviewerSpawns: () => store.listReviewerSpawns(),
      now: Date.now,
      graceMs: REVIEW_WORKTREE_GRACE_MS,
      dirMtime: (p) => {
        try {
          return statSync(p).mtimeMs;
        } catch {
          return null;
        }
      },
      remove: (p) => worktree.remove(p),
    });
    if (r.reaped.length)
      console.warn(
        `[worktrees] reaped ${r.reaped.length} stale review worktree(s); spared ${r.sparedOwned} owned, ${r.sparedLive} live`,
      );
  } catch (err) {
    console.warn("[worktrees] sweep failed:", err);
  }
};

// Re-adopt plan reviews left in flight by the previous run (the `inflight` map is in-memory):
// without this a restart mid-review orphans the reviewer forever — its verdict goes unread, the
// gate never advances, and the planning agent sits idle awaiting a re-review that never comes.
// The next tick() then finalizes each re-adopted run from the verdict it already wrote.
// gcStaleReviewWorktrees runs AFTER adoptOrphans has repopulated `inflight` so it only reaps
// truly ownerless review worktrees (e.g. the older of two #631 same-session orphans).
// reapOrphans() runs BEFORE sweepStaleReviewWorktrees: for a dead-process orphan whose claude
// already exited but finalize never ran the worktree survives — the disk sweep would delete it
// first, erasing the orphan signal before reapOrphans can see it. Running reap first drops the
// sticky error verdict and returns the task session ids to re-kick with a force-consider so the
// critic re-runs; the disk-sweep then runs last, with `inflight` populated so protectedPaths hold.
const reKickReapedReview = (id: string) => {
  const s = store.get(id);
  if (!s) return;
  const git = prPoller.get(id);
  if (git) {
    // Have a fresh cached GitState → re-review directly. NOT forced, and that is deliberate:
    // for an error orphan reapOrphans already dropped the verdict, so a plain consider() re-reviews
    // (no head-dedup); for a non-error orphan, normal rules re-review on a moved head and correctly
    // skip a redundant same-head re-review, keeping the spawn-ceiling cost guard intact. This also
    // matches the cold-cache branch below, which can only run a non-force consider via the
    // subscription — so both paths have identical semantics (consider itself no-ops if the PR
    // isn't open+green, so a stale kick is safe).
    void reviewService
      .consider(s, git)
      .catch((err) => console.warn("[review] reap re-kick consider failed:", err));
  } else {
    // No cached GitState yet (the 3s boot warm-tick hasn't run): drop+pollSession so the next
    // refresh() emits session:git with no prior `prev`, firing the same non-force consider() via
    // the subscription below.
    prPoller.drop(id);
    prPoller.pollSession(id);
  }
};
deferredStarts.push(() => {
  void planGate
    .adoptOrphans()
    .then(() => planGate.gcStaleReviewWorktrees())
    .then(() => reviewService.reapOrphans())
    .then((ids) => {
      for (const id of ids) reKickReapedReview(id);
    })
    .then(() => sweepStaleReviewWorktrees())
    .catch((err) => console.warn("[boot] review/plan-gate orphan reconcile:", err));
  setInterval(() => sweepStaleReviewWorktrees(), 60 * 60 * 1000);
});

attachReviewPush(events, store, push);
attachGitPush(events, store, push);
attachMergePush(events, push);

// Reduced-push "ready-after-5s" evaluator (#896): while reducedPushMode is on, fire the
// `ready` push once a session holds the ready set for ≥5s (with warm-up + seed-on-arm guard).
const readyNotifier = new ReadyNotifier({
  listSessions: () => store.list({ activeOnly: true }),
  workingBlocked: () => poller.workingBlockedSnapshot(),
  gitSnapshot: () => prPoller.snapshot(),
  reviewingIds: () => [...reviewService.reviewingIds(), ...planGate.reviewingIds()],
  notify: (input) => push.notify(input),
  reducedMode: () => config.reducedPushMode,
});
deferredStarts.push(() => {
  readyNotifier.start();
});
// drive the critic off PR-state changes: open + CI green + unreviewed head → review
onSessionGit(({ id, git }) => {
  const s = store.get(id);
  // consider() is async (it may fetch PR notes); swallow rejections so a throw in the
  // review path can't become an unhandled rejection that takes down the process.
  if (s)
    void reviewService
      .consider(s, git)
      .catch((err) => console.warn("[review] consider failed:", err));
});

// When a PR appears for a session that is still in the planning phase, auto-advance it to
// "executing" so the plan-gate badge unlatches and autopilot stops standing down. This covers
// the case where the operator reviewed the plan then steered the agent manually (without
// clicking Go), so the agent wrote code and opened a PR while planPhase was still "planning".
// PR-present = state !== "none" (open/merged/closed), mirroring autopilot's hasPr non-"none"
// semantics — using "open"-only would leave a merged/closed-PR planning session latched.
onSessionGit(({ id, git }) => {
  if (git.state === "none") return;
  const advanced = service.advanceToExecutionOnPr(id);
  // Only reap the plan reviewer when a real transition happened — avoids redundant
  // work and log spam on every subsequent poll tick (mirrors how session:archived
  // gates forget() on the id being present before calling it).
  // The gate row is intentionally retained for the life of the session (dropped at
  // archive via forget()) so the UI can re-open the signed-off plan read-only.
  if (advanced) planGate.reapReviewer(id);
});

// Workflow protocol on the session's backlog issue: one comment when the PR enters
// the waiting-on-handoff state (open + green + foreign reviewer/merger), one when it
// merges. Stamped per PR in issue_log so each fires once, across restarts and CI
// flaps; best-effort — a failed comment is retried on the next git event.
const logIssueWorkflow = createIssueLogger({ resolveForge, store });
onSessionGit(({ id, git }) => {
  const s = store.get(id);
  if (!s || s.issueNumber == null) return;
  void logIssueWorkflow(s, git).catch((err) =>
    console.warn(`[issue-log] comment on #${s.issueNumber} failed:`, err),
  );
});
// Merge-triggered doc-agent consideration (issue #904). On a managed session's PR merging to the
// default branch, consider a doc-sync run when the merge subject is doc-relevant (feat/config). Flag-
// gated; idempotent across the 3s boot warm-tick replay via onMergedPr's per-PR persisted key. The
// merge fast path only sees managed-session PRs — human/non-session/non-conventional merges (e.g.
// epic-landing PRs) are caught by the nightly catch-all instead.
events.subscribe((event, data) => {
  if (!config.docAgentEnabled) return;
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: import("./forge/types").GitState };
  if (git.state !== "merged") return;
  const s = store.get(id);
  if (!s) return;
  // onMergedPr gates on s.baseBranch === the repo default — a feat/config PR that merged into a
  // non-default (epic/stacked) base must not trigger a run grounded on the default tip.
  void docAgent
    .onMergedPr(s.repoPath, git.number, git.title, s.baseBranch)
    .catch((err) => console.warn("[doc-agent] onMergedPr failed:", err));
});
// Manual operator steps — durable post-merge materialization (#1061, epic #1056 P3). On a managed
// session's PR merging, freeze its manual steps into the archive-decoupled post_merge_steps table
// (so the Owed lens + recap keep them after teardown) and, behind a per-repo opt-in, open a GitHub
// tracking issue linked back to the PR. onMerged is internally defensive (re-derives steps when
// detection hasn't run, never throws); this subscriber's .catch is the backstop so a failure can
// never strand the independent archive flow, and every failure mode recovers on the merged-event
// warm-tick replay (idempotent on the sessionId PK + the tracking-issue null-URL guard).
const postMergeSteps = new PostMergeStepsService({
  store,
  resolveForge,
  emitChange: () => events.emit("post-merge-steps:changed", {}),
});
onSessionGit(({ id, git }) => {
  if (git.state !== "merged") return;
  const s = store.get(id);
  if (!s) return;
  void postMergeSteps
    .onMerged(s, git.number ?? null, git.title ?? "")
    .catch((err) => console.warn("[post-merge-steps] onMerged failed:", err));
});
deferredStarts.push(() => {
  setInterval(() => {
    if (maintenance.active) return;
    void reviewService.tick().catch((err) => console.warn("[review] tick failed:", err));
    // planGate.tick() has a `finally` but no `catch`, and neither does its finalize(): since #1567
    // a rejected applyApproved → release → releasePlanGate → reply → herdr.send propagates straight
    // out of the timer callback as an unhandled rejection.
    void planGate.tick().catch((err) => console.warn("[plan-gate] tick failed:", err));
    void standaloneCritic.tick().catch((err) => console.warn("[critic] tick failed:", err));
    void recapService.tick().catch((err) => console.warn("[recap] tick failed:", err)); // finalize in-flight recaps (restart-safe)
    void recapService.sweep().catch((err) => console.warn("[recap] sweep failed:", err)); // settled-idle auto-fire
    void herdDigestService.tick().catch((err) => console.warn("[rundown] tick failed:", err)); // finalize in-flight digest (restart-safe)
    void herdDigestService.sweep().catch((err) => console.warn("[rundown] sweep failed:", err)); // daily auto-spark
    if (config.docAgentEnabled) {
      void docAgent.tick().catch((err) => console.warn("[doc-agent] tick failed:", err)); // finalize: server stages/commits/pushes/opens PR
      void docAgent
        .sweepNightly()
        .catch((err) => console.warn("[doc-agent] nightly sweep failed:", err)); // cadence: once/day/repo, spawn only when base advanced
      void docAgent
        .sweepReadyPrs()
        .catch((err) => console.warn("[doc-agent] sweepReadyPrs failed:", err)); // pre-merge: re-target docs onto an open code PR (settled-idle)
    }
    // settled-idle nudge for a drifted build queue; async since its steer is (#1567), so a
    // rejection needs a .catch — a try/catch around the call would no longer see it.
    void buildQueueReminder
      .sweep()
      .catch((err) => console.warn("[build-queue] reminder sweep failed:", err));
  }, 15_000);
});
// The standalone critic's enumeration runs on its OWN 60s timer, separate from the 15s
// finalize tick above: a sweep lists every open PR per repo (a forge round-trip), far
// heavier than reading verdict files, so it polls coarsely while verdicts still finalize
// promptly on the shared 15s tick.
let lastCriticSweepAt = 0;
const criticIdleIntervalMs = 300_000;
deferredStarts.push(() => {
  setInterval(() => {
    if (maintenance.active) return;
    if (graphRateLimit.blocked()) return;
    const now = Date.now();
    // Cold path: no dashboard + no autonomous work → throttle the per-repo PR
    // enumeration to the coarse idle cadence (the cheap 15s verdict-finalize tick
    // above is untouched, so verdicts still settle promptly).
    if (!warm() && now - lastCriticSweepAt < criticIdleIntervalMs) return;
    lastCriticSweepAt = now;
    void standaloneCritic.sweep().catch((err) => console.warn("[critic] sweep failed:", err));
  }, 60_000);
});
// archived sessions: reap any in-flight critic + drop the verdict, and reap any
// in-flight plan reviewer + drop its gate (forget() does both).
events.subscribe((event, data) => {
  if (event === "session:archived") {
    const id = (data as { id: string }).id;
    reviewService.forget(id);
    planGate.forget(id);
    recapService.onArchived(id);
    autoMergedRecapEvidence.delete(id);
    buildQueueReminder.forget(id);
    docAgent.onArchived(id);
  }
});

/** A session's live PTY visible buffer via its matched herdr agent, or null (no session / no live
 *  agent / herdr down). Shared by the `readTail` and `pendingAuthUrl` autopilot seams. */
function readVisibleBuffer(id: string): string | null {
  const s = store.get(id);
  if (!s) return null;
  try {
    const live = matchAgent(s, herdr.list());
    return live ? herdr.read(live.terminalId, "visible") : null;
  } catch {
    return null;
  }
}

// Autopilot: the pre-PR twin of the critic's auto-address loop. When an autopilot-enabled
// session (per-repo default + per-session override) stalls on a procedural gate with no PR
// yet, a transient classifier decides gate (auto-proceed) / question (surface) / finished
// (drive to a PR). Genuine questions pause the session loudly (distinct state + push).
const autopilot = new AutopilotService({
  store,
  classify: (tail, taskPrompt, label) => {
    const env = roleEnv(config.autopilotCli, config.autopilotModel, config.autopilotEffort);
    return classifyStop(
      tail,
      taskPrompt,
      {
        herdr,
        provider: env.provider,
        model: env.model,
        effort: env.effort,
        operatorLanguage: config.operatorLanguage,
      },
      label,
    );
  },
  steer: (id, text) => service.reply(id, text),
  resume: (id) => service.resume(id),
  paneAlive: (id) => {
    const s = store.get(id);
    return !!s && matchAgent(s, herdr.list()) !== null;
  },
  deferSteer: (id) => service.shouldDeferSteer(id),
  readTail: (id) => {
    const v = readVisibleBuffer(id);
    return v === null ? [] : tailLines(v);
  },
  // Pending human-only OAuth authorize URL — autopilot stands down until the operator completes
  // it. A fresh read (not off an event) so onDone/consider re-checks are deterministic. TWO
  // independent sources, first hit wins: the swap-account-aware transcript (MCP OAuth,
  // freshness-gated) and, failing that, a fresh PTY visible read reconstructing a `/login`
  // account-re-login URL (PTY-only — never in the transcript). The `claudeSessionId` precondition
  // gates ONLY the transcript branch, so a `/login` session still reaches the PTY fallback.
  pendingAuthUrl: (id) => {
    const s = store.get(id);
    if (!s) return null;
    if (s.claudeSessionId) {
      try {
        const u = detectPendingAuthUrl(
          readTranscriptTail(jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir)),
        );
        if (u) return u;
      } catch {
        // transcript missing/unreadable → fall through to the PTY source
      }
    }
    const v = readVisibleBuffer(id); // PTY-only `/login` URL (guarded → null when herdr is down)
    return v === null ? null : detectLoginAuthUrl(v);
  },
  // Any PR (open/merged/closed) stands autopilot down — only a session with NO PR yet is its
  // territory. `state` is "none" when no PR exists; anything else means one does.
  hasPr: (id) => {
    const st = prPoller.snapshot()[id]?.state;
    return st !== undefined && st !== "none";
  },
  // Lightweight completion barrier (#807): mirror forgeOpenPr server-side (no Request) so an
  // agent with no `gh` still registers its pseudo-PR. Self-guarding: an EmptyDiff is a clean
  // "nothing to open" no-op and any other failure is logged, never rejected — so the awaiting
  // autopilot tick can't crash (house rule: no unguarded await on a fallible async).
  openLocalPr: async (id) => {
    try {
      const s = store.get(id);
      if (!s || !s.branch) return;
      const forge = resolveForge(s.repoPath);
      if (!forge || forge.kind !== "local") return; // defensive: only the local forge has no host
      const status = await forge.openPr({
        head: s.branch,
        base: s.baseBranch,
        title: s.name,
        body: s.prompt,
      });
      const me = (await forge.currentUser?.()) ?? null;
      const git: GitState = annotateHandoff({ kind: forge.kind, ...status }, s.repoPath, me);
      prPoller.set(s.id, git);
      events.emit("session:git", { id: s.id, git });
    } catch (err) {
      if (err instanceof EmptyDiffError) return; // nothing to open — clean no-op
      console.warn("[autopilot] openLocalPr:", err);
    }
  },
  // Deterministic completion verifier (#1009): true when the session's branch has a committed diff
  // vs base. Fails OPEN (returns true) on any git error so a systemic failure can't false-route a
  // genuinely-complete session to needs-human — but logs, so the bypass is observable, not silent.
  hasDiff: async (id) => {
    const s = store.get(id);
    if (!s) return true;
    try {
      return await hasCommittedChanges(s.worktreePath, s.baseBranch, s.branch);
    } catch (err) {
      console.warn("[autopilot] hasDiff:", err);
      return true;
    }
  },
  prGit: (id) => prPoller.snapshot()[id] ?? null,
  fullAuto: (id) => {
    const s = store.get(id);
    return !!s && isFullAuto(s, store.getRepoConfig(s.repoPath));
  },
  getReview: (id) => store.getReview(id),
  refreshPr: (id) => prPoller.pollSession(id),
  onPause: (id, question) => {
    const s = store.get(id);
    if (!s) return;
    void push.notify({
      kind: "autopilot",
      sessionId: id,
      tag: id,
      name: s.name,
      summary: question,
    });
  },
  onComplete: (id, summary) => {
    const s = store.get(id);
    if (!s) return;
    void push.notify({
      kind: "autopilot-done",
      sessionId: id,
      tag: id,
      name: s.name,
      summary,
    });
  },
  onState: (id) => {
    const s = store.get(id);
    if (s)
      events.emit("session:autopilot", {
        id,
        paused: s.autopilotPaused,
        complete: s.autopilotComplete,
        question: s.autopilotQuestion,
        enabled: s.autopilotEnabled,
      });
  },
  stepCap: config.autopilotStepCap,
  rebaseCap: config.autoMergeRebaseCap,
});

// Drive autopilot's block handling off the poller events. `session:status`/`session:git`
// no longer fan out here — they flow through the ordered SessionRouter seam (built after
// `drain`) so drain (retire) is awaited before autopilot (steer). Only `session:block`
// stays an independent autopilot subscription.
events.subscribe((event, data) => {
  if (event !== "session:block") return;
  const { id, block } = data as { id: string; block: import("./blocked").BlockReason | null };
  void autopilot.onBlock(id, block).catch((err) => console.warn("[autopilot] onBlock:", err));
});

// Drop autopilot's per-session tracking (incl. the MCP-OAuth stand-down set) when a session is
// archived, so its maps don't leak — mirrors the poller's pruneInactive.
events.subscribe((event, data) => {
  if (event !== "session:archived") return;
  autopilot.forget((data as { id: string }).id);
});

// Self-draining work queue (#222): when an auto session's PR merges, archive it and
// spawn the next labeled backlog issue, bounded by the per-repo rails. Pure decision
// core (computeNext) with side effects here; driven off the same poller events.
const drain = new DrainService({
  store,
  service,
  resolveForge,
  prCache: prPoller, // has snapshot()
  usage: usageLimits, // has limits(now)
  repos: () => listRepos(config.repoRoot).map((r) => r.path),
  emitStatus: (status) => events.emit("drain:status", status),
  emitArchived: (id) => events.emit("session:archived", { id }),
  dropPrCache: (id) => prPoller.drop(id),
  emitEpic: (epic) => events.emit("epic:update", epic),
  emitEpicCompleted: (e) => events.emit("epic:completed", e),
  // A brand-new session's agent is only just starting — its scratchpad can't hold artifacts
  // yet, so seed hasScratchpadFiles=false (#1164). The live truth thereafter rides the
  // session:status (idle/done) push and the /api/sessions list enrichment.
  emitSessionNew: (s) => events.emit("session:new", { ...s, hasScratchpadFiles: false }),
  telemetry,
  // #1071: wire rebase cap + real rebaseLandingBranch (mirrors autopilot/automerge wiring).
  rebaseCap: config.autoMergeRebaseCap,
});

// Drive the drain's archived/review handling off the poller events. `session:git`/`session:status`
// flow through the ordered SessionRouter seam below (drain before autopilot); only the
// archived/review side-effects stay independent drain subscriptions.
events.subscribe((event, data) => {
  if (event === "session:archived") {
    const { id } = data as { id: string };
    void drain.onArchived(id).catch((err) => console.warn("[drain] onArchived:", err));
  } else if (event === "session:review") {
    const { id } = data as { id: string };
    void drain.onReview(id).catch((err) => console.warn("[drain] onReview:", err));
  }
});

// #1094: one ordered "what happens next" seam. `session:status`/`session:git` used to fan out to
// two fire-and-forget subscriptions (drain retire + autopilot steer) that interleaved within a
// single poller tick and raced. The router builds the shared per-session snapshot once and dispatches
// consumers in order, AWAITING each — drain (retire) before autopilot (steer) — so a ready session is
// retired/handed off before autopilot spends a classify on it, and autopilot never steers a row drain
// is about to archive. autoMerge + every other session:git/status subscriber stay independent.
const sessionRouter = new SessionRouter(
  { getSession: (id) => store.get(id) },
  [
    { name: "drain", handle: (change) => drain.handle(change) },
    { name: "autopilot", handle: (change) => autopilot.handle(change) },
  ] satisfies SessionConsumer[],
  {
    // Plan-gate is an independent status side-effect (not a [drain,autopilot] consumer): a
    // planning-phase session that just settled likely finished writing .shepherd-plan.md → kick the
    // adversarial review. Fires BEFORE the awaited consumer chain so a slow/hanging drain pump can
    // never starve it (#1193); consider() is self-contained and claims its slot synchronously.
    // Also re-fires on the idle settle edge for the revise loop (a session that reworks its plan
    // after `changes_requested` settles to idle, not done) — see shouldConsiderOnSettle (#1610).
    onStatusIndependent: (change) => {
      const sess = change.snapshot.session;
      const priorDecision = store.getPlanGate(sess.id)?.decision;
      if (shouldConsiderOnSettle(change.status, sess.planPhase, priorDecision))
        void planGate.consider(sess).catch((err) => console.warn("[plan-gate] consider:", err));
    },
  },
);
events.subscribe((event, data) => {
  if (event === "session:status") {
    const { id, status } = data as { id: string; status: string };
    void sessionRouter
      .onStatus(id, status)
      .catch((err) => console.warn("[session-router] onStatus:", err));
  } else if (event === "session:git") {
    const { id, git } = data as { id: string; git: import("./forge/types").GitState };
    void sessionRouter.onGit(id, git).catch((err) => console.warn("[session-router] onGit:", err));
  }
});
// Slow sweep: catch newly-labeled issues and resumed-usage windows (~30s).
deferredStarts.push(() => {
  setInterval(() => {
    if (maintenance.active) return;
    void drain.tick().catch((err) => console.warn("[drain] tick:", err));
  }, 30_000);
});

const autoMerge = new AutoMergeService({
  store,
  service, // archive, reply, resume, resolveMerging
  resolveForge,
  worktree, // has behindBase
  prCache: prPoller,
  paneAlive: (id) => {
    const s = store.get(id);
    return !!s && matchAgent(s, herdr.list()) !== null;
  },
  deferSteer: (id) => service.shouldDeferSteer(id),
  repos: () => listRepos(config.repoRoot).map((r) => r.path),
  emitStatus: (status) => events.emit("automerge:status", status),
  emitArchived: (id) => events.emit("session:archived", { id }),
  dropPrCache: (id) => prPoller.drop(id),
  noteMergedForRecap: ({ sessionId, prNumber, headSha }) => {
    autoMergedRecapEvidence.set(sessionId, { prNumber, headSha });
  },
  retainClaim: (id) => drain.retainClaim(id),
  rebaseCap: config.autoMergeRebaseCap,
});

// Per-session merge-train error flags, derived live from the automerge:status stream so
// the Herd Rundown can fold a stuck train run into a session's attention signals without a
// forge round-trip (AutoMergeService.snapshot() is async). A "merge_error"/"rebase_cap"
// status marks its session; any other state for that session clears it.
const mergeErrorSessions = new Set<string>();
events.subscribe((event, data) => {
  if (event !== "automerge:status") return;
  const s = data as { state: string | null; sessionId: string | null };
  if (!s.sessionId) return;
  if (s.state === "merge_error" || s.state === "rebase_cap") mergeErrorSessions.add(s.sessionId);
  else mergeErrorSessions.delete(s.sessionId);
});

// Drive the merge train off the same poller/critic events the rest of the system emits.
events.subscribe((event, data) => {
  if (event === "session:git") {
    const { id } = data as { id: string };
    void autoMerge.onGit(id).catch((err) => console.warn("[automerge] onGit:", err));
  } else if (event === "session:review") {
    const { id } = data as { id: string };
    void autoMerge.onReview(id).catch((err) => console.warn("[automerge] onReview:", err));
  } else if (event === "session:status") {
    const { id } = data as { id: string };
    void autoMerge.onStatus(id).catch((err) => console.warn("[automerge] onStatus:", err));
  }
});
deferredStarts.push(() => {
  setInterval(() => {
    if (maintenance.active) return;
    void autoMerge.tick().catch((err) => console.warn("[automerge] tick:", err));
  }, 30_000);
});
// Re-engage idle full-auto sessions stuck on an open+red PR. A timer is the one trigger that
// re-fires on an UNCHANGED red head (the PR poller emits no `session:git` without a state change),
// so this owns the sustained re-engagement that onGit/considerCi structurally cannot deliver.
deferredStarts.push(() => {
  setInterval(() => {
    if (maintenance.active) return;
    void autopilot.tick().catch((err) => console.warn("[autopilot] tick:", err));
  }, 30_000);
});

// Herd Rundown: a once-daily synthesized "what needs a human right now?" digest across the
// whole live herd. All inputs are injected accessors over the same in-memory caches the rest
// of the system reads, so the service never reaches into live state directly:
//   snapshots          → the four per-session caches (git/reviews/gates/recaps)
//   stalledSessionIds  → transcript-derived stall set (read ONLY inside generate(), never the
//                        15s tick/sweep — a bounded sync transcript-tail read per active
//                        running session, mirroring the poller's stall candidate)
//   mergeTrainState    → live queued PRs (service.liveTrainPrs) + per-session train errors
//                        (mergeErrorSessions, fed by the automerge:status stream above)
// Landing-ready completed epics for the rundown (#1045). TTL-memoized: sweep()'s 15s tick keeps
// calling generate()/reconcileEpics() while an epic sits open, and each call would otherwise probe
// the forge. The cheap part (which epics are 'open') is a sync DB filter, computed EVERY call so a
// just-landed epic drops immediately; only the forge probe is memoized (≈once/TTL) and the cache is
// keyed on the open-epic set so any land/open busts it (TTL only bounds same-set CI-readiness flips).
// Mirrors backlogPriority reading a kept-warm cache rather than a live round-trip.
const EPIC_READY_TTL_MS = 5 * 60_000;
let epicReadyCache: { key: string; ts: number; val: RundownEpicItem[] } | null = null;
const landingReadyEpics = async (): Promise<RundownEpicItem[]> => {
  const now = Date.now();
  const openRows = store.listEpicCompleted().filter((r) => r.landingState === "open");
  if (openRows.length === 0) {
    epicReadyCache = null; // nothing open → drop any stale cache so a just-landed epic clears at once
    return [];
  }
  // Cache key = the set of open epics + their pause states. A change (landed, opened, or pause
  // reason flip) busts the cache; the TTL only throttles re-probing the forge for CI-readiness
  // flips on the same set.
  const key = openRows
    .map((r) => `${r.repoPath}#${r.parentIssueNumber}:${r.landingRebasePauseReason ?? ""}`)
    .sort()
    .join(",");
  if (epicReadyCache && epicReadyCache.key === key && now - epicReadyCache.ts < EPIC_READY_TTL_MS)
    return epicReadyCache.val;

  // Paused rows (#1071): non-null landingRebasePauseReason → surface immediately as Tier-1 items
  // without a forge probe (pause reason is already in the DB; no CI-readiness gate applies).
  const pausedItems: RundownEpicItem[] = openRows
    .filter((r) => r.landingRebasePauseReason !== null)
    .map((r) => ({
      repo: r.repoPath,
      parent: r.parentIssueNumber,
      title: r.parentTitle,
      landingPr: r.landingPrNumber,
      stranded: false, // paused items are not "stranded" (different escalation path)
      ciFailing: false,
      pausedReason: r.landingRebasePauseReason as "cap" | "conflict" | "driver",
    }));

  // Ready rows: probe the forge (TTL-memoized) for CI-readiness; exclude already-paused rows
  // (injected above) so each open row is surfaced under exactly one heading.
  const epics: CompletedEpic[] = openRows
    .filter((r) => r.landingRebasePauseReason === null)
    .map(
      ({
        childrenJson,
        landingAttempts,
        landingRebaseCount,
        landingRebaseDriverMisses,
        ...rest
      }) => {
        void landingAttempts;
        void landingRebaseCount;
        void landingRebaseDriverMisses;
        return { ...rest, children: JSON.parse(childrenJson) as CompletedEpic["children"] };
      },
    );
  await enrichLandingEpics(epics, {
    getEpicIntegrationBranch: (repoPath, parent) =>
      store.getEpicIntegrationBranch(repoPath, parent),
    resolveForge: (repoPath) => resolveForge(repoPath),
    now,
  });
  const readyItems: RundownEpicItem[] = epics
    .filter((e) => e.landingState === "open" && e.landingReady === true)
    .map((e) => ({
      repo: e.repoPath,
      parent: e.parentIssueNumber,
      title: e.parentTitle,
      landingPr: e.landingPrNumber,
      stranded: e.landingStranded === true,
      ciFailing: false,
    }));

  // CI-failing rows (terminal red, not behind/conflicting): surface as a distinct Tier-1 item. `epics`
  // already excludes paused rows; a red row has landingReady=false so it is not in readyItems either —
  // so each open row lands under exactly one heading.
  const ciFailingItems: RundownEpicItem[] = epics
    .filter((e) => e.landingState === "open" && e.landingCiFailing === true)
    .map((e) => ({
      repo: e.repoPath,
      parent: e.parentIssueNumber,
      title: e.parentTitle,
      landingPr: e.landingPrNumber,
      stranded: false,
      ciFailing: true,
    }));

  const val: RundownEpicItem[] = [...pausedItems, ...readyItems, ...ciFailingItems];
  epicReadyCache = { key, ts: now, val };
  return val;
};

const herdDigestService = new HerdDigestService({
  store,
  herdr,
  // Live operator-language setting, read per spawn (#1586).
  operatorLanguage: () => config.operatorLanguage,
  isActive: () => presence.isActive(),
  landingReadyEpics,
  hasOpenLandingEpics: () => store.listEpicCompleted().some((r) => r.landingState === "open"),
  onChange: (digest) => events.emit("herd:digest", { digest }),
  snapshots: () => ({
    git: prPoller.snapshot(),
    reviews: reviewService.snapshot(),
    gates: planGate.snapshot(),
    recaps: recapService.snapshot(),
  }),
  stalledSessionIds: () => {
    const now = Date.now();
    const stalled = new Set<string>();
    for (const s of store.list({ activeOnly: true })) {
      if (s.status !== "running" || !s.claudeSessionId) continue;
      const snap = readSnapshot(jsonlPathFor(s.worktreePath, s.claudeSessionId, s.spawnAccountDir));
      if (snap && isStalled(snap, now, DEFAULT_STALL)) stalled.add(s.id);
    }
    return stalled;
  },
  mergeTrainState: () => ({
    queuedPrs: service.liveTrainPrs(),
    bySession: Object.fromEntries([...mergeErrorSessions].map((id) => [id, { error: true }])),
  }),
  // Backlog-priority rank per repoPath: rank the configured repos by their WARM cached
  // open-issue count (descending — the same criterion the backlog overview ranks by),
  // assigning 0,1,2,…. Reads `backlog.peek()` off the kept-warm cache only (no async
  // forge round-trip); a repo with no cached counts sorts last. Called inside generate()
  // (≤ once/day), so cheap-by-construction. `backlog` is declared later in this module
  // but the closure only runs well after init, so the ref is safe.
  backlogPriority: () => {
    const ranked = listRepos(config.repoRoot)
      .map((r) => ({ path: r.path, openIssues: backlog.peek(r.path)?.openIssues ?? -1 }))
      .sort((a, b) => b.openIssues - a.openIssues);
    const rank: Record<string, number> = {};
    ranked.forEach((r, i) => (rank[r.path] = i));
    return rank;
  },
});

const holdService = new HoldReasonService({
  store,
  events,
  gitSnapshot: () => prPoller.snapshot(),
  reviewSnapshot: () => reviewService.snapshot(),
  gateSnapshot: () => planGate.snapshot(),
  recapSnapshot: () => recapService.snapshot(),
  onChange: (id, hold) => events.emit("session:hold", { id, hold }),
});

const draftReconcile = new DraftReconcileService({
  store,
  resolveForge,
  prCache: prPoller,
  pollSession: (id) => prPoller.pollSession(id),
  emitStatus: (s) => events.emit("draftreconcile:status", s),
});

// Drive draft-reconcile off the same poller/critic events automerge uses.
events.subscribe((event, data) => {
  if (event === "session:git") {
    const { id } = data as { id: string };
    void draftReconcile.onGit(id).catch((err) => console.warn("[draft-reconcile] onGit:", err));
  } else if (event === "session:review") {
    const { id } = data as { id: string };
    void draftReconcile
      .onReview(id)
      .catch((err) => console.warn("[draft-reconcile] onReview:", err));
  } else if (event === "session:status") {
    const { id } = data as { id: string };
    void draftReconcile
      .onStatus(id)
      .catch((err) => console.warn("[draft-reconcile] onStatus:", err));
  }
});
deferredStarts.push(() => {
  setInterval(() => {
    if (maintenance.active) return;
    void draftReconcile.tick().catch((err) => console.warn("[draft-reconcile] tick:", err));
  }, 30_000);
});
// Note: draftreconcile:status is forwarded to websocket clients automatically via
// the EventHub subscribe in server.ts (ws.data.kind === "events" path), just as
// automerge:status is — no additional forwarding needed.

// Learnings flywheel: capture block/stall signals, run the distiller on a slow
// cadence, and surface the proposed-rule count to clients.
attachSignalCapture(events, store);
const distiller = new DistillerService({
  store,
  herdr,
  scratch: defaultScratch,
  onChange: () => learningsSvc.emitPending(),
});
deferredStarts.push(() => {
  distiller.reapOrphans(); // issue #1135: close orphaned __distill__ tabs left by a prior lifetime
  setInterval(() => {
    if (maintenance.active) return;
    void distiller.tick();
  }, 30_000);
});
const promoter = new Promoter({ store, worktree, resolveForge });
const optimizer = new OptimizerService({
  store,
  herdr,
  scratch: defaultOptimizerScratch,
  promoter,
  onChange: () => learningsSvc.emitPending(),
});
deferredStarts.push(() => {
  optimizer.reapOrphans(); // issue #1135: close orphaned __optimize__ tabs left by a prior lifetime
  setInterval(() => {
    if (maintenance.active) return;
    void optimizer.tick();
  }, 30_000);
});
// Phase 4: background merge-suggestion pass (off the hot path). consider/considerCrossRepo
// run from the daily sweep (synchronous, non-blocking — they enqueue a detached spawn);
// the 30s tick reaps finished/timed-out runs.
const mergeSuggest = new MergeSuggestionService({
  store,
  herdr,
  scratch: defaultMergeScratch,
  onChange: () => learningsSvc.emitPending(),
});
deferredStarts.push(() => {
  mergeSuggest.reapOrphans(); // issue #1135: close orphaned __merge__ tabs left by a prior lifetime
  setInterval(() => {
    if (maintenance.active) return;
    void mergeSuggest.tick();
  }, 30_000);
});
// Issue #1136: the synchronous block-and-clean helpers (namer / autopilot / verify-key) stop their
// spawn in a `finally`, so they leave NO husk on a CLEAN exit — but a server restart mid-poll skips
// that finally, orphaning an interactive `claude` that idles at the prompt forever (the husk-only
// reaper spares it as a live non-shell proc). They track no inflight and none is running at this
// synchronous boot point, so an empty owned set is correct: close every prior-lifetime orphan by
// label prefix. Space-prefixed / multi-word labels can't collide with an `[a-z0-9-]` session slug.
deferredStarts.push(() => {
  // Fire-and-forget: `reapTransientByLabel` is async now (issue #1553) but internally guarded
  // (never rejects), and the thunk must stay `() => void` — `deferredStarts` is consumed
  // synchronously, so an async thunk would trip `no-misused-promises`. Boot need not block on
  // this best-effort orphan cleanup.
  void reapTransientByLabel(herdr, "name ", new Set(), "[namer]");
  void reapTransientByLabel(herdr, "autopilot ", new Set(), "[autopilot]");
  void reapTransientByLabel(herdr, "verify api key", new Set(), "[verify-key]");
});
const gitignoreAdopter = new GitignoreAdopter({ worktree, resolveForge });
// Daily: prune archived sessions, prune old signals, then consider a distill per repo
// with enough recent signal.
// Backups (#1080) are considered stale once the newest successful snapshot is older than this.
// Tunable default — NOT load-bearing. Note: this is only SAMPLED once per daily sweep, so the
// worst-case detection latency is ~24h regardless of the threshold.
const BACKUP_STALENESS_MS = 3 * 60 * 60 * 1000;
const HOST_SIGNAL_REPO = "__host__"; // sentinel repoPath for host-global (non-repo) signals

/**
 * Read-only staleness probe for the external backup timer. Runs inside the daily sweep so no
 * snapshot I/O ever touches the event loop. A host is only checked if it's *expected* to back up:
 * provision/update writes a `.backup-configured` marker when it enables the timer, so a macOS /
 * core-only box (no marker) stays silent, while a Linux box whose backup is broken from its very
 * first run (marker present, no `.last-success`) IS flagged. Alerts via three channels: a
 * guaranteed log line (visible even with no push subscription), a durable `backup_stale` signal
 * row, and a best-effort web push.
 */
const checkBackupStaleness = async (): Promise<void> => {
  let markerAgeMs: number;
  try {
    const st = await stat(backupConfiguredMarker());
    markerAgeMs = Date.now() - st.mtimeMs;
  } catch {
    return; // no marker → backups never configured on this host → stay silent
  }
  // Grace window: a freshly-configured host (marker younger than the staleness threshold) hasn't had
  // a chance to run its first backup — the timer's first fire is at the next hour boundary while the
  // boot+10s sweep would otherwise see no `.last-success` and cry stale. Suppress until the window
  // passes (provision/update also kick one backup immediately, so this is the race-free backstop).
  if (markerAgeMs < BACKUP_STALENESS_MS) return;
  let ageMs: number | null = null;
  try {
    const iso = (await readFile(lastSuccessMarker(), "utf8")).trim();
    const ts = Date.parse(iso);
    if (!Number.isNaN(ts)) ageMs = Date.now() - ts;
  } catch {
    ageMs = null; // marker present but never a successful run
  }
  const stale = ageMs === null || ageMs > BACKUP_STALENESS_MS;
  if (!stale) return;
  const staleHours = ageMs === null ? null : Math.floor(ageMs / (60 * 60 * 1000));
  console.warn(
    `[backup] STALE: ${ageMs === null ? "no successful backup yet" : `newest snapshot ~${staleHours}h old`} — the backup timer may be failing.`,
  );
  store.addSignal({
    repoPath: HOST_SIGNAL_REPO,
    sessionId: null,
    kind: "backup_stale",
    payload: JSON.stringify({ ageMs, thresholdMs: BACKUP_STALENESS_MS }),
  });
  void push
    .notify({
      kind: "backup_stale",
      sessionId: "",
      tag: "backup-stale",
      name: "backup",
      staleHours: staleHours ?? undefined,
      cooldownKey: "backup_stale",
    })
    .catch((err) => console.warn("[push] backup_stale notify failed:", err));
};

const runDailySweep = (opts?: { skipTmpSweep?: boolean }) => {
  if (maintenance.active) return;
  if (config.sessionHousekeepingEnabled)
    store.pruneArchivedSessions({
      maxAgeMs: SESSION_RETENTION_MS,
      keepNewest: SESSION_RETENTION_KEEP,
    });
  store.pruneSignals(Date.now() - 60 * 24 * 60 * 60 * 1000);
  // Cost-attribution records (issue #502); pruned on their own 90-day window, independent of
  // session housekeeping, so they survive an archived task's removal for later usage reports.
  store.pruneReviewerSpawns(Date.now() - REVIEWER_SPAWN_RETENTION_MS);
  // Scrape timeline history; pruned on a 90-day window matching the caps/credit tables.
  store.pruneUsageHistory(Date.now() - USAGE_HISTORY_RETENTION_MS);
  for (const repo of listRepos(config.repoRoot)) void distiller.consider(repo.path);
  // Phase 4 merge suggestions: per-repo near-duplicate clustering (intra) + a single global
  // cross-repo recurrence pass. Both no-op unless the active set is large enough AND changed
  // since the last pass, and each only enqueues (never awaited here).
  for (const repo of listRepos(config.repoRoot)) void mergeSuggest.consider(repo.path);
  void mergeSuggest.considerCrossRepo();
  store.pruneOrphanMergeSuggestions();
  // Auto-retire: soft-retire active rules whose Wilson-bounded help-rate is below the
  // repo base rate (gated on real harm evidence). Returns the retired set so we only
  // nudge clients (banner refresh) when something actually changed.
  const retired = runAutoRetire({ store, optimizer });
  if (retired.length > 0) {
    learningsSvc.emitPending();
    // Best-effort push so operators learn of background retirements without opening the
    // drawer (issue #852). One summary push across all repos; suppressed while the app is
    // active and for devices that muted the "agent" category. Guarded so a rejection can't
    // crash the sweep — the in-drawer banner remains the durable surface either way.
    void push
      .notify({
        kind: "learnings_retired",
        sessionId: "",
        tag: "learnings-retired",
        name: "learnings",
        retiredCount: retired.length,
        cooldownKey: "learnings_retired:all",
      })
      .catch((err) => console.warn("[push] learnings_retired notify failed:", err));
  }
  // Auto-trial strong proposals (#925): promote proposals with strong, multi-source evidence
  // to active trials (kill-switch via SHEPHERD_LEARNINGS_AUTO_TRIAL); reap inert/zombie trials;
  // expire stale dead proposals. All capped per sweep. Returns drive the client nudge + push.
  const trialed = runAutoTrial({ store });
  const reaped = runReapStaleTrials({ store });
  const expired = runAutoExpire({ store });
  if (trialed.length + reaped.length + expired.length > 0) {
    learningsSvc.emitPending();
  }
  if (trialed.length > 0) {
    // Best-effort push so operators learn of background trials without opening the drawer.
    // One summary push across all repos; suppressed while active / for muted devices. Guarded
    // so a rejection can't crash the sweep — the in-drawer surface remains durable.
    void push
      .notify({
        kind: "learnings_trialed",
        sessionId: "",
        tag: "learnings-trialed",
        name: "learnings",
        trialedCount: trialed.length,
        cooldownKey: "learnings_trialed:all",
      })
      .catch((err) => console.warn("[push] learnings_trialed notify failed:", err));
  }
  // Reclaim session_injected_learnings rows for sessions that vanished without archive()
  // (force-removed/crashed) — archive() consumes the rest.
  store.pruneOrphanInjectedLearnings();
  // Skip on the boot-time run: fireTmpSweep("boot") already ran the fallow/worktree
  // sweep seconds earlier, so re-running it here only duplicates the work (and the log).
  if (!opts?.skipTmpSweep) fireTmpSweep("daily");
  // Read-only backup-staleness probe (#1080); fire-and-forget so it never blocks the sweep.
  void checkBackupStaleness();
};
deferredStarts.push(() => {
  setTimeout(() => runDailySweep({ skipTmpSweep: true }), 10_000); // once shortly after boot
  setInterval(runDailySweep, 24 * 60 * 60 * 1000);
});

// recompute live limit % from local JSONL ~every 30s; push to clients
attachUsagePush(events, store, push);
attachCreditsPush(events, store, push);

/**
 * Wrap an async background task for a timer callback. `setTimeout`/`setInterval` expect
 * `() => void`, so handing them a bare async fn floats its promise: a rejection escapes as an
 * unhandled rejection instead of being logged. Every periodic tick below is best-effort — a
 * failed check must log and let the next tick retry, never take the process down.
 */
const timerTask = (label: string, fn: () => Promise<unknown>) => () =>
  void fn().catch((err) => console.warn(`[${label}] tick failed:`, err));

// Re-entrancy guard: a release can still be awaiting service.create() when the next
// 30s tick fires; without this a second tick re-reads the not-yet-removed head task and
// double-spawns it (or errors with agent_name_taken). Mirrors the `calibrating` flag below.
let releasingHeld = false;
deferredStarts.push(() => {
  setInterval(
    timerTask("usage", async () => {
      await accountIndex.refresh(Date.now());
      events.emit("usage:limits", usageLimits.limits(Date.now()));
      if (releasingHeld) return; // prior release still draining — skip this tick's release
      releasingHeld = true;
      try {
        await releaseHeldTasks(
          { store, service, usageLimits, events, resolveForge },
          {
            enabled: config.usageHoldEnabled,
            holdPct: config.usageHoldPct,
            autoRelease: config.usageHoldAutoRelease,
          },
          Date.now(),
        );
      } catch (e) {
        console.warn("[held] release failed:", e);
      } finally {
        releasingHeld = false;
      }
    }),
    30_000,
  );
});

// calibrate the per-window caps daily (and once on startup) by scraping `/usage`.
// The `/usage` probe is a single ephemeral agent, so concurrent calls must never double-spawn it.
// `singleFlight` coalesces them onto one run AND — unlike the old early-return-stale guard — makes
// a manual refresh landing mid-scrape AWAIT that scrape's completed result instead of returning the
// stale pre-scrape snapshot (the "refresh looks fine but stays stale" bug).
const runCalibrate = async (): Promise<{ limits: UsageLimits; scraped: boolean }> => {
  if (maintenance.active) return { limits: usageLimits.limits(Date.now()), scraped: false };
  const now = Date.now();
  try {
    await accountIndex.refresh(now);
    await usageLimits.calibrate(now); // boolean ignored — emit/fresh keys off the scrape, not a cap-write
  } catch (err) {
    console.warn("[usage] calibration failed:", err);
  }
  // Emit on ANY usable frame (not just a cap-write) so a fresh scrape always pushes the updated
  // scrapedAt/stale to clients — even the degenerate "frame but nothing to write" case. Safe: the
  // 30s recompute tick already emits unconditionally and both usage:limits push consumers dedup.
  const scraped = usageLimits.lastScrapeAt === now;
  if (scraped) events.emit("usage:limits", usageLimits.limits(Date.now()));
  return { limits: usageLimits.limits(Date.now()), scraped };
};
const calibrate = singleFlight(runCalibrate);
// self-rescheduling so the cadence escalates while the weekly window nears its cap (keeping
// paid extra-credit spend fresh) and relaxes back to daily once it's clear of the cap.
const scheduleCalibrate = () => {
  setTimeout(
    () => {
      // `finally`, not a plain await-then-reschedule: a rejected calibrate (the `/usage` probe
      // can fail) must NOT kill the self-rescheduling loop and silently stop calibration forever.
      void calibrate()
        .catch((err) => console.warn("[usage] calibrate failed:", err))
        .finally(() => scheduleCalibrate());
    },
    calibrateDelay(usageLimits.limits(Date.now())),
  );
};
deferredStarts.push(() => {
  setTimeout(timerTask("usage", calibrate), 3_000);
  scheduleCalibrate();
});
const refreshUsage = () => calibrate();

// watch origin/main for new commits and push the result to clients; the badge in
// the UI keys off `behind > 0`, so it only appears when main has moved ahead.
const updates = new UpdateService();

// one-click restart of the shepherd unit (optionally herdr live-handoff first);
// self-guarded: refuses unless this process IS the systemd unit's activation.
const restart = new RestartService();
const checkUpdates = async () => events.emit("update:status", await updates.check(Date.now()));
setTimeout(timerTask("update", checkUpdates), 3_000);
setInterval(timerTask("update", checkUpdates), 5 * 60 * 1000);

// watch herdr.dev for a newer herdr release and surface an informational badge;
// unlike the git self-update this never auto-applies. Applying ends live agent
// panes (herdr update is destructive) but shepherd stays up — no restart, no 502.
// releases are rare, so a 6h cadence is plenty.
const herdrUpdates = new HerdrUpdateService({
  onLog: (line) => events.emit("herdr-update:log", { line }),
  // shepherd stays up now — push the recomputed status (clears the badge) and a
  // terminal ✓/✗ result the modal renders instead of waiting for a page reload.
  onStatus: (status) => events.emit("herdr-update:status", status),
  onDone: (result) => events.emit("herdr-update:done", result),
});
const checkHerdrUpdate = async () =>
  events.emit("herdr-update:status", await herdrUpdates.check(Date.now()));
setTimeout(timerTask("herdr-update", checkHerdrUpdate), 4_000);
setInterval(timerTask("herdr-update", checkHerdrUpdate), 6 * 60 * 60 * 1000);

// watch npm for a newer @openai/codex and surface the same informational badge as
// herdr. Unlike `herdr update`, `codex update` is non-destructive (running codex
// panes keep their loaded build), so apply() never interrupts a session. Codex (the
// agent runtime) ships frequently, but a 6h cadence — the same as herdr — is plenty
// for a badge the operator applies manually.
const codexUpdates = new CodexUpdateService({
  onLog: (line) => events.emit("codex-update:log", { line }),
  onStatus: (status) => events.emit("codex-update:status", status),
  onDone: (result) => events.emit("codex-update:done", result),
});
const checkCodexUpdate = async () =>
  events.emit("codex-update:status", await codexUpdates.check(Date.now()));
setTimeout(timerTask("codex-update", checkCodexUpdate), 5_000);
setInterval(timerTask("codex-update", checkCodexUpdate), 6 * 60 * 60 * 1000);

// watch installed plugins for a newer released version and surface an
// informational badge — READ-ONLY, no apply (mirrors the codex badge). Each
// check hits `git ls-remote`/`git fetch` per plugin with a declared repository
// or git checkout, so a gentle 30-min cadence is plenty; plugin releases are rare.
const pluginUpdates = new PluginUpdateService();
const checkPluginUpdates = async () =>
  events.emit("plugin-update:status", await pluginUpdates.check(Date.now()));
setTimeout(timerTask("plugin-update", checkPluginUpdates), 6_000);
setInterval(timerTask("plugin-update", checkPluginUpdates), 30 * 60 * 1000);

// environment-readiness diagnostics (issue #623): fan 7 dependency probes behind
// a TTL cache and push the snapshot to clients. Like the herdr-update check, a
// delayed boot kick + a 6h background re-check keep the UI's health pip live with
// no client polling — the request path otherwise reads the TTL snapshot.
const diagnostics = new DiagnosticsService({
  anyForgeRepo: () =>
    listRepos(config.repoRoot).some((r) => store.getRepoConfig(r.path).repoMode === "forge"),
  anyLightweightRepo: () =>
    listRepos(config.repoRoot).some((r) => store.getRepoConfig(r.path).repoMode === "lightweight"),
});
// Adaptive background re-check (NOT a fixed setInterval): each tick probes, pushes the
// snapshot, then re-arms itself with a delay chosen from that snapshot — 60s while the
// verdict is a hard `error` (so a transient herdr `offline` self-corrects within ~one
// recheck instead of staying pinned on the client, which only takes the push), else the
// 6h steady cadence. Bespoke wiring, not `timerTask`: that helper is fire-and-forget and
// discards the snapshot the delay depends on. CRITICAL: the next tick is armed in `finally`
// (on settle), never only on the success path — a thrown `check()` must not kill the loop
// and freeze diagnostics until restart. `check()` is designed never to reject (each probe
// resolves to its non-ok state), so the catch is defensive; on the off chance it throws we
// re-arm at the recheck cadence to retry soon rather than wait 6h.
const diagnosticsTick = async (): Promise<void> => {
  let delay = DIAGNOSTICS_RECHECK_INTERVAL_MS;
  try {
    const snapshot = await diagnostics.check(Date.now());
    events.emit("diagnostics:status", snapshot);
    delay = nextDiagnosticsDelay(
      snapshot.overall,
      DIAGNOSTICS_INTERVAL_MS,
      DIAGNOSTICS_RECHECK_INTERVAL_MS,
    );
  } catch (err) {
    console.warn("[diagnostics] tick failed:", err);
  } finally {
    setTimeout(() => void diagnosticsTick(), delay);
  }
};
setTimeout(() => void diagnosticsTick(), 4_000);

// forge resolution: detect a repo's GitHub/Gitea host from its `origin` remote.
// Per-host config (tokens, gitea base URLs) loads from config.forges (SHEPHERD_FORGES);
// github.com works through the operator's existing `gh` CLI auth, so an absent file is fine.
// async `gh` runner: lets CountsService fan out per-repo GraphQL counts in
// parallel (a blocking execFileSync would serialize them on the event loop,
// making the backlog load scale linearly with repo count).
const ghRunnerAsync = async (args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.toString();
  } catch (err) {
    // Detect GraphQL rate-limit errors and record them in the shared backoff
    // state so pollers can pause before the next request. The error is always
    // re-thrown so existing caller behaviour is unchanged.
    if (isGraphqlBucketCall(args) && isRateLimitError(err)) {
      graphRateLimit.noteLimitError(
        parseRetryAfter(String((err as Record<string, unknown>)?.stderr ?? "")),
      );
    }
    throw err;
  }
};
const backlog = new CountsService(config.forges, ghRunnerAsync, fetch, undefined, (dir) =>
  store.getRepoConfig(dir),
);

// gentle "star us on GitHub?" nudge — surfaces once the operator has used Shepherd
// for a few days, stars erwins-enkel/shepherd through their existing gh auth. The
// onChange push closes the prompt on every connected client the moment it's resolved.
const starPrompt = new StarPromptService({
  store,
  gh: ghRunnerAsync,
  onChange: (status) => events.emit("star-prompt:status", status),
});
// keep the backlog counts cache warm so the overview's first paint is instant
// instead of blocking on per-repo gh/Gitea calls. Warm shortly after boot, then
// on a cadence below the cache's 60s TTL so the request path always hits warm.
// After each warm, push the freshly-built overview to every connected client so
// a long-open dashboard's issue/PR counts stay live instead of frozen at the
// fetch-once snapshot the page loaded with. `counts` reads the just-warmed cache
// (no extra gh round-trip), so this is the same payload GET /api/backlog returns.
const broadcastBacklog = async () =>
  events.emit(
    "backlog:update",
    await buildBacklogPayload({
      counts: (p) => backlog.counts(p),
      resolveForge,
      lastUsedByRepo: () => store.lastUsedByRepo(),
      recentCountsByRepo: (since) => store.recentSessionCountsByRepo(since),
      hiddenRepoPaths: () => store.hiddenRepoPaths(),
      repoRoot: config.repoRoot,
    }),
  );
const backlogPoller = new BacklogPoller(
  () => listRepos(config.repoRoot),
  resolveForge,
  (dir) => backlog.refresh(dir),
  90_000,
  broadcastBacklog,
  // Warm the backlog only while a dashboard is open — REST fallbacks keep counts
  // useful even while the GraphQL bucket is exhausted.
  () => presence.hasClients(),
);
deferredStarts.push(() => {
  setTimeout(() => void backlogPoller.tick(), 3_000);
  backlogPoller.start();
});

// Up Next (#1169): cross-repo ranked queue of un-started work. In-memory snapshot kept warm
// by a 15-min background loop; reuses the drain's epic pipeline for ready-child gating and
// pushes each fresh snapshot to clients over the WS (upnext:snapshot).
const upNext = new UpNextService({
  // Forge-backed, non-hidden repos only. buildUpNextRepos owns forge-kind filtering,
  // the realpath→raw reconcile, hidden-repo filtering, and the exact field mapping.
  listForgeRepos: () =>
    buildUpNextRepos({
      repos: listRepos(config.repoRoot),
      resolveForge,
      hiddenRealPaths: store.hiddenRepoPaths(),
    }),
  resolveForge,
  lastUsedByRepo: () => store.lastUsedByRepo(),
  buildEpic: (repoPath, run) => drain.buildEpic(repoPath, run),
  getEpicRun: (repoPath) => store.getEpicRun(repoPath),
  onChange: (snapshot) => events.emit("upnext:snapshot", { snapshot }),
});
deferredStarts.push(() => {
  upNext.start();
});

const appDeps: AppDeps = {
  store,
  service,
  telemetry,
  learnings: learningsSvc,
  repoConfig: repoConfigSvc,
  events,
  pluginRegistry,
  pluginsDir: config.pluginsDir,
  usageLimits,
  usageRollup,
  refreshUsage,
  // Live GitHub REST + GraphQL buckets for the usage view. `gh api rate_limit`
  // is quota-exempt, so it works even when the GraphQL bucket is at zero.
  githubRateLimit: () => fetchGithubRateLimit(ghRunnerAsync),
  updates,
  restart,
  herdrUpdates,
  codexUpdates,
  pluginUpdates,
  diagnostics,
  starPrompt,
  herdr,
  herdrSocketActive,
  resolveForge,
  prCache: prPoller,
  ownsPr,
  activity: { snapshot: () => poller.activitySnapshot() },
  blocks: { snapshot: () => poller.blockSnapshot() },
  claudeAlive: { snapshot: () => poller.claudeAliveSnapshot() },
  workingBlocked: { snapshot: () => poller.workingBlockedSnapshot() },
  preview: { snapshot: () => previewService.snapshot() },
  previewServe: { snapshot: () => tailscaleServe.snapshot() },
  push,
  presence,
  poller,
  hooks: hookIngest,
  reviewCache: {
    snapshot: () => reviewService.snapshot(),
    reviewing: () => reviewService.reviewingIds(),
  },
  planGateCache: {
    snapshot: () => planGate.snapshot(),
    reviewing: () => planGate.reviewingIds(),
  },
  planGate: {
    consider: (s, opts) => planGate.consider(s, opts),
    resume: (s) => planGate.resume(s),
    dismiss: (s) => planGate.dismiss(s),
  },
  reviewTrigger: {
    force: (s, g) => reviewService.forceReview(s, g),
    clearStallState: (s) => reviewService.clearStallState(s),
  },
  recapCache: { snapshot: () => recapService.snapshot() },
  recap: { regenerate: (s) => recapService.regenerate(s) },
  herdDigest: {
    snapshot: () => herdDigestService.snapshot(),
    currentFingerprint: () => herdDigestService.currentAttentionFingerprint(),
    regenerate: () => herdDigestService.regenerate(),
  },
  upNext: {
    snapshot: () => upNext.snapshot(),
    refresh: () => upNext.refresh(),
    recomputeUntilCleared: (started) => upNext.recomputeUntilCleared(started),
    hiddenRepoPathsRaw: () =>
      reconcileRealPathsToRaw(store.hiddenRepoPaths(), listRepos(config.repoRoot)),
  },
  verifyKey: () => verifyApiKey({ herdr }),
  backlog,
  openPrSnapshot,
  // After a backlog merge, force-refresh the repo's counts past the read-TTL and
  // re-broadcast the overview so the merged PR (and any auto-closed linked issue)
  // leaves the counters + headline at once, not on the next ~45s warm tick.
  //
  // `dir` is safeRepoDir's realpath-resolved form, but the warmer +
  // buildBacklogPayload key the counts cache by listRepos' raw join(repoRoot,
  // name) path. Under a symlinked repoRoot/repo those diverge, so refreshing by
  // `dir` would write a phantom key and the broadcast would re-read stale counts.
  // Match the repo back to its listRepos entry by realpath and refresh that exact
  // key (falling back to `dir` for a repo not under the enumerated root).
  //
  // Opportunistic: CountsService.load single-flights, so this refresh can
  // piggyback on an in-flight pre-merge warm fetch and broadcast slightly stale
  // counts; the next warm tick reconciles. Acceptable for a freshness nudge.
  refreshBacklog: async (dir) => {
    await backlog.refresh(listReposPathForReal(dir, config.repoRoot));
    await broadcastBacklog();
  },
  distiller,
  optimizer,
  mergeSuggest: { mergeNow: (repoPath) => mergeSuggest.mergeNow(repoPath) },
  promoter,
  docAgent: {
    consider: (repoPath: string) => docAgent.consider(repoPath),
    isRunning: (repoPath: string) => docAgent.isRunning(repoPath),
  },
  gitignoreAdopter,
  drain: {
    snapshot: () => drain.snapshot(),
    queue: (repoPath) => drain.queue(repoPath),
    retainClaim: (id) => drain.retainClaim(id),
    buildEpic: (repoPath, run) => drain.buildEpic(repoPath, run),
    diagnoseEpic: (repoPath, run) => drain.diagnoseEpic(repoPath, run),
    approveEpicNext: (repoPath) => drain.approveEpicNext(repoPath),
    tick: () => drain.tick(),
  },
  autoMerge: { snapshot: () => autoMerge.snapshot() },
  holds: { snapshot: () => holdService.snapshot() },
  // Read the source session's recent terminal history off its live pane and hand it to a
  // transient second agent for a next-prompt recommendation. The menu offers this on every
  // session, so a dead/unknown pane (no live terminal to read) is expected here → "no-history",
  // which the RecommendDialog surfaces as a distinct error rather than a silent failure.
  recommend: async (id, provider, model) => {
    const s = store.get(id);
    if (!s) return { error: "no-history" as const };
    const live = matchAgent(s, herdr.list());
    if (!live) return { error: "no-history" as const };
    let tail: string[];
    try {
      tail = tailLines(herdr.read(live.terminalId, "recent", 600), 600);
    } catch {
      return { error: "no-history" as const };
    }
    return recommendPrompt(
      {
        tail,
        taskPrompt: s.prompt,
        provider,
        model,
        label: `recommend ${s.desig}`,
        // Live per-call read at the composition root (#1586).
        operatorLanguage: config.operatorLanguage,
      },
      { herdr },
    );
  },
};

// Load server-side plugins ONCE, now that every core service exists — and before the
// server accepts requests, so a spawn can never race an unfinished registry. A missing/
// empty plugins dir is a clean no-op (the zero-plugin invariant).
await pluginRegistry.loadAll();
const loadedPlugins = pluginRegistry.list();
if (loadedPlugins.length > 0) {
  // "loaded" counts only plugins that actually registered (health ok); apiVersion
  // mismatches / register() failures are recorded for the panel but reported separately.
  const ok = loadedPlugins.filter((p) => p.health === "ok").length;
  const failed = loadedPlugins.length - ok;
  console.log(`[plugins] ${ok} plugin(s) loaded${failed > 0 ? `, ${failed} failed/skipped` : ""}`);
}

const server = serve(appDeps, config.port);
console.log(`shepherd core on http://localhost:${server.port}`);

// One-time gap-fill of pre-existing archived sessions into session_usage (#965).
// Fire-and-forget: async JSONL reads yield the event loop; never awaited at boot.
deferredStarts.push(() => {
  void runSessionUsageBackfill(store);
});

// Restricted agent-ingress listener: the autonomous netns's ONLY reachable control-plane surface.
// Bound to loopback on an ephemeral port; slirp maps the netns's 10.0.2.2 → host 127.0.0.1. Started
// with the SAME AppDeps as the main listener so delegated routes hit the real handlers (auth + origin
// preserved). The lazy `agentIngressPort` accessor wired into SessionService reads `.port` below.
const agentIngress = serveAgentIngress(appDeps, config.agentIngressPort);
agentIngressState.port = agentIngress.port;
console.log(`shepherd agent-ingress on http://127.0.0.1:${agentIngress.port}`);

// First-run gate: on an already-onboarded boot, start every deferred background subsystem now.
// On a fresh install (firstRun.pending) stay inert — the server serves only the onboarding UI —
// and register startBackground to fire off-thread when server.ts resolves the first root-pick.
deferredStarts.push(() => {
  telemetry.event("app_launched");
});
if (firstRun.pending) firstRun.onResolve(startBackground);
else startBackground();

// Best-effort teardown of preview listeners and tailscale mappings on process exit / SIGTERM.
process.on("exit", () => {
  previewService.stopAll();
  tailscaleServe.stopAll();
  standaloneCritic.stopAll();
  pluginRegistry.teardown(); // best-effort plugin teardown (also covers the SIGTERM path)
});
// Registering ANY SIGTERM handler overrides Bun's default terminate-on-signal, so we
// must exit explicitly — otherwise `systemctl stop/restart shepherd` hangs until the
// stop-timeout SIGKILL. Tear down, then exit (the `exit` handler's second stopAll is a
// no-op since stopAll is idempotent).
process.on("SIGTERM", () => {
  previewService.stopAll();
  tailscaleServe.stopAll();
  standaloneCritic.stopAll();
  process.exit(0);
});

// Consolidated operator-credentials banner — emitted LAST (after both listeners are up) so it's
// the final, prominent boot output instead of scrolling away mid-boot. bootstrapAuth already
// formatted it (box + the one-time password) and handed it over via the log callback above; we
// only print the buffered text plus the URL to reach it. Fires only when this boot GENERATED a
// password (no SHEPHERD_PASSWORD and no persisted hash); shows it exactly once.
if (credentialBanner) {
  console.log(credentialBanner);
  console.log(`  Open Shepherd at  http://localhost:${config.port}\n`);
}
