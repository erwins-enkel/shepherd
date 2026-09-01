import { test, expect } from "bun:test";
import {
  attachAttempts,
  attemptsOf,
  classifyGhError,
  sanitizeDetail,
  type GhFetchAttempt,
} from "../../src/forge/gh-attempt";

/** execFile-shaped rejection: `gh` writes its diagnosis to stderr. */
function ghError(stderr: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("Command failed: gh"), { stderr, ...extra });
}

test("classifyGhError: a drained budget reads as rate_limit, not a bare 403", () => {
  // GitHub answers an exhausted bucket with 403; without the rate-limit check
  // running first the operator would be told they lack permission.
  const a = classifyGhError("rest", ghError("gh: API rate limit exceeded for user (HTTP 403)"));
  expect(a).toEqual({
    transport: "rest",
    reason: "rate_limit",
    status: 403,
    detail: "gh: API rate limit exceeded for user (HTTP 403)",
  });
});

test("classifyGhError: HTTP 401 and credential text both read as auth", () => {
  expect(classifyGhError("cli", ghError("gh: Bad credentials (HTTP 401)")).reason).toBe("auth");
  expect(
    classifyGhError("cli", ghError("To get started with GitHub CLI, please run: gh auth login"))
      .reason,
  ).toBe("auth");
});

test("classifyGhError: HTTP 404 reads as not_found", () => {
  const a = classifyGhError("rest", ghError("gh: Not Found (HTTP 404)"));
  expect(a.reason).toBe("not_found");
  expect(a.status).toBe(404);
});

test("classifyGhError: ENOENT reads as gh_missing and carries no status", () => {
  const a = classifyGhError("cli", Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }));
  expect(a.reason).toBe("gh_missing");
  expect(a.status).toBeUndefined();
});

test("classifyGhError: connection failures read as network", () => {
  expect(
    classifyGhError("rest", ghError("dial tcp: lookup api.github.com: ENOTFOUND")).reason,
  ).toBe("network");
  expect(classifyGhError("rest", ghError("connect ECONNREFUSED 127.0.0.1:443")).reason).toBe(
    "network",
  );
});

test("classifyGhError: an unnamed status falls through to http; no status at all to unknown", () => {
  const http = classifyGhError("rest", ghError("gh: Server Error (HTTP 502)"));
  expect(http.reason).toBe("http");
  expect(http.status).toBe(502);
  expect(classifyGhError("cli", ghError("gh: something went sideways")).reason).toBe("unknown");
});

test("classifyGhError: falls back to the message when there is no stderr", () => {
  expect(classifyGhError("cli", new Error("cli boom")).detail).toBe("cli boom");
  expect(classifyGhError("cli", "plain throw").detail).toBe("plain throw");
});

test("sanitizeDetail: strips ANSI, collapses whitespace, caps at 300 chars", () => {
  expect(sanitizeDetail("\x1b[31mgh:\x1b[0m  API\n rate  limit")).toBe("gh: API rate limit");
  const long = sanitizeDetail("x".repeat(500));
  expect(long).toHaveLength(300);
  expect(long.endsWith("…")).toBe(true);
});

test("sanitizeDetail: redacts token shapes before they reach the browser", () => {
  const out = sanitizeDetail(
    "gh: bad credentials for ghp_abcdefghijklmnopqrstuvwxyz0123 and github_pat_ABCDEFGHIJKLMNOPQRSTUV",
  );
  expect(out).toBe("gh: bad credentials for <redacted> and <redacted>");
});

test("attachAttempts/attemptsOf: round-trips without touching enumerable properties", () => {
  const attempts: GhFetchAttempt[] = [{ transport: "cli", reason: "rate_limit", detail: "boom" }];
  const err = new Error("cli boom");
  expect(attachAttempts(err, attempts)).toBe(err);
  expect(attemptsOf(err)).toEqual(attempts);
  // The trail must not leak into logs or serialized error payloads.
  expect(Object.keys(err)).toEqual([]);
  expect(JSON.stringify(err)).toBe("{}");
});

test("attachAttempts: a non-object throw is wrapped so the trail survives", () => {
  const attempts: GhFetchAttempt[] = [{ transport: "rest", reason: "unknown", detail: "nope" }];
  const wrapped = attachAttempts("nope", attempts);
  expect(wrapped).toBeInstanceOf(Error);
  expect((wrapped as Error).message).toBe("nope");
  expect(attemptsOf(wrapped)).toEqual(attempts);
});

test("attemptsOf: null for an untagged error, a non-object, and an empty trail", () => {
  expect(attemptsOf(new Error("plain"))).toBeNull();
  expect(attemptsOf("nope")).toBeNull();
  expect(attemptsOf(attachAttempts(new Error("plain"), []))).toBeNull();
});
