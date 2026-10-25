import { test, expect } from "bun:test";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

/** Mode and contents read through one descriptor (no stat/read race). */
function readChannel(file: string): { mode: number; text: string } {
  const fd = openSync(file, "r");
  try {
    return { mode: fstatSync(fd).mode & 0o777, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  parseCookies,
  verifySessionCookie,
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

test("parseCookies extracts every session value among others, in header order", () => {
  expect(parseCookies(`a=1; ${SESSION_COOKIE}=tok123; b=2`)).toEqual(["tok123"]);
  expect(parseCookies(`${SESSION_COOKIE}=junk; a=1; ${SESSION_COOKIE}=tok`)).toEqual([
    "junk",
    "tok",
  ]);
  expect(parseCookies("a=1; b=2")).toEqual([]);
  expect(parseCookies(null)).toEqual([]);
});

const SECRET = "test-cookie-signing-secret";

// A preview origin can plant a path-scoped sibling cookie that the browser sends FIRST (#3365).
test("verifySessionCookie: any valid sibling authenticates, whatever its position", () => {
  const valid = signCookie(SECRET);
  expect(verifySessionCookie(SECRET, `${SESSION_COOKIE}=junk; ${SESSION_COOKIE}=${valid}`).ok).toBe(
    true,
  );
  expect(verifySessionCookie(SECRET, `${SESSION_COOKIE}=${valid}; ${SESSION_COOKIE}=junk`).ok).toBe(
    true,
  );
});

test("verifySessionCookie: picks the valid cookie with the latest expiry", () => {
  const now = Date.now();
  const older = signCookie(SECRET, SESSION_TTL_MS, now - 1000);
  const newer = signCookie(SECRET, SESSION_TTL_MS, now);
  const v = verifySessionCookie(SECRET, `${SESSION_COOKIE}=${newer}; ${SESSION_COOKIE}=${older}`);
  expect(v.ok && v.exp).toBe(now + SESSION_TTL_MS);
});

test("verifySessionCookie: fails when no value verifies or none is present", () => {
  const forged = signCookie("other-secret");
  expect(
    verifySessionCookie(SECRET, `${SESSION_COOKIE}=junk; ${SESSION_COOKIE}=${forged}`).ok,
  ).toBe(false);
  expect(verifySessionCookie(SECRET, "a=1")).toEqual({ ok: false });
  expect(verifySessionCookie(SECRET, null)).toEqual({ ok: false });
});

// ── conditional Secure detection ─────────────────────────────────────────────

test("isSecureRequest: X-Forwarded-Proto trusted only from a loopback peer; https url ⇒ true", () => {
  const xfp = () =>
    new Request("http://127.0.0.1:7330/api/me", { headers: { "x-forwarded-proto": "https" } });
  expect(isSecureRequest(xfp(), "127.0.0.1")).toBe(true);
  expect(isSecureRequest(xfp(), "::1")).toBe(true);
  expect(isSecureRequest(xfp(), "::ffff:127.0.0.1")).toBe(true);
  // A non-loopback (or unknown) peer could set the header itself (#2109).
  expect(isSecureRequest(xfp(), "100.64.0.7")).toBe(false);
  expect(isSecureRequest(xfp(), "::ffff:10.0.0.1")).toBe(false);
  expect(isSecureRequest(xfp())).toBe(false);
  // A loopback proxy saying http is honoured even for an https URL.
  expect(
    isSecureRequest(
      new Request("https://host.ts.net/api/me", { headers: { "x-forwarded-proto": "http" } }),
      "127.0.0.1",
    ),
  ).toBe(false);
  expect(isSecureRequest(new Request("http://127.0.0.1:7330/api/me"), "127.0.0.1")).toBe(false);
  expect(isSecureRequest(new Request("https://host.ts.net/api/me"))).toBe(true);
  expect(isSecureRequest(new Request("https://host.ts.net/api/me"), "100.64.0.7")).toBe(true);
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

test("bootstrapAuth: a CHANGED SHEPHERD_PASSWORD rotates the persisted cookie secret (#2106)", async () => {
  const store = fakeStore({
    passwordHash: await hashPassword("old-password"),
    cookieSecret: "persisted-secret",
  });
  const oldCookie = signCookie("persisted-secret");
  const r = await bootstrapAuth({ store, envPassword: "new-password", envCookieSecret: null });
  expect(r.sessionsRevoked).toBe(true);
  expect(r.staleSessionsKept).toBe(false);
  expect(r.cookieSecret).not.toBe("persisted-secret");
  expect(store.data.get("cookieSecret")).toBe(r.cookieSecret);
  expect(verifyCookie(r.cookieSecret, oldCookie).ok).toBe(false); // the old session is out
});

test("bootstrapAuth: an UNCHANGED SHEPHERD_PASSWORD keeps the cookie secret across restarts", async () => {
  const store = fakeStore({
    passwordHash: await hashPassword("same-password"),
    cookieSecret: "persisted-secret",
  });
  const r = await bootstrapAuth({ store, envPassword: "same-password", envCookieSecret: null });
  expect(r.sessionsRevoked).toBe(false);
  expect(r.cookieSecret).toBe("persisted-secret");
  // …and the re-seeded hash still recognizes the same password on the next boot.
  const again = await bootstrapAuth({ store, envPassword: "same-password", envCookieSecret: null });
  expect(again.cookieSecret).toBe("persisted-secret");
});

test("bootstrapAuth: first boot with SHEPHERD_PASSWORD (no persisted hash) is not a change", async () => {
  const store = fakeStore({ cookieSecret: "persisted-secret" });
  const r = await bootstrapAuth({ store, envPassword: "first", envCookieSecret: null });
  expect(r.sessionsRevoked).toBe(false);
  expect(r.cookieSecret).toBe("persisted-secret");
});

test("bootstrapAuth: a changed password with a PINNED env cookie secret reports stale sessions", async () => {
  const store = fakeStore({ passwordHash: await hashPassword("old"), cookieSecret: "persisted" });
  const r = await bootstrapAuth({ store, envPassword: "new", envCookieSecret: "env-pinned" });
  expect(r.cookieSecret).toBe("env-pinned"); // never overrides an operator pin
  expect(r.sessionsRevoked).toBe(false);
  expect(r.staleSessionsKept).toBe(true);
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

test("bootstrapAuth: supervised credential channel is private and never emits a banner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shepherd-auth-channel-"));
  try {
    const file = join(directory, "password");
    writeFileSync(file, "", { mode: 0o644 });
    const logs: string[] = [];
    const store = fakeStore();
    const result = await bootstrapAuth({
      store,
      envPassword: null,
      envCookieSecret: null,
      generatedPasswordFile: file,
      log: (line) => logs.push(line),
    });
    expect(logs).toEqual([]);
    const channel = readChannel(file);
    expect(channel.text).toBe(result.generatedPassword!);
    expect(channel.mode).toBe(0o600);
    expect(await verifyPassword(channel.text, result.passwordHash)).toBe(true);
    // An existing password is retained and no credential is offered again.
    writeFileSync(file, "");
    const restart = await bootstrapAuth({
      store,
      envPassword: null,
      envCookieSecret: null,
      generatedPasswordFile: file,
      log: (line) => logs.push(line),
    });
    expect(restart.passwordHash).toBe(result.passwordHash);
    expect(readChannel(file).text).toBe("");
    expect(logs).toEqual([]);
    const link = join(directory, "link");
    symlinkSync(file, link);
    await expect(
      bootstrapAuth({
        store: fakeStore(),
        envPassword: null,
        envCookieSecret: null,
        generatedPasswordFile: link,
        log: (line) => logs.push(line),
      }),
    ).rejects.toThrow();
    expect(logs).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of ["missing", "unwritable"] as const) {
  test(`bootstrapAuth: ${failure} credential channel leaves generation retryable`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "shepherd-auth-retry-"));
    try {
      // A directory is deterministically unwritable as a credential file, even as root.
      const file = failure === "missing" ? join(directory, "missing") : directory;
      const store = fakeStore();
      const logs: string[] = [];
      await expect(
        bootstrapAuth({
          store,
          envPassword: null,
          envCookieSecret: null,
          generatedPasswordFile: file,
          log: (line) => logs.push(line),
        }),
      ).rejects.toThrow();
      expect(store.getSetting("passwordHash")).toBe(null);
      expect(logs).toEqual([]);

      const retryFile = join(directory, "retry");
      writeFileSync(retryFile, "", { mode: 0o600 });
      const retry = await bootstrapAuth({
        store,
        envPassword: null,
        envCookieSecret: null,
        generatedPasswordFile: retryFile,
        log: (line) => logs.push(line),
      });
      expect(retry.generatedPassword).toBeTruthy();
      expect(store.getSetting("passwordHash")).toBe(retry.passwordHash);
      expect(await verifyPassword(readFileSync(retryFile, "utf8"), retry.passwordHash)).toBe(true);
      expect(logs).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
