import { test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import { signCookie, SESSION_COOKIE } from "../src/operator-auth";
import { PairingCodeService, PAIRING_TTL_MS } from "../src/pairing-codes";
import { AccessTokenService } from "../src/access-tokens";
const SECRET = "pairing-test-secret";
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

let previous: { cookieSecret: string | null; token: string | null };
beforeEach(() => {
  previous = { cookieSecret: config.cookieSecret, token: config.token };
  config.cookieSecret = SECRET;
  config.token = null;
});
afterEach(() => Object.assign(config, previous));
const cookie = () => ({ Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}` });
const post = (path: string, body?: unknown, headers = {}) =>
  new Request(`http://x/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("only an operator session mints invitations; paired full token authenticates", async () => {
  const deps = makeDeps();
  const app = makeApp(deps);
  expect((await app.fetch(post("pairing-codes"))).status).toBe(401);
  const invitation = await app.fetch(post("pairing-codes", undefined, cookie()));
  expect(invitation.status).toBe(201);
  expect(invitation.headers.get("Cache-Control")).toBe("no-store");
  const { code } = await invitation.json();
  const response = await app.fetch(post("pair", { code, deviceName: "My\niPhone" }));
  expect(response.status).toBe(201);
  const minted = await response.json();
  expect(minted.entry).toMatchObject({
    name: "Shepherd for iOS (MyiPhone)",
    scope: "full",
    expiresAt: null,
    repoPaths: null,
  });
  const bearer = { Authorization: `Bearer ${minted.token}` };
  expect((await app.fetch(new Request("http://x/api/me", { headers: bearer }))).status).toBe(200);
  expect((await app.fetch(post("pairing-codes", undefined, bearer))).status).toBe(403);
  const replay = await app.fetch(post("pair", { code }));
  expect(replay.status).toBe(401);
  expect(await replay.json()).toEqual({ error: "pairing_code_invalid" });
});

test("expiry, malformed bodies and name limits do not mint tokens", async () => {
  let now = 0;
  const deps = makeDeps();
  deps.pairingCodes = new PairingCodeService(() => now);
  const app = makeApp(deps);
  const { code } = deps.pairingCodes.mint();
  now = PAIRING_TTL_MS;
  expect((await app.fetch(post("pair", { code }))).status).toBe(401);
  expect((await app.fetch(post("pair", null))).status).toBe(400);
  const fresh = deps.pairingCodes.mint();
  expect(
    (await app.fetch(post("pair", { code: fresh.code, deviceName: "x".repeat(65) }))).status,
  ).toBe(400);
  expect((await app.fetch(post("pair", { code: fresh.code }))).status).toBe(201);
  expect(new AccessTokenService(deps.store).list()).toHaveLength(1);
});

test("pair: body over 1 KiB → 413 (declared Content-Length), no token minted", async () => {
  const deps = makeDeps();
  deps.pairingCodes = new PairingCodeService();
  const { code } = deps.pairingCodes.mint();
  const app = makeApp(deps);
  const res = await app.fetch(post("pair", { code, deviceName: "x".repeat(2000) }));
  expect(res.status).toBe(413);
  expect(deps.store.listAccessTokens()).toHaveLength(0);
  expect((await app.fetch(post("pair", { code }))).status).toBe(201); // code not consumed
});

test("pair: streamed body over 1 KiB without Content-Length → 413", async () => {
  const app = makeApp(makeDeps());
  const chunk = new TextEncoder().encode("x".repeat(256));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < 64) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const req = new Request("http://x/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
  });
  expect(req.headers.get("content-length")).toBeNull();
  const res = await app.fetch(req);
  expect(res.status).toBe(413);
  expect(sent).toBeLessThan(64); // stopped reading at the cap, never buffered the whole body
});

test("pair: malformed json within the cap → 400", async () => {
  const app = makeApp(makeDeps());
  const req = new Request("http://x/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect((await app.fetch(req)).status).toBe(400);
});

test("concurrent redemption yields only one token", async () => {
  const deps = makeDeps();
  deps.pairingCodes = new PairingCodeService();
  const { code } = deps.pairingCodes.mint();
  const app = makeApp(deps);
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => app.fetch(post("pair", { code }))),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([201, 401, 401]);
  expect(deps.store.listAccessTokens()).toHaveLength(1);
});

test("limiter ignores spoofed forwarding headers and resets with time", async () => {
  let now = 0;
  const deps = makeDeps();
  deps.pairingCodes = new PairingCodeService(() => now);
  const app = makeApp(deps);
  for (let i = 0; i < 10; i++)
    expect(
      (await app.fetch(post("pair", { code: "wrong" }, { "X-Forwarded-For": `peer-${i}` }))).status,
    ).toBe(401);
  expect((await app.fetch(post("pair", { code: "wrong" }))).status).toBe(429);
  now = 60_000;
  expect((await app.fetch(post("pair", { code: "wrong" }))).status).toBe(401);
});

test("outstanding codes are capped and attempts are bounded across all peers", () => {
  let now = 0;
  const svc = new PairingCodeService(() => now);
  const oldest = svc.mint();
  const next = Array.from({ length: 5 }, () => svc.mint());
  expect(svc.consume(oldest.code)).toBe(false);
  expect(svc.consume(next[0]!.code)).toBe(true);
  // 30 attempts a minute in total (#3338), however many distinct peers make them.
  for (let i = 0; i < 30; i++) expect(svc.allowAttempt(`peer-${i}`)).toBe(true);
  expect(svc.allowAttempt("extra")).toBe(false);
  now = 60_000;
  expect(svc.allowAttempt("extra")).toBe(true);
});
