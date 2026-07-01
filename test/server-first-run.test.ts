import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { firstRun } from "../src/first-run";

let tmp: string;
let savedRoot: string;
let savedCeiling: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-first-run-test-")));
  mkdirSync(join(tmp, "child"));
  savedRoot = config.repoRoot;
  savedCeiling = config.rootCeiling;
  config.rootCeiling = tmp;
  firstRun.pending = false; // start every test from a known, non-leaking state
});

afterEach(() => {
  config.repoRoot = savedRoot;
  config.rootCeiling = savedCeiling;
  firstRun.pending = false; // never leak into the next test file
  rmSync(tmp, { recursive: true, force: true });
});

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
    verifyKey: async () => ({ ok: true }) as any,
  };
  return { app: makeApp(deps, { skipAuth: true }), store };
}

const post = (app: ReturnType<typeof makeApp>, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );

test("POST /api/sessions is blocked with 409 first_run_pending while pending", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const res = await post(app, "/api/sessions", { prompt: "hi" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "first_run_pending" });
});

test("POST /api/up-next/start is blocked with 409 first_run_pending while pending", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const res = await post(app, "/api/up-next/start", { items: [] });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "first_run_pending" });
});

test("POST /api/held/:id/spawn is blocked with 409 first_run_pending while pending", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const res = await post(app, "/api/held/some-id/spawn");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "first_run_pending" });
});

test("GET /api/held/:id (list) is NOT blocked while pending — guard is on the spawn branch only", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/held"));
  expect(res.status).toBe(200); // list proceeds normally, never 409
});

test("POST /api/settings/verify-key is blocked with 409 first_run_pending while pending", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const res = await post(app, "/api/settings/verify-key");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "first_run_pending" });
});

test("POST /api/repos (clone) is blocked with 409 first_run_pending while pending", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const res = await post(app, "/api/repos", { url: "https://github.com/foo/bar" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "first_run_pending" });
});

test("POST /api/usage/refresh is blocked with 409 first_run_pending while pending", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const res = await post(app, "/api/usage/refresh");
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "first_run_pending" });
});

test("POST /api/sessions is NOT blocked when not pending — proceeds to normal validation", async () => {
  firstRun.pending = false;
  const { app } = harness();
  const res = await post(app, "/api/sessions", {}); // missing prompt → normal 400, never 409
  expect(res.status).not.toBe(409);
  expect(res.status).toBe(400);
});

test("GET /api/settings exposes firstRunPending reflecting the flag", async () => {
  firstRun.pending = true;
  const { app } = harness();
  const pendingRes = await app.fetch(new Request("http://x/api/settings"));
  expect((await pendingRes.json()).firstRunPending).toBe(true);

  firstRun.pending = false;
  const notPendingRes = await app.fetch(new Request("http://x/api/settings"));
  expect((await notPendingRes.json()).firstRunPending).toBe(false);
});

test("putRepoRoot first-pick resolves the gate + stamps firstRunResolved", async () => {
  firstRun.pending = true;
  const { app, store } = harness();
  const setSettingSpy: [string, string][] = [];
  const origSetSetting = store.setSetting.bind(store);
  store.setSetting = (key: string, value: string) => {
    setSettingSpy.push([key, value]);
    origSetSetting(key, value);
  };

  const res = await app.fetch(
    new Request("http://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: join(tmp, "child") }),
    }),
  );
  expect(res.status).toBe(200);
  expect(firstRun.pending).toBe(false);
  expect(setSettingSpy).toContainEqual(["firstRunResolved", "1"]);
});

test("putRepoRoot when NOT pending does not touch firstRunResolved", async () => {
  firstRun.pending = false;
  const { app, store } = harness();
  const setSettingSpy: [string, string][] = [];
  const origSetSetting = store.setSetting.bind(store);
  store.setSetting = (key: string, value: string) => {
    setSettingSpy.push([key, value]);
    origSetSetting(key, value);
  };

  const res = await app.fetch(
    new Request("http://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoRoot: join(tmp, "child") }),
    }),
  );
  expect(res.status).toBe(200);
  expect(firstRun.pending).toBe(false);
  expect(setSettingSpy.some(([k]) => k === "firstRunResolved")).toBe(false);
});
