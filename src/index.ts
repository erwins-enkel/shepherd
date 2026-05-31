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
import { serve } from "./server";
import { detectForge } from "./forge";
import { AccountUsageIndex } from "./usage";
import { UsageLimitsService } from "./usage-limits";
import { HerdrUsageProbe } from "./usage-probe";
import { sweepStaging } from "./uploads";
import { validateRoot } from "./dirs";
import { UpdateService } from "./update";
import { HerdrUpdateService } from "./herdr-update";
import { PushService, attachPush } from "./push";

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

// drop abandoned New-Task uploads (attached but never submitted) older than 24h
sweepStaging(config.repoRoot, 24 * 60 * 60 * 1000, Date.now());
const herdr = new HerdrDriver();
const worktree = new WorktreeMgr();
const events = new EventHub();
const service = new SessionService({
  store,
  worktree,
  herdr,
  namer: (p) => generateName(p),
});

const accountIndex = new AccountUsageIndex();
const usageLimits = new UsageLimitsService(accountIndex, store, new HerdrUsageProbe(herdr));

reconcile(store, herdr);

const poller = new StatusPoller(
  store,
  herdr,
  (id, status) => events.emit("session:status", { id, status }),
  (id, block) => events.emit("session:block", { id, block }),
);
poller.start();

// background Web Push: turn F3 state events into notifications for subscribed devices
const push = new PushService(store);
attachPush(events, store, push);

// poll PR status for active sessions every 120s; push session:git on change so
// the list overview badges stay current without opening each session's detail.
const prPoller = new PrPoller(
  store,
  (dir) => detectForge(dir, config.forges),
  (id, git) => events.emit("session:git", { id, git }),
);
setTimeout(() => void prPoller.tick(), 3_000); // warm the cache shortly after boot
prPoller.start();

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
const herdrUpdates = new HerdrUpdateService();
const checkHerdrUpdate = async () =>
  events.emit("herdr-update:status", await herdrUpdates.check(Date.now()));
setTimeout(checkHerdrUpdate, 4_000);
setInterval(checkHerdrUpdate, 6 * 60 * 60 * 1000);

// forge resolution: detect a repo's GitHub/Gitea host from its `origin` remote.
// Per-host config (tokens, gitea base URLs) loads from config.forges (SHEPHERD_FORGES);
// github.com works through the operator's existing `gh` CLI auth, so an absent file is fine.
const server = serve(
  {
    store,
    service,
    events,
    usageLimits,
    updates,
    herdrUpdates,
    herdr,
    resolveForge: (dir) => detectForge(dir, config.forges),
    prCache: prPoller,
    push,
    poller,
  },
  config.port,
);
console.log(`shepherd core on http://localhost:${server.port}`);
