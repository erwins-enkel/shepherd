import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import { SessionStore } from "./store";
import { WorktreeMgr } from "./worktree";
import { HerdrDriver } from "./herdr";
import { generateName } from "./namer";
import { EventHub } from "./events";
import { SessionService } from "./service";
import { StatusPoller } from "./poller";
import { PrPoller } from "./pr-poller";
import { reconcile } from "./reconcile";
import { reapOrphanTabs } from "./tab-reaper";
import { serve } from "./server";
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
import { CountsService } from "./backlog";
import { BacklogPoller } from "./backlog-poller";
import { ProcessReaper } from "./process-reaper";
import { listRepos } from "./repos";
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
const prPoller = new PrPoller(store, resolveForge, (id, git) =>
  events.emit("session:git", { id, git }),
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

const reviewService = new ReviewService({
  store,
  herdr,
  worktree,
  resolveForge,
  onChange: (id, verdict) => events.emit("session:review", { id, review: verdict }),
  onReviewing: (id, reviewing) => events.emit("session:reviewing", { id, reviewing }),
});
attachReviewPush(events, store, push);
attachGitPush(events, store, push);
// drive the critic off PR-state changes: open + CI green + unreviewed head → review
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: import("./forge/types").GitState };
  const s = store.get(id);
  if (s) reviewService.consider(s, git);
});
setInterval(() => void reviewService.tick(), 15_000);
// archived sessions: reap any in-flight critic + drop the verdict
events.subscribe((event, data) => {
  if (event === "session:archived") reviewService.forget((data as { id: string }).id);
});

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
const backlogPoller = new BacklogPoller(
  () => listRepos(config.repoRoot),
  resolveForge,
  (dir) => backlog.refresh(dir),
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
  },
  config.port,
);
console.log(`shepherd core on http://localhost:${server.port}`);
