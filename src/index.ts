import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  config,
  SESSION_RETENTION_MS,
  SESSION_RETENTION_KEEP,
  clampCap,
  PR_REVIEW_CYCLES_MIN,
  PR_REVIEW_CYCLES_MAX,
  PLAN_REVIEW_CYCLES_MIN,
  PLAN_REVIEW_CYCLES_MAX,
  parseServedPort,
  validatePreviewPortRange,
} from "./config";
import { SessionStore } from "./store";
import type { Session, SessionPreviewEvent, SessionPreviewServeEvent } from "./types";
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
import { reapOrphanTabs } from "./tab-reaper";
import { serve, buildBacklogPayload } from "./server";
import { detectForge } from "./forge";
import { AccountUsageIndex } from "./usage";
import { UsageLimitsService } from "./usage-limits";
import { HerdrUsageProbe } from "./usage-probe";
import { sweepStaging } from "./uploads";
import { validateRoot } from "./dirs";
import { UpdateService } from "./update";
import { HerdrUpdateService } from "./herdr-update";
import { StarPromptService } from "./star-prompt";
import { PushService, attachPush, attachReviewPush, attachGitPush, attachMergePush } from "./push";
import { Presence } from "./presence";
import { ReviewService } from "./review";
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
import { PreviewService } from "./preview";
import { listRepos, listReposPathForReal } from "./repos";
import { DistillerService, defaultScratch } from "./distiller";
import { Promoter } from "./promote";
import { attachSignalCapture } from "./signals";
import { maintenance } from "./maintenance";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startLoopLagSampler, logRemainingOnLoopBlockers } from "./instrument";
import { resolveNodeHost, TailscaleServeService } from "./tailscale";

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
// a UI-chosen backlog quick-launch standard command (persisted) overrides the env
// seed; absent → keep the config default. Stored verbatim (empty string allowed).
const savedSc = store.getSetting("standardCommand");
if (savedSc !== null) config.standardCommand = savedSc;
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

// drop abandoned New-Task uploads (attached but never submitted) older than 24h
sweepStaging(config.repoRoot, 24 * 60 * 60 * 1000, Date.now());
const herdr = new HerdrDriver();
const worktree = new WorktreeMgr();
const events = new EventHub();
const service = new SessionService({
  store,
  worktree,
  herdr,
  namer: generateName,
  refineName: config.llmNaming
    ? ({ taskText, label }) => llmName(taskText, { herdr, model: config.namerModel }, label)
    : undefined,
  events,
  reaper: new ProcessReaper(),
  // Fast-poll a queue member to surface its merge promptly when the train session
  // archives before the 120s PR sweep credits it (the merge-train completion race).
  // prPoller is defined below; this closure is only invoked at runtime, after init.
  refreshPr: (id) => prPoller.pollSession(id),
});

const accountIndex = new AccountUsageIndex();
const usageLimits = new UsageLimitsService(accountIndex, store, new HerdrUsageProbe(herdr));

reconcile(store, herdr);

// Reap orphaned helper tabs (usage-probe / review husks no live agent backs). The
// teardown paths close these at the source; this sweep is the safety net for husks
// they miss — agents that crashed out of `agent list`, or anything left over after a
// shepherd restart cleared the in-memory review tracking. Run once on boot, then hourly.
const sweepOrphanTabs = () => {
  if (maintenance.active) return;
  try {
    const closed = reapOrphanTabs(herdr);
    if (closed.length) console.warn(`[tabs] reaped ${closed.length} orphan helper tab(s)`);
  } catch (err) {
    console.warn("[tabs] orphan sweep failed:", err);
  }
};
setTimeout(sweepOrphanTabs, 5_000);
setInterval(sweepOrphanTabs, 60 * 60 * 1000);

// Memoize forge resolution: detectForge shells out to a synchronous
// `git remote get-url` per repo. forge↔repo is effectively immutable, so resolve
// once per dir and share the result across the pollers, the critic, and the
// per-request /api/backlog path — which otherwise re-shells git for every repo
// on every hit, blocking the event loop even when the counts cache is fully warm.
const forgeResolutionCache = new Map<string, ReturnType<typeof detectForge>>();
const resolveForge = (dir: string): ReturnType<typeof detectForge> => {
  let forge = forgeResolutionCache.get(dir);
  if (forge === undefined) {
    forge = detectForge(dir, config.forges);
    forgeResolutionCache.set(dir, forge);
  }
  return forge;
};

const previewService = new PreviewService({
  base: config.previewPortBase,
  count: config.previewPortCount,
  onChange: (id, previewPort) =>
    events.emit("session:preview", { id, previewPort } satisfies SessionPreviewEvent),
});

const tailscaleServe = new TailscaleServeService({
  base: config.previewPortBase,
  count: config.previewPortCount,
  enabled: config.previewAutoServe && config.previewHost != null,
  onChange: (id, _previewPort, serve) =>
    events.emit("session:preview-serve", { id, serve } satisfies SessionPreviewServeEvent),
});

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
  { service: previewService, sweepMs: config.previewSweepMs }, // preview sweep wiring
  // claude-liveness sweep wiring: lets the UI gate its Resume affordance on the
  // claude process actually being gone instead of offering it on every idle/done.
  { onChange: (id, claudeAlive) => events.emit("session:claude-alive", { id, claudeAlive }) },
);
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
});

// The train session itself was archived → clear any of its PRs still marked
// (e.g. ones it held back / rejected and never merged). Keyed on archive (a
// terminal state), NOT done/idle — a Claude pane reports done at the train's
// approval gate, where clearing would wipe the marks mid-train.
events.subscribe((event, data) => {
  if (event !== "session:archived") return;
  service.clearMergingForTrain((data as { id: string }).id);
});

// Backstop sweep: drop marks older than the TTL so a stuck/rejected PR can't
// stay "Merging" forever when neither of the above fires. Expected dwell: a PR
// the train holds back (never merged, train not yet archived) keeps the amber
// MERGING badge until the operator archives the train session, else up to
// MERGE_STALE_MS (~30 min). There is no per-PR "rejected" signal — an accepted
// cosmetic trade-off, fine while held-back PRs are rare; revisit if they aren't.
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
  reply: (id, text) => service.reply(id, text),
  release: (id) => service.releasePlanGate(id),
  onChange: (id, gate) => events.emit("session:plangate", { id, gate }),
  onReviewing: (id, reviewing) => events.emit("session:plangate-reviewing", { id, reviewing }),
  cap: () => config.planReviewCyclesCap,
});
attachReviewPush(events, store, push);
attachGitPush(events, store, push);
attachMergePush(events, push);
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
  if (advanced) planGate.forget(id);
});
setInterval(() => {
  if (maintenance.active) return;
  void reviewService.tick();
  void planGate.tick();
}, 15_000);
// archived sessions: reap any in-flight critic + drop the verdict, and reap any
// in-flight plan reviewer + drop its gate (forget() does both).
events.subscribe((event, data) => {
  if (event === "session:archived") {
    const id = (data as { id: string }).id;
    reviewService.forget(id);
    planGate.forget(id);
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
  fullAuto: (id) => {
    const s = store.get(id);
    return !!s && isFullAuto(s, store.getRepoConfig(s.repoPath));
  },
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
// Daily: prune archived sessions, prune old signals, then consider a distill per repo
// with enough recent signal.
const runDailySweep = () => {
  if (config.sessionHousekeepingEnabled)
    store.pruneArchivedSessions({
      maxAgeMs: SESSION_RETENTION_MS,
      keepNewest: SESSION_RETENTION_KEEP,
    });
  store.pruneSignals(Date.now() - 60 * 24 * 60 * 60 * 1000);
  for (const repo of listRepos(config.repoRoot)) distiller.consider(repo.path);
};
setTimeout(runDailySweep, 10_000); // once shortly after boot
setInterval(runDailySweep, 24 * 60 * 60 * 1000);

// recompute live limit % from local JSONL ~every 30s; push to clients
setInterval(async () => {
  await accountIndex.refresh(Date.now());
  events.emit("usage:limits", usageLimits.limits(Date.now()));
}, 30_000);

// calibrate the per-window caps daily (and once on startup) by scraping `/usage`
const calibrate = async () => {
  if (maintenance.active) return;
  try {
    await accountIndex.refresh(Date.now());
    const ok = await usageLimits.calibrate(Date.now());
    if (ok) events.emit("usage:limits", usageLimits.limits(Date.now()));
  } catch (err) {
    console.warn("[usage] calibration failed:", err);
  }
};
setTimeout(calibrate, 3_000);
setInterval(calibrate, 24 * 60 * 60 * 1000);

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
const backlog = new CountsService(config.forges, ghRunnerAsync);

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

const server = serve(
  {
    store,
    service,
    events,
    usageLimits,
    updates,
    herdrUpdates,
    starPrompt,
    herdr,
    resolveForge,
    prCache: prPoller,
    ownsPr,
    activity: { snapshot: () => poller.activitySnapshot() },
    claudeAlive: { snapshot: () => poller.claudeAliveSnapshot() },
    preview: { snapshot: () => previewService.snapshot() },
    previewServe: { snapshot: () => tailscaleServe.snapshot() },
    push,
    presence,
    poller,
    reviewCache: {
      snapshot: () => reviewService.snapshot(),
      reviewing: () => reviewService.reviewingIds(),
    },
    planGateCache: {
      snapshot: () => planGate.snapshot(),
      reviewing: () => planGate.reviewingIds(),
    },
    planGate: { consider: (s) => planGate.consider(s) },
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
    promoter,
    drain: { snapshot: () => drain.snapshot(), queue: (repoPath) => drain.queue(repoPath) },
    autoMerge: { snapshot: () => autoMerge.snapshot() },
  },
  config.port,
);
console.log(`shepherd core on http://localhost:${server.port}`);

// Best-effort teardown of preview listeners and tailscale mappings on process exit / SIGTERM.
process.on("exit", () => {
  previewService.stopAll();
  tailscaleServe.stopAll();
});
// Registering ANY SIGTERM handler overrides Bun's default terminate-on-signal, so we
// must exit explicitly — otherwise `systemctl stop/restart shepherd` hangs until the
// stop-timeout SIGKILL. Tear down, then exit (the `exit` handler's second stopAll is a
// no-op since stopAll is idempotent).
process.on("SIGTERM", () => {
  previewService.stopAll();
  tailscaleServe.stopAll();
  process.exit(0);
});
