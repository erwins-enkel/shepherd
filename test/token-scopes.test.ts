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

/** Every route the policy names, with the scopes that may reach it. */
const MATRIX: readonly { method: string; path: string; allowed: readonly TokenScope[] }[] = [
  // read surfaces
  { method: "GET", path: "/api/sessions", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/api/holds", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/api/git", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/api/me", allowed: ["read", "submit", "full"] },
  { method: "POST", path: "/api/ping", allowed: ["read", "submit", "full"] },
  { method: "GET", path: "/events", allowed: ["read", "submit", "full"] },
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
];

test("the full matrix: every scope against every named route", () => {
  for (const { method, path, allowed } of MATRIX) {
    for (const scope of TOKEN_SCOPES) {
      const want = allowed.includes(scope);
      // One assertion string per cell, so a failure names the exact cell rather than "false ≠ true".
      expect(`${scope} ${method} ${path} → ${scopeAllows(scope, method, path)}`).toBe(
        `${scope} ${method} ${path} → ${want}`,
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
  expect(scopeAllows("submit", "POST", "/api/held/h1/spawn/")).toBe(true);
  // Two slashes is not a route the dispatcher normalizes to the same place — stays full-only.
  expect(scopeAllows("read", "GET", "/api/sessions//")).toBe(false);
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
