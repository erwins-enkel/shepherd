import { test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, serve, makeAgentIngressApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE, SESSION_TTL_MS } from "../src/operator-auth";

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
// revocable, optionally expiring. Same reach as the env token by design (v1 has no scopes).

/** Mint through the real route, cookie-authed — the way the HUD does it. */
async function mintToken(
  app: { fetch: (req: Request) => Promise<Response> },
  name = "Asyar extension",
  expiresInDays: number | null = null,
): Promise<{ token: string; id: string }> {
  const res = await app.fetch(
    new Request("http://x/api/access-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(signCookie(SECRET)) },
      body: JSON.stringify({ name, expiresInDays }),
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
  // v1 tokens are full-parity by design (per-token scopes are the filed follow-up). Locking it
  // here so a later scope change is a deliberate edit to this expectation, not a silent drift.
  const deps = makeDeps();
  const app = makeApp(deps);
  const { token } = await mintToken(app);
  await withServer(async (port) => {
    const res = await fetch(`http://localhost:${port}/events`, { headers: bearer(token) });
    expect(res.status).not.toBe(401);
  }, deps);
});
