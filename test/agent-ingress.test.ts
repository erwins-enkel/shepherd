import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import {
  isAgentIngressRoute,
  makeAgentIngressApp,
  serveAgentIngress,
  type AppDeps,
} from "../src/server";
import { config } from "../src/config";

// A representative per-session UUID — the de-facto capability segment the agent only knows
// for its own session.
const ID = "11111111-2222-3333-4444-555555555555";
const SID = "step_abc";

// Helper: split a path the way makeApp/makeAgentIngressApp do.
const parts = (p: string) => p.split("/").filter(Boolean);

// ── isAgentIngressRoute: exhaustive allow/deny table ────────────────────────────
test("isAgentIngressRoute: ALLOWS exactly the four agent→server routes", () => {
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/hooks`))).toBe(true);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/queue`))).toBe(true);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/queue`))).toBe(true);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/steps/${SID}`))).toBe(true);
  // Epic-draft author/inspect (issue #1507) — like queue, PUT + GET are agent routes.
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/epic-draft`))).toBe(true);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/epic-draft`))).toBe(true);
});

test("isAgentIngressRoute: DENIES everything else (containment property)", () => {
  // The human/autopilot approve gate — NOT an agent action.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/approve`))).toBe(false);
  // The epic-draft approve gate (the whole #1507 point: agent never triggers GitHub writes).
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/epic-draft/approve`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/epic-draft`))).toBe(false);
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}/epic-draft`))).toBe(false);
  // Spawn a new session = full firewall escape; must never be reachable.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions`))).toBe(false);
  // Read/delete a session.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}`))).toBe(false);
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}`))).toBe(false);
  // Wrong methods on the allowed paths.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/hooks`))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/hooks`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue`))).toBe(false);
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}/queue`))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/queue/steps/${SID}`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/queue/steps/${SID}`))).toBe(false);
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
      start: async () => ({ terminalId: "term_x" }),
      list: () => [],
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
  return { store, service, events, usageLimits, distiller: { distillNow: async () => {} } };
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

test("makeAgentIngressApp: GET /api/sessions/:id/queue delegates — the agent can read back the queue it authored", async () => {
  // The spawn directive tells the agent to "inspect the current queue at any time" and to re-GET
  // the queue to recover step ids. A gate that 404s this GET makes agents conclude the whole
  // build-queue endpoint is dead and abandon the queue.
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);

  const put = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/queue`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: [{ id: "s1", title: "do a thing" }] }),
    }),
  );
  expect(put.status).toBe(200);

  const get = await app.fetch(new Request(`http://x/api/sessions/${s.id}/queue`));
  expect(get.status).toBe(200);
  const q = await get.json();
  expect(q.steps.length).toBe(1);
  expect(q.steps[0].id).toBe("s1");
});

test("makeAgentIngressApp: the ingress transport is EXEMPT from the human auth gate (issue #1079)", async () => {
  // Corrected #1079 design: the ingress is built with skipAuth — its loopback-only bind + route
  // allowlist + per-session UUID IS the agent's auth. So an allowed route is served WITHOUT any
  // human credential even when the gate is configured (cookie secret + bearer token both set);
  // agents carry neither. The SAME route on the gated MAIN app would 401 (see server-auth.test.ts).
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);
  const prevSecret = config.cookieSecret;
  const prevToken = config.token;
  config.cookieSecret = "test-cookie-secret"; // gate configured (would 401 un-credentialed on main app)
  config.token = "secret-token";
  try {
    const res = await app.fetch(
      new Request(`http://x/api/sessions/${s.id}/queue`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ steps: [{ title: "do a thing" }] }),
      }),
    );
    expect(res.status).not.toBe(401); // exempt: reaches the handler with no credential
  } finally {
    config.cookieSecret = prevSecret;
    config.token = prevToken;
  }
});

// ── serveAgentIngress: pinned bind + post-exit rebind (issue #1083) ─────────────

/** Probe a likely-free port by binding ephemeral, reading the assigned port, and releasing it. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const p = probe.port;
  await probe.stop();
  if (p == null) throw new Error("ephemeral probe yielded no port");
  return p;
}

test("serveAgentIngress: binds the requested (pinned) port exactly", async () => {
  const deps = makeDeps();
  const p = await freePort();
  const server = serveAgentIngress(deps, p);
  try {
    expect(server.port).toBe(p);
  } finally {
    await server.stop();
  }
});

test("serveAgentIngress: rebinds the SAME port after a real server-closed connection + restart", async () => {
  // Non-vacuous: we route a real allowlisted request through the live listener with the server as
  // the active closer (Connection: close), so a genuine server-side connection teardown exists on
  // the listening port BEFORE we stop + rebind. This exercises Bun's default SO_REUSEADDR recovery
  // (the restart case the pin exists for), not a no-op rebind of a listener that never accepted a
  // connection. We deliberately do NOT use reusePort, so this is true post-exit rebind, not co-bind.
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const p = await freePort();

  const first = serveAgentIngress(deps, p);
  expect(first.port).toBe(p);
  // Real allowlisted request over the actual socket; server actively closes (Connection: close).
  const res = await fetch(`http://127.0.0.1:${p}/api/sessions/${s.id}/queue`, {
    method: "PUT",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ steps: [{ title: "do a thing" }] }),
  });
  expect(res.status).toBe(200);
  await res.text(); // drain the body so the connection completes and the server closes it
  await first.stop(); // old process exits

  // The pinned port must rebind immediately despite the lingering server-closed connection.
  const second = serveAgentIngress(deps, p);
  try {
    expect(second.port).toBe(p);
  } finally {
    await second.stop();
  }
});
