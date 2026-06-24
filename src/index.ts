import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
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
  parseServedPort,
  validatePreviewPortRange,
} from "./config";
import { SessionStore } from "./store";
import type {
  Session,
  SessionPreviewEvent,
  SessionPreviewServeEvent,
  RundownEpicItem,
} from "./types";
import { WorktreeMgr } from "./worktree";
import { HerdrDriver, matchAgent } from "./herdr";
import { generateName } from "./namer";
import { llmName } from "./namer-llm";
import { EventHub } from "./events";
import { SessionService } from "./service";
import { StatusPoller } from "./poller";
import { PrPoller } from "./pr-poller";
import { BranchPruner } from "./branch-pruner";
import { reconcile } from "./reconcile";
import { reapOrphanTabs, reapStaleReviewWorktrees } from "./tab-reaper";
import { scanClaudeAliveByWorktree } from "./process-reaper";
import { serve, serveAgentIngress, buildBacklogPayload, type AppDeps } from "./server";
import { makeProductionForgeResolver } from "./forge/resolve";
import { EmptyDiffError, type GitState } from "./forge/types";
import { parseManualSteps } from "./manual-steps";
import { annotateHandoff } from "./repo-roles";
import { AccountUsageIndex, SessionUsageRollup } from "./usage";
import { UsageLimitsService, calibrateDelay, type UsageLimits } from "./usage-limits";
import { singleFlight } from "./single-flight";
import { HerdrUsageProbe } from "./usage-probe";
import { sweepStaging, STAGING_TTL_MS } from "./uploads";
import { validateRoot } from "./dirs";
import { UpdateService } from "./update";
import { HerdrUpdateService } from "./herdr-update";
import { DiagnosticsService } from "./diagnostics";
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
import { PlanGateService } from "./plan-gate";
import { AutopilotService } from "./autopilot";
import { DrainService } from "./drain";
import { AutoMergeService } from "./automerge";
import { DraftReconcileService } from "./draft-reconcile";
import { isFullAuto } from "./full-auto";
import { classifyStop } from "./autopilot-llm";
import { tailLines } from "./blocked";
import { CountsService } from "./backlog";
import { BacklogPoller } from "./backlog-poller";
import { ProcessReaper } from "./process-reaper";
import { sweepClaudeTmp, compileCacheDir, reapFallowCaches, pruneRepoWorktrees } from "./tmp-sweep";
import { runSessionUsageBackfill } from "./usage-backfill";
import { PreviewService } from "./preview";
import { listRepos, listReposPathForReal } from "./repos";
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
import { startLoopLagSampler, logRemainingOnLoopBlockers } from "./instrument";
import { resolveNodeHost, TailscaleServeService } from "./tailscale";
import { normalizeDefaultModelSetting, normalizeFableAvailable } from "./default-model";
import { normalizeAuthModeSetting } from "./auth-mode";
import { EgressWatcher } from "./egress-watch";
import { detectEgressHostLoopback } from "./egress";
import { RecapService } from "./recap";
import { PostMergeStepsService } from "./post-merge-steps";
import { BuildQueueReminderService } from "./build-queue-reminder";
import { HerdDigestService } from "./herd-digest";
import { readSnapshot, isStalled, DEFAULT_STALL } from "./stall";
import { jsonlPathFor } from "./usage";
import { verifyApiKey } from "./verify-key";
import { releaseHeldTasks } from "./held-release";
import { snapshotSessionUsage } from "./usage-snapshot";
import { hasCommittedChanges } from "./diff";
import { HoldReasonService } from "./hold-service";

const execFileAsync = promisify(execFile);

startLoopLagSampler(); // no-op unless SHEPHERD_PROFILE_LOOP=1
logRemainingOnLoopBlockers(); // one-time operator map of intentionally-sync calls

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
const savedUhp = store.getSetting("usageHoldPct");
if (savedUhp !== null) {
  const n = Number(savedUhp);
  if (Number.isFinite(n)) config.usageHoldPct = Math.min(100, Math.max(0, Math.floor(n)));
}

// ── preview port range startup validation (hard-fail) ──────────────────────
// Discover the public served port by parsing `tailscale serve status`; default
// to 443 when tailscale is unavailable or the mapping isn't found. The parser
// is pure and injected here so it's testable without tailscale.
// Also resolve this node's tailnet hostname for split-front preview URL construction.
{
  let servedPort = 443;
  try {
    const { stdout } = await execFileAsync("tailscale", ["serve", "status"], { timeout: 5000 });
    const parsed = parseServedPort(stdout, config.port);
    if (parsed !== null) servedPort = parsed;
  } catch {
    // tailscale not available or not set up — default to 443
  }
  // Resolve the node's own tailnet hostname (null when tailscale is absent).
  config.previewHost = await resolveNodeHost();
  validatePreviewPortRange({
    previewPortBase: config.previewPortBase,
    previewPortCount: config.previewPortCount,
    localPort: config.port,
    servedPort,
  });
  if (config.previewAutoServe && !config.previewHost) {
    console.warn(
      "[preview] dynamic tailscale serve registration is enabled but the node's tailnet host could not be resolved (is tailscale running?); previews won't be tailnet-reachable.",
    );
  }
}

// drop abandoned staged uploads (New-Task or relaunch carry, never submitted) past the TTL
sweepStaging(config.repoRoot, STAGING_TTL_MS, Date.now());
const herdr = new HerdrDriver();
const worktree = new WorktreeMgr();
const events = new EventHub();
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

// Session recap (#XXX): generates a plain-language summary of each settled-idle session
// so the operator can skim what happened without reading the transcript. Mirrors planGate's
// deps/onChange wiring; model defaults to "sonnet" inside the service. Constructed BEFORE
// SessionService so its pre-teardown hook (beforeArchive) can be wired into the service.
const recapService = new RecapService({
  store,
  herdr,
  onChange: (id, recap) => events.emit("session:recap", { id, recap }),
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

const service = new SessionService({
  store,
  worktree,
  herdr,
  resolveForge,
  agentIngressPort: () => agentIngressState.port,
  detectEgressHostLoopback,
  namer: generateName,
  refineName: config.llmNaming
    ? ({ taskText, label }) => llmName(taskText, { herdr, model: config.namerModel }, label)
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
});

// Build-queue reconciliation nudge: settled-idle backstop to the forward-fill cascade in
// store.setBuildStepStatus. Steers a drifted, settled-idle session to post its progress.
const buildQueueReminder = new BuildQueueReminderService({
  store,
  steer: (id, text) => service.reply(id, text),
});

const accountIndex = new AccountUsageIndex();
const usageRollup = new SessionUsageRollup();
const usageLimits = new UsageLimitsService(accountIndex, store, new HerdrUsageProbe(herdr), store);

reconcile(store, herdr);

// Reconcile orphaned per-session egress temp dirs (config + dns.log) from sessions
// whose teardown removal was missed across a crash/restart. Live sessions' dirs are
// preserved. Best-effort — never throws.
try {
  service.sweepEgressTmp();
} catch (err) {
  console.warn("[egress] startup temp-dir sweep failed:", err);
}

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
            `[tmp-sweep] ${phase}: fallow reap removed ${removed}, worktree prune pruned ${pruned}${failed ? `, failed ${failed}` : ""}`,
          );
        },
      ),
    )
    .catch((err) => console.warn(`[tmp-sweep] ${phase} fallow/prune failed:`, err));
};

fireTmpSweep("boot");

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
setTimeout(sweepOrphanTabs, 5_000);
setTimeout(sweepOrphanTabs, 45_000);
setInterval(sweepOrphanTabs, 60 * 60 * 1000);

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
  (id, status) => events.emit("session:status", { id, status }),
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
void tailscaleServe
  .reconcileStartup()
  .catch((err) => console.warn("[tailscale-serve] startup reconcile failed:", err));
poller.start();

// background Web Push: turn F3 state events into notifications for subscribed devices.
// Suppress while any window is actively in use — clients report focus/visibility
// over /events into `presence`, and the push gate reads it.
const presence = new Presence();
const push = new PushService(store, undefined, undefined, undefined, () => presence.isActive());
attachPush(events, store, push);

// poll PR status for active sessions every 120s; push session:git on change so
// the list overview badges stay current without opening each session's detail.
// reject a merged/closed PR that `gh pr list --head <name>` matched only by a
// reused branch name — its head commit won't be reachable from this branch's tip.
// Shared by the background poller and the on-demand git endpoint so they agree.
const ownsPr = (s: Session, headSha: string) => worktree.containsCommit(s.worktreePath, headSha);
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
  undefined,
  ownsPr,
);
setTimeout(() => void prPoller.tick(), 3_000); // warm the cache shortly after boot
prPoller.start();
// when an agent settles (finished a turn / paused) it has most likely just run
// `gh pr create`; poll that one session right away so the badge shows the PR
// number within seconds instead of on the next full sweep.
events.subscribe((event, data) => {
  if (event !== "session:status") return;
  const { id, status } = data as { id: string; status: string };
  if (status !== "running") prPoller.pollSession(id);
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
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: GitState };
  if (git.number == null || (git.state !== "open" && git.state !== "merged")) return;
  const headSha = git.headSha ?? "";
  if (manualStepsHeadSeen.get(id) === headSha) return; // unchanged head — skip the fetch
  manualStepsHeadSeen.set(id, headSha);
  void detectAndPersistManualSteps(id, git.number);
});

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
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: import("./forge/types").GitState };
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
setInterval(() => service.sweepStaleMerging(), 60_000);

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
setTimeout(() => void branchPruner.tick(), 30_000); // first sweep shortly after boot
branchPruner.start();

// PR-gated AI doc agent (issue #882, epic #875 Phase 3). Opt-in, default-off
// (config.docAgentEnabled / SHEPHERD_DOC_AGENT). Manual trigger only; the boot orphan-sweep +
// 15s finalize tick below are gated on the flag so the feature is fully inert when off.
const docAgent = new DocAgentService({
  herdr,
  worktree,
  resolveForge,
  repos: () => listRepos(config.repoRoot).map((r) => r.path),
  store,
  gitState: (id) => prPoller.get(id),
  nightlyHour: config.docAgentNightlyHour,
  model: config.docAgentModel,
  act: config.docAgentAct,
  onChange: (f) => events.emit("doc-agent:done", f),
});
if (config.docAgentEnabled) {
  // Boot reconcile: re-adopt a finished/in-progress interrupted run (its SENTINEL edits are the
  // deliverable), prune dead ones + husk tabs + dangling cost rows, and reap orphan remote
  // docs-update-* branches with no PR. Best-effort (not awaited): the per-repo `starting` claim is
  // the load-bearing double-spawn guard, and a merged trigger lost during this brief reconcile
  // window is recovered by the nightly catch-all. Works even if the herdr daemon also restarted.
  void docAgent.reapOrphans().catch((err) => console.warn("[doc-agent] reapOrphans:", err));
}

const reviewService = new ReviewService({
  store,
  herdr,
  worktree,
  resolveForge,
  onChange: (id, verdict) => events.emit("session:review", { id, review: verdict }),
  onReviewing: (id, reviewing) => events.emit("session:reviewing", { id, reviewing }),
  onActivity: (id, summary) => events.emit("session:critic-activity", { id, summary }),
  // auto-address: steer critic findings straight into the task agent's PTY (same path
  // as a human "send review to agent"). Gated per-repo by autoAddressEnabled; the
  // round cap below stops it ping-ponging forever.
  autoAddress: (id, text) => service.reply(id, text),
  // global, UI-configurable max auto-address rounds before escalating to the human.
  // A thunk so a settings change takes effect on the next critic run, no restart.
  cap: () => config.prReviewCyclesCap,
});

// Standalone repo-level PR critic (#596): the session-LESS twin of reviewService.
// Where reviewService reacts to a managed session's PR, this enumerates EVERY open,
// CI-green PR in a `criticAllPrs` repo (human PRs, other agents', forks) on a timer and
// posts comment-only reviews. Shares reviewService's primitives + model source (no
// `model` → the critic's own default); concurrency/timeout stay at service defaults.
const standaloneCritic = new StandalonePrCriticService({
  store,
  herdr,
  worktree,
  resolveForge,
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
  reply: (id, text) => service.reply(id, text),
  release: (id) => service.releasePlanGate(id),
  onChange: (id, gate) => events.emit("session:plangate", { id, gate }),
  onReviewing: (id, reviewing) => events.emit("session:plangate-reviewing", { id, reviewing }),
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
readyNotifier.start();
// drive the critic off PR-state changes: open + CI green + unreviewed head → review
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: import("./forge/types").GitState };
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
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: import("./forge/types").GitState };
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
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: import("./forge/types").GitState };
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
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: GitState };
  if (git.state !== "merged") return;
  const s = store.get(id);
  if (!s) return;
  void postMergeSteps
    .onMerged(s, git.number ?? null, git.title ?? "")
    .catch((err) => console.warn("[post-merge-steps] onMerged failed:", err));
});
setInterval(() => {
  if (maintenance.active) return;
  void reviewService.tick();
  void planGate.tick();
  void standaloneCritic.tick();
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
  try {
    buildQueueReminder.sweep(); // settled-idle nudge for a drifted build queue (sync)
  } catch (err) {
    console.warn("[build-queue] reminder sweep failed:", err);
  }
}, 15_000);
// The standalone critic's enumeration runs on its OWN 60s timer, separate from the 15s
// finalize tick above: a sweep lists every open PR per repo (a forge round-trip), far
// heavier than reading verdict files, so it polls coarsely while verdicts still finalize
// promptly on the shared 15s tick.
setInterval(() => {
  if (maintenance.active) return;
  void standaloneCritic.sweep();
}, 60_000);
// archived sessions: reap any in-flight critic + drop the verdict, and reap any
// in-flight plan reviewer + drop its gate (forget() does both).
events.subscribe((event, data) => {
  if (event === "session:archived") {
    const id = (data as { id: string }).id;
    reviewService.forget(id);
    planGate.forget(id);
    recapService.onArchived(id);
    buildQueueReminder.forget(id);
    docAgent.onArchived(id);
  }
});

// Autopilot: the pre-PR twin of the critic's auto-address loop. When an autopilot-enabled
// session (per-repo default + per-session override) stalls on a procedural gate with no PR
// yet, a transient classifier decides gate (auto-proceed) / question (surface) / finished
// (drive to a PR). Genuine questions pause the session loudly (distinct state + push).
const autopilot = new AutopilotService({
  store,
  classify: (tail, taskPrompt, label) =>
    classifyStop(tail, taskPrompt, { herdr, model: config.autopilotModel }, label),
  steer: (id, text) => service.reply(id, text),
  resume: (id) => service.resume(id),
  paneAlive: (id) => {
    const s = store.get(id);
    return !!s && matchAgent(s, herdr.list()) !== null;
  },
  readTail: (id) => {
    const s = store.get(id);
    if (!s) return [];
    const live = matchAgent(s, herdr.list());
    return live ? tailLines(herdr.read(live.terminalId, "visible")) : [];
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

// Drive autopilot off the same poller events the rest of the system already emits.
events.subscribe((event, data) => {
  if (event === "session:block") {
    const { id, block } = data as { id: string; block: import("./blocked").BlockReason | null };
    void autopilot.onBlock(id, block).catch((err) => console.warn("[autopilot] onBlock:", err));
  } else if (event === "session:status") {
    const { id, status } = data as { id: string; status: string };
    autopilot.onStatus(id, status); // clears a pause when the operator replies
    if (status === "done") {
      void autopilot.onDone(id).catch((err) => console.warn("[autopilot] onDone:", err));
      // A planning-phase session that just settled has likely finished writing
      // `.shepherd-plan.md` — kick off the adversarial plan review (no-op unless it's
      // in the planning phase with a fresh, un-reviewed plan).
      const sess = store.get(id);
      if (sess?.planPhase === "planning")
        void planGate.consider(sess).catch((err) => console.warn("[plan-gate] consider:", err));
    }
  } else if (event === "session:git") {
    const { id, git } = data as { id: string; git: import("./forge/types").GitState };
    // PR-open handoff to the critic loop AND red-CI recovery (the critic skips a red PR, so
    // autopilot drives the agent to fix its own failing checks).
    autopilot.onGit(id, git);
  }
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
  emitSessionNew: (s) => events.emit("session:new", s),
});

// Drive the drain off the poller events the rest of the system already emits.
events.subscribe((event, data) => {
  if (event === "session:git") {
    const { id, git } = data as { id: string; git: import("./forge/types").GitState };
    void drain.onGit(id, git).catch((err) => console.warn("[drain] onGit:", err));
  } else if (event === "session:status") {
    const { id } = data as { id: string };
    void drain.onStatus(id).catch((err) => console.warn("[drain] onStatus:", err));
  } else if (event === "session:archived") {
    const { id } = data as { id: string };
    void drain.onArchived(id).catch((err) => console.warn("[drain] onArchived:", err));
  } else if (event === "session:review") {
    const { id } = data as { id: string };
    void drain.onReview(id).catch((err) => console.warn("[drain] onReview:", err));
  }
});
// Slow sweep: catch newly-labeled issues and resumed-usage windows (~30s).
setInterval(() => {
  if (maintenance.active) return;
  void drain.tick().catch((err) => console.warn("[drain] tick:", err));
}, 30_000);

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
  repos: () => listRepos(config.repoRoot).map((r) => r.path),
  emitStatus: (status) => events.emit("automerge:status", status),
  emitArchived: (id) => events.emit("session:archived", { id }),
  dropPrCache: (id) => prPoller.drop(id),
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
setInterval(() => {
  if (maintenance.active) return;
  void autoMerge.tick().catch((err) => console.warn("[automerge] tick:", err));
}, 30_000);
// Re-engage idle full-auto sessions stuck on an open+red PR. A timer is the one trigger that
// re-fires on an UNCHANGED red head (the PR poller emits no `session:git` without a state change),
// so this owns the sustained re-engagement that onGit/considerCi structurally cannot deliver.
setInterval(() => {
  if (maintenance.active) return;
  void autopilot.tick().catch((err) => console.warn("[autopilot] tick:", err));
}, 30_000);

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
  // Cache key = the set of open epics. A change (one landed, or a new one opened) busts the cache so
  // the panel never shows an already-landed "land this epic"; the TTL only throttles re-probing the
  // forge when the SAME set's CI-readiness might have flipped.
  const key = openRows
    .map((r) => `${r.repoPath}#${r.parentIssueNumber}`)
    .sort()
    .join(",");
  if (epicReadyCache && epicReadyCache.key === key && now - epicReadyCache.ts < EPIC_READY_TTL_MS)
    return epicReadyCache.val;
  const epics: CompletedEpic[] = openRows.map(({ childrenJson, landingAttempts, ...rest }) => {
    void landingAttempts;
    return { ...rest, children: JSON.parse(childrenJson) as CompletedEpic["children"] };
  });
  await enrichLandingEpics(epics, {
    getEpicIntegrationBranch: (repoPath, parent) =>
      store.getEpicIntegrationBranch(repoPath, parent),
    resolveForge: (repoPath) => resolveForge(repoPath),
    now,
  });
  const val: RundownEpicItem[] = epics
    .filter((e) => e.landingState === "open" && e.landingReady === true)
    .map((e) => ({
      repo: e.repoPath,
      parent: e.parentIssueNumber,
      title: e.parentTitle,
      landingPr: e.landingPrNumber,
      stranded: e.landingStranded === true,
    }));
  epicReadyCache = { key, ts: now, val };
  return val;
};

const herdDigestService = new HerdDigestService({
  store,
  herdr,
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
      const snap = readSnapshot(jsonlPathFor(s.worktreePath, s.claudeSessionId));
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
setInterval(() => {
  if (maintenance.active) return;
  void draftReconcile.tick().catch((err) => console.warn("[draft-reconcile] tick:", err));
}, 30_000);
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
  onChange: () => events.emit("learnings:update", { pending: store.pendingLearningCount() }),
});
setInterval(() => {
  if (maintenance.active) return;
  void distiller.tick();
}, 30_000);
const promoter = new Promoter({ store, worktree, resolveForge });
const optimizer = new OptimizerService({
  store,
  herdr,
  scratch: defaultOptimizerScratch,
  promoter,
  onChange: () => events.emit("learnings:update", { pending: store.pendingLearningCount() }),
});
setInterval(() => {
  if (maintenance.active) return;
  void optimizer.tick();
}, 30_000);
// Phase 4: background merge-suggestion pass (off the hot path). consider/considerCrossRepo
// run from the daily sweep (synchronous, non-blocking — they enqueue a detached spawn);
// the 30s tick reaps finished/timed-out runs.
const mergeSuggest = new MergeSuggestionService({
  store,
  herdr,
  scratch: defaultMergeScratch,
  onChange: () => events.emit("learnings:update", { pending: store.pendingLearningCount() }),
});
setInterval(() => {
  if (maintenance.active) return;
  void mergeSuggest.tick();
}, 30_000);
const gitignoreAdopter = new GitignoreAdopter({ worktree, resolveForge });
// Daily: prune archived sessions, prune old signals, then consider a distill per repo
// with enough recent signal.
const runDailySweep = () => {
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
  for (const repo of listRepos(config.repoRoot)) distiller.consider(repo.path);
  // Phase 4 merge suggestions: per-repo near-duplicate clustering (intra) + a single global
  // cross-repo recurrence pass. Both no-op unless the active set is large enough AND changed
  // since the last pass, and each only enqueues (never awaited here).
  for (const repo of listRepos(config.repoRoot)) mergeSuggest.consider(repo.path);
  mergeSuggest.considerCrossRepo();
  store.pruneOrphanMergeSuggestions();
  // Auto-retire: soft-retire active rules whose Wilson-bounded help-rate is below the
  // repo base rate (gated on real harm evidence). Returns the retired set so we only
  // nudge clients (banner refresh) when something actually changed.
  const retired = runAutoRetire({ store, optimizer });
  if (retired.length > 0) {
    events.emit("learnings:update", { pending: store.pendingLearningCount() });
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
    events.emit("learnings:update", { pending: store.pendingLearningCount() });
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
  fireTmpSweep("daily");
};
setTimeout(runDailySweep, 10_000); // once shortly after boot
setInterval(runDailySweep, 24 * 60 * 60 * 1000);

// recompute live limit % from local JSONL ~every 30s; push to clients
attachUsagePush(events, store, push);
attachCreditsPush(events, store, push);
// Re-entrancy guard: a release can still be awaiting service.create() when the next
// 30s tick fires; without this a second tick re-reads the not-yet-removed head task and
// double-spawns it (or errors with agent_name_taken). Mirrors the `calibrating` flag below.
let releasingHeld = false;
setInterval(async () => {
  await accountIndex.refresh(Date.now());
  events.emit("usage:limits", usageLimits.limits(Date.now()));
  if (releasingHeld) return; // prior release still draining — skip this tick's release
  releasingHeld = true;
  try {
    await releaseHeldTasks(
      { store, service, usageLimits, events, resolveForge },
      { enabled: config.usageHoldEnabled, holdPct: config.usageHoldPct },
      Date.now(),
    );
  } catch (e) {
    console.warn("[held] release failed:", e);
  } finally {
    releasingHeld = false;
  }
}, 30_000);

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
setTimeout(calibrate, 3_000);
// self-rescheduling so the cadence escalates while the weekly window nears its cap (keeping
// paid extra-credit spend fresh) and relaxes back to daily once it's clear of the cap.
const scheduleCalibrate = () => {
  setTimeout(
    async () => {
      await calibrate();
      scheduleCalibrate();
    },
    calibrateDelay(usageLimits.limits(Date.now())),
  );
};
scheduleCalibrate();
const refreshUsage = () => calibrate();

// watch origin/main for new commits and push the result to clients; the badge in
// the UI keys off `behind > 0`, so it only appears when main has moved ahead.
const updates = new UpdateService();
const checkUpdates = async () => events.emit("update:status", await updates.check(Date.now()));
setTimeout(checkUpdates, 3_000);
setInterval(checkUpdates, 5 * 60 * 1000);

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
setTimeout(checkHerdrUpdate, 4_000);
setInterval(checkHerdrUpdate, 6 * 60 * 60 * 1000);

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
const checkDiagnostics = async () =>
  events.emit("diagnostics:status", await diagnostics.check(Date.now()));
setTimeout(checkDiagnostics, 4_000);
setInterval(checkDiagnostics, 6 * 60 * 60 * 1000);

// forge resolution: detect a repo's GitHub/Gitea host from its `origin` remote.
// Per-host config (tokens, gitea base URLs) loads from config.forges (SHEPHERD_FORGES);
// github.com works through the operator's existing `gh` CLI auth, so an absent file is fine.
// async `gh` runner: lets CountsService fan out per-repo GraphQL counts in
// parallel (a blocking execFileSync would serialize them on the event loop,
// making the backlog load scale linearly with repo count).
const ghRunnerAsync = async (args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.toString();
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
      repoRoot: config.repoRoot,
    }),
  );
const backlogPoller = new BacklogPoller(
  () => listRepos(config.repoRoot),
  resolveForge,
  (dir) => backlog.refresh(dir),
  45_000,
  broadcastBacklog,
);
setTimeout(() => void backlogPoller.tick(), 3_000);
backlogPoller.start();

const appDeps: AppDeps = {
  store,
  service,
  events,
  usageLimits,
  usageRollup,
  refreshUsage,
  updates,
  herdrUpdates,
  diagnostics,
  starPrompt,
  herdr,
  resolveForge,
  prCache: prPoller,
  ownsPr,
  activity: { snapshot: () => poller.activitySnapshot() },
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
    consider: (s) => planGate.consider(s),
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
  verifyKey: () => verifyApiKey({ herdr }),
  backlog,
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
    approveEpicNext: (repoPath) => drain.approveEpicNext(repoPath),
    tick: () => drain.tick(),
  },
  autoMerge: { snapshot: () => autoMerge.snapshot() },
  holds: { snapshot: () => holdService.snapshot() },
};
const server = serve(appDeps, config.port);
console.log(`shepherd core on http://localhost:${server.port}`);

// One-time gap-fill of pre-existing archived sessions into session_usage (#965).
// Fire-and-forget: async JSONL reads yield the event loop; never awaited at boot.
void runSessionUsageBackfill(store);

// Restricted agent-ingress listener: the autonomous netns's ONLY reachable control-plane surface.
// Bound to loopback on an ephemeral port; slirp maps the netns's 10.0.2.2 → host 127.0.0.1. Started
// with the SAME AppDeps as the main listener so delegated routes hit the real handlers (auth + origin
// preserved). The lazy `agentIngressPort` accessor wired into SessionService reads `.port` below.
const agentIngress = serveAgentIngress(appDeps);
agentIngressState.port = agentIngress.port;
console.log(`shepherd agent-ingress on http://127.0.0.1:${agentIngress.port}`);

// Best-effort teardown of preview listeners and tailscale mappings on process exit / SIGTERM.
process.on("exit", () => {
  previewService.stopAll();
  tailscaleServe.stopAll();
  standaloneCritic.stopAll();
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
