import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, serve, type AppDeps } from "../src/server";
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
    } as any,
  });
  return { store, service, events };
}

function harness() {
  const deps = makeDeps();
  return makeApp(deps);
}

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
  expect(created.desig).toBe("UNIT-01");

  const list = await (await app.fetch(new Request("http://x/api/sessions"))).json();
  expect(list.length).toBe(1);
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
