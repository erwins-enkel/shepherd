import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stagingDir } from "../src/uploads";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, serve, PTY_GONE_CODE, claimLinkedIssue, type AppDeps } from "../src/server";
import { WorktreeMgr } from "../src/worktree";
import type { GitForge } from "../src/forge/types";
import { config, USAGE_HISTORY_RETENTION_MS } from "../src/config";
import { ACTIVE_LABEL } from "../src/drain-core";

// Create a real tmp dir inside config.repoRoot so validation passes
let tmpRoot: string;
let validRepo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-srv-test-"));
  validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

// liveTerminals: terminal ids herdr should report as live (drives reply()'s pane-liveness
// check). Defaults to none — resume/most tests assume the started pane is already dead.
function makeDeps(liveTerminals: string[] = []): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => {},
    } as any,
    herdr: {
      start: async () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => liveTerminals.map((terminalId) => ({ terminalId })),
      stop: async () => {},
      send: () => {},
    } as any,
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
  const distiller = { distillNow: async () => {} };
  return { store, service, events, usageLimits, distiller };
}

function harness() {
  const deps = makeDeps();
  return makeApp(deps);
}

test("GET /api/usage/limits returns limits + projections", async () => {
  const res = await harness().fetch(new Request("http://x/api/usage/limits"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    limits: {
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    },
    projections: [],
  });
});

test("GET /api/commands rejects invalid provider", async () => {
  const res = await harness().fetch(
    new Request(`http://x/api/commands?repo=${encodeURIComponent(validRepo)}&provider=mixed`),
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid provider" });
});

test("POST /api/usage/refresh calls refreshUsage and returns its fresh limits", async () => {
  const fresh = {
    session5h: { pct: 80, resetAt: 123 },
    week: { pct: 95, resetAt: 456 },
    perModelWeek: [],
    credits: {
      pct: 12,
      spent: 6,
      cap: 50,
      currency: "€",
      resetAt: 789,
      scrapedAt: 1,
      stale: false,
    },
    stale: false,
    calibratedAt: 1,
  };
  let called = 0;
  const deps = makeDeps();
  deps.refreshUsage = async () => {
    called++;
    return { limits: fresh, scraped: true } as any;
  };
  const res = await makeApp(deps).fetch(
    new Request("http://x/api/usage/refresh", { method: "POST" }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(fresh); // success returns the UNWRAPPED bare limits
  expect(called).toBe(1);
});

test("POST /api/usage/refresh fails closed (503) when the probe did not re-scrape", async () => {
  // A refresh that didn't actually re-scrape (scraped:false) must surface as an error, not a
  // silent 200 with stale numbers — so the client shows its retry state instead of "looks fine".
  const fresh = {
    session5h: null,
    week: null,
    perModelWeek: [],
    credits: {
      pct: 0,
      spent: 79.16,
      cap: 100,
      currency: "€",
      resetAt: 789,
      scrapedAt: 1,
      stale: true,
    },
    stale: true,
    calibratedAt: 1,
    subscriptionOnly: false,
  };
  const deps = makeDeps();
  deps.refreshUsage = async () => ({ limits: fresh, scraped: false }) as any;
  const res = await makeApp(deps).fetch(
    new Request("http://x/api/usage/refresh", { method: "POST" }),
  );
  expect(res.status).toBe(503);
  expect((await res.json()).code).toBe("refresh_stale");
});

test("POST /api/usage/refresh stays 200 for subscription-only even when scraped:false", async () => {
  // Subscription-only (api-key) attempts no scrape, so scraped:false there is expected, not a
  // failure — it must not trip the fail-closed path.
  const fresh = {
    session5h: null,
    week: null,
    perModelWeek: [],
    credits: null,
    stale: true,
    calibratedAt: null,
    subscriptionOnly: true,
  };
  const deps = makeDeps();
  deps.refreshUsage = async () => ({ limits: fresh, scraped: false }) as any;
  const res = await makeApp(deps).fetch(
    new Request("http://x/api/usage/refresh", { method: "POST" }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(fresh);
});

test("POST /api/usage/refresh without refreshUsage falls back to current limits snapshot", async () => {
  const res = await harness().fetch(new Request("http://x/api/usage/refresh", { method: "POST" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    session5h: null,
    week: null,
    perModelWeek: [],
    credits: null,
    stale: true,
    calibratedAt: null,
    subscriptionOnly: false,
  });
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

test("POST /api/sessions returns 422 when the selected base does not resolve to a commit", async () => {
  const unbornRepo = join(tmpRoot, "unborn");
  mkdirSync(unbornRepo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: unbornRepo });

  const deps = makeDeps();
  deps.service = new SessionService({
    store: deps.store,
    namer: async () => "x",
    worktree: new WorktreeMgr(),
    herdr: {
      start: async () => {
        throw new Error("herdr should not start for a missing base ref");
      },
      list: () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    events: deps.events,
  });

  const res = await postSessions(makeApp(deps), {
    repoPath: unbornRepo,
    baseBranch: "main",
    prompt: "go",
  });

  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error).toContain('base ref "main" does not resolve to a commit');
  expect(body.error).toContain("create an initial commit");
  expect(body.error).toContain("choose an existing base branch");
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
function harnessWithReaper(reaper: { detect: any; reap: any; stopListenersOnPort?: any }) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const fullReaper = { stopListenersOnPort: () => 0, ...reaper };
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => {},
    } as any,
    herdr: {
      start: async () => ({}) as any,
      list: () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    reaper: fullReaper,
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
  const app = makeApp({
    store,
    service,
    events,
    usageLimits,
    distiller: { distillNow: async () => {} },
  });
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

test("WS /events with preview-port Origin → 403 (CSRF guard covers WS upgrade)", async () => {
  const deps = makeDeps();
  const server = serve(deps, 0);
  try {
    const port = server.port;
    // config.allowedOriginHosts includes "localhost"; config.previewPortBase=8001,
    // count=16 → [8001,8017). Port 8005 ∈ that range — must be rejected even though
    // the hostname is allowlisted.
    const res = await fetch(`http://localhost:${port}/events`, {
      headers: { Origin: `http://localhost:${config.previewPortBase + 4}` },
    });
    expect(res.status).toBe(403);
  } finally {
    server.stop();
  }
});

test("WS /pty/:id with preview-port Origin → 403 (CSRF guard covers WS upgrade)", async () => {
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
    herdrAgentId: "term_65306e7cb9451a",
  });
  const server = serve(deps, 0);
  try {
    const port = server.port;
    // A preview-port origin on the allowlisted hostname must still be rejected —
    // /pty is bidirectional (keystrokes reach the agent terminal).
    const res = await fetch(`http://localhost:${port}/pty/${session.id}`, {
      headers: { Origin: `http://localhost:${config.previewPortBase + 4}` },
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

test("GET /api/repos → 200 + { repos, recentWindowDays }", async () => {
  const app = harness();
  const res = await app.fetch(new Request("http://x/api/repos"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.repos)).toBe(true);
  expect(typeof body.recentWindowDays).toBe("number");
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

test("POST /api/repos/init-empty-commit creates an initial commit", async () => {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: validRepo });
  const app = harness();
  const res = await app.fetch(
    new Request("http://x/api/repos/init-empty-commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: validRepo, branch: "main" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ branch: "main" });
  const sha = execFileSync("git", ["rev-parse", "--verify", "main^{commit}"], {
    cwd: validRepo,
  })
    .toString()
    .trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
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

test("POST /api/uploads saves a staged attachment and returns its path", async () => {
  const app = harness();
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "s.pdf", { type: "application/pdf" }));
  const res = await app.fetch(new Request("http://x/api/uploads", { method: "POST", body: fd }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.path.startsWith(stagingDir(config.repoRoot) + "/")).toBe(true);
  expect(body.path.endsWith(".pdf")).toBe(true);
  expect(existsSync(body.path)).toBe(true);
  rmSync(body.path, { force: true });
});

test("POST /api/uploads?session rejects a non-image for the live terminal image workflow", async () => {
  const app = makeApp(makeDeps(["term_x"]));
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([1])], "s.pdf", { type: "application/pdf" }));
  const res = await app.fetch(
    new Request(`http://x/api/uploads?session=${created.id}`, { method: "POST", body: fd }),
  );
  expect(res.status).toBe(415);
});

test("POST /api/sessions/:id/reply types into the agent and 404s unknown ids", async () => {
  const app = makeApp(makeDeps(["term_x"])); // created session's pane (term_x) reads as live
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
test("POST /api/learnings/:id/approve with an empty rule keeps the stored rule", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const l = deps.store.addLearning({
    repoPath: realpathSync(validRepo),
    rule: "keep me",
    rationale: "",
    evidence: [],
  });
  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify({ rule: "   " }),
    }),
  );
  expect(res.status).toBe(200);
  expect(deps.store.getLearning(l.id)?.status).toBe("active");
  expect(deps.store.getLearning(l.id)?.rule).toBe("keep me"); // blank edit ignored
});
test("POST /api/learnings/:id/approve caps an over-long rule to 240 chars", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const l = deps.store.addLearning({
    repoPath: realpathSync(validRepo),
    rule: "x",
    rationale: "",
    evidence: [],
  });
  const res = await app.fetch(
    new Request(`http://x/api/learnings/${l.id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify({ rule: "a".repeat(300) }),
    }),
  );
  expect(res.status).toBe(200);
  expect(deps.store.getLearning(l.id)?.rule.length).toBe(240);
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

test("GET /api/learnings/pending resolves cited evidence into kinds + source detail", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const sess = deps.store.create({
    name: "x",
    prompt: "x",
    repoPath: "/x",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
  const a = deps.store.addSignal({
    repoPath: "/x",
    sessionId: sess.id,
    kind: "reply",
    payload: "use bun,\n  not npm",
  });
  const b = deps.store.addSignal({ repoPath: "/x", sessionId: null, kind: "critic", payload: "b" });
  deps.store.addLearning({
    repoPath: "/x",
    rule: "p1",
    rationale: "",
    evidence: [a.id, b.id, "pruned"],
  });

  const res = await app.fetch(new Request("http://x/api/learnings/pending"));
  const body = await res.json();
  expect(body[0].evidenceKinds).toEqual({ reply: 1, critic: 1 });
  // newest first; pruned id dropped; multi-line payload flattened to one line;
  // reply resolves to its source session designation, the orphan critic to null.
  expect(body[0].evidenceDetail).toEqual([
    { id: b.id, kind: "critic", desig: null, excerpt: "b", ts: expect.any(Number) },
    {
      id: a.id,
      kind: "reply",
      desig: sess.desig,
      excerpt: "use bun, not npm",
      ts: expect.any(Number),
    },
  ]);
});

test("GET /api/learnings/pending excerpt truncates on code points (no split surrogate)", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // emoji straddles the 140-unit cut: a naive slice would keep a lone surrogate
  const payload = "x".repeat(138) + "😀yy";
  const s = deps.store.addSignal({ repoPath: "/x", sessionId: null, kind: "reply", payload });
  deps.store.addLearning({ repoPath: "/x", rule: "p", rationale: "", evidence: [s.id] });

  const res = await app.fetch(new Request("http://x/api/learnings/pending"));
  const body = await res.json();
  expect(body[0].evidenceDetail[0].excerpt).toBe("x".repeat(138) + "😀…");
});

test("GET /api/learnings/injectable returns per-repo injected flags + budget numbers", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // 40 max-ish-length active rules on /big → some over the 4000 budget.
  for (let i = 0; i < 40; i++) {
    const r = deps.store.addLearning({
      repoPath: "/big",
      rule: `R${String(i).padStart(2, "0")}-` + "x".repeat(150),
      rationale: "",
      evidence: [],
    });
    deps.store.setLearningStatus(r.id, "active");
  }
  // one small repo, all fit
  const s = deps.store.addLearning({
    repoPath: "/small",
    rule: "tiny",
    rationale: "",
    evidence: [],
  });
  deps.store.setLearningStatus(s.id, "active");

  const res = await app.fetch(new Request("http://x/api/learnings/injectable"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);

  const big = body.find((e: any) => e.repoPath === "/big");
  expect(big.enabled).toBe(true);
  expect(big.budgetChars).toBe(4000);
  expect(big.usedChars).toBeGreaterThan(0);
  expect(big.usedChars).toBeLessThanOrEqual(4000);
  expect(big.rules.length).toBe(40);
  const injected = big.rules.filter((r: any) => r.injected).length;
  expect(injected).toBeGreaterThan(0);
  expect(injected).toBeLessThan(40);
  // every rule carries the injected flag
  expect(big.rules.every((r: any) => typeof r.injected === "boolean")).toBe(true);

  const small = body.find((e: any) => e.repoPath === "/small");
  expect(small.rules.length).toBe(1);
  expect(small.rules[0].injected).toBe(true);
});

test("GET /api/learnings/injectable marks all rules uninjected when learnings disabled", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const r = deps.store.addLearning({
    repoPath: "/off",
    rule: "use bun",
    rationale: "",
    evidence: [],
  });
  deps.store.setLearningStatus(r.id, "active");
  deps.store.setRepoConfig("/off", {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    sandboxProfile: "trusted",
    defaultModel: "inherit",
    defaultEffort: "inherit",
    previewOpenMode: "ask",
    egressExtraHosts: [],
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
  });

  const res = await app.fetch(new Request("http://x/api/learnings/injectable"));
  expect(res.status).toBe(200);
  const body = await res.json();
  const off = body.find((e: any) => e.repoPath === "/off");
  expect(off.enabled).toBe(false);
  expect(off.usedChars).toBe(0);
  expect(off.budgetChars).toBe(4000);
  expect(off.rules.length).toBe(1);
  expect(off.rules[0].injected).toBe(false);
});

// ── /api/learnings/health ────────────────────────────────────────────────────

test("GET /api/learnings/health returns distiller health when health() present", async () => {
  const deps = makeDeps();
  const unhealthy = {
    ok: false,
    consecutiveFailures: 3,
    lastFailure: { reason: "spawn", at: 1, repoPath: "/r" },
  };
  deps.distiller = { distillNow: async () => {}, health: () => unhealthy };
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://x/api/learnings/health"));
  expect(res.status).toBe(200);
  const body = await res.json();
  // top-level fields are the distiller's; optimizer is additive
  expect(body).toMatchObject(unhealthy);
  expect(body).toHaveProperty("optimizer");
});

test("GET /api/learnings/health returns safe default when distiller lacks health()", async () => {
  const deps = makeDeps(); // distiller = { distillNow: async () => {} } — no health
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://x/api/learnings/health"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, consecutiveFailures: 0, lastFailure: null });
  expect(body).toHaveProperty("optimizer");
});

// ── clear-all-merged endpoint ────────────────────────────────────────────────
// Build an app with a mutable stub prCache (the merged source of truth) + reaper.
// Rows get random ids, so we create them first, then seed each session's PR state.
function clearMergedHarness() {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const emitted: string[] = [];
  events.subscribe((event, data: any) => {
    if (event === "session:archived") emitted.push(data.id);
  });
  const detect = (sess: any): any[] => [
    { kind: "process", name: "vite", port: null, key: `process:${sess.name}` },
  ];
  const reaped: string[] = [];
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({}) as any,
      ensureBaseRef: async () => {},
      remove: () => {},
      branchExists: () => false,
    } as any,
    herdr: {
      start: async () => ({}) as any,
      list: () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    reaper: {
      detect,
      reap: (ls: any[]) => reaped.push(...ls.map((l) => l.key)),
      stopListenersOnPort: () => 0,
    },
    events,
  });
  const cache = new Map<string, any>();
  const dropped: string[] = [];
  const prCache = {
    snapshot: () => Object.fromEntries(cache),
    set: (id: string, g: any) => cache.set(id, g),
    drop: (id: string) => {
      dropped.push(id);
      cache.delete(id);
    },
  };
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
  const app = makeApp({ store, service, events, usageLimits, prCache } as any);
  const mk = (name: string, state: string) => {
    const s = store.create({
      name,
      prompt: "p",
      repoPath: "/r",
      baseBranch: "main",
      branch: `shepherd/${name}`,
      worktreePath: `/wt/${name}`,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: `term_${name}`,
    });
    cache.set(s.id, { state });
    return s;
  };
  return { app, store, mk, emitted, reaped, dropped };
}

const clearMergedPost = (app: any, body: unknown) =>
  app.fetch(
    new Request("http://x/api/sessions/clear-merged", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify(body),
    }),
  );

test("GET /api/sessions/clear-merged lists only merged ids and totals their leftovers", async () => {
  const h = clearMergedHarness();
  const a = h.mk("a", "merged");
  const b = h.mk("b", "merged");
  h.mk("c", "open"); // not merged → excluded
  const res = await h.app.fetch(new Request("http://x/api/sessions/clear-merged"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(new Set(body.ids)).toEqual(new Set([a.id, b.id]));
  expect(body.leftovers).toBe(2); // one detected leftover per merged session
});

test("POST /api/sessions/clear-merged archives only merged sessions, ignoring others", async () => {
  const h = clearMergedHarness();
  const a = h.mk("a", "merged");
  const b = h.mk("b", "merged");
  const c = h.mk("c", "open");
  // client over-sends: an open session + a bogus id. The server re-validates against
  // its own merged set, so only the truly-merged rows are cleared.
  const res = await clearMergedPost(h.app, { ids: [a.id, b.id, c.id, "bogus"] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(new Set(body.cleared)).toEqual(new Set([a.id, b.id]));
  expect(body.leftovers).toBe(2);
  expect(h.store.get(a.id)?.status).toBe("archived");
  expect(h.store.get(b.id)?.status).toBe("archived");
  expect(h.store.get(c.id)?.status).not.toBe("archived"); // open PR left alone
  expect(new Set(h.emitted)).toEqual(new Set([a.id, b.id])); // session:archived per cleared
  expect(new Set(h.reaped)).toEqual(new Set(["process:a", "process:b"])); // leftovers killed
  expect(new Set(h.dropped)).toEqual(new Set([a.id, b.id])); // prCache dropped
});

test("POST /api/sessions/clear-merged with no ids falls back to the full merged set", async () => {
  const h = clearMergedHarness();
  const a = h.mk("a", "merged");
  h.mk("b", "open");
  const res = await clearMergedPost(h.app, {});
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ cleared: [a.id] });
});

test("POST /api/sessions/clear-merged with an explicit empty array clears nothing", async () => {
  const h = clearMergedHarness();
  h.mk("a", "merged");
  const res = await clearMergedPost(h.app, { ids: [] });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ cleared: [] }); // [] ≠ absent → no fallback
  expect(h.emitted).toEqual([]);
});

test("DELETE /api/sessions/clear-merged → 405, never archives the literal segment", async () => {
  const h = clearMergedHarness();
  h.mk("a", "merged");
  const res = await h.app.fetch(
    new Request("http://x/api/sessions/clear-merged", {
      method: "DELETE",
      headers: { Origin: "http://localhost:7330" },
    }),
  );
  expect(res.status).toBe(405); // doesn't fall through to handleSessionDelete
  expect(h.emitted).toEqual([]); // no spurious session:archived for "clear-merged"
});

// ── POST /api/repos ──────────────────────────────────────────────────────────

function postRepos(app: ReturnType<typeof makeApp>, body: unknown, headers?: HeadersInit) {
  return app.fetch(
    new Request("http://x/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /api/repos missing Content-Type → 415", async () => {
  const app = harness();
  const res = await app.fetch(
    new Request("http://x/api/repos", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ url: "https://github.com/owner/repo" }),
    }),
  );
  expect(res.status).toBe(415);
});

test("POST /api/repos bad url body → 400", async () => {
  const app = harness();
  const res = await postRepos(app, { url: "not-a-valid-url" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("clonerepo_failed_url");
});

// Note: validateCloneUrl intentionally blocks file:// URLs (only https:// and scp git@ allowed).
// The 201 happy path is fully covered by the cloneRepo unit test in repos.test.ts.
// Here we verify that an unreachable https URL correctly routes through the clone attempt
// and returns 422 (clone failed, not a validation error), confirming the POST branch wiring.
test("POST /api/repos unreachable https url → 422 (clone attempted, not a validation error)", async () => {
  const app = harness();
  const res = await postRepos(app, { url: "https://nonexistent.invalid/owner/my-test-repo" });
  // 400 would mean validation failed; 422 means validation passed but clone failed
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(typeof body.error).toBe("string");
  expect(body.error).toMatch(/^clonerepo_/);
});

test("POST /api/repos target already exists → 409", async () => {
  // Pre-create the target directory inside repoRoot so cloneRepo returns clonerepo_failed_exists
  // before attempting any network access. Uses a well-formed https URL that passes validateCloneUrl.
  const targetName = "my-repo-exists-test";
  mkdirSync(join(config.repoRoot, targetName), { recursive: true });
  try {
    const app = harness();
    // URL slug's last segment must match targetName; validateCloneUrl strips .git suffix
    const res = await postRepos(app, {
      url: `https://github.com/owner/${targetName}.git`,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("clonerepo_failed_exists");
  } finally {
    rmSync(join(config.repoRoot, targetName), { recursive: true, force: true });
  }
});

test("POST /api/repos with foreign Origin → 403", async () => {
  const app = harness();
  const res = await postRepos(
    app,
    { url: "https://github.com/owner/repo" },
    { Origin: "https://evil.com" },
  );
  expect(res.status).toBe(403);
});

// ── autoMergeEnabled repo-config + per-session override ─────────────────────

function putRepoConfig(app: ReturnType<typeof makeApp>, repo: string, body: unknown) {
  return app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repo)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify(body),
    }),
  );
}

function putSessionAutoMerge(app: ReturnType<typeof makeApp>, id: string, body: unknown) {
  return app.fetch(
    new Request(`http://x/api/sessions/${id}/automerge`, {
      method: "PUT",
      headers: { "content-type": "application/json", Origin: "http://localhost:7330" },
      body: JSON.stringify(body),
    }),
  );
}

test("PUT /api/repo-config accepts autoMergeEnabled", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { autoMergeEnabled: true });
  expect(res.status).toBe(200);
  expect(deps.store.getRepoConfig(validRepo).autoMergeEnabled).toBe(true);
});

test("PUT /api/repo-config rejects non-boolean autoMergeEnabled", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { autoMergeEnabled: "yes" });
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config error message includes autoMergeEnabled in boolean fields list", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { autoMergeEnabled: 1 });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("autoMergeEnabled");
});

test("PUT /api/repo-config empty body error message includes autoMergeEnabled", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, {});
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("autoMergeEnabled");
});

// ── preWarmEpicLandingCi repo-config (#1664) ─────────────────────────────────

test("PUT /api/repo-config accepts preWarmEpicLandingCi true → 200 and GET reflects it", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { preWarmEpicLandingCi: true });
  expect(res.status).toBe(200);
  expect(deps.store.getRepoConfig(validRepo).preWarmEpicLandingCi).toBe(true);
});

test("PUT /api/repo-config rejects non-boolean preWarmEpicLandingCi", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { preWarmEpicLandingCi: "yes" });
  expect(res.status).toBe(400);
});

// ── draftMode + signoffAuthority repo-config ─────────────────────────────────

test("PUT /api/repo-config accepts draftMode true", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { draftMode: true });
  expect(res.status).toBe(200);
  expect(deps.store.getRepoConfig(validRepo).draftMode).toBe(true);
});

test("PUT /api/repo-config rejects non-boolean draftMode", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { draftMode: "yes" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("draftMode");
});

test("PUT /api/repo-config draftMode + autoMergeEnabled together → 400 mutual exclusivity", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { draftMode: true, autoMergeEnabled: true });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("mutually exclusive");
});

test("PUT /api/repo-config enabling draftMode on an existing autoMerge repo → 400", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // first enable autoMerge
  await putRepoConfig(app, validRepo, { autoMergeEnabled: true });
  // now try to enable draftMode — should be rejected
  const res = await putRepoConfig(app, validRepo, { draftMode: true });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("mutually exclusive");
});

test("PUT /api/repo-config enabling autoMerge on an existing draftMode repo → 400", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // first enable draftMode
  await putRepoConfig(app, validRepo, { draftMode: true });
  // now try to enable autoMerge — should be rejected
  const res = await putRepoConfig(app, validRepo, { autoMergeEnabled: true });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("mutually exclusive");
});

test("PUT /api/repo-config accepts signoffAuthority valid values", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  for (const v of ["human", "critic", "either"] as const) {
    const res = await putRepoConfig(app, validRepo, { signoffAuthority: v });
    expect(res.status).toBe(200);
    expect(deps.store.getRepoConfig(validRepo).signoffAuthority).toBe(v);
  }
});

test("PUT /api/repo-config draftMode + critic authority while critic OFF → 400 (would deadlock)", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, {
    draftMode: true,
    signoffAuthority: "critic",
    criticEnabled: false,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("requires criticEnabled");
});

test("PUT /api/repo-config draftMode + either authority while critic OFF → 400", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, {
    draftMode: true,
    signoffAuthority: "either",
    criticEnabled: false,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("requires criticEnabled");
});

test("PUT /api/repo-config draftMode + human authority while critic OFF → 200 (human needs no critic)", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, {
    draftMode: true,
    signoffAuthority: "human",
    criticEnabled: false,
  });
  expect(res.status).toBe(200);
});

test("PUT /api/repo-config turning critic OFF on a draftMode+critic-authority repo → 400 (both orderings)", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // critic on by default → draftMode + critic authority is fine
  await putRepoConfig(app, validRepo, { draftMode: true, signoffAuthority: "critic" });
  // now disabling the critic would strand the draft → rejected
  const res = await putRepoConfig(app, validRepo, { criticEnabled: false });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("requires criticEnabled");
});

test("PUT /api/repo-config rejects unknown signoffAuthority", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { signoffAuthority: "nobody" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("signoffAuthority");
});

test("PUT /api/repo-config empty body error message includes draftMode and signoffAuthority", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, {});
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("draftMode");
  expect(body.error).toContain("signoffAuthority");
});

// ── sandboxProfile repo-config ─────────────────────────────────────────────────

test("PUT /api/repo-config accepts sandboxProfile autonomous → 200 and GET reflects it", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { sandboxProfile: "autonomous" });
  expect(res.status).toBe(200);
  expect(deps.store.getRepoConfig(validRepo).sandboxProfile).toBe("autonomous");
});

test("PUT /api/repo-config rejects unknown sandboxProfile → 400 with error message", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { sandboxProfile: "bogus" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("sandboxProfile");
});

test("PUT /api/repo-config with only sandboxProfile is present → not empty-patch 400", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { sandboxProfile: "standard" });
  expect(res.status).toBe(200);
});

test("PUT /api/repo-config omitting sandboxProfile preserves existing value", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  // Set sandboxProfile to autonomous first
  await putRepoConfig(app, validRepo, { sandboxProfile: "autonomous" });
  expect(deps.store.getRepoConfig(validRepo).sandboxProfile).toBe("autonomous");
  // PUT without sandboxProfile — should preserve autonomous
  await putRepoConfig(app, validRepo, { criticEnabled: true });
  expect(deps.store.getRepoConfig(validRepo).sandboxProfile).toBe("autonomous");
});

// ── defaultModel repo-config override ──────────────────────────────────────────

test("PUT /api/repo-config accepts defaultModel override → 200 and GET reflects it", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  expect(deps.store.getRepoConfig(validRepo).defaultModel).toBe("inherit");
  const res = await putRepoConfig(app, validRepo, { defaultModel: "opus" });
  expect(res.status).toBe(200);
  expect(deps.store.getRepoConfig(validRepo).defaultModel).toBe("opus");
});

test("PUT /api/repo-config rejects unknown defaultModel → 400 with error message", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putRepoConfig(app, validRepo, { defaultModel: "gpt4" });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain("defaultModel");
});

test("PUT /api/repo-config omitting defaultModel preserves existing override", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  await putRepoConfig(app, validRepo, { defaultModel: "haiku" });
  await putRepoConfig(app, validRepo, { criticEnabled: true });
  expect(deps.store.getRepoConfig(validRepo).defaultModel).toBe("haiku");
});

test("PUT /api/sessions/:id/automerge sets the override", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const id = created.id;

  const res = await putSessionAutoMerge(app, id, { enabled: true });
  expect(res.status).toBe(200);
  expect(deps.store.get(id)!.autoMergeEnabled).toBe(true);

  const res2 = await putSessionAutoMerge(app, id, { enabled: null });
  expect(res2.status).toBe(200);
  expect(deps.store.get(id)!.autoMergeEnabled).toBeNull();
});

test("PUT /api/sessions/:id/automerge rejects non-boolean/non-null enabled", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const res = await putSessionAutoMerge(app, created.id, { enabled: "yes" });
  expect(res.status).toBe(400);
});

test("PUT /api/sessions/:id/automerge 404s for unknown session", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const res = await putSessionAutoMerge(app, "does-not-exist", { enabled: true });
  expect(res.status).toBe(404);
});

test("GET /api/automerge returns empty array when dep absent", async () => {
  const res = await harness().fetch(new Request("http://x/api/automerge"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([]);
});

test("PUT /api/sessions/:id/automerge emits session:automerge with the new override", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();
  const id = created.id;

  const emitted: { event: string; data: unknown }[] = [];
  deps.events.subscribe((event, data) => emitted.push({ event, data }));

  const res = await putSessionAutoMerge(app, id, { enabled: true });
  expect(res.status).toBe(200);
  expect(emitted).toContainEqual({
    event: "session:automerge",
    data: { id, enabled: true },
  });
});

test("claimLinkedIssue stamps the active label on the linked issue", async () => {
  const calls: { number: number; label: string }[] = [];
  const forge = {
    addIssueLabel: async (number: number, label: string) => {
      calls.push({ number, label });
    },
  } as unknown as GitForge;
  await claimLinkedIssue(forge, 42);
  expect(calls).toEqual([{ number: 42, label: ACTIVE_LABEL }]);
});

test("claimLinkedIssue is a no-op without a forge", async () => {
  await expect(claimLinkedIssue(null, 42)).resolves.toBeUndefined();
});

test("claimLinkedIssue tolerates a forge lacking addIssueLabel", async () => {
  const forge = {} as unknown as GitForge;
  await expect(claimLinkedIssue(forge, 42)).resolves.toBeUndefined();
});

test("claimLinkedIssue swallows an addIssueLabel rejection", async () => {
  const forge = {
    addIssueLabel: async () => {
      throw new Error("label api boom");
    },
  } as unknown as GitForge;
  await expect(claimLinkedIssue(forge, 42)).resolves.toBeUndefined();
});

// ── GET /api/preview — serve status merge ─────────────────────────────────────

test("GET /api/preview merges serve status into preview snapshot", async () => {
  const deps = makeDeps() as AppDeps;
  deps.preview = {
    snapshot: () => ({
      s1: { previewPort: 8001 },
      s2: { previewPort: 8002 },
    }),
  };
  (deps as any).previewServe = {
    snapshot: () => ({ s1: "failed" }),
  };
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://x/api/preview"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, { previewPort: number; serve?: string }>;
  expect(body.s1).toEqual({ previewPort: 8001, serve: "failed" });
  // s2 has no serve entry — field should be absent
  expect(body.s2).toEqual({ previewPort: 8002 });
  expect((body.s2 as any).serve).toBeUndefined();
});

test("GET /api/preview without previewServe dep returns unchanged snapshot (back-compat)", async () => {
  const deps = makeDeps() as AppDeps;
  deps.preview = {
    snapshot: () => ({
      s1: { previewPort: 8001 },
    }),
  };
  // previewServe intentionally absent
  const app = makeApp(deps);
  const res = await app.fetch(new Request("http://x/api/preview"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, { previewPort: number; serve?: string }>;
  expect(body.s1).toEqual({ previewPort: 8001 });
  expect((body.s1 as any).serve).toBeUndefined();
});

// ── POST /api/sessions/:id/preview/stop ──────────────────────────────────────

// Build a harness that wires service-level reaper + preview deps so stopPreview
// returns controllable outcomes. devPortFor returns the configured port (or null),
// stopListenersOnPort returns the configured killed count.
function harnessWithPreviewStop({
  devPortFor,
  stopListenersOnPort,
}: {
  devPortFor: (id: string) => number | null;
  stopListenersOnPort: (worktreePath: string, port: number, signal: NodeJS.Signals) => number;
}) {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt/x", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => {},
    } as any,
    herdr: {
      start: async () => ({}) as any,
      list: () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    reaper: { detect: () => [], reap: () => {}, stopListenersOnPort },
    preview: { devPortFor },
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
  const app = makeApp({
    store,
    service,
    events,
    usageLimits,
    distiller: { distillNow: async () => {} },
  });
  return { app, store };
}

const previewStop = (app: ReturnType<typeof makeApp>, id: string) =>
  app.fetch(
    new Request(`http://x/api/sessions/${id}/preview/stop`, {
      method: "POST",
    }),
  );

test("POST /api/sessions/:id/preview/stop → 404 for unknown session id", async () => {
  const { app } = harnessWithPreviewStop({
    devPortFor: () => null,
    stopListenersOnPort: () => 0,
  });
  const res = await previewStop(app, "does-not-exist");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});

test("POST /api/sessions/:id/preview/stop → 409 when no live preview bound", async () => {
  const { app, store } = harnessWithPreviewStop({
    devPortFor: () => null, // no preview bound
    stopListenersOnPort: () => 0,
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
  const res = await previewStop(app, s.id);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "not_bound" });
});

test("POST /api/sessions/:id/preview/stop → 200 with killed count (happy path)", async () => {
  const signalCalls: { worktreePath: string; port: number; signal: NodeJS.Signals }[] = [];
  const { app, store } = harnessWithPreviewStop({
    devPortFor: () => 5173,
    stopListenersOnPort: (worktreePath, port, signal) => {
      signalCalls.push({ worktreePath, port, signal });
      return 2;
    },
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
  const res = await previewStop(app, s.id);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ killed: 2 });
  expect(signalCalls).toEqual([{ worktreePath: "/wt/x", port: 5173, signal: "SIGKILL" }]);
});

test("POST /api/sessions/:id/preview/stop → 200 {killed:0} is not an error", async () => {
  const { app, store } = harnessWithPreviewStop({
    devPortFor: () => 5173,
    stopListenersOnPort: () => 0,
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
  const res = await previewStop(app, s.id);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ killed: 0 });
});

test("GET /api/sessions/:id/preview/stop (wrong method) → falls through router (non-200)", async () => {
  const { app, store } = harnessWithPreviewStop({
    devPortFor: () => 5173,
    stopListenersOnPort: () => 0,
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
  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}/preview/stop`));
  expect(res.status).not.toBe(200);
});

// ── GET /api/usage/history ─────────────────────────────────────────────────

test("GET /api/usage/history returns empty arrays when no history rows exist", async () => {
  const res = await harness().fetch(new Request("http://x/api/usage/history"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.caps.session5h).toEqual([]);
  expect(body.caps.week).toEqual([]);
  expect(body.credit).toEqual([]);
  expect(typeof body.since).toBe("number");
});

test("GET /api/usage/history returns cap rows split by window in ASC scrapedAt order", async () => {
  const now = Date.now();
  const deps = makeDeps();

  // Insert two session5h rows at different times
  deps.store.putCap({
    window: "session5h",
    cap: 100,
    resetAt: now - 1000,
    pct: 10,
    scrapedAt: now - 200,
  });
  deps.store.putCap({
    window: "session5h",
    cap: 100,
    resetAt: now - 1000,
    pct: 20,
    scrapedAt: now - 100,
  });
  // Insert one week row
  deps.store.putCap({
    window: "week",
    cap: 1000,
    resetAt: now - 5000,
    pct: 30,
    scrapedAt: now - 150,
  });

  const res = await makeApp(deps).fetch(new Request("http://x/api/usage/history"));
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.caps.session5h).toHaveLength(2);
  expect(body.caps.session5h[0].pct).toBe(10);
  expect(body.caps.session5h[1].pct).toBe(20);
  expect(body.caps.session5h[0].window).toBe("session5h");

  expect(body.caps.week).toHaveLength(1);
  expect(body.caps.week[0].pct).toBe(30);
  expect(body.caps.week[0].window).toBe("week");

  expect(body.credit).toEqual([]);
});

test("GET /api/usage/history returns credit snapshots and since equals now - USAGE_HISTORY_RETENTION_MS", async () => {
  const now = Date.now();
  const deps = makeDeps();

  deps.store.putCreditSnapshot({
    spent: 5,
    cap: 50,
    currency: "€",
    pct: 10,
    resetAt: now - 3000,
    scrapedAt: now - 100,
  });

  const res = await makeApp(deps).fetch(new Request("http://x/api/usage/history"));
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.credit).toHaveLength(1);
  expect(body.credit[0]).toEqual({
    spent: 5,
    cap: 50,
    currency: "€",
    pct: 10,
    resetAt: now - 3000,
    scrapedAt: now - 100,
  });

  // since must be approximately now - USAGE_HISTORY_RETENTION_MS (within 1s)
  expect(Math.abs(body.since - (Date.now() - USAGE_HISTORY_RETENTION_MS))).toBeLessThan(1000);
});

test("GET /api/usage/history does not return rows older than retention window", async () => {
  const now = Date.now();
  const deps = makeDeps();

  const oldTs = now - USAGE_HISTORY_RETENTION_MS - 10000; // older than retention
  // Directly insert an old row via the store's internal db to bypass putCap which writes current time
  (deps.store as any).db.run(
    `INSERT INTO usage_caps_history (window, cap, resetAt, pct, scrapedAt) VALUES (?,?,?,?,?)`,
    ["session5h", 100, now - 5000, 99, oldTs],
  );
  // Also insert a recent row
  deps.store.putCap({
    window: "session5h",
    cap: 100,
    resetAt: now - 1000,
    pct: 50,
    scrapedAt: now - 50,
  });

  const res = await makeApp(deps).fetch(new Request("http://x/api/usage/history"));
  expect(res.status).toBe(200);
  const body = await res.json();

  // Only the recent row should appear
  expect(body.caps.session5h).toHaveLength(1);
  expect(body.caps.session5h[0].pct).toBe(50);
});
