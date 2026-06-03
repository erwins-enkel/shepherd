import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config, SESSION_RETENTION_MS, SESSION_RETENTION_KEEP } from "./config";
import { SessionStore } from "./store";
import { WorktreeMgr } from "./worktree";
import { HerdrDriver } from "./herdr";
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
import { PushService, attachPush, attachReviewPush, attachGitPush } from "./push";
import { Presence } from "./presence";
import { ReviewService } from "./review";
import { AutopilotService } from "./autopilot";
import { DrainService } from "./drain";
import { classifyStop } from "./autopilot-llm";
import { tailLines } from "./blocked";
import { CountsService } from "./backlog";
import { BacklogPoller } from "./backlog-poller";
import { ProcessReaper } from "./process-reaper";
import { listRepos } from "./repos";
import { DistillerService, defaultScratch } from "./distiller";
import { Promoter } from "./promote";
import { attachSignalCapture } from "./signals";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
});

const accountIndex = new AccountUsageIndex();
const usageLimits = new UsageLimitsService(accountIndex, store, new HerdrUsageProbe(herdr));

reconcile(store, herdr);

// Reap orphaned helper tabs (usage-probe / review husks no live agent backs). The
// teardown paths close these at the source; this sweep is the safety net for husks
// they miss — agents that crashed out of `agent list`, or anything left over after a
// shepherd restart cleared the in-memory review tracking. Run once on boot, then hourly.
const sweepOrphanTabs = () => {
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

const poller = new StatusPoller(
  store,
  herdr,
  (id, status) => events.emit("session:status", { id, status }),
  (id, block) => events.emit("session:block", { id, block }),
  undefined, // intervalMs
  undefined, // reclassifyMs
  undefined, // classify
  undefined, // now
  undefined, // stallProbe
  undefined, // stallCfg
  undefined, // stallCheckMs
  (id, ready) => events.emit("session:ready", { id, ready }),
  (id, activity) => events.emit("session:activity", { id, activity }),
);
poller.start();

// background Web Push: turn F3 state events into notifications for subscribed devices.
// Suppress while any window is actively in use — clients report focus/visibility
// over /events into `presence`, and the push gate reads it.
const presence = new Presence();
const push = new PushService(store, undefined, undefined, undefined, () => presence.isActive());
attachPush(events, store, push);

// poll PR status for active sessions every 120s; push session:git on change so
// the list overview badges stay current without opening each session's detail.
const prPoller = new PrPoller(
  store,
  resolveForge,
  (id, git) => events.emit("session:git", { id, git }),
  undefined,
  undefined,
  // on a "no PR" miss, adopt the agent's renamed worktree branch so its open PR
  // is recognized instead of staying invisible against the stale stored branch
  (s) => service.syncWorktreeBranch(s.id),
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
  // auto-address: steer critic findings straight into the task agent's PTY (same path
  // as a human "send review to agent"). Gated per-repo by autoAddressEnabled; the
  // round cap inside ReviewService stops it ping-ponging forever.
  autoAddress: (id, text) => service.reply(id, text),
});
attachReviewPush(events, store, push);
attachGitPush(events, store, push);
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
setInterval(() => void reviewService.tick(), 15_000);
// archived sessions: reap any in-flight critic + drop the verdict
events.subscribe((event, data) => {
  if (event === "session:archived") reviewService.forget((data as { id: string }).id);
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
    return !!s && herdr.list().some((a) => a.terminalId === s.herdrAgentId);
  },
  readTail: (id) => {
    const s = store.get(id);
    return s ? tailLines(herdr.read(s.herdrAgentId, "visible")) : [];
  },
  // Any PR (open/merged/closed) stands autopilot down — only a session with NO PR yet is its
  // territory. `state` is "none" when no PR exists; anything else means one does.
  hasPr: (id) => {
    const st = prPoller.snapshot()[id]?.state;
    return st !== undefined && st !== "none";
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
  onState: (id) => {
    const s = store.get(id);
    if (s)
      events.emit("session:autopilot", {
        id,
        paused: s.autopilotPaused,
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
    if (status === "done")
      void autopilot.onDone(id).catch((err) => console.warn("[autopilot] onDone:", err));
  } else if (event === "session:git") {
    const { id, git } = data as { id: string; git: import("./forge/types").GitState };
    if (git.state === "open") autopilot.onPrOpen(id); // handoff to the critic loop
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
setInterval(() => void drain.tick().catch((err) => console.warn("[drain] tick:", err)), 30_000);

// Learnings flywheel: capture block/stall signals, run the distiller on a slow
// cadence, and surface the proposed-rule count to clients.
attachSignalCapture(events, store);
const distiller = new DistillerService({
  store,
  herdr,
  scratch: defaultScratch,
  onChange: () => events.emit("learnings:update", { pending: store.pendingLearningCount() }),
});
setInterval(() => void distiller.tick(), 30_000);
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
const checkUpdates = () => events.emit("update:status", updates.check(Date.now()));
setTimeout(checkUpdates, 3_000);
setInterval(checkUpdates, 5 * 60 * 1000);

// watch herdr.dev for a newer herdr release and surface an informational badge;
// unlike the self-update above this never auto-applies (running `herdr update`
// restarts the herdr server and bounces every live session). releases are rare,
// so a 6h cadence is plenty.
const herdrUpdates = new HerdrUpdateService({
  onLog: (line) => events.emit("herdr-update:log", { line }),
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
    herdr,
    resolveForge,
    prCache: prPoller,
    push,
    presence,
    poller,
    reviewCache: {
      snapshot: () => reviewService.snapshot(),
      reviewing: () => reviewService.reviewingIds(),
    },
    backlog,
    distiller,
    promoter,
    drain: { snapshot: () => drain.snapshot(), queue: (repoPath) => drain.queue(repoPath) },
  },
  config.port,
);
console.log(`shepherd core on http://localhost:${server.port}`);
