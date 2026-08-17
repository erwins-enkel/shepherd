import { test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, serve, makeAgentIngressApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE, SESSION_TTL_MS } from "../src/operator-auth";
import type { TokenScope } from "../src/token-scopes";

const SECRET = "test-cookie-signing-secret";
const PASSWORD = "operator-password";

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

const cookieHeader = (value: string) => ({ Cookie: `${SESSION_COOKIE}=${value}` });

let prevSecret: string | null;
let prevHash: string | null;
let prevToken: string | null;

beforeEach(async () => {
  prevSecret = config.cookieSecret;
  prevHash = config.passwordHash;
  prevToken = config.token;
  // Gate ACTIVE: a configured cookie secret + password hash (what bootstrapAuth guarantees at boot).
  config.cookieSecret = SECRET;
  config.passwordHash = await hashPassword(PASSWORD);
  config.token = null; // default: no operator bearer; agents use the exempt ingress
});

afterEach(() => {
  config.cookieSecret = prevSecret;
  config.passwordHash = prevHash;
  config.token = prevToken;
});

// ── gate: cookie OR token, else 401 ─────────────────────────────────────────

test("gate: a valid session cookie passes (GET /api/me → 200 authenticated)", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/me", { headers: cookieHeader(signCookie(SECRET)) }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ authenticated: true });
});

test("gate: no credential → 401 unauthorized", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(new Request("http://x/api/me"));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("gate: a cookie signed with the wrong secret → 401", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/me", { headers: cookieHeader(signCookie("other-secret")) }),
  );
  expect(res.status).toBe(401);
});

test("gate: a valid operator bearer token passes (when config.token is set)", async () => {
  config.token = "operator-bearer";
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/me", { headers: { Authorization: "Bearer operator-bearer" } }),
  );
  expect(res.status).toBe(200);
});

// ── exemptions: login route + static shell pass un-credentialed ─────────────

test("exemption: a static-shell GET is not gated (no 401)", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(new Request("http://x/"));
  expect(res.status).not.toBe(401); // serveStatic owns it (200 or 404), never the gate
});

test("exemption: GET /api/health is public 200 WHILE /api/diagnostics still 401s — same app (#1112)", async () => {
  // Locks the exemption's NARROWNESS: in one bootstrapped app (gate active), the
  // un-credentialed liveness route answers while a sibling gated /api route does not.
  const app = makeApp(makeDeps());
  const health = await app.fetch(new Request("http://x/api/health"));
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  // HEAD is exempt too (isPublicRequest covers GET+HEAD) → bodyless 200, NOT the /api 404.
  const headRes = await app.fetch(new Request("http://x/api/health", { method: "HEAD" }));
  expect(headRes.status).toBe(200);
  expect(await headRes.text()).toBe("");
  // /api/diagnostics is NOT exempt: an un-credentialed GET is rejected by checkAuth
  // (before its handler — so it 401s even though deps.diagnostics is unwired here).
  const diag = await app.fetch(new Request("http://x/api/diagnostics"));
  expect(diag.status).toBe(401);
  expect(await diag.json()).toEqual({ error: "unauthorized" });
});

test("exemption: POST /api/login is reachable un-credentialed; wrong password → handler 401", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    }),
  );
  expect(res.status).toBe(401);
  // handler's message, NOT the gate's {error:"unauthorized"} — proves it passed the gate
  expect(await res.json()).toEqual({ error: "invalid password" });
});

// ── login / logout / me + cookie attributes ─────────────────────────────────

test("login: correct password → 200 + HttpOnly SameSite=Strict cookie; conditional Secure", async () => {
  const app = makeApp(makeDeps());
  // plain loopback HTTP → no Secure
  const res = await app.fetch(
    new Request("http://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toContain(`${SESSION_COOKIE}=`);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).not.toContain("Secure");

  // HTTPS (via X-Forwarded-Proto) → Secure
  const resHttps = await app.fetch(
    new Request("http://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  expect(resHttps.headers.get("set-cookie")).toContain("Secure");
});

test("login → cookie then authenticates a gated route", async () => {
  const app = makeApp(makeDeps());
  const login = await app.fetch(
    new Request("http://x/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const value = login.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const me = await app.fetch(new Request("http://x/api/me", { headers: cookieHeader(value) }));
  expect(me.status).toBe(200);
});

test("logout: clears the cookie (Max-Age=0)", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/logout", {
      method: "POST",
      headers: cookieHeader(signCookie(SECRET)),
    }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("logout: a PAST-HALF-LIFE cookie still only clears — re-stamp must NOT re-issue a valid session", async () => {
  const app = makeApp(makeDeps());
  const old = signCookie(SECRET, SESSION_TTL_MS, Date.now() - SESSION_TTL_MS * 0.6); // restamp-eligible
  const res = await app.fetch(
    new Request("http://x/api/logout", { method: "POST", headers: cookieHeader(old) }),
  );
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie();
  // exactly ONE Set-Cookie, and it expires the session (no second, valid, re-stamped cookie)
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toContain("Max-Age=0");
  expect(cookies.some((c) => /Max-Age=(?!0)\d/.test(c))).toBe(false);
});

// ── sliding re-stamp ─────────────────────────────────────────────────────────

test("re-stamp: a cookie past half-life gets a fresh Set-Cookie on a 2xx response", async () => {
  const app = makeApp(makeDeps());
  const old = signCookie(SECRET, SESSION_TTL_MS, Date.now() - SESSION_TTL_MS * 0.6); // past half-life, still valid
  const res = await app.fetch(new Request("http://x/api/me", { headers: cookieHeader(old) }));
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
});

test("re-stamp: a fresh cookie (within first half) gets no Set-Cookie", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/me", { headers: cookieHeader(signCookie(SECRET)) }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toBe(null);
});

// ── WebSocket upgrades inherit the gate (the live-PTY fix) ───────────────────

async function withServer(fn: (port: number) => Promise<void>, deps: AppDeps = makeDeps()) {
  const server = serve(deps, 0);
  try {
    await fn(server.port!);
  } finally {
    server.stop(true);
  }
}

test("WS /events: rejected (401) without a credential", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/events`, {
      headers: { Origin: `http://localhost:${port}` },
    });
    expect(res.status).toBe(401);
  });
});

test("WS /events: with a valid cookie passes the gate + origin (not 401/403)", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/events`, {
      headers: { Origin: "http://localhost", ...cookieHeader(signCookie(SECRET)) },
    });
    // a non-handshake fetch can't complete the upgrade (→ 500), but it cleared auth + origin
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

test("WS /pty/:id: rejected (401) without a credential", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/pty/some-id`, {
      headers: { Origin: `http://localhost:${port}` },
    });
    expect(res.status).toBe(401);
  });
});

test("WS /events: a valid cookie but evil Origin is still 403 (CSWSH guard kept)", async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/events`, {
      headers: { Origin: "http://evil.example", ...cookieHeader(signCookie(SECRET)) },
    });
    expect(res.status).toBe(403);
  });
});

// ── agent-transport regression: exempt ingress vs gated main port ────────────

test("agent-transport: an uncredentialed hook POST is 2xx on the ingress but 401 on the main port", async () => {
  const deps = makeDeps();
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const hookReq = () =>
    new Request(`http://x/api/sessions/${s.id}/hooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });

  // exempt ingress transport: agent reaches the handler with NO credential
  const ingress = makeAgentIngressApp(deps);
  const viaIngress = await ingress.fetch(hookReq());
  expect(viaIngress.status).not.toBe(401);

  // gated main port: the SAME uncredentialed POST is rejected
  const main = makeApp(deps);
  const viaMain = await main.fetch(hookReq());
  expect(viaMain.status).toBe(401);
});

// ── minted access tokens (issue #2082) ──────────────────────────────────────
// A third accepted credential alongside the cookie and SHEPHERD_TOKEN: named, individually
// revocable, optionally expiring — and, since #2083, SCOPED. Unlike the cookie and the env token,
// authenticating here does not imply reaching every route; see the scope block further down.

/** Mint through the real route, cookie-authed — the way the HUD does it. `scope` omitted mints a
 *  `full` token, so every pre-#2083 caller of this helper keeps the reach it was written against. */
async function mintToken(
  app: { fetch: (req: Request) => Promise<Response> },
  name = "Asyar extension",
  expiresInDays: number | null = null,
  scope?: TokenScope,
): Promise<{ token: string; id: string }> {
  const res = await app.fetch(
    new Request("http://x/api/access-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(signCookie(SECRET)) },
      body: JSON.stringify(
        scope === undefined ? { name, expiresInDays } : { name, expiresInDays, scope },
      ),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; entry: { id: string } };
  return { token: body.token, id: body.entry.id };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test("minted token: authenticates GET /api/sessions and GET /api/holds like SHEPHERD_TOKEN", async () => {
  const app = makeApp(makeDeps());
  const { token } = await mintToken(app);

  const sessions = await app.fetch(
    new Request("http://x/api/sessions", { headers: bearer(token) }),
  );
  expect(sessions.status).toBe(200);
  const holds = await app.fetch(new Request("http://x/api/holds", { headers: bearer(token) }));
  expect(holds.status).toBe(200);
});

test("minted token: revoking it 401s the next request — no restart", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const { token, id } = await mintToken(app);
  expect((await app.fetch(new Request("http://x/api/me", { headers: bearer(token) }))).status).toBe(
    200,
  );

  const revoked = await app.fetch(
    new Request(`http://x/api/access-tokens/${id}`, {
      method: "DELETE",
      headers: cookieHeader(signCookie(SECRET)),
    }),
  );
  expect(revoked.status).toBe(200);

  // Same app object, same process — no restart between these two lines.
  const after = await app.fetch(new Request("http://x/api/me", { headers: bearer(token) }));
  expect(after.status).toBe(401);
  expect(await after.json()).toEqual({ error: "unauthorized" });
});

test("minted token: an unknown or tampered token is 401", async () => {
  const app = makeApp(makeDeps());
  const { token } = await mintToken(app);

  const tampered = await app.fetch(
    new Request("http://x/api/me", { headers: bearer(`${token}x`) }),
  );
  expect(tampered.status).toBe(401);
  const madeUp = await app.fetch(
    new Request("http://x/api/me", { headers: bearer("shp_not-a-real-token") }),
  );
  expect(madeUp.status).toBe(401);
});

test("minted token: coexists with SHEPHERD_TOKEN — both authenticate", async () => {
  config.token = "operator-bearer";
  const app = makeApp(makeDeps());
  const { token } = await mintToken(app);

  const viaEnv = await app.fetch(
    new Request("http://x/api/me", { headers: bearer("operator-bearer") }),
  );
  expect(viaEnv.status).toBe(200);
  const viaMinted = await app.fetch(new Request("http://x/api/me", { headers: bearer(token) }));
  expect(viaMinted.status).toBe(200);
});

test("minted token: reaches the WS upgrade gate exactly like SHEPHERD_TOKEN does", async () => {
  // Still true for a `full` token, which is what `mintToken` produces when no scope is named — the
  // #2083 migration target, so this is the no-regression lock for every pre-scope client. A `read`
  // token is refused at `/pty/:id` instead; see the scope block below.
  const deps = makeDeps();
  const app = makeApp(deps);
  const { token } = await mintToken(app);
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/events`, { headers: bearer(token) });
    expect(res.status).not.toBe(401);
  }, deps);
});

// ── per-token scopes (issue #2083) ──────────────────────────────────────────
// The acceptance criteria, end to end. The route→scope policy itself is covered exhaustively in
// test/token-scopes.test.ts; what these lock is that `checkAuth` actually consults it — on BOTH
// entry points, the WS upgrades included.

/** The 403 body the scope gate returns, distinct from checkOrigin's 403s. */
const INSUFFICIENT = { error: "insufficient_scope" };

test("scope read: 200 on GET /api/sessions, 403 on POST /api/sessions", async () => {
  const app = makeApp(makeDeps());
  const { token } = await mintToken(app, "asyar launcher", null, "read");

  const list = await app.fetch(new Request("http://x/api/sessions", { headers: bearer(token) }));
  expect(list.status).toBe(200);

  const spawn = await app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ repoPath: "/repo", baseBranch: "main", prompt: "go" }),
    }),
  );
  expect(spawn.status).toBe(403);
  expect(await spawn.json()).toEqual(INSUFFICIENT);
});

test("scope read: the rest of its surface is reachable, and nothing else is", async () => {
  const app = makeApp(makeDeps());
  const { token } = await mintToken(app, "asyar launcher", null, "read");

  for (const path of ["/api/holds", "/api/git", "/api/me"]) {
    const res = await app.fetch(new Request(`http://x${path}`, { headers: bearer(token) }));
    expect(`GET ${path} → ${res.status}`).toBe(`GET ${path} → 200`);
  }
  const ping = await app.fetch(
    new Request("http://x/api/ping", { method: "POST", headers: bearer(token) }),
  );
  expect(ping.status).toBe(200);

  // A GET that is not on the read list is refused, not merely un-mutating.
  const settings = await app.fetch(
    new Request("http://x/api/settings", { headers: bearer(token) }),
  );
  expect(settings.status).toBe(403);
  expect(await settings.json()).toEqual(INSUFFICIENT);
});

test("scope read: refused at the /pty/:id upgrade, while /events still passes", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const { token } = await mintToken(app, "asyar launcher", null, "read");
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });

  await withServer(async (port) => {
    // The live terminal — the hole #2083 closes. Asserted against a REAL session id, so a 403 here
    // cannot be a 404-for-missing-session in disguise.
    const pty = await fetch(`http://localhost:${port}/pty/${s.id}`, { headers: bearer(token) });
    expect(pty.status).toBe(403);
    expect(await pty.json()).toEqual(INSUFFICIENT);

    // …and the status bus a read client legitimately needs is untouched.
    const events = await fetch(`http://localhost:${port}/events`, { headers: bearer(token) });
    expect(events.status).not.toBe(401);
    expect(events.status).not.toBe(403);
  }, deps);
});

test("scope submit: reaches everything the Capture extension posts to, but no terminal", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const { token } = await mintToken(app, "Capture extension", null, "submit");

  // The four routes extension/src/lib/transport.ts calls. Asserted as "not the scope 403" rather
  // than a specific success: these handlers reach real work (git, gh, disk) the stub deps don't
  // provide, and what is under test is the gate, not the handler.
  for (const [method, path] of [
    ["POST", "/api/ping"],
    ["POST", "/api/uploads"],
    ["POST", "/api/sessions"],
    ["POST", "/api/issues"],
  ] as const) {
    const res = await app.fetch(
      new Request(`http://x${path}`, {
        method,
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({}),
      }),
    );
    expect(`${method} ${path} → ${res.status}`).not.toBe(`${method} ${path} → 403`);
  }

  // The held-task routes it also carries.
  expect(
    (await app.fetch(new Request("http://x/api/held", { headers: bearer(token) }))).status,
  ).toBe(200);

  // But driving a running session, and the terminal, stay out of reach.
  const reply = await app.fetch(
    new Request("http://x/api/sessions/s1/reply", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ text: "do something else" }),
    }),
  );
  expect(reply.status).toBe(403);
  expect(await reply.json()).toEqual(INSUFFICIENT);

  await withServer(async (port) => {
    const pty = await fetch(`http://localhost:${port}/pty/some-id`, { headers: bearer(token) });
    expect(pty.status).toBe(403);
  }, deps);
});

test("scope full: no regression — the terminal and the spawn route both still open", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  const { token } = await mintToken(app, "cron", null, "full");
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });

  const spawn = await app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ repoPath: "/repo", baseBranch: "main", prompt: "go" }),
    }),
  );
  expect(spawn.status).not.toBe(403);

  await withServer(async (port) => {
    const pty = await fetch(`http://localhost:${port}/pty/${s.id}`, { headers: bearer(token) });
    expect(pty.status).not.toBe(401);
    expect(pty.status).not.toBe(403);
  }, deps);
});

test("SHEPHERD_TOKEN stays unscoped — the break-glass credential is untouched", async () => {
  config.token = "operator-bearer";
  const deps = makeDeps();
  const app = makeApp(deps);
  const s = await deps.service.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
  const env = bearer("operator-bearer");

  // A route no scope below `full` reaches…
  expect((await app.fetch(new Request("http://x/api/settings", { headers: env }))).status).toBe(
    200,
  );
  // …a mutation…
  const spawn = await app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...env },
      body: JSON.stringify({ repoPath: "/repo", baseBranch: "main", prompt: "go" }),
    }),
  );
  expect(spawn.status).not.toBe(403);
  // …and the terminal.
  await withServer(async (port) => {
    const pty = await fetch(`http://localhost:${port}/pty/${s.id}`, { headers: env });
    expect(pty.status).not.toBe(401);
    expect(pty.status).not.toBe(403);
  }, deps);
});

test("a cookie-authed operator is never scope-checked", async () => {
  // The scope branch sits inside the minted-token arm of checkAuth, so the human path cannot
  // regress into it — including on the terminal upgrade.
  const deps = makeDeps();
  const app = makeApp(deps);
  const cookie = cookieHeader(signCookie(SECRET));
  expect((await app.fetch(new Request("http://x/api/settings", { headers: cookie }))).status).toBe(
    200,
  );
  await withServer(async (port) => {
    const pty = await fetch(`http://localhost:${port}/pty/some-id`, {
      headers: { Origin: "http://localhost", ...cookie },
    });
    expect(pty.status).not.toBe(403);
  }, deps);
});

test("scope: a revoked read token is 401 (unauthorized), not 403 (insufficient_scope)", async () => {
  // Order matters: a dead credential must not be reported as a live one that merely lacks a route,
  // so authentication has to fail BEFORE the scope check is consulted. (Expiry takes the same path
  // — `verify` returns null for both — and is covered on the clock in test/access-tokens.test.ts.)
  const app = makeApp(makeDeps());
  const { token } = await mintToken(app, "reader", null, "read");
  const res = await app.fetch(new Request("http://x/api/sessions", { headers: bearer(token) }));
  expect(res.status).toBe(200); // live, and within its scope

  const listed = await app.fetch(
    new Request("http://x/api/access-tokens", { headers: cookieHeader(signCookie(SECRET)) }),
  );
  const { tokens } = (await listed.json()) as { tokens: { id: string }[] };
  await app.fetch(
    new Request(`http://x/api/access-tokens/${tokens[0]!.id}`, {
      method: "DELETE",
      headers: cookieHeader(signCookie(SECRET)),
    }),
  );
  const after = await app.fetch(new Request("http://x/api/sessions", { headers: bearer(token) }));
  expect(after.status).toBe(401);
  expect(await after.json()).toEqual({ error: "unauthorized" });
});
