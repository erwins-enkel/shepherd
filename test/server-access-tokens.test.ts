import { test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, makeAgentIngressApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE } from "../src/operator-auth";
import { ACCESS_TOKEN_NAME_MAX, ACCESS_TOKEN_PREFIX } from "../src/access-tokens";

// The /api/access-tokens routes (#2082). Distinct from server-auth.test.ts, which covers whether a
// minted token AUTHENTICATES; this file covers minting, listing, revoking and their guards.

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
    } as never,
    herdr: {
      start: async () => ({ terminalId: "term_x" }),
      list: () => [],
      stop: async () => {},
      send: () => {},
    } as never,
    events,
  });
  return {
    store,
    service,
    events,
    usageLimits: {
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
    },
  };
}

const asOperator = () => ({
  "content-type": "application/json",
  Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}`,
});

type Minted = { token: string; entry: Record<string, unknown> };
type Listed = { tokens: { id: string; name: string; hint: string; lastUsedAt: number | null }[] };

const post = (body: unknown, headers: Record<string, string> = asOperator()) =>
  new Request("http://x/api/access-tokens", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

let prevSecret: string | null;
let prevHash: string | null;
let prevToken: string | null;

beforeEach(async () => {
  prevSecret = config.cookieSecret;
  prevHash = config.passwordHash;
  prevToken = config.token;
  config.cookieSecret = SECRET;
  config.passwordHash = await hashPassword(PASSWORD);
  config.token = null;
});

afterEach(() => {
  config.cookieSecret = prevSecret;
  config.passwordHash = prevHash;
  config.token = prevToken;
});

// ── happy path ─────────────────────────────────────────────────────────────

test("mint → list → revoke round-trip", async () => {
  const app = makeApp(makeDeps());

  const created = await app.fetch(post({ name: "Asyar — MacBook", expiresInDays: null }));
  expect(created.status).toBe(201);
  const minted = (await created.json()) as Minted;
  expect(minted.token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
  expect(minted.entry).toMatchObject({
    name: "Asyar — MacBook",
    lastUsedAt: null,
    expiresAt: null,
  });
  expect(minted.entry).not.toHaveProperty("tokenHash");

  const listed = (await (
    await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
  ).json()) as Listed;
  expect(listed.tokens).toHaveLength(1);
  expect(listed.tokens[0]!.name).toBe("Asyar — MacBook");
  expect(listed.tokens[0]!.hint).toBe(minted.token.slice(-4));
  // The list never carries the plaintext, on any field.
  expect(JSON.stringify(listed)).not.toContain(minted.token);

  const id = listed.tokens[0]!.id;
  const revoked = await app.fetch(
    new Request(`http://x/api/access-tokens/${id}`, {
      method: "DELETE",
      headers: asOperator(),
    }),
  );
  expect(revoked.status).toBe(200);
  const after = (await (
    await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
  ).json()) as Listed;
  expect(after.tokens).toHaveLength(0);
});

test("mint: an expiry preset lands as an absolute timestamp in the future", async () => {
  const app = makeApp(makeDeps());
  const before = Date.now();
  const minted = (await (
    await app.fetch(post({ name: "short-lived", expiresInDays: 30 }))
  ).json()) as Minted;
  const expiresAt = minted.entry.expiresAt as number;
  expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
});

test("mint: expiresInDays may be omitted entirely (never expires)", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(post({ name: "no-expiry-field" }));
  expect(res.status).toBe(201);
  expect(((await res.json()) as Minted).entry.expiresAt).toBeNull();
});

// ── the operator-session guard ─────────────────────────────────────────────

test("guard: a minted bearer cannot list, mint or revoke — 403 on all three", async () => {
  const app = makeApp(makeDeps());
  const minted = (await (await app.fetch(post({ name: "Asyar", expiresInDays: null }))).json()) as {
    token: string;
    entry: { id: string };
  };
  const asBearer = { "content-type": "application/json", Authorization: `Bearer ${minted.token}` };

  const list = await app.fetch(new Request("http://x/api/access-tokens", { headers: asBearer }));
  expect(list.status).toBe(403);
  expect(await list.json()).toEqual({ error: "operator_session_required" });

  const mint = await app.fetch(post({ name: "escalation", expiresInDays: null }, asBearer));
  expect(mint.status).toBe(403);

  const revoke = await app.fetch(
    new Request(`http://x/api/access-tokens/${minted.entry.id}`, {
      method: "DELETE",
      headers: asBearer,
    }),
  );
  expect(revoke.status).toBe(403);
});

test("guard: SHEPHERD_TOKEN is no more privileged here than a minted one", async () => {
  config.token = "operator-bearer";
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/access-tokens", {
      headers: { Authorization: "Bearer operator-bearer" },
    }),
  );
  expect(res.status).toBe(403);
});

test("guard: no credential at all is stopped by checkAuth first (401, not 403)", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(new Request("http://x/api/access-tokens"));
  expect(res.status).toBe(401);
});

test("guard: the auth-exempt agent ingress does not expose the token routes at all", async () => {
  // The ingress is built with skipAuth, so checkAuth never runs there — its route ALLOWLIST is
  // what keeps a spawned agent away from minting credentials. Locked here because widening
  // isAgentIngressRoute is otherwise a silent privilege escalation.
  const deps = makeDeps();
  const ingress = makeAgentIngressApp(deps);
  for (const [method, path] of [
    ["GET", "/api/access-tokens"],
    ["POST", "/api/access-tokens"],
    ["DELETE", "/api/access-tokens/t1"],
  ] as const) {
    const res = await ingress.fetch(
      new Request(`http://x${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ name: "escalation" }) : undefined,
      }),
    );
    expect(res.status).toBe(404);
  }
  // And nothing was minted along the way.
  expect(deps.store.listAccessTokens()).toHaveLength(0);
});

// ── validation ─────────────────────────────────────────────────────────────

test("validation: name must be present, non-blank and within the length bound", async () => {
  const app = makeApp(makeDeps());
  for (const name of ["", "   ", 42, null, undefined, "a".repeat(ACCESS_TOKEN_NAME_MAX + 1)]) {
    const res = await app.fetch(post({ name, expiresInDays: null }));
    expect(res.status).toBe(400);
  }
  expect((await app.fetch(post({ name: "a".repeat(ACCESS_TOKEN_NAME_MAX) }))).status).toBe(201);
});

test("validation: expiresInDays must be null or a preset", async () => {
  const app = makeApp(makeDeps());
  for (const expiresInDays of [1, 0, -30, "30", 7300]) {
    const res = await app.fetch(post({ name: "x", expiresInDays }));
    expect(res.status).toBe(400);
  }
});

test("validation: unknown fields are rejected", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(post({ name: "x", expiresInDays: null, scopes: ["read"] }));
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toMatchObject({ error: "unknown field: scopes" });
});

test("validation: a non-JSON content type is 415, malformed JSON is 400", async () => {
  const app = makeApp(makeDeps());
  const wrongType = await app.fetch(
    new Request("http://x/api/access-tokens", {
      method: "POST",
      headers: { "content-type": "text/plain", Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}` },
      body: "name=x",
    }),
  );
  expect(wrongType.status).toBe(415);

  const badJson = await app.fetch(
    new Request("http://x/api/access-tokens", {
      method: "POST",
      headers: asOperator(),
      body: "{not json",
    }),
  );
  expect(badJson.status).toBe(400);
});

test("validation: a JSON array body is rejected, not treated as an object", async () => {
  const app = makeApp(makeDeps());
  expect((await app.fetch(post([{ name: "x" }]))).status).toBe(400);
});

// ── revoke edge cases ──────────────────────────────────────────────────────

test("revoke: an unknown id is 404", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(
    new Request("http://x/api/access-tokens/no-such-id", {
      method: "DELETE",
      headers: asOperator(),
    }),
  );
  expect(res.status).toBe(404);
});

test("routing: an unsupported shape 404s rather than admitting the route group exists", async () => {
  // A 403 here would tell an unauthenticated caller that /api/access-tokens is a real route
  // group. Unmatched shapes must reach the dispatch tail's 404 WITHOUT touching the session
  // guard — so these are checked with a valid operator cookie AND without one.
  const app = makeApp(makeDeps());
  const shapes: [string, string][] = [
    ["PUT", "/api/access-tokens"],
    ["PATCH", "/api/access-tokens"],
    ["GET", "/api/access-tokens/t1"],
    ["POST", "/api/access-tokens/t1"],
    ["DELETE", "/api/access-tokens/t1/extra"],
  ];
  for (const [method, path] of shapes) {
    const res = await app.fetch(new Request(`http://x${path}`, { method, headers: asOperator() }));
    expect(`${method} ${path} → ${res.status}`).toBe(`${method} ${path} → 404`);
  }
});

test("revoke: DELETE without an id does not fall through to a mass delete", async () => {
  const app = makeApp(makeDeps());
  await app.fetch(post({ name: "keeper", expiresInDays: null }));
  const res = await app.fetch(
    new Request("http://x/api/access-tokens", { method: "DELETE", headers: asOperator() }),
  );
  expect(res.status).toBe(404); // unmatched /api route
  const listed = (await (
    await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
  ).json()) as Listed;
  expect(listed.tokens).toHaveLength(1);
});

// ── the settings payload's env-token flag ──────────────────────────────────

test("settings payload: envTokenActive mirrors whether SHEPHERD_TOKEN is set, never its value", async () => {
  const app = makeApp(makeDeps());
  const off = (await (
    await app.fetch(new Request("http://x/api/settings", { headers: asOperator() }))
  ).json()) as Record<string, unknown>;
  expect(off.envTokenActive).toBe(false);

  config.token = "operator-bearer";
  const on = (await (
    await app.fetch(new Request("http://x/api/settings", { headers: asOperator() }))
  ).json()) as Record<string, unknown>;
  expect(on.envTokenActive).toBe(true);
  expect(JSON.stringify(on)).not.toContain("operator-bearer");
});
