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
