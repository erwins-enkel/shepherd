import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";

let tmp: string;
let savedRoot: string;
let savedCeiling: string;
let savedRc: boolean;
let savedSc: string;
let savedHk: boolean;
let savedCap: number;

beforeEach(() => {
  // realpath so comparisons hold where tmpdir() is a symlink (macOS)
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-settings-test-")));
  mkdirSync(join(tmp, "child"));
  savedRoot = config.repoRoot; // PUT mutates the shared config; restore after
  savedCeiling = config.rootCeiling;
  savedRc = config.remoteControlAtStartup;
  savedSc = config.standardCommand;
  savedHk = config.sessionHousekeepingEnabled;
  savedCap = config.reviewCyclesCap;
  // the ceiling is the immutable boundary; point it at our temp dir for the test so
  // dirs inside tmp validate and the dir browser is confined to tmp.
  config.rootCeiling = tmp;
});

afterEach(() => {
  config.repoRoot = savedRoot;
  config.rootCeiling = savedCeiling;
  config.remoteControlAtStartup = savedRc;
  config.standardCommand = savedSc;
  config.sessionHousekeepingEnabled = savedHk;
  config.reviewCyclesCap = savedCap;
  rmSync(tmp, { recursive: true, force: true });
});

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

const put = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.fetch(
    new Request("http://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("GET /api/settings returns the current repo root and remote-control flag", async () => {
  config.repoRoot = tmp;
  config.remoteControlAtStartup = false;
  config.standardCommand = "do the thing";
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.repoRoot).toBe(tmp);
  expect(typeof body.repoRootDisplay).toBe("string");
  expect(body.remoteControlAtStartup).toBe(false);
  expect(body.standardCommand).toBe("do the thing");
  // housekeeping flag + display-only retention thresholds
  expect(typeof body.sessionHousekeepingEnabled).toBe("boolean");
  expect(body.sessionRetentionDays).toBeGreaterThan(0);
  expect(body.sessionRetentionKeep).toBeGreaterThan(0);
  // review-cycles cap + its display-only bounds
  expect(typeof body.reviewCyclesCap).toBe("number");
  expect(body.reviewCyclesMin).toBeGreaterThan(0);
  expect(body.reviewCyclesMax).toBeGreaterThanOrEqual(body.reviewCyclesMin);
});

test("PUT /api/settings sets reviewCyclesCap in range, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.reviewCyclesCap = 3;
  const { app, store } = harness();
  const res = await put(app, { reviewCyclesCap: 5 });
  expect(res.status).toBe(200);
  expect((await res.json()).reviewCyclesCap).toBe(5);
  expect(config.reviewCyclesCap).toBe(5); // live
  expect(store.getSetting("reviewCyclesCap")).toBe("5"); // persisted as a string
  expect(config.repoRoot).toBe(tmp); // a cap patch must not touch the repo root
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.reviewCyclesCap).toBe(5);
});

test("PUT /api/settings clamps an out-of-range reviewCyclesCap into the valid bounds", async () => {
  const { app, store } = harness();
  const high = await put(app, { reviewCyclesCap: 99 });
  expect(high.status).toBe(200);
  const hi = (await high.json()).reviewCyclesCap;
  expect(hi).toBeLessThanOrEqual(8); // snapped to MAX, not rejected
  expect(store.getSetting("reviewCyclesCap")).toBe(String(hi));
  const low = await put(app, { reviewCyclesCap: 0 });
  expect(low.status).toBe(200);
  expect((await low.json()).reviewCyclesCap).toBeGreaterThanOrEqual(1); // snapped to MIN
});

test("PUT /api/settings rounds a fractional reviewCyclesCap to an integer", async () => {
  const { app } = harness();
  const res = await put(app, { reviewCyclesCap: 4.7 });
  expect(res.status).toBe(200);
  expect((await res.json()).reviewCyclesCap).toBe(5);
});

test("PUT /api/settings rejects a non-number reviewCyclesCap", async () => {
  const { app } = harness();
  config.reviewCyclesCap = 3;
  for (const bad of ["4", true, null, NaN]) {
    const res = await put(app, { reviewCyclesCap: bad });
    expect(res.status).toBe(400);
  }
  expect(config.reviewCyclesCap).toBe(3); // unchanged on failure
});

test("PUT /api/settings sets standardCommand, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.standardCommand = "";
  const { app, store } = harness();
  const res = await put(app, { standardCommand: "check relevance + status" });
  expect(res.status).toBe(200);
  expect((await res.json()).standardCommand).toBe("check relevance + status");
  expect(config.standardCommand).toBe("check relevance + status"); // live
  expect(store.getSetting("standardCommand")).toBe("check relevance + status"); // persisted
  expect(config.repoRoot).toBe(tmp); // a standardCommand patch must not touch the repo root
  // reflected by a subsequent GET
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.standardCommand).toBe("check relevance + status");
});

test("PUT /api/settings accepts an empty standardCommand (disables the shortcut)", async () => {
  config.standardCommand = "something";
  const { app, store } = harness();
  const res = await put(app, { standardCommand: "" });
  expect(res.status).toBe(200);
  expect(config.standardCommand).toBe("");
  expect(store.getSetting("standardCommand")).toBe("");
});

test("PUT /api/settings rejects a non-string standardCommand", async () => {
  const { app } = harness();
  const before = config.standardCommand;
  const res = await put(app, { standardCommand: 42 });
  expect(res.status).toBe(400);
  expect(config.standardCommand).toBe(before); // unchanged on failure
});

test("PUT /api/settings rejects an over-long standardCommand", async () => {
  const { app } = harness();
  const before = config.standardCommand;
  const res = await put(app, { standardCommand: "x".repeat(8001) });
  expect(res.status).toBe(400);
  expect(config.standardCommand).toBe(before); // unchanged on failure
});

test("PUT /api/settings toggles remoteControlAtStartup, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.remoteControlAtStartup = false;
  const { app, store } = harness();
  const res = await put(app, { remoteControlAtStartup: true });
  expect(res.status).toBe(200);
  expect((await res.json()).remoteControlAtStartup).toBe(true);
  expect(config.remoteControlAtStartup).toBe(true); // live
  expect(store.getSetting("remoteControlAtStartup")).toBe("1"); // persisted as "1"/"0"
  expect(config.repoRoot).toBe(tmp); // a RC patch must not touch the repo root
  // reflected by GET, and toggling back persists "0"
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.remoteControlAtStartup).toBe(true);
  await put(app, { remoteControlAtStartup: false });
  expect(store.getSetting("remoteControlAtStartup")).toBe("0");
});

test("PUT /api/settings rejects a non-boolean remoteControlAtStartup", async () => {
  const { app } = harness();
  const res = await put(app, { remoteControlAtStartup: "yes" });
  expect(res.status).toBe(400);
});

test("PUT /api/settings toggles sessionHousekeepingEnabled, persists, leaves repoRoot intact", async () => {
  config.repoRoot = tmp;
  config.sessionHousekeepingEnabled = true;
  const { app, store } = harness();
  const res = await put(app, { sessionHousekeepingEnabled: false });
  expect(res.status).toBe(200);
  expect((await res.json()).sessionHousekeepingEnabled).toBe(false);
  expect(config.sessionHousekeepingEnabled).toBe(false); // live
  expect(store.getSetting("sessionHousekeepingEnabled")).toBe("0"); // persisted as "1"/"0"
  expect(config.repoRoot).toBe(tmp); // a housekeeping patch must not touch the repo root
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.sessionHousekeepingEnabled).toBe(false);
  await put(app, { sessionHousekeepingEnabled: true });
  expect(store.getSetting("sessionHousekeepingEnabled")).toBe("1");
});

test("PUT /api/settings rejects a non-boolean sessionHousekeepingEnabled", async () => {
  const { app } = harness();
  const before = config.sessionHousekeepingEnabled;
  const res = await put(app, { sessionHousekeepingEnabled: "yes" });
  expect(res.status).toBe(400);
  expect(config.sessionHousekeepingEnabled).toBe(before); // unchanged on failure
});

test("PUT /api/settings updates config, persists, and is reflected by GET", async () => {
  const { app, store } = harness();
  const child = join(tmp, "child");
  const res = await put(app, { repoRoot: child });
  expect(res.status).toBe(200);
  expect((await res.json()).repoRoot).toBe(child);
  // runtime config updated
  expect(config.repoRoot).toBe(child);
  // persisted
  expect(store.getSetting("repoRoot")).toBe(child);
  // reflected by a subsequent GET
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.repoRoot).toBe(child);
});

test("PUT /api/settings with a dir inside the ceiling → 200", async () => {
  const { app } = harness();
  const res = await put(app, { repoRoot: join(tmp, "child") });
  expect(res.status).toBe(200);
});

test("PUT /api/settings with a dir OUTSIDE the ceiling → 400", async () => {
  const { app } = harness();
  const before = config.repoRoot;
  for (const outside of ["/etc", "/tmp", "/"]) {
    const res = await put(app, { repoRoot: outside });
    expect(res.status).toBe(400);
  }
  expect(config.repoRoot).toBe(before); // unchanged on failure
});

test("PUT /api/settings rejects a non-existent directory", async () => {
  const { app } = harness();
  const before = config.repoRoot;
  const res = await put(app, { repoRoot: join(tmp, "does-not-exist") });
  expect(res.status).toBe(400);
  expect(config.repoRoot).toBe(before); // unchanged on failure
});

test("GET /api/fs/dirs lists sub-directories within the ceiling", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request(`http://x/api/fs/dirs?path=${encodeURIComponent(tmp)}`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(tmp);
  expect(body.entries.map((e: { name: string }) => e.name)).toEqual(["child"]);
  expect(body.parent).toBeNull(); // at the ceiling → no parent
});

test("GET /api/fs/dirs?path=/ stays clamped to the ceiling (never escapes to '/')", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/fs/dirs?path=/"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path).toBe(tmp);
  expect(body.parent).toBeNull();
});
