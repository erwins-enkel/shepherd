import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../../src/config";
import { firstRun } from "../../src/first-run";
import { SESSION_COOKIE } from "../../src/operator-auth";
import {
  bearer,
  coverage,
  declaredEvents,
  declaredOperations,
  loadContract,
  login,
  mintToken,
  restoreAuth,
  securedOperations,
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
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
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
    const viaBearer = await fetch(`${s.baseUrl}/api/access-tokens/${id}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    await validateResponse("DELETE", "/api/access-tokens/{id}", viaBearer);
    expect(viaBearer.status).toBe(403);
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
    const setCookie = res.headers.get("set-cookie") ?? "";
    const clearedPair = setCookie.split(";")[0] ?? "";
    expect(clearedPair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(setCookie).toContain("Max-Age=0");
    // The session cookie is stateless — operator-auth.ts documents there is no server-side
    // revocation list, so logout only instructs the client to overwrite the cookie with the
    // empty value above; it does not invalidate the old signed value itself (a client still
    // sending `throwaway` would stay authenticated). A client that honors the Set-Cookie
    // instruction and sends the cleared pair back is unauthenticated.
    const after = await fetch(`${s.baseUrl}/api/settings`, { headers: { cookie: clearedPair } });
    expect(after.status).toBe(401);
  });
});

describe("settings", () => {
  test("GET /api/settings reflects firstRunPending", async () => {
    firstRun.pending = true;
    try {
      const res = await fetch(`${s.baseUrl}/api/settings`, { headers: bearer(token) });
      const body = (await validateResponse("GET", "/api/settings", res)) as {
        firstRunPending: boolean;
      };
      expect(body.firstRunPending).toBe(true);
    } finally {
      firstRun.pending = false;
    }
  });

  test("PUT /api/settings repoRoot resolves first run; bad path is 400", async () => {
    const child = join(s.tmpRoot, "workspace");
    mkdirSync(child, { recursive: true });
    firstRun.pending = true;
    try {
      const ok = await fetch(`${s.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ repoRoot: child }),
      });
      const body = (await validateResponse("PUT", "/api/settings", ok)) as { repoRoot: string };
      expect(body.repoRoot).toBe(child);
      expect(firstRun.pending).toBe(false);

      const bad = await fetch(`${s.baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ repoRoot: join(s.tmpRoot, "does-not-exist") }),
      });
      await validateResponse("PUT", "/api/settings", bad);
      expect(bad.status).toBe(400);
    } finally {
      config.repoRoot = s.tmpRoot;
      firstRun.pending = false;
    }
  });
});

describe("sessions", () => {
  let created: { id: string };

  test("POST /api/sessions creates (201) and rejects bad input (400)", async () => {
    const res = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "contract" }),
    });
    created = (await validateResponse("POST", "/api/sessions", res)) as { id: string };
    expect(res.status).toBe(201);

    const bad = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ repoPath: "/etc", baseBranch: "main", prompt: "x" }),
    });
    await validateResponse("POST", "/api/sessions", bad);
    expect(bad.status).toBe(400);
  });

  test("POST /api/sessions is 409 while first run is pending", async () => {
    firstRun.pending = true;
    try {
      const res = await fetch(`${s.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "x" }),
      });
      await validateResponse("POST", "/api/sessions", res);
      expect(res.status).toBe(409);
    } finally {
      firstRun.pending = false;
    }
  });

  test("GET /api/sessions and /api/sessions/{id}", async () => {
    const list = await fetch(`${s.baseUrl}/api/sessions`, { headers: bearer(token) });
    const sessions = (await validateResponse("GET", "/api/sessions", list)) as { id: string }[];
    expect(sessions.map((x) => x.id)).toContain(created.id);

    const one = await fetch(`${s.baseUrl}/api/sessions/${created.id}`, { headers: bearer(token) });
    await validateResponse("GET", "/api/sessions/{id}", one);
    expect(one.status).toBe(200);

    const missing = await fetch(`${s.baseUrl}/api/sessions/nope`, { headers: bearer(token) });
    await validateResponse("GET", "/api/sessions/{id}", missing);
    expect(missing.status).toBe(404);
  });

  test("POST /api/sessions/{id}/interrupt", async () => {
    const ok = await fetch(`${s.baseUrl}/api/sessions/${created.id}/interrupt`, {
      method: "POST",
      headers: bearer(token),
    });
    await validateResponse("POST", "/api/sessions/{id}/interrupt", ok);
    expect(ok.status).toBe(200);
    const missing = await fetch(`${s.baseUrl}/api/sessions/nope/interrupt`, {
      method: "POST",
      headers: bearer(token),
    });
    await validateResponse("POST", "/api/sessions/{id}/interrupt", missing);
    expect(missing.status).toBe(404);
  });

  // No request body: handleSessionDelete's `{reap}` body is optional (it parses with a
  // `.catch(() => null)` and never requires a JSON content-type), and the native client
  // archives without reaping — so the contract declares no requestBody either.
  test("DELETE /api/sessions/{id} archives; GET /api/sessions/done lists it", async () => {
    const del = await fetch(`${s.baseUrl}/api/sessions/${created.id}`, {
      method: "DELETE",
      headers: bearer(token),
    });
    await validateResponse("DELETE", "/api/sessions/{id}", del);
    expect(del.status).toBe(200);
    const done = await fetch(`${s.baseUrl}/api/sessions/done`, { headers: bearer(token) });
    const list = (await validateResponse("GET", "/api/sessions/done", done)) as { id: string }[];
    expect(list.map((x) => x.id)).toContain(created.id);
  });
});

describe("repos", () => {
  test("GET /api/repos lists the fake repo", async () => {
    const res = await fetch(`${s.baseUrl}/api/repos`, { headers: bearer(token) });
    const body = (await validateResponse("GET", "/api/repos", res)) as {
      repos: { path: string }[];
    };
    expect(body.repos.map((r) => r.path)).toContain(s.validRepo);
  });
});

// Sits directly before the coverage gate: it exercises every secured operation once, without
// credentials, and records the 401 coverage the gate then checks for.
describe("unauthenticated sweep", () => {
  test("every secured operation rejects a request without credentials with 401", async () => {
    for (const { method, template } of securedOperations()) {
      const path = template.replace(/\{[^}]+\}/g, "x");
      const init: RequestInit = { method: method.toUpperCase() };
      if (["post", "put", "patch"].includes(method)) {
        init.headers = { "content-type": "application/json" };
        init.body = "{}";
      }
      const res = await fetch(`${s.baseUrl}${path}`, init);
      await validateResponse(method.toUpperCase(), template, res);
      expect(res.status, `${method.toUpperCase()} ${template}`).toBe(401);
    }
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
