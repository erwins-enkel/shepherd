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

mkdirSync(dirname(config.dbPath), { recursive: true });

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

reconcile(store, herdr);

const poller = new StatusPoller(store, herdr, (id, status) =>
  events.emit("session:status", { id, status }),
);
poller.start();

const server = serve({ store, service, events }, config.port);
console.log(`shepherd core on http://localhost:${server.port}`);
