import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-autopilot-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

// ── PUT /api/repo-config accepts autopilotEnabled ────────────────────────────

test("PUT /api/repo-config accepts autopilotEnabled", async () => {
  const { app, store: s } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;

  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autopilotEnabled: true }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.autopilotEnabled).toBe(true);
  expect(s.getRepoConfig(repoDir).autopilotEnabled).toBe(true);
});

test("PUT /api/repo-config autopilotEnabled preserved across other field updates", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;

  // First set autopilotEnabled
  await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autopilotEnabled: true }),
    }),
  );

  // Then update a different field — autopilotEnabled must be preserved
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criticEnabled: false }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.autopilotEnabled).toBe(true);
  expect(body.criticEnabled).toBe(false);
});

test("PUT /api/repo-config with only autopilotEnabled does not 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autopilotEnabled: false }),
    }),
  );
  expect(res.status).toBe(200);
});

test("PUT /api/repo-config with non-boolean autopilotEnabled → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autopilotEnabled: "yes" }),
    }),
  );
  expect(res.status).toBe(400);
});

// ── PUT /api/sessions/:id/autopilot ──────────────────────────────────────────

function makeSession(store: SessionStore, repoPath: string) {
  return store.create({
    name: "test-session",
    prompt: "do something",
    repoPath,
    baseBranch: "main",
    branch: "shepherd/test-session",
    worktreePath: repoPath,
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: "claude-x",
    model: null,
  });
}

test("PUT /api/sessions/:id/autopilot sets enabled=true", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/autopilot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
  );
  expect(res.status).toBe(200);
  expect(store.get(session.id)?.autopilotEnabled).toBe(true);
});

test("PUT /api/sessions/:id/autopilot sets enabled=null (inherit)", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  // First set to true
  await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/autopilot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
  );

  // Then clear to null
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/autopilot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: null }),
    }),
  );
  expect(res.status).toBe(200);
  expect(store.get(session.id)?.autopilotEnabled).toBeNull();
});

test("PUT /api/sessions/:id/autopilot with invalid enabled → 400", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/autopilot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT /api/sessions/:id/autopilot with unknown id → 404", async () => {
  const { app } = harness();

  const res = await app.fetch(
    new Request(`http://x/api/sessions/does-not-exist/autopilot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
  );
  expect(res.status).toBe(404);
});

test("PUT /api/sessions/:id/autopilot returns updated session", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/autopilot`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe(session.id);
  expect(body.autopilotEnabled).toBe(false);
});
