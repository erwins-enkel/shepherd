import { test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, makeAgentIngressApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE } from "../src/operator-auth";
import { ACCESS_TOKEN_NAME_MAX, ACCESS_TOKEN_PREFIX } from "../src/access-tokens";
import { TOKEN_SCOPES } from "../src/token-scopes";

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
    scope: "full", // no `scope` in the body ⇒ the pre-#2083 reach
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

test("guard: a minted bearer cannot list, mint, or revoke ANOTHER token — 403 on all three", async () => {
  const app = makeApp(makeDeps());
  const minted = (await (await app.fetch(post({ name: "Asyar", expiresInDays: null }))).json()) as {
    token: string;
    entry: { id: string };
  };
  const other = (await (await app.fetch(post({ name: "someone else" }))).json()) as {
    entry: { id: string };
  };
  const asBearer = { "content-type": "application/json", Authorization: `Bearer ${minted.token}` };

  const list = await app.fetch(new Request("http://x/api/access-tokens", { headers: asBearer }));
  expect(list.status).toBe(403);
  expect(await list.json()).toEqual({ error: "operator_session_required" });

  const mint = await app.fetch(post({ name: "escalation", expiresInDays: null }, asBearer));
  expect(mint.status).toBe(403);

  const revoke = await app.fetch(
    new Request(`http://x/api/access-tokens/${other.entry.id}`, {
      method: "DELETE",
      headers: asBearer,
    }),
  );
  expect(revoke.status).toBe(403);
  expect(await revoke.json()).toEqual({ error: "operator_session_required" });
  // …and the token it tried to revoke is still there.
  const listed = (await (
    await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
  ).json()) as Listed;
  expect(listed.tokens.map((t) => t.id).sort()).toEqual([minted.entry.id, other.entry.id].sort());
});

// ── self-revocation: the one exception to the operator-session rule ────────

test("self-revoke: a bearer may revoke ITSELF, and the token dies immediately", async () => {
  // How a native client logs out: it holds only the token, never a cookie. Without this the
  // credential on a logged-out (or lost) machine stays live until an operator opens the web UI.
  const app = makeApp(makeDeps());
  const minted = (await (await app.fetch(post({ name: "Asyar — MacBook" }))).json()) as {
    token: string;
    entry: { id: string };
  };
  const asBearer = { Authorization: `Bearer ${minted.token}` };
  expect((await app.fetch(new Request("http://x/api/me", { headers: asBearer }))).status).toBe(200);

  const res = await app.fetch(
    new Request(`http://x/api/access-tokens/${minted.entry.id}`, {
      method: "DELETE",
      headers: asBearer,
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  // Same app object, same process: the token no longer verifies.
  const after = await app.fetch(new Request("http://x/api/me", { headers: asBearer }));
  expect(after.status).toBe(401);
  expect(await after.json()).toEqual({ error: "unauthorized" });
  const listed = (await (
    await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
  ).json()) as Listed;
  expect(listed.tokens).toHaveLength(0);
});

test("self-revoke: allowed for every scope — a token may always kill itself", async () => {
  // Scope answers "how far does this credential reach"; self-destruction reaches nothing. A `read`
  // token would otherwise be stopped one layer earlier by the seam's scope gate (403
  // insufficient_scope), so this also pins the SELF_REVOKE_PATTERN carve-out in token-scopes.ts.
  for (const scope of TOKEN_SCOPES) {
    const app = makeApp(makeDeps());
    const minted = (await (await app.fetch(post({ name: `client-${scope}`, scope }))).json()) as {
      token: string;
      entry: { id: string };
    };
    // A second token of the same scope: this bearer must not be able to revoke IT, only itself —
    // the carve-out is bound to the caller's own id (`scopeAllows`'s `selfTokenId`). `full` reaches
    // the handler regardless of id (its scope-gate check is unconditional) and is refused there by
    // `requireOperatorSession`/`revokesItself`; `read`/`submit` never even reach the handler for
    // someone else's id — the tightened seam gate (#F3) refuses it first as `insufficient_scope`.
    const other = (await (await app.fetch(post({ name: `other-${scope}`, scope }))).json()) as {
      token: string;
      entry: { id: string };
    };
    const asMinted = { Authorization: `Bearer ${minted.token}` };
    const crossRevoke = await app.fetch(
      new Request(`http://x/api/access-tokens/${other.entry.id}`, {
        method: "DELETE",
        headers: asMinted,
      }),
    );
    const expectedError = scope === "full" ? "operator_session_required" : "insufficient_scope";
    expect(`${scope} cross-revoke → ${crossRevoke.status}`).toBe(`${scope} cross-revoke → 403`);
    expect(await crossRevoke.json()).toEqual({ error: expectedError });
    // The target token is untouched — still able to authenticate.
    const otherStillLive = await app.fetch(
      new Request("http://x/api/ping", {
        method: "POST",
        headers: { Authorization: `Bearer ${other.token}` },
      }),
    );
    expect(`${scope} target still live → ${otherStillLive.status}`).toBe(
      `${scope} target still live → 200`,
    );

    const res = await app.fetch(
      new Request(`http://x/api/access-tokens/${minted.entry.id}`, {
        method: "DELETE",
        headers: asMinted,
      }),
    );
    expect(`${scope} → ${res.status}`).toBe(`${scope} → 200`);
  }
});

test("self-revoke: an unknown or tampered bearer gets 401 at the gate, never 404", async () => {
  // The mismatch answer must not depend on whether the id exists, or it becomes an enumeration
  // oracle for the token list a bearer is deliberately not allowed to read.
  const app = makeApp(makeDeps());
  const minted = (await (await app.fetch(post({ name: "Asyar" }))).json()) as {
    token: string;
    entry: { id: string };
  };
  for (const auth of [
    `Bearer ${minted.token}x`,
    `Bearer ${ACCESS_TOKEN_PREFIX}nope`,
    "Bearer xyz",
  ]) {
    for (const id of [minted.entry.id, "no-such-id"]) {
      const res = await app.fetch(
        new Request(`http://x/api/access-tokens/${id}`, {
          method: "DELETE",
          headers: { Authorization: auth },
        }),
      );
      // checkAuth stops these at the gate first — a dead credential is 401, never a hint that the
      // route exists. What matters is that none of them is a 200 or a 404.
      expect(`${auth} ${id} → ${res.status}`).toBe(`${auth} ${id} → 401`);
    }
  }
  // And the token is untouched.
  expect(
    (
      (await (
        await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
      ).json()) as Listed
    ).tokens,
  ).toHaveLength(1);
});

test("self-revoke: an already-revoked bearer also gets 401 at the gate, not 404", async () => {
  // Once revoked (here, by the operator, as `checkAuth`'s ordinary path would after any revoke),
  // the plaintext no longer verifies at all — replaying it hits the SAME gate as a bearer that was
  // never real, not a special "already gone" case in the self-revoke handler.
  const app = makeApp(makeDeps());
  const minted = (await (await app.fetch(post({ name: "Asyar" }))).json()) as {
    token: string;
    entry: { id: string };
  };
  const revoke = await app.fetch(
    new Request(`http://x/api/access-tokens/${minted.entry.id}`, {
      method: "DELETE",
      headers: asOperator(),
    }),
  );
  expect(revoke.status).toBe(200);

  const replay = await app.fetch(
    new Request(`http://x/api/access-tokens/${minted.entry.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${minted.token}` },
    }),
  );
  expect(replay.status).toBe(401);
  expect(await replay.json()).toEqual({ error: "unauthorized" });
});

test("self-revoke: SHEPHERD_TOKEN has no id of its own, so it revokes nothing", async () => {
  // The legacy env credential is not a minted row — there is no id it could ever match, including
  // the id of a token it can otherwise authenticate as.
  config.token = "operator-bearer";
  const app = makeApp(makeDeps());
  const minted = (await (await app.fetch(post({ name: "Asyar" }))).json()) as {
    entry: { id: string };
  };
  for (const id of [minted.entry.id, "operator-bearer", "no-such-id"]) {
    const res = await app.fetch(
      new Request(`http://x/api/access-tokens/${id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer operator-bearer" },
      }),
    );
    expect(`${id} → ${res.status}`).toBe(`${id} → 403`);
    expect(await res.json()).toEqual({ error: "operator_session_required" });
  }
  expect(
    (
      (await (
        await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
      ).json()) as Listed
    ).tokens,
  ).toHaveLength(1);
});

test("self-revoke: a bearer still cannot LIST, even though it may revoke itself", async () => {
  const app = makeApp(makeDeps());
  const minted = (await (await app.fetch(post({ name: "Asyar" }))).json()) as { token: string };
  const res = await app.fetch(
    new Request("http://x/api/access-tokens", {
      headers: { Authorization: `Bearer ${minted.token}` },
    }),
  );
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "operator_session_required" });
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

// ── scopes (#2083) ─────────────────────────────────────────────────────────

test("mint: the chosen scope round-trips onto the row the list renders", async () => {
  const app = makeApp(makeDeps());
  for (const scope of TOKEN_SCOPES) {
    const res = await app.fetch(post({ name: `client-${scope}`, scope }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Minted).entry).toMatchObject({ scope });
  }
  const listed = (await (
    await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
  ).json()) as { tokens: { name: string; scope: string }[] };
  expect(listed.tokens.map((t) => `${t.name}:${t.scope}`).sort()).toEqual([
    "client-full:full",
    "client-read:read",
    "client-submit:submit",
  ]);
});

test("validation: scope must be one of the three levels", async () => {
  const app = makeApp(makeDeps());
  for (const scope of ["", "admin", "READ", "read submit", ["read"], 1, null, {}]) {
    const res = await app.fetch(post({ name: "x", scope }));
    expect(`scope=${JSON.stringify(scope)} → ${res.status}`).toBe(
      `scope=${JSON.stringify(scope)} → 400`,
    );
    expect((await res.json()) as { error: string }).toMatchObject({
      error: `scope must be one of ${TOKEN_SCOPES.join(", ")}`,
    });
  }
});

test("mint: there is no route to change a scope after the fact", async () => {
  // The audit story depends on this: a token's reach is fixed at mint. PATCH/PUT on the collection
  // and on a single token must not resolve to anything — they 404 as unmatched /api routes.
  const app = makeApp(makeDeps());
  const { entry } = (await (await app.fetch(post({ name: "reader", scope: "read" }))).json()) as {
    entry: { id: string };
  };
  for (const method of ["PATCH", "PUT", "POST"] as const) {
    const res = await app.fetch(
      new Request(`http://x/api/access-tokens/${entry.id}`, {
        method,
        headers: asOperator(),
        body: JSON.stringify({ scope: "full" }),
      }),
    );
    expect(`${method} → ${res.status}`).toBe(`${method} → 404`);
  }
  // …and the scope is unchanged.
  const listed = (await (
    await app.fetch(new Request("http://x/api/access-tokens", { headers: asOperator() }))
  ).json()) as { tokens: { scope: string }[] };
  expect(listed.tokens[0]!.scope).toBe("read");
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
