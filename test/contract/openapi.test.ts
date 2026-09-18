import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bearer,
  coverage,
  declaredEvents,
  declaredOperations,
  loadContract,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";

let s: ContractServer;
let cookie: string;
let token: string;
let tokenId: string;

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  cookie = await login(s);
  ({ token, id: tokenId } = await mintToken(s, cookie));
});
afterAll(() => {
  s.stop();
  restoreAuth();
});

describe("health", () => {
  test("GET /api/health is public and matches the contract", async () => {
    const res = await fetch(`${s.baseUrl}/api/health`);
    const body = (await validateResponse("GET", "/api/health", res)) as {
      ok: boolean;
      version: string;
    };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("declaredOperations ignores path-level parameters", () => {
    const c = loadContract();
    const before = declaredOperations().length;
    (c.paths["/api/health"] as Record<string, unknown>).parameters = [{ name: "x", in: "query" }];
    try {
      expect(declaredOperations().length).toBe(before);
    } finally {
      delete (c.paths["/api/health"] as Record<string, unknown>).parameters;
    }
  });
});

describe("auth", () => {
  test("POST /api/login rejects a wrong password", async () => {
    const res = await fetch(`${s.baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    await validateResponse("POST", "/api/login", res);
    expect(res.status).toBe(401);
  });

  test("bearer token passes the gate; no credential is 401", async () => {
    const ok = await fetch(`${s.baseUrl}/api/settings`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    const anon = await fetch(`${s.baseUrl}/api/settings`);
    expect(anon.status).toBe(401);
  });

  test("GET /api/access-tokens lists with cookie, 403 with bearer", async () => {
    const list = await fetch(`${s.baseUrl}/api/access-tokens`, { headers: { cookie } });
    const body = (await validateResponse("GET", "/api/access-tokens", list)) as {
      tokens: { id: string }[];
    };
    expect(body.tokens.some((t) => t.id === tokenId)).toBe(true);
    const viaBearer = await fetch(`${s.baseUrl}/api/access-tokens`, { headers: bearer(token) });
    await validateResponse("GET", "/api/access-tokens", viaBearer);
    expect(viaBearer.status).toBe(403);
  });

  test("POST /api/access-tokens rejects unknown fields (400) and bearer callers (403)", async () => {
    const bad = await fetch(`${s.baseUrl}/api/access-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "x", nope: 1 }),
    });
    await validateResponse("POST", "/api/access-tokens", bad);
    expect(bad.status).toBe(400);
    const viaBearer = await fetch(`${s.baseUrl}/api/access-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ name: "x" }),
    });
    await validateResponse("POST", "/api/access-tokens", viaBearer);
    expect(viaBearer.status).toBe(403);
  });

  test("DELETE /api/access-tokens/{id} revokes once, then 404", async () => {
    const { id } = await mintToken(s, cookie, "to revoke");
    const del = await fetch(`${s.baseUrl}/api/access-tokens/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    await validateResponse("DELETE", "/api/access-tokens/{id}", del);
    expect(del.status).toBe(200);
    const again = await fetch(`${s.baseUrl}/api/access-tokens/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    await validateResponse("DELETE", "/api/access-tokens/{id}", again);
    expect(again.status).toBe(404);
  });

  test("POST /api/logout clears the cookie session", async () => {
    const throwaway = await login(s);
    const res = await fetch(`${s.baseUrl}/api/logout`, {
      method: "POST",
      headers: { cookie: throwaway },
    });
    await validateResponse("POST", "/api/logout", res);
    expect(res.status).toBe(200);
  });
});

// The coverage gate stays the LAST describe in this file for the whole plan; every later
// contract area adds its describe above it.
describe("coverage gate", () => {
  test("every declared operation and event was exercised", () => {
    const { operations, events } = coverage();
    const missingOps = declaredOperations().filter((o) => !operations.has(o));
    const missingEvents = declaredEvents().filter((e) => !events.has(e));
    expect(missingOps).toEqual([]);
    expect(missingEvents).toEqual([]);
  });
});
