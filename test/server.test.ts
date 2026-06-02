import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { stagingDir } from "../src/uploads";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, serve, PTY_GONE_CODE, type AppDeps } from "../src/server";
import { config } from "../src/config";

// Create a real tmp dir inside config.repoRoot so validation passes
let tmpRoot: string;
let validRepo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-srv-test-"));
  validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: {
      start: () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => [],
      stop: () => {},
      send: () => {},
    } as any,
    events,
  });
  const usageLimits = {
    limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
  };
  const distiller = { distillNow: () => {} };
  return { store, service, events, usageLimits, distiller };
}

function harness() {
  const deps = makeDeps();
  return makeApp(deps);
}

test("GET /api/usage/limits returns the limits snapshot", async () => {
  const res = await harness().fetch(new Request("http://x/api/usage/limits"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ session5h: null, week: null, stale: true, calibratedAt: null });
});

test("GET /api/sessions/:id/usage returns zeroed usage for a session w/o JSONL", async () => {
  const app = harness();
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const res = await app.fetch(new Request(`http://x/api/sessions/${created.id}/usage`));
  expect(res.status).toBe(200);
  const u = await res.json();
  expect(u.total).toBe(0);
  expect(u.messageCount).toBe(0);
});

test("GET /api/sessions/:id/activity returns [] for a session w/o JSONL", async () => {
  const app = harness();
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const res = await app.fetch(new Request(`http://x/api/sessions/${created.id}/activity`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("GET /api/sessions/:id/activity 404s for unknown id", async () => {
  const res = await harness().fetch(new Request("http://x/api/sessions/nope/activity"));
  expect(res.status).toBe(404);
});

test("GET /api/sessions/:id/usage 404s for unknown id", async () => {
  const res = await harness().fetch(new Request("http://x/api/sessions/nope/usage"));
  expect(res.status).toBe(404);
});

function postSessions(app: ReturnType<typeof makeApp>, body: unknown, headers?: HeadersInit) {
  return app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /api/sessions creates, GET lists", async () => {
  const app = harness();
  const post = await postSessions(app, {
    repoPath: validRepo,
    baseBranch: "main",
    prompt: "go",
  });
  expect(post.status).toBe(201);
  const created = await post.json();
  expect(created.desig).toBe("TASK-01");

  const list = await (await app.fetch(new Request("http://x/api/sessions"))).json();
  expect(list.length).toBe(1);
});

test("POST /api/sessions surfaces a herdr failure with its real message (not a bare status)", async () => {
  const deps = makeDeps();
  // mirror herdr rejecting `tab create` — the create path throws past validation
  deps.service = {
    create: async () => {
      throw new Error("Command failed: herdr tab create … no active workspace");
    },
  } as any;
  const res = await postSessions(makeApp(deps), {
    repoPath: validRepo,
    baseBranch: "main",
    prompt: "go",
  });
  expect(res.status).toBe(502); // herdr/git failure
  const body = await res.json();
  expect(body.error).toContain("no active workspace"); // real cause reaches the client
});

test("an unhandled throw on any route becomes a JSON 500, not Bun's HTML error page", async () => {
  const deps = makeDeps();
  // a route with no local try/catch (GET /api/sessions) — exercise the global safety net
  deps.store = {
    list: () => {
      throw new Error("db exploded");
    },
  } as any;
  const res = await makeApp(deps).fetch(new Request("http://x/api/sessions"));
  expect(res.status).toBe(500);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = await res.json();
  expect(body.error).toBe("db exploded"); // message preserved as JSON, parseable by the UI
});

test("DELETE /api/sessions/:id archives", async () => {
  const app = harness();
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const del = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}`, { method: "DELETE" }),
  );
  expect(del.status).toBe(200);
});

// Build an app whose service is backed by a stub reaper, so we can drive the
// /leftovers + reap-on-DELETE paths without touching real /proc.
function harnessWithReaper(reaper: { detect: any; reap: any }) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      remove: () => {},
    } as any,
    herdr: { start: () => ({}) as any, list: () => [], stop: () => {}, send: () => {} } as any,
    reaper,
  });
  const usageLimits = {
    limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
  };
  const app = makeApp({ store, service, events, usageLimits, distiller: { distillNow: () => {} } });
  return { app, store };
}

test("GET /api/sessions/:id/leftovers returns the reaper's detected list", async () => {
  const detected = [{ kind: "process", name: "vite", port: 5174, pid: 9, key: "process:9" }];
  const { app, store } = harnessWithReaper({ detect: () => detected, reap: () => {} });
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/leftovers`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(detected);
});

test("GET /api/sessions/:id/leftovers → [] without a reaper", async () => {
  const app = harness();
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const res = await app.fetch(new Request(`http://x/api/sessions/${created.id}/leftovers`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("DELETE /api/sessions/:id with a reap body terminates the selected leftovers", async () => {
  const detected = [
    { kind: "process", name: "vite", port: 5174, pid: 9, key: "process:9" },
    { kind: "system", name: "tailscale serve", port: 5174, key: "system:tailscale serve:5174" },
  ];
  const reaped: string[][] = [];
  const { app, store } = harnessWithReaper({
    detect: () => detected,
    reap: (ls: any[]) => reaped.push(ls.map((l) => l.key)),
  });
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  const del = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify({ reap: ["process:9"] }),
    }),
  );
  expect(del.status).toBe(200);
  expect(reaped).toEqual([["process:9"]]); // only the selected one
  expect(store.get(s.id)?.status).toBe("archived");
});

test("DELETE /api/sessions/:id with no body archives without reaping", async () => {
  const reaped: unknown[] = [];
  const { app, store } = harnessWithReaper({
    detect: () => [{ kind: "process", name: "vite", port: 5174, pid: 9, key: "process:9" }],
    reap: (ls: unknown) => reaped.push(ls),
  });
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  const del = await app.fetch(new Request(`http://x/api/sessions/${s.id}`, { method: "DELETE" }));
  expect(del.status).toBe(200);
  expect(reaped).toEqual([]); // nothing selected → reaper untouched
  expect(store.get(s.id)?.status).toBe("archived");
});

test("POST with disallowed Origin → 403", async () => {
  const app = harness();
  const res = await postSessions(
    app,
    { repoPath: validRepo, baseBranch: "main", prompt: "go" },
    { Origin: "https://evil.com" },
  );
  expect(res.status).toBe(403);
});

test("POST with allowed Origin (localhost) → 201", async () => {
  const app = harness();
  const res = await postSessions(
    app,
    { repoPath: validRepo, baseBranch: "main", prompt: "go" },
    { Origin: "http://localhost:7330" },
  );
  expect(res.status).toBe(201);
});

test("POST with invalid baseBranch → 400", async () => {
  const app = harness();
  const res = await postSessions(app, {
    repoPath: validRepo,
    baseBranch: "--evil",
    prompt: "go",
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/baseBranch/i);
});

test("POST missing Content-Type → 415", async () => {
  const app = harness();
  const res = await app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ repoPath: validRepo, baseBranch: "main", prompt: "go" }),
    }),
  );
  expect(res.status).toBe(415);
});

test("POST with repoPath outside repoRoot → 400", async () => {
  const app = harness();
  const res = await postSessions(app, { repoPath: "/etc", baseBranch: "main", prompt: "go" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toMatch(/repoPath/i);
});

test("GET /api/sessions has no auth/origin restrictions", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/sessions"));
  expect(res.status).toBe(200);
});

// ── WebSocket Origin guard (CSWSH) ────────────────────────────────────────────

test("WS /events with evil Origin → 403", async () => {
  const deps = makeDeps();
  const server = serve(deps, 0);
  try {
    const port = server.port;
    const res = await fetch(`http://localhost:${port}/events`, {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
  } finally {
    server.stop();
  }
});

test("WS /pty/:id with evil Origin → 403", async () => {
  const deps = makeDeps();
  // Insert a real session so the route finds it and reaches the origin guard
  const session = deps.store.create({
    name: "test",
    prompt: "go",
    repoPath: "/wt",
    baseBranch: "main",
    branch: null,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_65306e7cb9451a",
  });
  const server = serve(deps, 0);
  try {
    const port = server.port;
    const res = await fetch(`http://localhost:${port}/pty/${session.id}`, {
      headers: { Origin: "https://evil.com" },
    });
    expect(res.status).toBe(403);
  } finally {
    server.stop();
  }
});

// ── PTY: terminated session must not attach (would loop on agent_not_found) ────

// Build a herdr stub whose live list contains exactly the given terminal ids.
function herdrWith(...liveTerminalIds: string[]): AppDeps["herdr"] {
  return {
    list: () =>
      liveTerminalIds.map((terminalId) => ({
        agent: "claude",
        agentStatus: "done",
        cwd: "/wt",
        name: "",
        paneId: "p",
        tabId: "t",
        terminalId,
        workspaceId: "w",
      })),
  };
}

// Wait for a gone/archived session's pty WS to be rejected, resolving the close
// code. Only listens for onclose (the server closes immediately) — never onopen,
// which under a loaded full-suite run can race ahead of the server's close frame.
function expectPtyClose(port: number | undefined, id: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/pty/${id}`);
    ws.onclose = (e) => resolve(e.code);
    ws.onerror = () => {};
    setTimeout(() => reject(new Error("timed out waiting for close")), 3000);
  });
}

test("WS /pty/:id for a done session whose herdr agent is GONE closes with PTY_GONE_CODE", async () => {
  const deps = makeDeps();
  const session = deps.store.create({
    name: "test",
    prompt: "go",
    repoPath: "/wt",
    baseBranch: "main",
    branch: null,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_dead",
  });
  // claude exited / ctrl-c: the poller (or reconcile) has marked it done AND the
  // herdr agent has been reaped (absent from the live list).
  deps.store.update(session.id, { status: "done", lastState: "done" });

  const server = serve({ ...deps, herdr: herdrWith() }, 0);
  try {
    expect(await expectPtyClose(server.port, session.id)).toBe(PTY_GONE_CODE);
  } finally {
    server.stop();
  }
});

test("WS /pty/:id for an archived session closes with PTY_GONE_CODE even if its agent is live", async () => {
  const deps = makeDeps();
  const session = deps.store.create({
    name: "test",
    prompt: "go",
    repoPath: "/wt",
    baseBranch: "main",
    branch: null,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_archived",
  });
  deps.store.update(session.id, { status: "archived", lastState: "done" });

  const server = serve({ ...deps, herdr: herdrWith("term_archived") }, 0);
  try {
    expect(await expectPtyClose(server.port, session.id)).toBe(PTY_GONE_CODE);
  } finally {
    server.stop();
  }
});

test("WS /pty/:id for a done session whose herdr agent is STILL ALIVE is allowed to attach", async () => {
  const deps = makeDeps();
  const session = deps.store.create({
    name: "test",
    prompt: "go",
    repoPath: "/wt",
    baseBranch: "main",
    branch: null,
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_alive",
  });
  // 'done' means the agent finished its turn and is idle at the prompt, but the
  // herdr pane is still alive (listed by `herdr agent list`). It must attach.
  deps.store.update(session.id, { status: "done", lastState: "done" });

  const server = serve({ ...deps, herdr: herdrWith("term_alive") }, 0);
  try {
    // A live-but-done session must NOT be closed with PTY_GONE_CODE. The attach
    // is allowed (socket opens); resolve with the close code only if the server
    // rejects it, else "open".
    const outcome = await new Promise<number | "open">((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/pty/${session.id}`);
      let settled = false;
      const done = (v: number | "open") => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      ws.onopen = () => {
        ws.close();
        done("open");
      };
      ws.onclose = (e) => done(e.code);
      ws.onerror = () => {};
      setTimeout(() => reject(new Error("timed out waiting for open/close")), 3000);
    });
    expect(outcome).not.toBe(PTY_GONE_CODE);
  } finally {
    server.stop();
  }
});

// ── Static / SPA serving ──────────────────────────────────────────────────────

const UI_INDEX = join(import.meta.dir, "..", "ui", "build", "index.html");

test.skipIf(!existsSync(UI_INDEX))("GET / serves the SPA index html", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("html");
});

test("GET /api/unknown still returns JSON 404 (not html)", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/unknown"));
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").toContain("json");
});

// ── WebSocket Origin guard (CSWSH) ────────────────────────────────────────────

test("WS /events with allowed Origin → not 403", async () => {
  const deps = makeDeps();
  const server = serve(deps, 0);
  try {
    const port = server.port;
    const res = await fetch(`http://localhost:${port}/events`, {
      headers: { Origin: "http://localhost:7330" },
    });
    // The upgrade will fail (plain fetch, not a WS client) → 500, but NOT 403
    expect(res.status).not.toBe(403);
  } finally {
    server.stop();
  }
});

// ── /api/repos + /api/todo ────────────────────────────────────────────────────

test("GET /api/repos → 200 + JSON array", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/repos"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
});

test("GET /api/branches?repo=<validRepo> → 200 with branches + current", async () => {
  const app = harness();
  const res = await app.fetch(
    new Request(`http://x/api/branches?repo=${encodeURIComponent(validRepo)}`),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.branches)).toBe(true);
  expect("current" in body).toBe(true);
});

test("GET /api/branches?repo=/etc → 400", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/branches?repo=/etc"));
  expect(res.status).toBe(400);
});

test("HEAD on a non-API route → 200, no body (not 404)", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/", { method: "HEAD" }));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
});

test("GET /api/todo?repo=/etc/passwd → 400", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/todo?repo=/etc/passwd"));
  expect(res.status).toBe(400);
});

// ── /api/issues ───────────────────────────────────────────────────────────────

test("GET /api/issues?repo=<validRepo> → 200 with slug + issues array", async () => {
  const app = harness();
  const res = await app.fetch(
    new Request(`http://x/api/issues?repo=${encodeURIComponent(validRepo)}`),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect("slug" in body).toBe(true);
  expect(Array.isArray(body.issues)).toBe(true);
});

test("GET /api/issues?repo=/etc → 400", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/issues?repo=/etc"));
  expect(res.status).toBe(400);
});

test("PUT /api/todo with evil Origin → 403", async () => {
  const app = harness();
  const res = await app.fetch(
    new Request(`http://x/api/todo?repo=${encodeURIComponent(validRepo)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Origin: "https://evil.com",
      },
      body: JSON.stringify({ content: "- [ ] test" }),
    }),
  );
  expect(res.status).toBe(403);
});

test("POST /api/uploads saves a staged image and returns its path", async () => {
  const app = harness();
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "s.png", { type: "image/png" }));
  const res = await app.fetch(new Request("http://x/api/uploads", { method: "POST", body: fd }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(stagingDir(config.repoRoot) + "/")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
  rmSync(body.path, { force: true });
});

test("POST /api/uploads rejects a non-image", async () => {
  const app = harness();
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1])], "s.pdf", { type: "application/pdf" }));
  const res = await app.fetch(new Request("http://x/api/uploads", { method: "POST", body: fd }));
  expect(res.status).toBe(415);
});

test("POST /api/sessions/:id/reply types into the agent and 404s unknown ids", async () => {
  const app = harness();
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();

  const ok = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "1" }),
    }),
  );
  expect(ok.status).toBe(200);

  const missing = await app.fetch(
    new Request(`http://x/api/sessions/does-not-exist/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "1" }),
    }),
  );
  expect(missing.status).toBe(404);

  const bad = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
    }),
  );
  expect(bad.status).toBe(400);

  const wrongType = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/reply`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "1",
    }),
  );
  expect(wrongType.status).toBe(415);
});

test("POST /api/sessions/:id/ready toggles the flag, emits session:ready, validates", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();

  const events: { event: string; data: unknown }[] = [];
  deps.events.subscribe((event, data) => events.push({ event, data }));

  const ok = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: true }),
    }),
  );
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  expect(deps.store.get(created.id)?.readyToMerge).toBe(true);
  expect(events).toEqual([{ event: "session:ready", data: { id: created.id, ready: true } }]);

  const off = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: false }),
    }),
  );
  expect(off.status).toBe(200);
  expect(deps.store.get(created.id)?.readyToMerge).toBe(false);

  const missing = await app.fetch(
    new Request(`http://x/api/sessions/does-not-exist/ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: true }),
    }),
  );
  expect(missing.status).toBe(404);

  const bad = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: "yes" }),
    }),
  );
  expect(bad.status).toBe(400);

  const wrongType = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/ready`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "1",
    }),
  );
  expect(wrongType.status).toBe(415);
});

test("POST /api/sessions/:id/resume brings a finished session back + emits running", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  deps.store.update(created.id, { status: "done", lastState: "done" });

  const events: { event: string; data: unknown }[] = [];
  deps.events.subscribe((event, data) => events.push({ event, data }));

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/resume`, { method: "POST" }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("running");
  expect(events).toContainEqual({
    event: "session:status",
    data: { id: created.id, status: "running" },
  });
});

test("POST /api/sessions/:id/resume 409s when there's nothing to resume", async () => {
  const res = await harness().fetch(
    new Request("http://x/api/sessions/nope/resume", { method: "POST" }),
  );
  expect(res.status).toBe(409);
});

// ── self-update routes ─────────────────────────────────────────────────────
function harnessWithUpdates(updates: AppDeps["updates"]) {
  return makeApp({ ...makeDeps(), updates });
}

test("GET /api/update with no updater returns a zeroed status", async () => {
  const res = await harness().fetch(new Request("http://x/api/update"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.behind).toBe(0);
});

test("GET /api/update returns the updater's current status", async () => {
  const status = {
    behind: 2,
    current: "abc1234",
    latest: "def5678",
    commits: [{ sha: "def5678", subject: "feat: x" }],
    checkedAt: 1,
  };
  const app = harnessWithUpdates({ current: () => status, apply: () => ({ started: true }) });
  const res = await app.fetch(new Request("http://x/api/update"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(status);
});

test("POST /api/update with no updater → 503", async () => {
  const res = await harness().fetch(new Request("http://x/api/update", { method: "POST" }));
  expect(res.status).toBe(503);
});

test("POST /api/update when up to date → 409", async () => {
  const app = harnessWithUpdates({
    current: () => ({ behind: 0, current: "a", latest: "a", commits: [], checkedAt: 1 }),
    apply: () => ({ started: true }),
  });
  const res = await app.fetch(new Request("http://x/api/update", { method: "POST" }));
  expect(res.status).toBe(409);
});

test("POST /api/update when behind triggers apply → 202", async () => {
  let applied = 0;
  const app = harnessWithUpdates({
    current: () => ({ behind: 1, current: "a", latest: "b", commits: [], checkedAt: 1 }),
    apply: () => {
      applied++;
      return { started: true };
    },
  });
  const res = await app.fetch(new Request("http://x/api/update", { method: "POST" }));
  expect(res.status).toBe(202);
  expect(applied).toBe(1);
});

test("POST /api/update that can't start → 409 carries the reason (not a bare code)", async () => {
  const app = harnessWithUpdates({
    current: () => ({ behind: 1, current: "a", latest: "b", commits: [], checkedAt: 1 }),
    apply: () => ({ started: false, error: "a deploy is already running" }),
  });
  const res = await app.fetch(new Request("http://x/api/update", { method: "POST" }));
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe("a deploy is already running");
});

test("GET /api/update/log returns the deploy state", async () => {
  const app = harnessWithUpdates({
    current: () => ({ behind: 1, current: "a", latest: "b", commits: [], checkedAt: 1 }),
    apply: () => ({ started: true }),
    applyState: () => ({ phase: "failed", exitCode: 1, log: "build failed: tsc error" }),
  });
  const res = await app.fetch(new Request("http://x/api/update/log"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    phase: "failed",
    exitCode: 1,
    log: "build failed: tsc error",
  });
});

test("GET /api/update/log with no updater → idle", async () => {
  const res = await harness().fetch(new Request("http://x/api/update/log"));
  expect(res.status).toBe(200);
  expect((await res.json()).phase).toBe("idle");
});

// ── /api/learnings ──────────────────────────────────────────────────────────

test("GET /api/learnings?repo=&status=proposed lists the repo's proposed learnings", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // safeRepoDir realpaths the dir; store by the same value so the query key matches
  const repo = realpathSync(validRepo);
  deps.store.addLearning({ repoPath: repo, rule: "use bun", rationale: "", evidence: [] });

  const res = await app.fetch(
    new Request(`http://x/api/learnings?repo=${encodeURIComponent(validRepo)}&status=proposed`),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBe(1);
  expect(body[0].rule).toBe("use bun");
});

test("POST /api/learnings/:id/approve sets status active and applies the rule override", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const repo = realpathSync(validRepo);
  const l = deps.store.addLearning({
    repoPath: repo,
    rule: "use bun",
    rationale: "",
    evidence: [],
  });

  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify({ rule: "new" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(deps.store.getLearning(l.id)?.status).toBe("active");
  expect(deps.store.getLearning(l.id)?.rule).toBe("new");
});

test("POST /api/learnings/:id/dismiss sets status dismissed", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const repo = realpathSync(validRepo);
  const l = deps.store.addLearning({
    repoPath: repo,
    rule: "use bun",
    rationale: "",
    evidence: [],
  });

  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/dismiss`, {
      method: "POST",
      headers: { Origin: "http://localhost:7330" },
    }),
  );
  expect(res.status).toBe(200);
  expect(deps.store.getLearning(l.id)?.status).toBe("dismissed");
});

test("POST /api/learnings/<bogus-id>/approve returns 404", async () => {
  const app = harness();
  const res = await app.fetch(
    new Request("http://x/api/learnings/does-not-exist/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "http://localhost:7330",
      },
      body: JSON.stringify({ rule: "anything" }),
    }),
  );
  expect(res.status).toBe(404);
});

test("GET /api/learnings/pending returns all proposed learnings across repos", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  deps.store.addLearning({ repoPath: "/x", rule: "p1", rationale: "", evidence: [] });

  const res = await app.fetch(new Request("http://x/api/learnings/pending"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBe(1);
  expect(body[0].rule).toBe("p1");
});
