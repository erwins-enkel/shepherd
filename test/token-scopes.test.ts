import { test, expect } from "bun:test";
import {
  DEFAULT_TOKEN_SCOPE,
  TOKEN_SCOPES,
  isTokenScope,
  scopeAllows,
  type TokenScope,
} from "../src/token-scopes";

// The per-token scope policy (#2083). Pure, so the whole matrix is checked here without HTTP —
// the integration side (that checkAuth actually consults this, on both entry points) lives in
// test/server-auth.test.ts.

/** Every route the policy names, with the scopes that may reach it. `selfTokenId`, when given, is
 *  the id `scopeAllows` is told the caller authenticated as — only the self-revoke rows below need
 *  it, since every other row's outcome does not depend on it. */
const MATRIX: readonly {
  method: string;
  path: string;
  allowed: readonly TokenScope[];
  selfTokenId?: string;
}[] = [
  // read surfaces
  { method: "GET", path: "/api/sessions", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/api/holds", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/api/git", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/api/me", allowed: ["read", "submit", "full"] },
  { method: "POST", path: "/api/ping", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/events", allowed: ["read", "submit", "full"] },
  // #2421: whether a reviewer is mid-run, so a read client can reproduce the herd's
  // `reviewerRunning` stage instead of calling that session the operator's turn early.
  { method: "GET", path: "/api/reviews/inflight", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/api/plan-gates/inflight", allowed: ["read", "submit", "full"] },
  // …and the boundary that buys: the PARENT routes return verdict bodies (findings, summaries,
  // plan questions) and stay `full`-only. Exact matching, so the child grants nothing here.
  { method: "GET", path: "/api/reviews", allowed: ["full"] },
  { method: "GET", path: "/api/plan-gates", allowed: ["full"] },
  // submit surfaces
  { method: "POST", path: "/api/sessions", allowed: ["submit", "full"] },
  { method: "GET", path: "/api/held", allowed: ["submit", "full"] },
  { method: "POST", path: "/api/held/h1/spawn", allowed: ["submit", "full"] },
  { method: "PATCH", path: "/api/held/h1", allowed: ["submit", "full"] },
  { method: "DELETE", path: "/api/held/h1", allowed: ["submit", "full"] },
  { method: "POST", path: "/api/uploads", allowed: ["submit", "full"] },
  { method: "POST", path: "/api/issues", allowed: ["submit", "full"] },
  // full-only: the terminal, and a sample of the reach a v1 token had
  { method: "GET", path: "/pty/abc", allowed: ["full"] },
  { method: "POST", path: "/api/sessions/s1/reply", allowed: ["full"] },
  { method: "POST", path: "/api/sessions/s1/interrupt", allowed: ["full"] },
  { method: "DELETE", path: "/api/sessions/s1", allowed: ["full"] },
  { method: "GET", path: "/api/settings", allowed: ["full"] },
  { method: "POST", path: "/api/settings", allowed: ["full"] },
  { method: "GET", path: "/api/diagnostics", allowed: ["full"] },
  { method: "POST", path: "/api/prs/merge", allowed: ["full"] },
  { method: "GET", path: "/api/access-tokens", allowed: ["full"] },
  // The one exception, and it grants nothing on its own: the route still proves the presented
  // bearer IS the token named by the id before it revokes anything (`revokesItself`, server.ts).
  // Own id: every scope's seam-level check passes.
  {
    method: "DELETE",
    path: "/api/access-tokens/t1",
    selfTokenId: "t1",
    allowed: ["read", "submit", "full"],
  },
  // Someone ELSE's id at the very same route: the carve-out is bound to the caller's own id, so a
  // read/submit token reaches nothing here — `full`'s blanket allow is the only reason this passes.
  {
    method: "DELETE",
    path: "/api/access-tokens/t1",
    selfTokenId: "another-token-id",
    allowed: ["full"],
  },
];

test("the full matrix: every scope against every named route", () => {
  for (const { method, path, allowed, selfTokenId } of MATRIX) {
    for (const scope of TOKEN_SCOPES) {
      const want = allowed.includes(scope);
      const label = `${scope} ${method} ${path} (self=${selfTokenId ?? "-"})`;
      // One assertion string per cell, so a failure names the exact cell rather than "false ≠ true".
      expect(`${label} → ${scopeAllows(scope, method, path, selfTokenId)}`).toBe(
        `${label} → ${want}`,
      );
    }
  }
});

test("full reaches everything, including routes no table names", () => {
  for (const [method, path] of [
    ["GET", "/api/anything-invented-later"],
    ["POST", "/api/anything-invented-later"],
    ["PUT", "/api/x"],
    ["PATCH", "/api/x"],
    ["DELETE", "/api/x"],
    ["GET", "/pty/whatever"],
  ] as const) {
    expect(scopeAllows("full", method, path)).toBe(true);
  }
});

test("deny by default: an unnamed route requires full, whatever the verb", () => {
  // The property that makes the map safe to get wrong: a route nobody listed is full-only, so a
  // route landing in a later PR cannot silently widen an existing read/submit token.
  for (const scope of ["read", "submit"] as const) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      expect(scopeAllows(scope, method, "/api/route-from-the-future")).toBe(false);
    }
  }
});

test("no prefix matching: a sub-path does not inherit its parent's scope", () => {
  // GET /api/sessions is a read route; nothing UNDER it is.
  for (const path of [
    "/api/sessions/s1",
    "/api/sessions/s1/git",
    "/api/sessions/s1/scratchpad",
    "/api/held/h1/extra",
    "/api/gitignore",
    "/api/me/extra",
    // The `/inflight` leaves are exact too: nothing under them, and no sibling of them.
    "/api/reviews/inflight/extra",
    "/api/plan-gates/inflight/extra",
    "/api/reviews/s1",
  ]) {
    expect(`read GET ${path} → ${scopeAllows("read", "GET", path)}`).toBe(
      `read GET ${path} → false`,
    );
  }
  // …and the held id patterns match exactly one segment, so a deeper path is full-only.
  expect(scopeAllows("submit", "POST", "/api/held/h1/spawn/extra")).toBe(false);
  expect(scopeAllows("submit", "DELETE", "/api/held/h1/extra")).toBe(false);
});

test("the method is part of the key: the right path with the wrong verb is refused", () => {
  expect(scopeAllows("read", "POST", "/api/sessions")).toBe(false);
  expect(scopeAllows("read", "DELETE", "/api/holds")).toBe(false);
  expect(scopeAllows("read", "GET", "/api/ping")).toBe(false); // ping is POST-only
  expect(scopeAllows("submit", "PUT", "/api/held/h1")).toBe(false);
  expect(scopeAllows("submit", "GET", "/api/uploads")).toBe(false);
  // Lowercase verbs never match — Bun hands checkAuth an uppercase Request.method.
  expect(scopeAllows("read", "get", "/api/sessions")).toBe(false);
});

test("one trailing slash is tolerated, because the dispatcher tolerates it", () => {
  // `pathname.split("/").filter(Boolean)` routes /api/sessions/ to the same handler, so refusing
  // the slashed form would 403 a request the server otherwise answers.
  expect(scopeAllows("read", "GET", "/api/sessions/")).toBe(true);
  expect(scopeAllows("read", "GET", "/events/")).toBe(true);
  expect(scopeAllows("read", "GET", "/api/reviews/inflight/")).toBe(true);
  expect(scopeAllows("read", "GET", "/api/plan-gates/inflight/")).toBe(true);
  expect(scopeAllows("submit", "POST", "/api/held/h1/spawn/")).toBe(true);
  // Two slashes is not a route the dispatcher normalizes to the same place — stays full-only.
  expect(scopeAllows("read", "GET", "/api/sessions//")).toBe(false);
});

test("self-revoke is the ONLY access-token shape a non-full scope reaches, and only for its OWN id", () => {
  // Exactly one id segment, DELETE only, matching the caller's own id, and never the collection —
  // everything else about the token routes stays full-only (and, at the route,
  // operator-session-only).
  for (const scope of ["read", "submit"] as const) {
    expect(scopeAllows(scope, "DELETE", "/api/access-tokens/t1", "t1")).toBe(true);
    // Someone else's id at the very same route: the carve-out does not open.
    expect(scopeAllows(scope, "DELETE", "/api/access-tokens/t1", "another-token-id")).toBe(false);
    expect(scopeAllows(scope, "DELETE", "/api/access-tokens", "t1")).toBe(false);
    expect(scopeAllows(scope, "DELETE", "/api/access-tokens/t1/extra", "t1")).toBe(false);
    expect(scopeAllows(scope, "GET", "/api/access-tokens/t1", "t1")).toBe(false);
    expect(scopeAllows(scope, "POST", "/api/access-tokens/t1", "t1")).toBe(false);
  }
  // An unrecognized scope does not get it either.
  expect(scopeAllows("admin", "DELETE", "/api/access-tokens/t1", "t1")).toBe(false);
});

test("omitting selfTokenId never opens the carve-out, even on the token's own id path", () => {
  // `checkAuth` is the only call site that ever passes `selfTokenId` (`verified.id`). Every other
  // caller of `scopeAllows` omits it, and must never accidentally reach the self-revoke route.
  for (const scope of ["read", "submit"] as const) {
    expect(scopeAllows(scope, "DELETE", "/api/access-tokens/t1")).toBe(false);
  }
});

test("an unrecognized stored scope grants nothing — not read, not full", () => {
  // A hand-edited row, or one written by a future version. Deny-by-default applied to the scope
  // itself: it authenticates (verify matched the hash) but reaches no route at all.
  for (const scope of ["", "wat", "READ", "Full", "admin", "read submit", "*"]) {
    expect(`${scope} → ${scopeAllows(scope, "GET", "/api/sessions")}`).toBe(`${scope} → false`);
    expect(scopeAllows(scope, "GET", "/pty/abc")).toBe(false);
  }
});

test("isTokenScope accepts exactly the three levels", () => {
  for (const scope of TOKEN_SCOPES) expect(isTokenScope(scope)).toBe(true);
  for (const raw of ["", "READ", "admin", "scopes", 0, 1, null, undefined, {}, ["read"], true]) {
    expect(isTokenScope(raw)).toBe(false);
  }
});

test("the mint default is full — the pre-#2083 behaviour a scope-less request keeps", () => {
  expect(DEFAULT_TOKEN_SCOPE).toBe("full");
  expect(isTokenScope(DEFAULT_TOKEN_SCOPE)).toBe(true);
});
