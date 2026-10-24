import { test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp } from "../src/server";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE } from "../src/operator-auth";
import { HUD_CSP, withSecurityHeaders } from "../src/security-headers";

// #2099 / audit N04: no HUD response may be frameable by a same-site preview port, and the app CSP
// must restrict img-src/form-action behind the markdown sanitizer.

const SECRET = "test-cookie-signing-secret";
let prevSecret: string | null;
let prevHash: string | null;

beforeEach(async () => {
  prevSecret = config.cookieSecret;
  prevHash = config.passwordHash;
  config.cookieSecret = SECRET;
  config.passwordHash = await hashPassword("pw");
});

afterEach(() => {
  config.cookieSecret = prevSecret;
  config.passwordHash = prevHash;
});

function app() {
  return makeApp({
    store: new SessionStore(":memory:"),
    events: new EventHub(),
    service: {} as any,
    usageLimits: {
      limits: () => {
        throw new Error("boom");
      },
      projections: () => [],
    } as any,
  });
}

const authed = { Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}` };

function expectHardened(res: Response) {
  expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  const csp = res.headers.get("content-security-policy");
  expect(csp).toBe(HUD_CSP);
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("font-src 'self' data:");
  expect(csp).toContain("media-src 'self' blob:");
  expect(csp).toContain(
    "img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com",
  );
}

test.each([
  ["SPA document", "/", {}],
  ["SPA deep link", "/login", {}],
  ["authed JSON", "/api/me", authed],
  ["public probe", "/api/health", {}],
  ["unauthenticated 401", "/api/me", {}],
  ["API 404", "/api/nope", authed],
] as const)("%s carries anti-framing + CSP", async (_label, path, headers) => {
  const res = await app().fetch(new Request(`http://x${path}`, { headers }));
  expectHardened(res);
});

test("a thrown handler's 500 fallback still carries the headers", async () => {
  const res = await app().fetch(new Request("http://x/api/usage/limits", { headers: authed }));
  expect(res.status).toBe(500);
  expectHardened(res);
});

test("withSecurityHeaders copies a response with immutable headers", async () => {
  const res = withSecurityHeaders(Response.redirect("http://x/elsewhere", 302));
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("http://x/elsewhere");
  expectHardened(res);
});
