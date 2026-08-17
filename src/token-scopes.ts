/**
 * Per-token authorization policy for minted access tokens (issue #2083).
 *
 * #2082 shipped minted tokens at full parity with `SHEPHERD_TOKEN` — every gated surface, the
 * `/pty/:id` terminal upgrade included. This module is the other half: three coarse levels, chosen
 * once at mint time, enforced at the ONE auth seam both entry points already share (`checkAuth` in
 * server.ts, called by `makeApp.fetch` for the HTTP chain and by `serve().fetch` for the `/events`
 * and `/pty/:id` upgrades). Three levels and not thirty: scopes fine enough to need a per-route UI
 * are scopes nobody sets correctly.
 *
 * DENY BY DEFAULT — the whole safety argument. `read` and `submit` are ALLOWLISTS; a route not
 * named here requires `full`. A route added tomorrow is therefore `full`-only until someone
 * deliberately edits a table in this file, and a mistake fails CLOSED (a client gets a loud 403 it
 * reports) rather than open (a token quietly reaching more than the operator granted). Do NOT
 * invert this into a denylist of "dangerous" routes: the set of dangerous routes grows silently,
 * the set of safe ones does not.
 *
 * Pure on purpose — no Request, no store, no config — so the entire per-scope matrix is testable
 * without HTTP (test/token-scopes.test.ts).
 */

/** Ordered widest-last, but the order is documentation only — `scopeAllows` is not a rank compare,
 *  because `read` and `submit` are sets of routes rather than nested privilege levels. */
export const TOKEN_SCOPES = ["read", "submit", "full"] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * What a token gets when the mint request names no scope. `full` deliberately: it mirrors the
 * `scope TEXT NOT NULL DEFAULT 'full'` column default that migrates every pre-#2083 row, so a
 * script that posts `{name}` keeps minting exactly what it minted before. The MINT FORM starts on
 * `read` instead (least privilege for the operator clicking through) — the form always sends an
 * explicit scope, so the two defaults never collide.
 */
export const DEFAULT_TOKEN_SCOPE: TokenScope = "full";

export function isTokenScope(raw: unknown): raw is TokenScope {
  return typeof raw === "string" && (TOKEN_SCOPES as readonly string[]).includes(raw);
}

/**
 * `read`: status surfaces a dashboard or launcher consumes. Nothing here mutates anything.
 *
 * `POST /api/ping` belongs in this set despite the verb — `handlePing` is a pure no-op reachability
 * probe, a POST only so it rides `checkOrigin` and can reproduce the CSRF 403 a real capture POST
 * would hit. It reads nothing and writes nothing.
 *
 * `GET /events` is the status/metadata event bus, not a terminal: agent bytes ride `/pty/:id`,
 * which no scope below `full` reaches.
 */
const READ_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/sessions",
  "GET /api/holds",
  "GET /api/git",
  "GET /api/me",
  "POST /api/ping",
  "GET /events",
]);

/**
 * `submit` adds handing work IN — queue it, attach to it, file it. Nothing here drives a session
 * that is already running (no reply, no interrupt, no relaunch, no archive) and nothing reaches a
 * terminal; that is what `full` is for.
 *
 * `/api/uploads` and `/api/issues` are here because Shepherd's own Capture extension needs them
 * alongside `POST /api/sessions` (see extension/src/lib/transport.ts). Without them the shipped
 * client would be forced to `full`, which is the over-privilege this issue exists to remove.
 */
const SUBMIT_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/sessions",
  "GET /api/held",
  "POST /api/uploads",
  "POST /api/issues",
]);

/** The `submit` routes carrying an id segment. Anchored, exactly one non-`/` segment — so
 *  `/api/held/x/y` matches nothing and falls through to the `full` requirement. */
const SUBMIT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["POST", /^\/api\/held\/[^/]+\/spawn$/],
  ["PATCH", /^\/api\/held\/[^/]+$/],
  ["DELETE", /^\/api\/held\/[^/]+$/],
];

/** Strip ONE trailing slash. The dispatcher routes on `pathname.split("/").filter(Boolean)`, so
 *  `/api/sessions/` and `/api/sessions` reach the same handler and must score the same here — an
 *  exact-match table would otherwise 403 the slashed form. `/` itself is left alone. */
function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/**
 * The gate. True when a token carrying `scope` may reach `method pathname`.
 *
 * `scope` is typed `string`, not `TokenScope`, because it arrives from a SQLite TEXT column: a
 * hand-edited or future-version row can hold anything. Such a value grants NOTHING — not `read`,
 * not `full` — which is the deny-by-default rule applied to the scope itself and not just to the
 * route table.
 *
 * Matching is exact on method + path. No prefix matching: `GET /api/sessions/abc` does not inherit
 * `GET /api/sessions`, so a per-session read stays behind `full` until it is listed here.
 */
export function scopeAllows(scope: string, method: string, pathname: string): boolean {
  if (scope === "full") return true;
  // Adding a fourth level to TOKEN_SCOPES is not enough — it lands here as "unrecognized" and
  // grants NOTHING until it gets its own branch. Deliberately: a level that silently inherited
  // another's routes would be a scope nobody could reason about.
  if (scope !== "read" && scope !== "submit") return false;
  const path = normalizePath(pathname);
  const key = `${method} ${path}`;
  if (READ_ROUTES.has(key)) return true;
  if (scope === "read") return false;
  return SUBMIT_ROUTES.has(key) || SUBMIT_PATTERNS.some(([m, re]) => m === method && re.test(path));
}
