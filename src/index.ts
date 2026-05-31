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
import { reconcile } from "./reconcile";
import { serve } from "./server";
import { detectForge } from "./forge";
import { AccountUsageIndex } from "./usage";
import { UsageLimitsService } from "./usage-limits";
import { HerdrUsageProbe } from "./usage-probe";
import { sweepStaging } from "./uploads";

mkdirSync(dirname(config.dbPath), { recursive: true });
// drop abandoned New-Task uploads (attached but never submitted) older than 24h
sweepStaging(config.repoRoot, 24 * 60 * 60 * 1000, Date.now());

const store = new SessionStore(config.dbPath);
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

const poller = new StatusPoller(store, herdr, (id, status) =>
  events.emit("session:status", { id, status }),
);
poller.start();

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

// forge resolution: detect a repo's GitHub/Gitea host from its `origin` remote.
// Per-host config (tokens, gitea base URLs) loads from config.forges (SHEPHERD_FORGES);
// github.com works through the operator's existing `gh` CLI auth, so an absent file is fine.
const server = serve(
  { store, service, events, usageLimits, resolveForge: (dir) => detectForge(dir, config.forges) },
  config.port,
);
console.log(`shepherd core on http://localhost:${server.port}`);
