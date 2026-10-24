import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createSession, login, logout, getMe } from "./api";
import { auth } from "./auth.svelte";
import type { CreateInput } from "./types";

function mockFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("single-operator auth (issue #1079)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    auth.unauthenticated = false;
    auth.checked = false;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    auth.unauthenticated = false;
    auth.checked = false;
  });

  it("401 interceptor flips the unauthenticated store on a gated call", async () => {
    globalThis.fetch = mockFetch(401, { error: "unauthorized" });
    await createSession({ repo: "r", prompt: "p" } as unknown as CreateInput).catch(() => {});
    expect(auth.unauthenticated).toBe(true);
  });

  it("getMe: true on 200, false on 401, false on network error", async () => {
    globalThis.fetch = mockFetch(200);
    expect(await getMe()).toBe(true);
    globalThis.fetch = mockFetch(401);
    expect(await getMe()).toBe(false);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await getMe()).toBe(false);
  });

  it("login: success clears the flag and returns ok", async () => {
    auth.unauthenticated = true;
    globalThis.fetch = mockFetch(200, { ok: true });
    expect(await login("right")).toBe("ok");
    expect(auth.unauthenticated).toBe(false);
  });

  it("login: wrong password returns invalid without throwing", async () => {
    globalThis.fetch = mockFetch(401, { error: "invalid password" });
    expect(await login("wrong")).toBe("invalid");
  });

  it("login: a spent attempt budget (429) returns rate_limited, not invalid", async () => {
    auth.unauthenticated = true;
    globalThis.fetch = mockFetch(429, { error: "login_rate_limited" });
    expect(await login("right")).toBe("rate_limited");
    expect(auth.unauthenticated).toBe(true);
  });

  it("logout: flips the flag to unauthenticated", async () => {
    globalThis.fetch = mockFetch(200, { ok: true });
    await logout();
    expect(auth.unauthenticated).toBe(true);
  });
});
