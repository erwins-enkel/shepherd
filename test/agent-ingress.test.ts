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
import { BrowserTokenSigner } from "../src/browser-token";
import type { CdpClient, CdpPipeClient } from "../src/cdp-pipe";
import { SharedBrowserError } from "../src/shared-browser";

// A representative per-session UUID — the de-facto capability segment the agent only knows
// for its own session.
const ID = "11111111-2222-3333-4444-555555555555";
const SID = "step_abc";

// Helper: split a path the way makeApp/makeAgentIngressApp do.
const parts = (p: string) => p.split("/").filter(Boolean);

// ── isAgentIngressRoute: exhaustive allow/deny table ────────────────────────────
test("isAgentIngressRoute: ALLOWS exactly the agent→server routes", () => {
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/hooks`))).toBe(true);
  // The session's MCP endpoint (issue #2003): the same control plane as a TOOL surface.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/mcp`))).toBe(true);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/mcp`))).toBe(true);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/queue`))).toBe(true);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/queue`))).toBe(true);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/steps/${SID}`))).toBe(true);
  // Epic-draft author/inspect (issue #1507) — like queue, PUT + GET are agent routes.
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/epic-draft`))).toBe(true);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/epic-draft`))).toBe(true);
  // Self-read + self-rename (issue #2053): the coordinates the public `video-brief` skill uses to
  // retitle its own session. SELF only — the id segment is the capability.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}`))).toBe(true);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/rename`))).toBe(true);
  // Browser Attach (ADR 0001): a GET WebSocket upgrade, token-gated in serveAgentIngress.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/browser`))).toBe(true);
});

test("isAgentIngressRoute: DENIES everything else (containment property)", () => {
  // Operator task amendments (#2225) — the channel that can WIDEN a session's task, and therefore
  // the one an agent must never reach: whatever can widen the task can be used to excuse a finding.
  // If this ever flips to true, an agent can authorize its own scope creep past its own critic.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/amendments`))).toBe(false);
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}/amendments/a-1`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/amendments`))).toBe(false);
  // The human/autopilot approve gate — NOT an agent action.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/queue/approve`))).toBe(false);
  // The epic-draft approve gate (the whole #1507 point: agent never triggers GitHub writes).
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/epic-draft/approve`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/epic-draft`))).toBe(false);
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}/epic-draft`))).toBe(false);
  // Spawn a new session = full firewall escape; must never be reachable.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions`))).toBe(false);
  // Self-read is GET-only: nothing may mutate or destroy the session through the bare route.
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}`))).toBe(false);
  expect(isAgentIngressRoute("PATCH", parts(`/api/sessions/${ID}`))).toBe(false);
  // The enumeration route hiding in the SAME path shape as the self-read: GET /api/sessions/done
  // answers with every recently-archived session across every repo. The id segment must look like
  // a session UUID, which no reserved literal ever will.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/done`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/archived`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/not-a-uuid`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}x`))).toBe(false);
  // An unknown sub-segment under a real session id is not a route.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/x`))).toBe(false);
  // Browser Attach is GET-only (the upgrade), exact-path.
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/browser`))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/browser`))).toBe(false);
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/browser/x`))).toBe(false);
  // Rename is POST-only, exact-path.
  expect(isAgentIngressRoute("GET", parts(`/api/sessions/${ID}/rename`))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts(`/api/sessions/${ID}/rename`))).toBe(false);
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}/rename`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/rename/x`))).toBe(false);
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
  // MCP is POST (+ the GET stream probe, answered 405), exact-path.
  expect(isAgentIngressRoute("DELETE", parts(`/api/sessions/${ID}/mcp`))).toBe(false);
  expect(isAgentIngressRoute("POST", parts(`/api/sessions/${ID}/mcp/x`))).toBe(false);
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
function makeDeps(
  start: (argv: string[]) => Promise<{ terminalId: string }> = async () => ({
    terminalId: "term_x",
  }),
): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      renameBranch: () => {},
      remove: () => {},
    } as any,
    herdr: {
      start: (_name: string, _cwd: string, argv: string[]) => start(argv),
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

test("makeAgentIngressApp: an agent cannot amend its OWN task (#2225 containment, end to end)", async () => {
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/amendments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "this widens my own scope" }),
    }),
  );
  expect(res.status).toBe(404);
  // Containment, not just a status code: nothing was written, so no critic can ever read it.
  expect(deps.store.listTaskAmendments(s.id)).toEqual([]);
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

test("makeAgentIngressApp: GET /api/sessions/:id delegates to the canonical session read (issue #2053)", async () => {
  // The `video-brief` skill reads its own session to learn the current name before proposing a
  // better one. Delegation (not a bespoke ingress reader) is what keeps the payload identical to
  // what the HUD sees — including the derived `hasScratchpadFiles` flag sessionRead attaches.
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);

  const res = await app.fetch(new Request(`http://x/api/sessions/${s.id}`));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.id).toBe(s.id);
  expect(body.name).toBe(s.name);
  // The derived flag only sessionRead attaches — a bespoke ingress reader wouldn't have it.
  expect(body).toHaveProperty("hasScratchpadFiles");
});

test("makeAgentIngressApp: GET /api/sessions/done is 404'd at the gate (no enumeration)", async () => {
  // Same path SHAPE as the self-read above, but `done` is the Done-lens enumeration route: every
  // recently-archived session across every repo. The UUID gate is what separates them.
  const deps = makeDeps();
  const res = await makeAgentIngressApp(deps).fetch(new Request("http://x/api/sessions/done"));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});

test("makeAgentIngressApp: POST /api/sessions/:id/rename delegates to the canonical rename (issue #2053)", async () => {
  // Self-rename must run the REAL handler: slugification, the open-PR display-only decision, the
  // branch move, collision handling, persistence and the live event all stay centralized.
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const renamed: unknown[] = [];
  deps.events.subscribe((event, data) => {
    if (event === "session:renamed") renamed.push(data);
  });
  const app = makeAgentIngressApp(deps);

  const res = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Login crash on submit" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  // Slugified by the canonical handler, not stored verbatim.
  expect(body.session.name).toBe("login-crash-on-submit");
  expect(body.branchRenamed).toBe(true);
  expect(deps.store.get(s.id)!.name).toBe("login-crash-on-submit");
  expect(deps.store.get(s.id)!.branch).toBe("shepherd/login-crash-on-submit");
  // The live event the HUD re-renders on fired too — proof the whole handler ran, not a shortcut.
  expect(renamed.length).toBe(1);

  // The handler's own validation is reachable: an invalid body is a 400, not a gate 404.
  const bad = await app.fetch(
    new Request(`http://x/api/sessions/${s.id}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    }),
  );
  expect(bad.status).toBe(400);
});

test("makeAgentIngressApp: the MCP endpoint delegates and drives the queue through a tool call (issue #2003)", async () => {
  // The whole point of the slice: the agent moves a step WITHOUT being taught an HTTP call, and
  // reaches the tool over the same auth-exempt ingress the curl used to.
  const deps = makeDeps();
  deps.store.setRepoConfig("/repo", {
    ...deps.store.getRepoConfig("/repo"),
    buildQueueEnabled: true,
  });
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const app = makeAgentIngressApp(deps);
  const rpc = async (method: string, params?: unknown) =>
    app.fetch(
      new Request(`http://x/api/sessions/${s.id}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );

  const list = await rpc("tools/list");
  expect(list.status).toBe(200);
  expect((await list.json()).result.tools.map((t: { name: string }) => t.name)).toEqual([
    "queue_write",
    "queue_step",
    "sessions_list",
    "sessions_show",
    "self_status",
  ]);

  await rpc("tools/call", {
    name: "queue_write",
    arguments: { steps: [{ id: "s1", title: "A" }] },
  });
  const called = await rpc("tools/call", {
    name: "queue_step",
    arguments: { stepId: "s1", status: "active" },
  });
  expect(called.status).toBe(200);
  expect(deps.store.getBuildQueue(s.id).steps[0]!.status).toBe("active");
});

/** The session id a spawn argv's `--mcp-config` points at. */
function mcpSessionId(argv: string[]): string {
  const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!);
  return cfg.mcpServers.shepherd.url.split("/").at(-2);
}

test("makeAgentIngressApp: the MCP endpoint answers WHILE the spawn is in flight, before the row exists", async () => {
  // Claude Code connects to its MCP servers during its own startup — before herdr.start returns
  // and create() persists the row. A 404 there makes it drop the server for the whole session.
  let app: ReturnType<typeof makeAgentIngressApp> | null = null;
  const seen: { init?: number; tools?: string[]; call?: unknown; rowExisted?: boolean } = {};
  const deps = makeDeps(async (argv) => {
    const id = mcpSessionId(argv);
    const rpc = (method: string, params?: unknown) =>
      app!.fetch(
        new Request(`http://x/api/sessions/${id}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );
    seen.rowExisted = deps.store.get(id) !== null;
    seen.init = (await rpc("initialize", { protocolVersion: "2025-06-18" })).status;
    seen.tools = (await (await rpc("tools/list")).json()).result.tools.map(
      (t: { name: string }) => t.name,
    );
    seen.call = (
      await (await rpc("tools/call", { name: "queue_write", arguments: { steps: [] } })).json()
    ).result;
    return { terminalId: "term_x" };
  });
  deps.store.setRepoConfig("/repo", {
    ...deps.store.getRepoConfig("/repo"),
    buildQueueEnabled: true,
  });
  app = makeAgentIngressApp(deps);
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });

  expect(seen.rowExisted).toBe(false);
  expect(seen.init).toBe(200);
  expect(seen.tools).toEqual([
    "queue_write",
    "queue_step",
    "sessions_list",
    "sessions_show",
    "self_status",
  ]);
  // A tool call before the row exists is a readable isError result, not a protocol error.
  expect(seen.call).toMatchObject({ isError: true });
  expect(JSON.stringify(seen.call)).toContain("still starting");
  // Once persisted, the endpoint serves from the row — and the in-flight entry is gone.
  expect(deps.service.spawningAgentCapabilities(s.id)).toBeNull();
});

test("makeAgentIngressApp: GET on the MCP endpoint is 405 — no SSE stream offered, per spec", async () => {
  const res = await makeAgentIngressApp(makeDeps()).fetch(
    new Request(`http://x/api/sessions/${ID}/mcp`, { headers: { accept: "text/event-stream" } }),
  );
  expect(res.status).toBe(405);
  expect(res.headers.get("allow")).toBe("POST");
});

test("a failed spawn leaves no in-flight MCP entry behind", async () => {
  let id = "";
  const deps = makeDeps(async (argv) => {
    id = mcpSessionId(argv);
    throw new Error("herdr refused");
  });
  await expect(
    deps.service.create({
      repoPath: "/repo",
      baseBranch: "main",
      prompt: "go",
      model: null,
      images: [],
    }),
  ).rejects.toThrow();
  expect(id).not.toBe("");
  expect(deps.service.spawningAgentCapabilities(id)).toBeNull();
  const res = await makeAgentIngressApp(deps).fetch(
    new Request(`http://x/api/sessions/${id}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
  );
  expect(res.status).toBe(404);
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

test("Codex reset routes are inaccessible to agent ingress", () => {
  expect(isAgentIngressRoute("POST", parts("/api/usage/codex/reset"))).toBe(false);
  expect(isAgentIngressRoute("PUT", parts("/api/usage/codex/automation"))).toBe(false);
});

// ── Browser Attach broker (ADR 0001) ────────────────────────────────────────────

const signer = new BrowserTokenSigner(Buffer.alloc(32, 7));

interface FakeAttach {
  repos: string[];
  received: string[];
  detached: number;
  fail?: Error;
}

function fakeSharedBrowser(state: FakeAttach) {
  return {
    attach: async (repoPath: string, sink: CdpClient): Promise<CdpPipeClient> => {
      state.repos.push(repoPath);
      // Resolve on a later tick so messages sent right after `open` exercise the pre-attach buffer.
      await new Promise((r) => setTimeout(r, 20));
      if (state.fail) throw state.fail;
      return {
        receive: (text) => {
          state.received.push(text);
          sink.send(`echo:${text}`);
        },
        detach: () => {
          state.detached++;
        },
        ready: Promise.resolve(),
      };
    },
    open: async () => "T1",
    sessionTab: () => null,
    stop: () => {},
  };
}

async function brokerFixture(opts: { enabled?: boolean; fail?: Error } = {}) {
  const deps = makeDeps();
  const state: FakeAttach = { repos: [], received: [], detached: 0, fail: opts.fail };
  deps.sharedBrowser = fakeSharedBrowser(state);
  deps.browserToken = signer;
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  deps.store.setRepoConfig("/repo", {
    ...deps.store.getRepoConfig("/repo"),
    sharedBrowserEnabled: opts.enabled ?? true,
  });
  const server = serveAgentIngress(deps, 0);
  const url = (id: string, token: string | null) =>
    `ws://127.0.0.1:${server.port}/api/sessions/${id}/browser${token === null ? "" : `?token=${token}`}`;
  const httpStatus = async (id: string, token: string | null) => {
    const res = await fetch(url(id, token).replace(/^ws/, "http"), {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    await res.text();
    return res.status;
  };
  return { deps, state, s, server, url, httpStatus };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("browser broker: 401 for a missing, wrong or other session's token", async () => {
  const f = await brokerFixture();
  try {
    expect(await f.httpStatus(f.s.id, null)).toBe(401);
    expect(await f.httpStatus(f.s.id, "00".repeat(32))).toBe(401);
    expect(await f.httpStatus(f.s.id, signer.sign(ID))).toBe(401);
    expect(f.state.repos).toEqual([]);
  } finally {
    await f.server.stop(true);
  }
});

test("browser broker: 401 for an archived session, even with its valid token", async () => {
  const f = await brokerFixture();
  try {
    f.deps.store.archive(f.s.id);
    expect(await f.httpStatus(f.s.id, signer.sign(f.s.id))).toBe(401);
  } finally {
    await f.server.stop(true);
  }
});

test("browser broker: 403 when the repo has not opted in", async () => {
  const f = await brokerFixture({ enabled: false });
  try {
    expect(await f.httpStatus(f.s.id, signer.sign(f.s.id))).toBe(403);
    expect(f.state.repos).toEqual([]);
  } finally {
    await f.server.stop(true);
  }
});

test("browser broker: 403 for an autonomous session (no attach before its egress guard exists)", async () => {
  const f = await brokerFixture();
  try {
    f.deps.store.setSandboxState(f.s.id, { applied: "autonomous" });
    expect(await f.httpStatus(f.s.id, signer.sign(f.s.id))).toBe(403);
  } finally {
    await f.server.stop(true);
  }
});

test("browser broker: 503 when no shared-browser manager is wired", async () => {
  const f = await brokerFixture();
  try {
    f.deps.sharedBrowser = undefined;
    expect(await f.httpStatus(f.s.id, signer.sign(f.s.id))).toBe(503);
  } finally {
    await f.server.stop(true);
  }
});

test("browser broker: upgrades, round-trips messages (incl. pre-attach ones) and detaches on close", async () => {
  const f = await brokerFixture();
  try {
    const ws = await openSocket(f.url(f.s.id, signer.sign(f.s.id)));
    const got: string[] = [];
    ws.onmessage = (e) => got.push(String(e.data));
    // Sent before the (deliberately slow) attach resolves: buffered, then replayed in order.
    ws.send('{"id":1,"method":"Browser.getVersion"}');
    ws.send('{"id":2,"method":"Target.getTargets"}');
    await until(() => got.length === 2);
    expect(f.state.repos).toEqual(["/repo"]);
    expect(got).toEqual([
      'echo:{"id":1,"method":"Browser.getVersion"}',
      'echo:{"id":2,"method":"Target.getTargets"}',
    ]);
    ws.close();
    await until(() => f.state.detached === 1);
  } finally {
    await f.server.stop(true);
  }
});

test("browser broker: an attach refused for the cap closes the socket with 1013", async () => {
  const f = await brokerFixture({ fail: new SharedBrowserError("cap", "full") });
  try {
    const ws = await openSocket(f.url(f.s.id, signer.sign(f.s.id)));
    const closed = await new Promise<CloseEvent>((r) => (ws.onclose = r));
    expect(closed.code).toBe(1013);
    expect(closed.reason).toBe("cap");
  } finally {
    await f.server.stop(true);
  }
});

test("browser broker: a binary frame closes the socket with 1003", async () => {
  const f = await brokerFixture();
  try {
    const ws = await openSocket(f.url(f.s.id, signer.sign(f.s.id)));
    const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
    ws.send(new Uint8Array([1, 2, 3]));
    expect((await closed).code).toBe(1003);
  } finally {
    await f.server.stop(true);
  }
});
