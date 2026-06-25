/**
 * Single-operator authentication primitives (issue #1079). Hand-rolled on Bun built-ins —
 * no new deps. One shared credential: a password verified against an argon2id hash at rest,
 * exchanged for a stateless HMAC-signed session cookie. The identity check lives behind one
 * seam (checkAuth in server.ts) so multi-user/SSO could be added later without a rewrite —
 * but none of that machinery exists here.
 *
 * Stateless by design: the cookie is a bare capability with an expiry (no identity encoded —
 * there is only one operator), signed with a server-side secret. Verifying it is a single
 * HMAC (no DB read on the hot path — the server is one Bun loop pumping the web terminal).
 * Logout clears the cookie client-side only; there is no server-side revocation list. Rotating
 * the signing secret invalidates every outstanding cookie (the all-sessions kill-switch).
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/** Session cookie name. Same-origin; browsers attach it to fetch + WS upgrades automatically. */
export const SESSION_COOKIE = "shepherd_session";

/** 7-day sliding window. Idle ⇒ expires; active ⇒ re-stamped past half-life ⇒ effectively never re-login. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── password (argon2id via Bun.password) ─────────────────────────────────────

/** Hash a plaintext password with argon2id (Bun.password defaults). ~100ms — that cost IS the
 *  brute-force control (no lockout counters, per the settled single-operator threat model). */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Verify a plaintext against a stored argon2id hash. Returns false (never throws) on a malformed
 *  hash so a corrupt settings row can't crash the login path. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

/** Generate a strong random password for the fail-closed auto-provision path (printed once to the
 *  log). base64url of 18 bytes ⇒ 24 url-safe chars, ~144 bits. */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/** Generate a cookie signing secret (hex, 32 bytes / 256 bits). Persisted once in settings. */
export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

// ── session cookie (HMAC-signed, stateless) ──────────────────────────────────

type Payload = { iat: number; exp: number };

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Mint a signed session cookie value: `base64url(payload).hmac`. The payload carries only an
 * issued-at + expiry (no identity — single operator). `now` is injectable for tests.
 */
export function signCookie(secret: string, ttlMs = SESSION_TTL_MS, now = Date.now()): string {
  const payload: Payload = { iat: now, exp: now + ttlMs };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

/**
 * Verify a session cookie value. Returns `{ ok: true, iat, exp }` only when the signature is
 * valid (timing-safe compare) AND the cookie is unexpired. Any tampering (flipped byte, wrong
 * secret), malformed shape, or expiry ⇒ `{ ok: false }`.
 */
export function verifyCookie(
  secret: string,
  value: string | null | undefined,
  now = Date.now(),
): { ok: true; iat: number; exp: number } | { ok: false } {
  if (!value) return { ok: false };
  const dot = value.indexOf(".");
  if (dot <= 0) return { ok: false };
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = hmac(secret, body);
  // Length-guard before timingSafeEqual (it throws on unequal-length buffers).
  if (sig.length !== expected.length) return { ok: false };
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false };
  let payload: Payload;
  try {
    payload = JSON.parse(unb64url(body));
  } catch {
    return { ok: false };
  }
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return { ok: false };
  if (payload.exp <= now) return { ok: false };
  return { ok: true, iat: payload.iat, exp: payload.exp };
}

/** True when a valid cookie is past its half-life and should be re-stamped with a fresh expiry. */
export function shouldRestamp(iat: number, ttlMs = SESSION_TTL_MS, now = Date.now()): boolean {
  return now - iat >= ttlMs / 2;
}

// ── cookie header (serialize / parse) ────────────────────────────────────────

/**
 * Serialize a `Set-Cookie` header for the session. `HttpOnly` + `SameSite=Strict` ALWAYS;
 * `Secure` only when the request arrived over HTTPS (so `http://127.0.0.1:7330` stays usable for
 * local debugging). `Path=/` so it rides every route incl. the WS upgrades.
 */
export function serializeCookie(value: string, opts: { secure: boolean; ttlMs?: number }): string {
  const maxAge = Math.floor((opts.ttlMs ?? SESSION_TTL_MS) / 1000);
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Serialize the logout `Set-Cookie` — same attributes, empty value, `Max-Age=0` to expire it. */
export function clearCookie(opts: { secure: boolean }): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Pull one cookie value out of a `Cookie:` request header. Null when absent. */
export function parseCookie(
  header: string | null | undefined,
  name = SESSION_COOKIE,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Decide whether the response cookie should carry `Secure`, from the request. True when the HUD
 * was reached over HTTPS — either a terminating proxy set `X-Forwarded-Proto: https` (Tailscale
 * serve) or the request URL is itself `https:`. Plain loopback HTTP ⇒ false.
 */
export function isSecureRequest(req: Request): boolean {
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp) return xfp.split(",")[0]!.trim().toLowerCase() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

// ── boot bootstrap (fail-closed) ─────────────────────────────────────────────

/** Minimal settings-store surface bootstrapAuth needs (the real SessionStore satisfies it). */
export interface AuthSettingsStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

const PASSWORD_HASH_KEY = "passwordHash";
const COOKIE_SECRET_KEY = "cookieSecret";

/**
 * Resolve the operator-auth secrets at boot — fail-closed, so the app is never silently open.
 *
 * - Cookie signing secret: env override ?? persisted ?? generate+persist (always non-null after).
 * - Password hash:
 *   - `envPassword` set ⇒ authoritative: hash it and re-seed the persisted hash every boot.
 *   - else persisted hash ⇒ use as-is (an auto-generated one survives restarts).
 *   - else ⇒ generate a strong password, hash+persist it, and emit it ONCE via `log` with a loud
 *     CHANGE-THIS banner. Returned in `generatedPassword` for callers/tests.
 *
 * Pure w.r.t. the injected store + log, so the fail-closed paths are unit-testable.
 */
export async function bootstrapAuth(opts: {
  store: AuthSettingsStore;
  envPassword: string | null;
  envCookieSecret: string | null;
  log?: (msg: string) => void;
}): Promise<{ passwordHash: string; cookieSecret: string; generatedPassword: string | null }> {
  const { store, envPassword, envCookieSecret } = opts;
  const log = opts.log ?? (() => {});

  let cookieSecret = envCookieSecret ?? store.getSetting(COOKIE_SECRET_KEY);
  if (!cookieSecret) {
    cookieSecret = generateSecret();
    store.setSetting(COOKIE_SECRET_KEY, cookieSecret);
  }

  let generatedPassword: string | null = null;
  let passwordHash: string;
  if (envPassword) {
    passwordHash = await hashPassword(envPassword);
    store.setSetting(PASSWORD_HASH_KEY, passwordHash); // SHEPHERD_PASSWORD wins — re-seed each boot
  } else {
    const persisted = store.getSetting(PASSWORD_HASH_KEY);
    if (persisted) {
      passwordHash = persisted;
    } else {
      generatedPassword = generatePassword();
      passwordHash = await hashPassword(generatedPassword);
      store.setSetting(PASSWORD_HASH_KEY, passwordHash);
      log(
        "\n" +
          "  ┌──────────────────────────────────────────────────────────────────────┐\n" +
          "  │  SHEPHERD: no password configured — generated a random one (below).    │\n" +
          "  │  CHANGE THIS: set SHEPHERD_PASSWORD in ~/.shepherd/env and restart.     │\n" +
          "  └──────────────────────────────────────────────────────────────────────┘\n" +
          `  Operator password (shown ONCE): ${generatedPassword}\n`,
      );
    }
  }

  return { passwordHash, cookieSecret, generatedPassword };
}
