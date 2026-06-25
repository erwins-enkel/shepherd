import { test, expect } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  generatePassword,
  generateSecret,
  signCookie,
  verifyCookie,
  shouldRestamp,
  serializeCookie,
  clearCookie,
  parseCookie,
  isSecureRequest,
  bootstrapAuth,
  type AuthSettingsStore,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "../src/operator-auth";

/** In-memory settings store for bootstrapAuth tests. */
function fakeStore(
  seed: Record<string, string> = {},
): AuthSettingsStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getSetting: (k) => data.get(k) ?? null,
    setSetting: (k, v) => void data.set(k, v),
  };
}

// ── password (argon2id) ──────────────────────────────────────────────────────

test("hashPassword → argon2id hash verifies the right password and rejects the wrong one", async () => {
  const hash = await hashPassword("correct horse battery staple");
  expect(hash.startsWith("$argon2id$")).toBe(true);
  expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  expect(await verifyPassword("wrong", hash)).toBe(false);
});

test("verifyPassword returns false (no throw) on a malformed hash", async () => {
  expect(await verifyPassword("x", "not-a-real-hash")).toBe(false);
});

test("generatePassword / generateSecret produce distinct strong values", () => {
  expect(generatePassword()).not.toBe(generatePassword());
  const secret = generateSecret();
  expect(secret).toHaveLength(64); // 32 bytes hex
  expect(generateSecret()).not.toBe(secret);
});

// ── cookie sign → verify roundtrip + tamper rejection ────────────────────────

test("signCookie → verifyCookie roundtrip succeeds within the window", () => {
  const secret = generateSecret();
  const now = 1_000_000;
  const value = signCookie(secret, SESSION_TTL_MS, now);
  const r = verifyCookie(secret, value, now + 1000);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.exp).toBe(now + SESSION_TTL_MS);
});

test("verifyCookie rejects a flipped-byte signature (timing-safe)", () => {
  const secret = generateSecret();
  const value = signCookie(secret, SESSION_TTL_MS, 1000);
  const [body, sig] = value.split(".");
  // flip the last char of the signature
  const last = sig!.at(-1) === "A" ? "B" : "A";
  const tampered = `${body}.${sig!.slice(0, -1)}${last}`;
  expect(verifyCookie(secret, tampered, 2000).ok).toBe(false);
});

test("verifyCookie rejects a cookie signed with a different secret", () => {
  const value = signCookie(generateSecret(), SESSION_TTL_MS, 1000);
  expect(verifyCookie(generateSecret(), value, 2000).ok).toBe(false);
});

test("verifyCookie rejects an expired cookie", () => {
  const secret = generateSecret();
  const now = 1000;
  const value = signCookie(secret, 10_000, now);
  expect(verifyCookie(secret, value, now + 9_000).ok).toBe(true);
  expect(verifyCookie(secret, value, now + 10_001).ok).toBe(false);
});

test("verifyCookie rejects malformed / empty values", () => {
  const secret = generateSecret();
  expect(verifyCookie(secret, null).ok).toBe(false);
  expect(verifyCookie(secret, "").ok).toBe(false);
  expect(verifyCookie(secret, "nodot").ok).toBe(false);
  expect(verifyCookie(secret, ".onlysig").ok).toBe(false);
});

// ── sliding re-stamp ─────────────────────────────────────────────────────────

test("shouldRestamp: false within the first half, true past half-life", () => {
  const iat = 1_000_000;
  expect(shouldRestamp(iat, SESSION_TTL_MS, iat + SESSION_TTL_MS / 4)).toBe(false);
  expect(shouldRestamp(iat, SESSION_TTL_MS, iat + SESSION_TTL_MS / 2 + 1)).toBe(true);
});

// ── cookie header serialize / parse ──────────────────────────────────────────

test("serializeCookie always sets HttpOnly + SameSite=Strict; Secure only when asked", () => {
  const insecure = serializeCookie("v", { secure: false });
  expect(insecure).toContain(`${SESSION_COOKIE}=v`);
  expect(insecure).toContain("HttpOnly");
  expect(insecure).toContain("SameSite=Strict");
  expect(insecure).toContain("Path=/");
  expect(insecure).not.toContain("Secure");

  const secure = serializeCookie("v", { secure: true });
  expect(secure).toContain("Secure");
});

test("clearCookie expires the cookie with Max-Age=0", () => {
  expect(clearCookie({ secure: false })).toContain("Max-Age=0");
  expect(clearCookie({ secure: false })).toContain(`${SESSION_COOKIE}=;`);
});

test("parseCookie extracts the session value among others", () => {
  expect(parseCookie(`a=1; ${SESSION_COOKIE}=tok123; b=2`)).toBe("tok123");
  expect(parseCookie("a=1; b=2")).toBe(null);
  expect(parseCookie(null)).toBe(null);
});

// ── conditional Secure detection ─────────────────────────────────────────────

test("isSecureRequest: X-Forwarded-Proto https ⇒ true; plain loopback ⇒ false; https url ⇒ true", () => {
  expect(
    isSecureRequest(
      new Request("http://127.0.0.1:7330/api/me", { headers: { "x-forwarded-proto": "https" } }),
    ),
  ).toBe(true);
  expect(isSecureRequest(new Request("http://127.0.0.1:7330/api/me"))).toBe(false);
  expect(isSecureRequest(new Request("https://host.ts.net/api/me"))).toBe(true);
});

// ── fail-closed bootstrap ────────────────────────────────────────────────────

test("bootstrapAuth: no password + no env ⇒ generates+persists hash AND secret, logs plaintext once", async () => {
  const store = fakeStore();
  const logs: string[] = [];
  const r = await bootstrapAuth({
    store,
    envPassword: null,
    envCookieSecret: null,
    log: (m) => logs.push(m),
  });
  // both secrets provisioned + persisted
  expect(r.cookieSecret).toBeTruthy();
  expect(store.data.get("cookieSecret")).toBe(r.cookieSecret);
  expect(r.passwordHash.startsWith("$argon2id$")).toBe(true);
  expect(store.data.get("passwordHash")).toBe(r.passwordHash);
  // plaintext generated, verifies against the persisted hash, and logged exactly once
  expect(r.generatedPassword).toBeTruthy();
  expect(await verifyPassword(r.generatedPassword!, r.passwordHash)).toBe(true);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain(r.generatedPassword!);
  expect(logs[0]).toContain("SHEPHERD_PASSWORD");
});

test("bootstrapAuth: SHEPHERD_PASSWORD set ⇒ overrides + re-seeds the persisted hash, no plaintext logged", async () => {
  const store = fakeStore({ passwordHash: "$argon2id$stale" });
  const logs: string[] = [];
  const r = await bootstrapAuth({
    store,
    envPassword: "operator-secret",
    envCookieSecret: null,
    log: (m) => logs.push(m),
  });
  expect(r.generatedPassword).toBe(null);
  expect(logs).toHaveLength(0);
  expect(store.data.get("passwordHash")).toBe(r.passwordHash);
  expect(r.passwordHash).not.toBe("$argon2id$stale"); // re-seeded
  expect(await verifyPassword("operator-secret", r.passwordHash)).toBe(true);
});

test("bootstrapAuth: persisted hash + no env ⇒ reused as-is (survives restart), no log", async () => {
  const existing = await hashPassword("kept-password");
  const store = fakeStore({ passwordHash: existing, cookieSecret: "fixedsecret" });
  const logs: string[] = [];
  const r = await bootstrapAuth({
    store,
    envPassword: null,
    envCookieSecret: null,
    log: (m) => logs.push(m),
  });
  expect(r.passwordHash).toBe(existing);
  expect(r.cookieSecret).toBe("fixedsecret");
  expect(r.generatedPassword).toBe(null);
  expect(logs).toHaveLength(0);
});

test("bootstrapAuth: env cookie secret pins the signing secret (overrides persisted)", async () => {
  const store = fakeStore({ cookieSecret: "persisted" });
  const r = await bootstrapAuth({
    store,
    envPassword: "x",
    envCookieSecret: "env-pinned",
    log: () => {},
  });
  expect(r.cookieSecret).toBe("env-pinned");
});
