/**
 * Named machine access tokens (issue #2082). The third credential accepted by the one auth seam
 * (`checkAuth` in server.ts), alongside the operator session cookie and the env-provisioned
 * `SHEPHERD_TOKEN`. Unlike that shared env secret, a minted token has a name (attribution), an
 * optional expiry, a scope bounding what it may reach (#2083, src/token-scopes.ts), and can be
 * revoked on its own — without a restart.
 *
 * At rest we keep only `sha256(plaintext)` plus a 4-char `hint` for the list. The plaintext exists
 * exactly once: in the response to the mint request.
 *
 * Hot path, deliberately: verification is one SHA-256 plus a Map lookup, never a DB read (the same
 * Bun loop pumps the web terminal — see the docstring in operator-auth.ts). The map is built once
 * from SQLite at construction and mutated in place by `mint`/`revoke`, which is what makes a
 * revocation effective on the very next request.
 *
 * Why no `timingSafeEqual` here, unlike `isAuthorized()` in validate.ts: that function compares the
 * SECRET itself, so it must be constant-time. Here the compared value is a HASH of the secret.
 * Recovering the stored hash byte-by-byte through lookup timing buys an attacker nothing — they
 * would still need a SHA-256 preimage to produce a token that hashes to it. Same construction as
 * GitHub PATs and Django's token auth.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import { DEFAULT_TOKEN_SCOPE, TOKEN_SCOPES, isTokenScope, type TokenScope } from "./token-scopes";

/** Greppable in logs, detectable by secret scanners — and lets `verify` reject non-tokens cheaply. */
export const ACCESS_TOKEN_PREFIX = "shp_";

/** The expiry presets the mint form offers; `null` (never) is accepted too, and is the default.
 *  Module-internal — `parseMintRequest` is the only gate that needs it, and the UI can't import
 *  across packages, so `EXPIRY_DAYS` in SettingsAccessPanel.svelte mirrors it by hand. */
const ACCESS_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;

export const ACCESS_TOKEN_NAME_MAX = 64;

const DAY_MS = 24 * 60 * 60 * 1000;

const BEARER = "Bearer ";

/** At most one `lastUsedAt` write per token per minute — this runs on every authed request. */
const LAST_USED_THROTTLE_MS = 60_000;

/** A row as it sits in SQLite. `lastUsedAt: null` = never used; `expiresAt: null` = never expires.
 *
 *  `scope` is typed as the union for callers' convenience, but SQLite holds plain TEXT: a
 *  hand-edited or future-version row can carry anything, and `scopeAllows` grants such a value
 *  NOTHING rather than trusting this annotation. Never widen that to a cast-and-trust. */
export interface AccessTokenRow {
  id: string;
  name: string;
  tokenHash: string;
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  scope: TokenScope;
}

/** What the API and the UI ever see — the same row minus the hash. */
export type AccessTokenSummary = Omit<AccessTokenRow, "tokenHash">;

/** Built field-by-field rather than by destructuring the row, so the hash cannot leak by accident. */
function toSummary(row: AccessTokenRow): AccessTokenSummary {
  return {
    id: row.id,
    name: row.name,
    hint: row.hint,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    scope: row.scope,
  };
}

/** `shp_` + base64url(32 random bytes) ⇒ 43 url-safe chars, 256 bits. */
export function generateAccessToken(): string {
  return ACCESS_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** SHA-256 (hex) of the FULL plaintext, prefix included — the only form stored. */
export function hashAccessToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Last 4 plaintext chars, for `shp_…a9Fz` in the list. Leaves ~232 bits — no meaningful leak. */
export function tokenHint(plaintext: string): string {
  return plaintext.slice(-4);
}

/**
 * Trim + bound a token name from an untrusted body. Returns null when it is not a non-empty
 * string of at most ACCESS_TOKEN_NAME_MAX characters after trimming.
 */
export function normalizeTokenName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > ACCESS_TOKEN_NAME_MAX) return null;
  return name;
}

/** True for `null` (never expires) or one of the three presets. Anything else is a 400. */
export function isExpiryPreset(raw: unknown): raw is number | null {
  if (raw === null) return true;
  return (ACCESS_TOKEN_EXPIRY_DAYS as readonly number[]).includes(raw as number);
}

/**
 * Validate a mint request body from the wire. Returns the normalized fields, or the operator-facing
 * message the route turns into a 400. Pure, so every rejection path is unit-testable without HTTP —
 * and so the route stays routing + I/O.
 *
 * `expiresInDays` absent ⇒ never expires, the default the mint form starts on. `scope` absent ⇒
 * DEFAULT_TOKEN_SCOPE (`full`), so a caller written against #2082 mints exactly what it did before
 * — the mint FORM always sends an explicit scope and starts on `read`. Unknown keys are rejected,
 * matching the house style of `validateCreate`.
 */
export function parseMintRequest(
  body: unknown,
): { name: string; expiresInDays: number | null; scope: TokenScope } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "invalid body" };
  }
  const raw = body as Record<string, unknown>;
  const known = ["name", "expiresInDays", "scope"];
  const unknownField = Object.keys(raw).find((k) => !known.includes(k));
  if (unknownField) return { error: `unknown field: ${unknownField}` };

  const name = normalizeTokenName(raw.name);
  if (name === null) return { error: `name must be 1-${ACCESS_TOKEN_NAME_MAX} characters` };

  const expiresInDays = raw.expiresInDays === undefined ? null : raw.expiresInDays;
  if (!isExpiryPreset(expiresInDays)) {
    return { error: `expiresInDays must be null or one of ${ACCESS_TOKEN_EXPIRY_DAYS.join(", ")}` };
  }

  const scope = raw.scope === undefined ? DEFAULT_TOKEN_SCOPE : raw.scope;
  if (!isTokenScope(scope)) {
    return { error: `scope must be one of ${TOKEN_SCOPES.join(", ")}` };
  }
  return { name, expiresInDays, scope };
}

/**
 * True when an `Authorization` header carries a minted-token-SHAPED credential. Checks only the
 * PUBLIC prefix, so it reveals nothing about any secret — its job is to let the caller skip the
 * service (and, at the auth seam, its lazy construction) for the overwhelming majority of
 * requests, which carry a cookie, the env token, or nothing at all.
 */
export function looksLikeAccessToken(
  authorization: string | null | undefined,
): authorization is string {
  if (!authorization || !authorization.startsWith(BEARER)) return false;
  return authorization.slice(BEARER.length).startsWith(ACCESS_TOKEN_PREFIX);
}

type Store = Pick<
  SessionStore,
  "listAccessTokens" | "insertAccessToken" | "deleteAccessToken" | "touchAccessToken"
>;

/** What `verify` hands the auth seam: who presented the token, and how far it reaches. */
export interface VerifiedToken {
  id: string;
  scope: TokenScope;
}

export class AccessTokenService {
  private readonly store: Store;
  private readonly now: () => number;
  /** hash → identity. The hot-path index; expired entries stay (verify checks) so the list stays
   *  whole. Carries the SCOPE so the gate never needs a DB read to authorize a route (#2083). */
  private readonly byHash = new Map<
    string,
    { id: string; expiresAt: number | null; scope: TokenScope }
  >();
  /** token id → last `lastUsedAt` write, for the throttle. */
  private readonly stampedAt = new Map<string, number>();

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
    for (const row of store.listAccessTokens()) {
      this.byHash.set(row.tokenHash, {
        id: row.id,
        expiresAt: row.expiresAt,
        scope: row.scope,
      });
    }
  }

  /** Every token, newest first — metadata only. */
  list(): AccessTokenSummary[] {
    return this.store.listAccessTokens().map(toSummary);
  }

  /**
   * Mint a token. The returned `token` is the ONLY time the plaintext exists outside the client;
   * it is not recoverable afterwards. `expiresInDays` null ⇒ never expires. `scope` is fixed here
   * for the token's whole life — there is deliberately no setter (#2083): an editable scope makes
   * "what could this credential do last Tuesday" unanswerable. Mint a new token instead.
   */
  mint(
    name: string,
    expiresInDays: number | null,
    scope: TokenScope = DEFAULT_TOKEN_SCOPE,
  ): { token: string; entry: AccessTokenSummary } {
    const token = generateAccessToken();
    const createdAt = this.now();
    const row: AccessTokenRow = {
      id: randomUUID(),
      name,
      tokenHash: hashAccessToken(token),
      hint: tokenHint(token),
      createdAt,
      lastUsedAt: null,
      expiresAt: expiresInDays === null ? null : createdAt + expiresInDays * DAY_MS,
      scope,
    };
    this.store.insertAccessToken(row);
    this.byHash.set(row.tokenHash, { id: row.id, expiresAt: row.expiresAt, scope: row.scope });
    return { token, entry: toSummary(row) };
  }

  /** Revoke by id. False when no such token. Effective on the next request — no restart. */
  revoke(id: string): boolean {
    if (!this.store.deleteAccessToken(id)) return false;
    for (const [hash, entry] of this.byHash) {
      if (entry.id === id) this.byHash.delete(hash);
    }
    this.stampedAt.delete(id);
    return true;
  }

  /**
   * Hot path. Returns the matching token's id AND scope, or null when the header carries no minted
   * token, an unknown one, or an expired one. Never throws.
   *
   * Authentication only — it answers "whose token is this, and how far does it reach", never "may
   * it have this route". That second question is `scopeAllows` (src/token-scopes.ts), asked once by
   * the auth seam, so this stays a hash + Map lookup with no DB read.
   */
  verify(authorization: string | null | undefined): VerifiedToken | null {
    // Cheap reject on the PUBLIC prefix, before hashing — no information about any secret.
    if (!looksLikeAccessToken(authorization)) return null;
    const presented = authorization.slice(BEARER.length);
    const entry = this.byHash.get(hashAccessToken(presented));
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) return null;
    return { id: entry.id, scope: entry.scope };
  }

  /** Throttled `lastUsedAt` stamp. Called after a successful `verify` on every authed request. */
  stampUsed(id: string): void {
    const now = this.now();
    const last = this.stampedAt.get(id);
    if (last !== undefined && now - last < LAST_USED_THROTTLE_MS) return;
    this.stampedAt.set(id, now);
    this.store.touchAccessToken(id, now);
  }
}
