import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { isAgentIngressRoute, makeAgentIngressApp, type AppDeps } from "../src/server";
import { config } from "../src/config";

// A representative per-session UUID — the de-facto capability segment the agent only knows
// for its own session.
const ID = "11111111-2222-3333-4444-555555555555";
const SID = "step_abc";

// Helper: split a path the way makeApp/makeAgentIngressApp do.
const parts = (p: string) => p.split("/").filter(Boolean);

// ── isAgentIngressRoute: exhaustive allow/deny table ────────────────────────────
test("isAgentIngressRoute: ALLOWS exactly the three agent→server routes", () => {
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/hooks`))).toBe(true);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/queue`))).toBe(true);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/steps/${SID}`))).toBe(true);
});

test("isAgentIngressRoute: DENIES everything else (containment property)", () => {
  // The human/autopilot approve gate — NOT an agent action.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/approve`))).toBe(false);
  // Spawn a new session = full firewall escape; must never be reachable.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions`))).toBe(false);
  // Read/delete a session.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}`))).toBe(false);
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}`))).toBe(false);
  // Wrong methods on the allowed paths.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/hooks`))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/hooks`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/queue`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue`))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/queue/steps/${SID}`))).toBe(false);
  // queue/steps without a step id, or with a trailing extra segment.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/steps`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/steps/${SID}/x`))).toBe(
    false,
  );
  // hooks with a trailing extra segment.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/hooks/x`))).toBe(false);
  // Missing session id.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions`))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions//queue`))).toBe(false);
  // Roots + non-/api/sessions paths.
  expect(isAgentIngressRoute("GET", parts(`/`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/backlog`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/healthz`))).toBe(false);
});

// ── makeAgentIngressApp: 404-at-gate vs delegate-to-real-app ────────────────────
function makeDeps(): AppDeps {
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
      start: () => ({ terminalId: "term_x" }),
      list: () => [],
      stop: () => {},
      send: () => {},
    } as any,
    events,
  });
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
  };
  return { store, service, events, usageLimits, distiller: { distillNow: () => {} } };
}

test("makeAgentIngressApp: a DENIED route 404s AT THE GATE (never reaches a handler)", async () => {
  const deps = makeDeps();
  // Spawn a session so the route would otherwise be live — proving the 404 is the gate, not a
  // missing session.
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);

  // POST /api/sessions/:id/queue/approve is a real, working route on the full app — but the gate
  // must 404 it (it's the human gate). Assert containment: the build queue is NOT approved after.
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/queue/approve`, { method: "POST" }),
  );
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
  // The handler never ran → not approved.
  expect(deps.store.getBuildQueue(s.id).approved).toBe(false);
});

test("makeAgentIngressApp: POST /api/sessions (spawn) is 404'd at the gate (no firewall escape)", async () => {
  const deps = makeDeps();
  const app = makeAgentIngressApp(deps);
  const res = await app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/repo", baseBranch: "main", prompt: "p" }),
    }),
  );
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});

test("makeAgentIngressApp: an ALLOWED route DELEGATES to the full app (reaches the real handler)", async () => {
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);

  // PUT /api/sessions/:id/queue with an INVALID body reaches putBuildQueue, which validates and
  // returns 400 "invalid build steps" — a NON-404 sentinel proving delegation past the gate.
  const bad = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "steps" }),
    }),
  );
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid build steps" });

  // PUT with a VALID body reaches the handler and mutates the queue (200) — full delegation.
  const ok = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ title: "do a thing" }] }),
    }),
  );
  expect(ok.status).toBe(200);
  const q = await ok.json();
  expect(q.steps.length).toBe(1);
  expect(q.steps[0].title).toBe("do a thing");
});

test("makeAgentIngressApp: delegation does NOT bypass checkAuth (token is enforced)", async () => {
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);
  const prev = config.token;
  config.token = "secret-token";
  try {
    // ALLOWED route, but WITHOUT a valid Authorization header → checkAuth 401s through the gate.
    const unauthed = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/queue`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ steps: [{ title: "do a thing" }] }),
      }),
    );
    expect(unauthed.status).toBe(401);
    expect(await unauthed.json()).toEqual({ error: "unauthorized" });

    // SAME allowed route WITH the correct bearer token → past checkAuth, reaches the handler.
    const authed = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/queue`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer secret-token",
        },
        body: JSON.stringify({ steps: [{ title: "do a thing" }] }),
      }),
    );
    expect(authed.status).not.toBe(401);
  } finally {
    config.token = prev;
  }
});
