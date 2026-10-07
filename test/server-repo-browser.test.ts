/** Operator "Open shared browser" route + stop-on-disable (ADR 0001). */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { makeApp, type AppDeps } from "../src/server";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { SharedBrowserError } from "../src/shared-browser";

let tmpRoot: string;
let repo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-browser-test-"));
  repo = join(tmpRoot, "repo");
  mkdirSync(repo);
  repo = realpathSync(repo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

interface Calls {
  opened: Array<{ repo: string; url: string }>;
  stopped: string[];
  fail?: Error;
}

function makeDeps(calls: Calls, devPorts: Record<string, number> = {}): AppDeps {
  const store = new SessionStore(":memory:");
  return {
    store,
    events: new EventHub(),
    service: {} as any,
    sharedBrowser: {
      attach: async () => {
        throw new Error("unused");
      },
      open: async (repoPath: string, url: string) => {
        if (calls.fail) throw calls.fail;
        calls.opened.push({ repo: repoPath, url });
        return "T1";
      },
      sessionTab: () => null,
      stop: (repoPath: string) => {
        calls.stopped.push(repoPath);
      },
    },
    preview: { snapshot: () => ({}), devPortFor: (id: string) => devPorts[id] ?? null },
    previewLauncher: {
      findDevPort: async () => null,
      scriptExists: async () => false,
      scriptPath: async () => null,
      ensureScript: async () => null,
      startScript: async () => {},
    },
  } as unknown as AppDeps;
}

const enable = (deps: AppDeps, on = true) =>
  deps.store.setRepoConfig(repo, { ...deps.store.getRepoConfig(repo), sharedBrowserEnabled: on });

function post(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.fetch(
    new Request("http://x/api/repo-browser/open", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify(body),
    }),
  );
}

function put(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repo)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify(body),
    }),
  );
}

function addSession(deps: AppDeps, repoPath: string) {
  return deps.store.create({
    name: "s",
    prompt: "p",
    repoPath,
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_1",
  });
}

test("POST /api/repo-browser/open: 400 for a repo outside the repo root", async () => {
  const calls: Calls = { opened: [], stopped: [] };
  const app = makeApp(makeDeps(calls));
  expect((await post(app, { repo: "/etc" })).status).toBe(400);
  expect((await post(app, {})).status).toBe(400);
  expect(calls.opened).toEqual([]);
});

test("POST /api/repo-browser/open: 409 while the repo has not opted in", async () => {
  const calls: Calls = { opened: [], stopped: [] };
  const app = makeApp(makeDeps(calls));
  const res = await post(app, { repo });
  expect(res.status).toBe(409);
  expect(calls.opened).toEqual([]);
});

test("POST /api/repo-browser/open: 200 opens about:blank without a session", async () => {
  const calls: Calls = { opened: [], stopped: [] };
  const deps = makeDeps(calls);
  enable(deps);
  const res = await post(makeApp(deps), { repo });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, url: "about:blank" });
  expect(calls.opened).toEqual([{ repo, url: "about:blank" }]);
});

test("POST /api/repo-browser/open: a session with a dev server opens its real localhost origin", async () => {
  const calls: Calls = { opened: [], stopped: [] };
  const deps = makeDeps(calls);
  enable(deps);
  const s = addSession(deps, repo);
  (deps.preview as any).devPortFor = (id: string) => (id === s.id ? 5173 : null);
  const res = await post(makeApp(deps), { repo, sessionId: s.id });
  expect(res.status).toBe(200);
  expect(calls.opened).toEqual([{ repo, url: "http://localhost:5173" }]);
});

test("POST /api/repo-browser/open: a session from another repo is refused", async () => {
  const calls: Calls = { opened: [], stopped: [] };
  const deps = makeDeps(calls);
  enable(deps);
  const other = join(tmpRoot, "other");
  mkdirSync(other);
  const s = addSession(deps, other);
  expect((await post(makeApp(deps), { repo, sessionId: s.id })).status).toBe(400);
  expect((await post(makeApp(deps), { repo, sessionId: "nope" })).status).toBe(404);
  expect(calls.opened).toEqual([]);
});

test("POST /api/repo-browser/open: 503 carries the SharedBrowserError code", async () => {
  for (const code of ["missing-binary", "cap", "launch-failed"] as const) {
    const calls: Calls = { opened: [], stopped: [], fail: new SharedBrowserError(code, "x") };
    const deps = makeDeps(calls);
    enable(deps);
    const res = await post(makeApp(deps), { repo });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(code);
  }
});

test("PUT /api/repo-config: turning sharedBrowserEnabled off stops the repo's browser", async () => {
  const calls: Calls = { opened: [], stopped: [] };
  const deps = makeDeps(calls);
  const app = makeApp(deps);
  expect((await put(app, { sharedBrowserEnabled: true })).status).toBe(200);
  expect(calls.stopped).toEqual([]);
  // An unrelated patch while on leaves the browser running.
  expect((await put(app, { criticEnabled: false })).status).toBe(200);
  expect(calls.stopped).toEqual([]);
  expect((await put(app, { sharedBrowserEnabled: false })).status).toBe(200);
  expect(calls.stopped).toEqual([repo]);
  // Already off: no second stop.
  expect((await put(app, { sharedBrowserEnabled: false })).status).toBe(200);
  expect(calls.stopped).toEqual([repo]);
});
