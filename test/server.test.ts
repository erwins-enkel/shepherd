import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp } from "../src/server";
import { config } from "../src/config";

// Create a real tmp dir inside config.repoRoot so validation passes
let tmpRoot: string;
let validRepo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "tank-srv-test-"));
  validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness() {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "tank/x", isolated: true }),
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
    } as any,
  });
  return makeApp({ store, service, events });
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
