import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;
let store: SessionStore;
let app: ReturnType<typeof makeApp>;
let emitted: string[];
let ranNow: string[];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-sched-api-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  store = new SessionStore(":memory:");
  emitted = [];
  ranNow = [];
  const hub = new EventHub();
  hub.subscribe((event) => emitted.push(event));
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: hub,
    usageLimits: { limits: () => ({}) } as any,
    schedules: {
      runNow: async (id) => {
        ranNow.push(id);
        return store.getSchedule(id)
          ? {
              id: 1,
              scheduleId: id,
              slotKey: "manual:x",
              outcome: "spawned",
              sessionId: "s",
              reason: null,
              usage: null,
              at: 1,
            }
          : null;
      },
    },
  } as AppDeps;
  app = makeApp(deps);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function call(method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const valid = () => ({
  repoPath: repoDir,
  name: "Triage",
  prompt: "/triage-feedback",
  days: 0b0011111,
  times: ["09:00", "18:00"],
});

test("create → list → patch → runs → delete", async () => {
  const created = await call("POST", "/api/schedules", valid());
  expect(created.status).toBe(201);
  const s = await created.json();
  expect(s).toMatchObject({ name: "Triage", enabled: true, lastRun: null });
  expect(typeof s.nextAt).toBe("number");
  expect(s.launch.autopilotEnabled).toBe(false);
  expect(emitted).toContain("schedules:changed");

  const list = await (
    await call("GET", `/api/schedules?repo=${encodeURIComponent(repoDir)}`)
  ).json();
  expect(list.schedules.map((x: { id: string }) => x.id)).toEqual([s.id]);
  const other = await (
    await call("GET", `/api/schedules?repo=${encodeURIComponent(tmpRoot)}`)
  ).json();
  expect(other.schedules).toEqual([]);

  const patched = await call("PATCH", `/api/schedules/${s.id}`, {
    enabled: false,
    launch: { research: true },
  });
  expect(patched.status).toBe(200);
  const p = await patched.json();
  expect(p.enabled).toBe(false);
  expect(p.nextAt).toBeNull();
  expect(p.launch).toMatchObject({ research: true, autopilotEnabled: false });

  expect((await call("GET", `/api/schedules/${s.id}/runs`)).status).toBe(200);
  expect((await call("DELETE", `/api/schedules/${s.id}`)).status).toBe(200);
  expect((await call("DELETE", `/api/schedules/${s.id}`)).status).toBe(404);
  expect((await call("GET", `/api/schedules/${s.id}/runs`)).status).toBe(404);
});

test("enable / cadence change re-baselines; rename does not", async () => {
  const s = await (await call("POST", "/api/schedules", { ...valid(), enabled: false })).json();
  const base0 = store.getSchedule(s.id)!.baselineAt;
  await Bun.sleep(2);
  await call("PATCH", `/api/schedules/${s.id}`, { name: "Renamed" });
  expect(store.getSchedule(s.id)!.baselineAt).toBe(base0);
  await call("PATCH", `/api/schedules/${s.id}`, { enabled: true });
  const base1 = store.getSchedule(s.id)!.baselineAt;
  expect(base1).toBeGreaterThan(base0);
  await Bun.sleep(2);
  await call("PATCH", `/api/schedules/${s.id}`, { times: ["10:00"] });
  expect(store.getSchedule(s.id)!.baselineAt).toBeGreaterThan(base1);
});

test("validation errors are 400; repoPath is immutable", async () => {
  expect((await call("POST", "/api/schedules", { ...valid(), days: 0 })).status).toBe(400);
  expect((await call("POST", "/api/schedules", { ...valid(), times: ["25:00"] })).status).toBe(400);
  expect((await call("POST", "/api/schedules", { ...valid(), repoPath: "/etc" })).status).toBe(400);
  const s = await (await call("POST", "/api/schedules", valid())).json();
  expect((await call("PATCH", `/api/schedules/${s.id}`, { repoPath: tmpRoot })).status).toBe(400);
  expect((await call("PATCH", `/api/schedules/${s.id}`, { times: [] })).status).toBe(400);
  expect((await call("PATCH", "/api/schedules/nope", { name: "x" })).status).toBe(404);
});

test("run now delegates to the scheduler", async () => {
  const s = await (await call("POST", "/api/schedules", valid())).json();
  const res = await call("POST", `/api/schedules/${s.id}/run`);
  expect(res.status).toBe(200);
  expect((await res.json()).outcome).toBe("spawned");
  expect(ranNow).toEqual([s.id]);
  expect((await call("POST", "/api/schedules/nope/run")).status).toBe(404);
});

test("interval CRUD preserves omitted cadence and rebaselines only on changes", async () => {
  const interval = { everyMinutes: 15, from: "08:00", until: "18:00" };
  const response = await call("POST", "/api/schedules", { ...valid(), times: [], interval });
  expect(response.status).toBe(201);
  const s = await response.json();
  expect(s.interval).toEqual(interval);
  expect(typeof s.nextAt).toBe("number");
  const patch = (body: unknown) => call("PATCH", `/api/schedules/${s.id}`, body);
  await patch({ name: "Changed" });
  await patch({ interval });
  expect(store.getSchedule(s.id)!.baselineAt).toBe(s.baselineAt);
  await Bun.sleep(2);
  await patch({ interval: { ...interval, everyMinutes: 30 } });
  expect(store.getSchedule(s.id)!.baselineAt).toBeGreaterThan(s.baselineAt);
  expect((await patch({ interval: null })).status).toBe(400);
  expect((await patch({ interval: null, times: ["09:00"] })).status).toBe(200);
  expect(store.getSchedule(s.id)!.interval).toBeNull();
  expect((await patch({ interval: { ...interval, until: "08:00" }, times: [] })).status).toBe(400);
});

test("usage limits roundtrip, preserve on PATCH, reject invalid, and do not rebaseline", async () => {
  const usageLimit = { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 };
  const created = await call("POST", "/api/schedules", { ...valid(), usageLimit });
  expect(created.status).toBe(201);
  const s = await created.json();
  expect(s.usageLimit).toEqual(usageLimit);
  const path = `/api/schedules/${s.id}`;
  expect((await (await call("PATCH", path, { name: "Renamed" })).json()).usageLimit).toEqual(
    usageLimit,
  );
  const changed = await (
    await call("PATCH", path, { usageLimit: { kind: "upTo", stopPct: 70 } })
  ).json();
  expect(changed.baselineAt).toBe(s.baselineAt);
  expect(changed.usageLimit).toEqual({ kind: "upTo", stopPct: 70 });
  expect((await call("PATCH", path, { usageLimit: { ...usageLimit, stopPct: 80 } })).status).toBe(
    400,
  );
  expect(
    (
      await call("POST", "/api/schedules", {
        ...valid(),
        usageLimit: { kind: "upTo", stopPct: 71 },
      })
    ).status,
  ).toBe(400);
  expect((await (await call("PATCH", path, { usageLimit: null })).json()).usageLimit).toBeNull();
});

test("mismatch actions roundtrip and disabling expires waiting rows immediately", async () => {
  for (const onMismatch of ["skip", "wait", "otherProvider"]) {
    const usageLimit = { kind: "upTo", stopPct: 70, onMismatch };
    const created = await call("POST", "/api/schedules", { ...valid(), usageLimit });
    expect(created.status).toBe(201);
    const s = await created.json();
    expect(s.usageLimit).toEqual(usageLimit);
    const path = `/api/schedules/${s.id}`;
    const patched = await (
      await call("PATCH", path, { usageLimit: { ...usageLimit, stopPct: 80 } })
    ).json();
    expect(patched.baselineAt).toBe(s.baselineAt);
    expect(patched.usageLimit.onMismatch).toBe(onMismatch);
    expect(
      (await call("PATCH", path, { usageLimit: { ...usageLimit, onMismatch: "bad" } })).status,
    ).toBe(400);
    store.claimScheduleRun(s.id, "2026-10-26T09:00", Date.now());
    store.settleScheduleRun(s.id, "2026-10-26T09:00", "waiting:limit");
    expect((await call("PATCH", path, { enabled: false })).status).toBe(200);
    expect(store.getScheduleRun(s.id, "2026-10-26T09:00")).toMatchObject({
      outcome: "skipped:limit-expired",
      reason: "disabled",
    });
  }
});
