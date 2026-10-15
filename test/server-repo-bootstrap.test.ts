/** #3105: GET/PUT /api/repo-bootstrap + POST /api/repo-bootstrap/override. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";

let tmpRoot: string;
let repo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-srv-bootstrap-test-"));
  repo = join(tmpRoot, "repo");
  mkdirSync(repo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}), remove: () => {} } as any,
    herdr: { list: () => [], stop: async () => {}, send: () => {} } as any,
    events,
  });
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  };
  return { store, service, events, usageLimits };
}

function call(app: ReturnType<typeof makeApp>, method: string, path: string, body?: unknown) {
  return app.fetch(
    new Request(`http://x/api/repo-bootstrap${path}?repo=${encodeURIComponent(repo)}`, {
      method,
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

test("GET: a repo without bootstrap state reads off and is suggested when it has no manifest", async () => {
  const app = makeApp(makeDeps());
  const res = await call(app, "GET", "");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    state: "off",
    phase: 1,
    overrideAt: null,
    missing: [],
    suggested: true,
    next: null,
  });
  writeFileSync(join(repo, "package.json"), "{}");
  expect((await (await call(app, "GET", "")).json()).suggested).toBe(false);
});

test("PUT: toggle on → active P1 with all phases missing; phase moves; off clears", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  let body = await (await call(app, "PUT", "", { state: "active" })).json();
  expect(body).toMatchObject({ state: "active", phase: 1, missing: ["P1", "P2", "P3", "P4"] });
  body = await (await call(app, "PUT", "", { phase: 3 })).json();
  expect(body).toMatchObject({ state: "active", phase: 3, missing: ["P3", "P4"] });
  body = await (await call(app, "PUT", "", { state: "off" })).json();
  expect(body).toMatchObject({ state: "off", missing: [] });
  expect(deps.store.getRepoBootstrap(realpathSync(repo)).state).toBe("off");
});

test("PUT: phase 5 with green must-haves exits to done", async () => {
  const app = makeApp(makeDeps());
  await call(app, "PUT", "", { state: "active" });
  const body = await (await call(app, "PUT", "", { phase: 5 })).json();
  expect(body).toMatchObject({ state: "done", phase: 5, missing: [] });
});

test("PUT: validation (400) and phase-only on a non-bootstrapping repo (409)", async () => {
  const app = makeApp(makeDeps());
  expect((await call(app, "PUT", "", { state: "done" })).status).toBe(400);
  expect((await call(app, "PUT", "", { phase: 6 })).status).toBe(400);
  expect((await call(app, "PUT", "", {})).status).toBe(400);
  expect((await call(app, "PUT", "", { phase: 2 })).status).toBe(409);
});

test("POST override: 409 unless active; ON is persisted and logged; missing still listed", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  expect((await call(app, "POST", "/override", { on: true })).status).toBe(409);
  await call(app, "PUT", "", { state: "active" });
  expect((await call(app, "POST", "/override", { on: "yes" })).status).toBe(400);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const res = await call(app, "POST", "/override", { on: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.overrideAt).toBe("number");
    expect(body.missing).toEqual(["P1", "P2", "P3", "P4"]);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("[bootstrap] operator override ON")),
    ).toBe(true);
  } finally {
    warn.mockRestore();
  }
  const off = await (await call(app, "POST", "/override", { on: false })).json();
  expect(off.overrideAt).toBeNull();
});

test("#3107: red must-haves from the greenfield service block the exit and show in missing", async () => {
  const deps = makeDeps();
  let red = ["ci_on_main"];
  const refreshed: string[] = [];
  deps.greenfield = {
    mustHavesMissing: () => red,
    refresh: async (d: string) => (refreshed.push(d), {}) as never,
  };
  const app = makeApp(deps);
  await call(app, "PUT", "", { state: "active" });
  expect(refreshed).toHaveLength(1); // entering active scans at once
  const held = await (await call(app, "PUT", "", { phase: 5 })).json();
  expect(held.state).toBe("active");
  expect(held.missing).toEqual(["ci_on_main"]);
  red = [];
  const done = await (await call(app, "PUT", "", { phase: 5 })).json();
  expect(done.state).toBe("done");
  expect(refreshed).toHaveLength(1); // a phase move alone doesn't re-scan
});
