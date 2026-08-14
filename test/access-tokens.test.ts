import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import {
  AccessTokenService,
  ACCESS_TOKEN_PREFIX,
  generateAccessToken,
  hashAccessToken,
  tokenHint,
  normalizeTokenName,
  isExpiryPreset,
  looksLikeAccessToken,
  ACCESS_TOKEN_NAME_MAX,
} from "../src/access-tokens";

const DAY = 24 * 60 * 60 * 1000;

/** A store plus a service on a movable clock — expiry and the throttle are tested without sleeps. */
function harness(startAt = 1_000_000) {
  const store = new SessionStore(":memory:");
  let now = startAt;
  const svc = new AccessTokenService(store, () => now);
  return { store, svc, at: (t: number) => (now = t), advance: (ms: number) => (now += ms) };
}

const bearer = (token: string) => `Bearer ${token}`;

/** First row, asserted present — keeps the assertions readable under noUncheckedIndexedAccess. */
function only<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}

// ── format helpers (pure) ──────────────────────────────────────────────────

test("generateAccessToken: prefixed, url-safe, 256 bits of entropy", () => {
  const t = generateAccessToken();
  expect(t.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
  const body = t.slice(ACCESS_TOKEN_PREFIX.length);
  expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url of 32 bytes
  expect(generateAccessToken()).not.toBe(t);
});

test("hashAccessToken: deterministic hex sha256, differs per token", () => {
  const t = generateAccessToken();
  expect(hashAccessToken(t)).toBe(hashAccessToken(t));
  expect(hashAccessToken(t)).toMatch(/^[0-9a-f]{64}$/);
  expect(hashAccessToken(generateAccessToken())).not.toBe(hashAccessToken(t));
});

test("tokenHint: the last 4 plaintext chars", () => {
  expect(tokenHint("shp_abcdWXYZ")).toBe("WXYZ");
});

test("normalizeTokenName: trims, rejects empty / over-long / non-strings", () => {
  expect(normalizeTokenName("  Asyar — MacBook  ")).toBe("Asyar — MacBook");
  expect(normalizeTokenName("   ")).toBeNull();
  expect(normalizeTokenName("")).toBeNull();
  expect(normalizeTokenName(42)).toBeNull();
  expect(normalizeTokenName(undefined)).toBeNull();
  expect(normalizeTokenName("a".repeat(ACCESS_TOKEN_NAME_MAX))).toHaveLength(ACCESS_TOKEN_NAME_MAX);
  expect(normalizeTokenName("a".repeat(ACCESS_TOKEN_NAME_MAX + 1))).toBeNull();
});

test("looksLikeAccessToken: the shape gate that keeps the service off the cold path", () => {
  expect(looksLikeAccessToken(bearer(generateAccessToken()))).toBe(true);
  expect(looksLikeAccessToken("Bearer shp_")).toBe(true); // shape only — verify decides validity
  expect(looksLikeAccessToken("Bearer some-env-provisioned-secret")).toBe(false);
  expect(looksLikeAccessToken("shp_no-bearer-marker")).toBe(false);
  expect(looksLikeAccessToken("Basic shp_wrong-scheme")).toBe(false);
  expect(looksLikeAccessToken(null)).toBe(false);
  expect(looksLikeAccessToken(undefined)).toBe(false);
  expect(looksLikeAccessToken("")).toBe(false);
});

test("isExpiryPreset: null or one of the three presets", () => {
  expect(isExpiryPreset(null)).toBe(true);
  expect(isExpiryPreset(30)).toBe(true);
  expect(isExpiryPreset(90)).toBe(true);
  expect(isExpiryPreset(365)).toBe(true);
  expect(isExpiryPreset(1)).toBe(false);
  expect(isExpiryPreset("30")).toBe(false);
  expect(isExpiryPreset(undefined)).toBe(false);
});

// ── at rest ────────────────────────────────────────────────────────────────

test("the plaintext is never written to SQLite — only its hash and a 4-char hint", () => {
  const { store, svc } = harness();
  const { token, entry } = svc.mint("Asyar", null);

  const rows = store.listAccessTokens();
  expect(rows).toHaveLength(1);
  expect(only(rows).tokenHash).toBe(hashAccessToken(token));
  expect(only(rows).hint).toBe(token.slice(-4));
  // No column anywhere in the row carries the plaintext.
  expect(JSON.stringify(only(rows))).not.toContain(token);
  // Nor does the summary the API returns.
  expect(JSON.stringify(entry)).not.toContain(token);
  expect(entry).not.toHaveProperty("tokenHash");
});

test("list(): newest first, metadata only", () => {
  const { svc, advance } = harness();
  svc.mint("first", null);
  advance(1000);
  svc.mint("second", null);

  const list = svc.list();
  expect(list.map((t) => t.name)).toEqual(["second", "first"]);
  expect(only(list)).not.toHaveProperty("tokenHash");
  expect(only(list).lastUsedAt).toBeNull();
});

// ── verification ───────────────────────────────────────────────────────────

test("verify: accepts the minted token and returns its id", () => {
  const { svc } = harness();
  const { token, entry } = svc.mint("Asyar", null);
  expect(svc.verify(bearer(token))).toBe(entry.id);
});

test("verify: rejects unknown, malformed, unprefixed and missing headers", () => {
  const { svc } = harness();
  const { token } = svc.mint("Asyar", null);

  expect(svc.verify(bearer(generateAccessToken()))).toBeNull(); // well-formed but unknown
  expect(svc.verify(bearer(`${token}x`))).toBeNull(); // tampered
  expect(svc.verify(bearer("not-a-shepherd-token"))).toBeNull(); // wrong prefix
  expect(svc.verify(token)).toBeNull(); // no "Bearer " marker
  expect(svc.verify(null)).toBeNull();
  expect(svc.verify(undefined)).toBeNull();
  expect(svc.verify("")).toBeNull();
});

test("verify: an expired token is rejected, and its row stays listed", () => {
  const { svc, advance } = harness();
  const { token } = svc.mint("short-lived", 30);

  advance(29 * DAY);
  expect(svc.verify(bearer(token))).not.toBeNull();

  advance(2 * DAY); // now past the expiry
  expect(svc.verify(bearer(token))).toBeNull();
  expect(svc.list()).toHaveLength(1); // expired rows stay visible until revoked by hand
});

test("verify: a never-expiring token survives an absurd clock jump", () => {
  const { svc, advance } = harness();
  const { token } = svc.mint("long-lived", null);
  advance(10 * 365 * DAY);
  expect(svc.verify(bearer(token))).not.toBeNull();
});

test("a service constructed over an existing store verifies tokens minted before it (boot path)", () => {
  const store = new SessionStore(":memory:");
  const { token } = new AccessTokenService(store).mint("minted-before-restart", null);

  // A fresh instance = a restart. It must seed its map from SQLite.
  expect(new AccessTokenService(store).verify(bearer(token))).not.toBeNull();
});

// ── revocation ─────────────────────────────────────────────────────────────

test("revoke: drops the row and the in-memory entry immediately", () => {
  const { store, svc } = harness();
  const { token, entry } = svc.mint("Asyar", null);

  expect(svc.revoke(entry.id)).toBe(true);
  expect(svc.verify(bearer(token))).toBeNull();
  expect(svc.list()).toHaveLength(0);
  expect(store.listAccessTokens()).toHaveLength(0);
});

test("revoke: unknown id is false, and leaves the other tokens alone", () => {
  const { svc } = harness();
  const { token } = svc.mint("keeper", null);
  expect(svc.revoke("no-such-id")).toBe(false);
  expect(svc.verify(bearer(token))).not.toBeNull();
});

// ── lastUsedAt ─────────────────────────────────────────────────────────────

test("stampUsed: writes once, then throttles for a minute", () => {
  const { store, svc, advance } = harness();
  const { entry } = svc.mint("Asyar", null);
  const id = entry.id;

  svc.stampUsed(id);
  const first = only(store.listAccessTokens()).lastUsedAt;
  expect(first).not.toBeNull();

  advance(30_000); // inside the window — no second write
  svc.stampUsed(id);
  expect(only(store.listAccessTokens()).lastUsedAt).toBe(first);

  advance(31_000); // past the window — writes again
  svc.stampUsed(id);
  expect(only(store.listAccessTokens()).lastUsedAt).toBeGreaterThan(first!);
});

test("stampUsed: throttled per token, not globally", () => {
  const { store, svc } = harness();
  const a = svc.mint("a", null).entry.id;
  const b = svc.mint("b", null).entry.id;

  svc.stampUsed(a);
  svc.stampUsed(b);
  expect(store.listAccessTokens().every((r) => r.lastUsedAt !== null)).toBe(true);
});

test("stampUsed: a re-minted token id starts its throttle fresh after a revoke", () => {
  const { store, svc, advance } = harness();
  const first = svc.mint("a", null).entry.id;
  svc.stampUsed(first);
  svc.revoke(first);

  advance(1000);
  const second = svc.mint("b", null).entry.id;
  svc.stampUsed(second);
  expect(only(store.listAccessTokens()).lastUsedAt).not.toBeNull();
});
