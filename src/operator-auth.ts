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
import { constants, openSync, closeSync, fchmodSync, ftruncateSync, writeFileSync } from "node:fs";

/** Session cookie name. Same-origin; browsers attach it to fetch + WS upgrades automatically. */
export const SESSION_COOKIE = "shepherd_session";

/** 7-day sliding window. Idle ⇒ expires; active ⇒ re-stamped past half-life ⇒ effectively never re-login. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── password (argon2id via Bun.password) ─────────────────────────────────────

/** Hash a plaintext password with argon2id (Bun.password defaults). ~100ms; together with the
 *  per-peer `POST /api/login` attempt budget (#2105) that bounds online guessing. */
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

/** Pull every value of one cookie out of a `Cookie:` request header, in header order. Empty when
 *  absent. A header can carry several: same name, different Path/Domain (#3365). */
export function parseCookies(header: string | null | undefined, name = SESSION_COOKIE): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

/**
 * Verify the session cookie(s) in a `Cookie:` header. Accepts when ANY `shepherd_session` value
 * verifies, so a junk sibling — e.g. one planted path-scoped by preview-origin JS, which the
 * browser sends first (#3365) — can't shadow a valid session. Several valid ⇒ the latest expiry.
 */
export function verifySessionCookie(
  secret: string,
  header: string | null | undefined,
  now = Date.now(),
): { ok: true; iat: number; exp: number } | { ok: false } {
  let best: { ok: true; iat: number; exp: number } | { ok: false } = { ok: false };
  for (const value of parseCookies(header)) {
    const v = verifyCookie(secret, value, now);
    if (v.ok && (!best.ok || v.exp > best.exp)) best = v;
  }
  return best;
}

/** True for a loopback socket address (IPv4 127/8, `::1`, IPv4-mapped 127/8). */
export function isLoopbackPeer(peer: string | null | undefined): boolean {
  if (!peer) return false;
  const v4 = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  return v4.startsWith("127.") || peer === "::1";
}

/**
 * Decide whether the response cookie should carry `Secure`, from the request. True when the HUD
 * was reached over HTTPS — either a terminating proxy set `X-Forwarded-Proto: https` (Tailscale
 * serve) or the request URL is itself `https:`. Plain loopback HTTP ⇒ false. The header is only
 * honoured from a loopback `peer` (where the local proxy connects from, #2109); any other client
 * could set it freely, so it then falls back to the URL.
 */
export function isSecureRequest(req: Request, peer?: string | null): boolean {
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp && isLoopbackPeer(peer)) return xfp.split(",")[0]!.trim().toLowerCase() === "https";
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

/** Cookie signing secret: env override ?? persisted ?? generate+persist, rotated when a changed
 *  env password replaces the persisted hash (#2106). A changed password is detected by verifying it
 *  against the hash it replaces — no extra state at rest; first boot is no change. */
async function resolveCookieSecret(
  store: AuthSettingsStore,
  envPassword: string | null,
  envCookieSecret: string | null,
): Promise<{ cookieSecret: string; sessionsRevoked: boolean; staleSessionsKept: boolean }> {
  const previousHash = envPassword ? store.getSetting(PASSWORD_HASH_KEY) : null;
  const passwordChanged =
    !!envPassword && !!previousHash && !(await verifyPassword(envPassword, previousHash));
  const current = envCookieSecret ?? store.getSetting(COOKIE_SECRET_KEY);
  if (current && !(passwordChanged && !envCookieSecret)) {
    return {
      cookieSecret: current,
      sessionsRevoked: false,
      staleSessionsKept: passwordChanged && !!envCookieSecret,
    };
  }
  const cookieSecret = generateSecret();
  store.setSetting(COOKIE_SECRET_KEY, cookieSecret);
  return { cookieSecret, sessionsRevoked: !!current, staleSessionsKept: false };
}

/**
 * Resolve the operator-auth secrets at boot — fail-closed, so the app is never silently open.
 *
 * - Cookie signing secret: env override ?? persisted ?? generate+persist (always non-null after).
 * - Password hash:
 *   - `envPassword` set ⇒ authoritative: hash it and re-seed the persisted hash every boot. When it
 *     no longer matches the persisted hash (the operator CHANGED the password), the persisted
 *     cookie secret is rotated too, so every outstanding session cookie stops verifying (#2106).
 *     An env-pinned `envCookieSecret` can't be rotated here — `staleSessionsKept` reports that.
 *   - else persisted hash ⇒ use as-is (an auto-generated one survives restarts).
 *   - else ⇒ generate a strong password, deliver it, then persist its hash. Emit it ONCE via `log` with a loud
 *     CHANGE-THIS banner. Returned in `generatedPassword` for callers/tests.
 *
 * Pure w.r.t. the injected store + log, so the fail-closed paths are unit-testable.
 */
export async function bootstrapAuth(opts: {
  store: AuthSettingsStore;
  envPassword: string | null;
  envCookieSecret: string | null;
  log?: (msg: string) => void;
  /** Precreated private one-shot channel for the Mac app; never also log the credential. */
  generatedPasswordFile?: string;
}): Promise<{
  passwordHash: string;
  cookieSecret: string;
  generatedPassword: string | null;
  /** The env password changed and the persisted cookie secret was rotated (all sessions out). */
  sessionsRevoked: boolean;
  /** The env password changed but SHEPHERD_COOKIE_SECRET pins the secret: old cookies stay valid. */
  staleSessionsKept: boolean;
}> {
  const { store, envPassword, envCookieSecret } = opts;
  const log = opts.log ?? (() => {});
  const { cookieSecret, sessionsRevoked, staleSessionsKept } = await resolveCookieSecret(
    store,
    envPassword,
    envCookieSecret,
  );

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
      if (opts.generatedPasswordFile) {
        // O_NOFOLLOW rejects a replaced symlink; the supervisor creates the file
        // before launch. Failure is fatal, never a fallback to persistent stdout.
        const fd = openSync(opts.generatedPasswordFile, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          fchmodSync(fd, 0o600);
          ftruncateSync(fd, 0);
          writeFileSync(fd, generatedPassword);
        } finally {
          closeSync(fd);
        }
      } else
        log(
          "\n" +
            "  ┌──────────────────────────────────────────────────────────────────────┐\n" +
            "  │  SHEPHERD: no password configured — generated a random one (below).    │\n" +
            "  │  CHANGE THIS: set SHEPHERD_PASSWORD in ~/.shepherd/env and restart.     │\n" +
            "  └──────────────────────────────────────────────────────────────────────┘\n" +
            `  Operator password (shown ONCE): ${generatedPassword}\n`,
        );
      // Failed delivery must leave generation retryable on the next boot.
      store.setSetting(PASSWORD_HASH_KEY, passwordHash);
    }
  }

  return { passwordHash, cookieSecret, generatedPassword, sessionsRevoked, staleSessionsKept };
}
