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
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-bq-api-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness(): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
  emitted: { event: string; data: unknown }[];
  replies: { id: string; text: string }[];
} {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: unknown }[] = [];
  const replies: { id: string; text: string }[] = [];
  const hub = new EventHub();
  hub.subscribe((event, data) => emitted.push({ event, data }));
  const fakeService = {
    reply(id: string, text: string): boolean {
      replies.push({ id, text });
      return true;
    },
  };
  const deps: AppDeps = {
    store,
    service: fakeService as any,
    events: hub,
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store, emitted, replies };
}

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

// ── GET /api/sessions/:id/queue ───────────────────────────────────────────────

test("GET queue returns empty queue for new session", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(new Request(`http://x/api/sessions/${session.id}/queue`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sessionId).toBe(session.id);
  expect(body.steps).toEqual([]);
  expect(body.approved).toBe(false);
});

test("GET queue returns 404 for unknown session", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request(`http://x/api/sessions/no-such-session/queue`));
  expect(res.status).toBe(404);
});

// ── PUT /api/sessions/:id/queue ───────────────────────────────────────────────

test("PUT queue replaces steps and returns the queue", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "Step A" }, { title: "Step B" }] }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.sessionId).toBe(session.id);
  expect(body.steps).toHaveLength(2);
  expect(body.steps[0].title).toBe("Step A");
  expect(body.steps[1].title).toBe("Step B");
});

test("PUT queue emits queue:update event", async () => {
  const { app, store, emitted } = harness();
  const session = makeSession(store, repoDir);

  await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "Step A" }] }),
    }),
  );

  const ev = emitted.find((e) => e.event === "queue:update");
  expect(ev).toBeDefined();
  const data = ev!.data as { sessionId: string; steps: unknown[] };
  expect(data.sessionId).toBe(session.id);
  expect(data.steps).toHaveLength(1);
});

test("PUT queue with bad body → 400", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "" }] }), // empty title
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT queue with duplicate explicit step ids → 400, queue unchanged", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);
  // seed a valid queue first
  store.replaceBuildQueue(session.id, [{ id: "s1", title: "A" }]);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        steps: [
          { id: "dup", title: "A" },
          { id: "dup", title: "B" },
        ],
      }),
    }),
  );
  expect(res.status).toBe(400);
  // the rejected PUT did not replace the existing queue
  expect(store.getBuildQueue(session.id).steps.map((x) => x.id)).toEqual(["s1"]);
});

test("POST queue/steps resolves a short verbatim agent id by exact match", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);
  store.replaceBuildQueue(session.id, [
    { id: "s1", title: "A" },
    { id: "s2", title: "B" },
  ]);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/steps/s1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(store.getBuildQueue(session.id).steps[0]!.status).toBe("active");
});

test("PUT queue with missing steps → 400", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT queue without content-type → 415", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      body: JSON.stringify({ steps: [] }),
    }),
  );
  expect(res.status).toBe(415);
});

test("PUT queue for unknown session → 404", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/sessions/no-such/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [] }),
    }),
  );
  expect(res.status).toBe(404);
});

// ── POST /api/sessions/:id/queue/steps/:stepId ───────────────────────────────

test("POST queue/steps/:stepId sets status and returns queue", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  // First create a step via PUT
  const putRes = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "Step A" }] }),
    }),
  );
  const queue = await putRes.json();
  const stepId = queue.steps[0].id;

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/steps/${stepId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.steps[0].status).toBe("active");
});

test("POST queue/steps/:stepId emits queue:update", async () => {
  const { app, store, emitted } = harness();
  const session = makeSession(store, repoDir);

  const putRes = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "S" }] }),
    }),
  );
  const queue = await putRes.json();
  const stepId = queue.steps[0].id;

  emitted.length = 0; // clear prior events

  await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/steps/${stepId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    }),
  );

  const ev = emitted.find((e) => e.event === "queue:update");
  expect(ev).toBeDefined();
});

test("POST queue/steps with unknown stepId → 404 with actionable message", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/steps/no-such-step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    }),
  );
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error).toContain("not found");
});

test("POST queue/steps with an unambiguous ≥8-char prefix resolves and updates the step", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const putRes = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "Step A" }] }),
    }),
  );
  const queue = await putRes.json();
  const fullId = queue.steps[0].id;
  const prefix = fullId.slice(0, 8);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/steps/${prefix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.steps[0].id).toBe(fullId);
  expect(body.steps[0].status).toBe("done");
});

test("POST queue/steps with an ambiguous prefix → 409 with matches, no change", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  // Seed two steps whose ids share an 8-char prefix so the posted prefix is ambiguous.
  // This is a SYNTHETIC scenario: server-generated ids are fixed-length random UUIDs that can't
  // collide on an 8-char prefix. replaceBuildQueue now stores explicit ids VERBATIM (store.ts),
  // so we just PUT the colliding ids directly rather than poking the DB.
  store.replaceBuildQueue(session.id, [
    { id: "abcd1234-aaaa-4e41-88b0-c4f255337d81", title: "A" },
    { id: "abcd1234-bbbb-4e41-88b0-c4f255337d81", title: "B" },
  ]);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/steps/abcd1234`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    }),
  );
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.matches).toHaveLength(2);
  // nothing changed — both steps still pending
  expect(store.getBuildQueue(session.id).steps.map((x: { status: string }) => x.status)).toEqual([
    "pending",
    "pending",
  ]);
});

test("POST queue/steps with invalid status → 400", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  // PUT a step first
  const putRes = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "S" }] }),
    }),
  );
  const queue = await putRes.json();
  const stepId = queue.steps[0].id;

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/steps/${stepId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bad-value" }),
    }),
  );
  expect(res.status).toBe(400);
});

// ── POST /api/sessions/:id/queue/approve ─────────────────────────────────────

test("POST queue/approve sets approved=true and returns queue", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/approve`, {
      method: "POST",
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.approved).toBe(true);
  expect(store.getBuildQueue(session.id).approved).toBe(true);
});

test("POST queue/approve emits queue:update", async () => {
  const { app, store, emitted } = harness();
  const session = makeSession(store, repoDir);

  await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/approve`, {
      method: "POST",
    }),
  );

  const ev = emitted.find((e) => e.event === "queue:update");
  expect(ev).toBeDefined();
  const data = ev!.data as { sessionId: string; approved: boolean };
  expect(data.sessionId).toBe(session.id);
  expect(data.approved).toBe(true);
});

test("POST queue/approve calls service.reply with APPROVE_STEER text", async () => {
  const { app, store, replies } = harness();
  const session = makeSession(store, repoDir);

  await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/approve`, {
      method: "POST",
    }),
  );

  expect(replies).toHaveLength(1);
  expect(replies.at(0)!.id).toBe(session.id);
  expect(replies.at(0)!.text).toContain("Build queue approved");
  expect(replies.at(0)!.text).toContain("work the steps in order");
});

test("POST queue/approve for unknown session → 404", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/sessions/no-such/queue/approve`, {
      method: "POST",
    }),
  );
  expect(res.status).toBe(404);
});

// ── approvalKind round-trips ──────────────────────────────────────────────────

test("POST queue/approve sets approvalKind=operator in response and store", async () => {
  const { app, store } = harness();
  const session = makeSession(store, repoDir);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/approve`, {
      method: "POST",
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.approvalKind).toBe("operator");
  expect(store.getBuildQueue(session.id).approvalKind).toBe("operator");
});

test("POST queue/approve emits queue:update with approvalKind=operator", async () => {
  const { app, store, emitted } = harness();
  const session = makeSession(store, repoDir);

  await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/queue/approve`, {
      method: "POST",
    }),
  );

  const ev = emitted.find((e) => e.event === "queue:update");
  expect(ev).toBeDefined();
  const data = ev!.data as { sessionId: string; approved: boolean; approvalKind?: string };
  expect(data.approvalKind).toBe("operator");
});

test("store: auto-approved queue has approvalKind=auto, unapproved has no approvalKind", () => {
  const { store } = harness();
  const session = makeSession(store, repoDir);

  // unapproved: approvalKind must be absent (undefined)
  expect(store.getBuildQueue(session.id).approvalKind).toBeUndefined();

  // auto-approve
  store.setBuildQueueApproved(session.id, true, "auto");
  expect(store.getBuildQueue(session.id).approvalKind).toBe("auto");
});

// ── GET /api/queues — bulk snapshot ──────────────────────────────────────────

test("GET /api/queues returns keyed map of sessions with steps, approved flag", async () => {
  const { app, store } = harness();
  const sess1 = makeSession(store, repoDir);
  const sess2 = makeSession(store, repoDir);

  store.replaceBuildQueue(sess1.id, [{ title: "Step A" }, { title: "Step B" }]);
  store.setBuildQueueApproved(sess1.id, true);
  store.replaceBuildQueue(sess2.id, [{ title: "Step C" }]);
  // sess2 approved defaults to false

  const res = await app.fetch(new Request(`http://x/api/queues`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<
    string,
    { sessionId: string; steps: unknown[]; approved: boolean }
  >;

  // sess1: 2 steps, approved=true
  expect(body[sess1.id]).toBeDefined();
  expect(body[sess1.id]!.sessionId).toBe(sess1.id);
  expect(body[sess1.id]!.steps).toHaveLength(2);
  expect(body[sess1.id]!.approved).toBe(true);

  // sess2: 1 step, approved=false
  expect(body[sess2.id]).toBeDefined();
  expect(body[sess2.id]!.sessionId).toBe(sess2.id);
  expect(body[sess2.id]!.steps).toHaveLength(1);
  expect(body[sess2.id]!.approved).toBe(false);
});

test("GET /api/queues omits sessions with no steps", async () => {
  const { app, store } = harness();
  const withSteps = makeSession(store, repoDir);
  const noSteps = makeSession(store, repoDir);

  store.replaceBuildQueue(withSteps.id, [{ title: "Step A" }]);
  // noSteps has no queue entries

  const res = await app.fetch(new Request(`http://x/api/queues`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;

  expect(body[withSteps.id]).toBeDefined();
  expect(body[noSteps.id]).toBeUndefined();
});

test("GET /api/queues returns empty object when no sessions have steps", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request(`http://x/api/queues`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({});
});

test("GET /api/queues route does not shadow GET /api/sessions/:id/queue", async () => {
  // Proof: seed TWO sessions. A handler captured by /:id would only see one session's data;
  // a genuine bulk handler returns a multi-session map → proves the right route fired.
  const { app, store } = harness();
  const sess1 = makeSession(store, repoDir);
  const sess2 = makeSession(store, repoDir);
  store.replaceBuildQueue(sess1.id, [{ title: "Step A" }]);
  store.replaceBuildQueue(sess2.id, [{ title: "Step B" }, { title: "Step C" }]);

  // bulk endpoint returns BOTH sessions — proves non-capture
  const bulk = await app.fetch(new Request(`http://x/api/queues`));
  expect(bulk.status).toBe(200);
  const bulkBody = (await bulk.json()) as Record<string, { sessionId: string; steps: unknown[] }>;
  expect(bulkBody[sess1.id]).toBeDefined();
  expect(bulkBody[sess1.id]!.steps).toHaveLength(1);
  expect(bulkBody[sess2.id]).toBeDefined();
  expect(bulkBody[sess2.id]!.steps).toHaveLength(2);

  // per-session endpoint still works independently (co-existence)
  const single = await app.fetch(new Request(`http://x/api/sessions/${sess1.id}/queue`));
  expect(single.status).toBe(200);
  const singleBody = await single.json();
  expect(singleBody.sessionId).toBe(sess1.id);
  expect(singleBody.steps).toHaveLength(1);
});
