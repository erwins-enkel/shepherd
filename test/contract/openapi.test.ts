import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { config } from "../../src/config";
import { firstRun } from "../../src/first-run";
import { SESSION_COOKIE } from "../../src/operator-auth";
import { RESIZE_PREFIX } from "../../src/operator-activity";
import { SANDBOX_PROFILES } from "../../src/sandbox";
import { PTY_GONE_CODE, PTY_SUPERSEDED_CODE } from "../../src/server";
import { TOKEN_SCOPES } from "../../src/token-scopes";
import { AGENT_PROVIDERS, EFFORTS } from "../../src/types";
import { WorktreeMissingBaseError } from "../../src/worktree";
import * as fx from "./event-fixtures";
import {
  bearer,
  collectEvents,
  coverage,
  declaredEvents,
  declaredOperations,
  HTTP_METHODS,
  loadContract,
  login,
  mintToken,
  restoreAuth,
  securedOperations,
  startContractServer,
  validateEvent,
  validateResponse,
  withAuth,
  type ContractServer,
  type Operation,
  type ResponseDecl,
} from "./harness";
import { operationTemplate, streamOwnedEvents, streamOwnedPaths } from "./stream-blocks";

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

  test("DELETE /api/access-tokens/{id}: a bearer may revoke ITSELF", async () => {
    // The native client's logout: it holds the token and no cookie. Minted through the cookie
    // route, then destroyed by its own bearer — the one token-management call a bearer may make.
    const throwaway = await mintToken(s, cookie, "self-revoking client");
    const res = await fetch(`${s.baseUrl}/api/access-tokens/${throwaway.id}`, {
      method: "DELETE",
      headers: bearer(throwaway.token),
    });
    const body = (await validateResponse("DELETE", "/api/access-tokens/{id}", res)) as {
      ok: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The credential is dead on the very next request — no restart.
    const after = await fetch(`${s.baseUrl}/api/me`, { headers: bearer(throwaway.token) });
    expect(after.status).toBe(401);
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
  /** POST a standard create body. Each test gets its own session so none depends on another
   *  test having run (or on the order they run in). */
  async function post(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", ...body }),
    });
  }

  async function createSession(prompt: string): Promise<{ id: string }> {
    const res = await post({ prompt });
    const body = (await validateResponse("POST", "/api/sessions", res)) as { id: string };
    expect(res.status).toBe(201);
    return body;
  }

  test("POST /api/sessions creates (201) and rejects bad input (400)", async () => {
    const created = await createSession("contract");
    expect(created.id).toBeTruthy();

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
      const res = await post({ prompt: "x" });
      await validateResponse("POST", "/api/sessions", res);
      expect(res.status).toBe(409);
    } finally {
      firstRun.pending = false;
    }
  });

  test("accepts the six create fields milestone 3 declared", async () => {
    const body = {
      repoPath: s.validRepo,
      baseBranch: "main",
      prompt: "declared create fields",
      research: false,
      epicAuthoring: false,
      mergeTrainPrs: [],
      attachmentNames: [],
      launchUiState: {
        researchChecked: false,
        planGateChecked: false,
        autopilotChecked: false,
      },
      issueRef: { number: 1, url: "https://example.test/i/1", title: "t", body: "" },
    };
    // Validate the request too: the server already accepts these fields, so a 201 alone
    // cannot catch a missing declaration in the generated client's contract.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(loadContract() as unknown as object, "contract");
    const validate = ajv.compile({ $ref: "contract#/components/schemas/CreateSessionRequest" });
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...body, issueRef: { number: 1, url: body.issueRef.url, title: "t" } })).toBe(
      false,
    );
    expect(validate({ ...body, launchUiState: { source: "contract-test" } })).toBe(false);

    const res = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify(body),
    });
    // 201 proves ALLOWED_KEYS took every field; an unknown key would answer 400.
    expect(res.status).toBe(201);
    await validateResponse("POST", "/api/sessions", res);
  });

  test("declares and accepts the spawn-id request header", async () => {
    expect(loadContract().paths["/api/sessions"]!.post).toMatchObject({
      parameters: expect.arrayContaining([
        {
          name: "X-Shepherd-Spawn-Id",
          in: "header",
          required: false,
          schema: { type: "string" },
          description: expect.any(String),
        },
      ]),
    });
    const res = await fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(token),
        "X-Shepherd-Spawn-Id": crypto.randomUUID(),
      },
      body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "spawn id" }),
    });
    expect(res.status).toBe(201);
    await validateResponse("POST", "/api/sessions", res);
  });

  // The usage-hold gate (config.usageHoldEnabled defaults on, usageHoldPct 80): shouldHold()
  // compares max(session5h.pct, week.pct) against the threshold, so lifting the stubbed 5h
  // window above it queues the task (200 HeldTask) instead of spawning. `force: true` is the
  // client's documented override and must still spawn (201).
  test("POST /api/sessions holds (200) over the usage threshold; force spawns anyway (201)", async () => {
    const saved = s.stubs.usageLimits.limits;
    s.stubs.usageLimits.limits = (now: number) => ({
      ...saved(now),
      session5h: { pct: config.usageHoldPct + 5, resetAt: now + 3_600_000 },
    });
    let heldId: string | null = null;
    try {
      const res = await post({ prompt: "held" });
      const body = (await validateResponse("POST", "/api/sessions", res)) as {
        held: boolean;
        id: string;
      };
      expect(res.status).toBe(200);
      expect(body.held).toBe(true);
      heldId = body.id;

      const forced = await post({ prompt: "forced", force: true });
      const created = (await validateResponse("POST", "/api/sessions", forced)) as { id: string };
      expect(forced.status).toBe(201);
      expect(created.id).toBeTruthy();
    } finally {
      s.stubs.usageLimits.limits = saved;
      // A held task is a row in held_tasks, not a session — it never shows up in
      // GET /api/sessions — but drop it anyway so the store is left as we found it.
      if (heldId) s.deps.store.removeHeldTask(heldId);
    }
  });

  // createErrorResponse maps a missing base ref to 422; the service reaches it through
  // worktree.ensureBaseRef, the first worktree call on the create path.
  test("POST /api/sessions is 422 when the base ref is missing", async () => {
    const saved = s.stubs.worktree.ensureBaseRef;
    s.stubs.worktree.ensureBaseRef = async () => {
      throw new WorktreeMissingBaseError("no-such-branch");
    };
    try {
      const res = await post({ prompt: "missing base" });
      await validateResponse("POST", "/api/sessions", res);
      expect(res.status).toBe(422);
    } finally {
      s.stubs.worktree.ensureBaseRef = saved;
    }
  });

  // Anything else create throws is a downstream failure: 502.
  test("POST /api/sessions is 502 when the spawn fails", async () => {
    const saved = s.stubs.herdr.start;
    s.stubs.herdr.start = async () => {
      throw new Error("boom");
    };
    try {
      const res = await post({ prompt: "spawn fails" });
      await validateResponse("POST", "/api/sessions", res);
      expect(res.status).toBe(502);
    } finally {
      s.stubs.herdr.start = saved;
    }
  });

  test("GET /api/sessions and /api/sessions/{id}", async () => {
    const created = await createSession("listed");
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
    const created = await createSession("interrupted");
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
    const created = await createSession("archived");
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

describe("realtime /events", () => {
  test("upgrade requires auth", async () => {
    // checkAuth runs in `fetch`, before server.upgrade — an anonymous client never gets an open
    // socket. Bun surfaces the rejected handshake as `error`, then `close`; either proves the gate.
    const closed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${s.wsUrl}/events`);
      ws.onerror = () => resolve(true);
      ws.onclose = () => resolve(true);
      ws.onopen = () => {
        ws.close();
        resolve(false);
      };
    });
    expect(closed).toBe(true);

    // The WebSocket attempt above proves the handshake never opens, but that also passes on any
    // handshake failure (a bad host, a dropped connection, …), not specifically on the auth gate.
    // Probe the same upgrade path over plain `fetch` so we can assert the exact HTTP status:
    // checkAuth runs before `server.upgrade`, so a missing bearer token must yield 401, and a
    // valid one must not.
    const upgradeHeaders = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    };
    const anon = await fetch(`${s.baseUrl}/events`, { headers: upgradeHeaders });
    expect(anon.status).toBe(401);

    const authed = await fetch(`${s.baseUrl}/events`, {
      headers: { ...upgradeHeaders, ...bearer(token) },
    });
    // Bun's fetch cannot complete a WebSocket upgrade itself (it reports the attempt as a 101, or
    // as a network-level failure once the server switches protocols mid-response), but either way
    // it must NOT be the 401 the anonymous probe got — that's the auth gate specifically, not just
    // "some handshake failure".
    expect(authed.status).not.toBe(401);
  });

  test("real session:new and session:archived frames match the contract", async () => {
    const declared = new Set(declaredEvents());
    let id = "";
    const frames = await collectEvents(s, token, async () => {
      const res = await fetch(`${s.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", prompt: "events" }),
      });
      id = ((await res.json()) as { id: string }).id;
      await fetch(`${s.baseUrl}/api/sessions/${id}`, {
        method: "DELETE",
        headers: bearer(token),
      });
    });
    const names = frames.map((f) => f.event);
    expect(names).toContain("session:new");
    expect(names).toContain("session:archived");
    // Everything the real server pushed that the contract declares must match it; frames for
    // undeclared events (the native client ignores them) are not the contract's business.
    for (const f of frames) if (declared.has(f.event)) validateEvent(f.event, f.data);
  });

  test("typed fixtures for herdr-driven events pass through the hub unchanged", async () => {
    const emits: [string, unknown][] = [
      ["session:status", fx.statusEvent],
      ["session:renamed", fx.renamedEvent],
      ["session:block", fx.blockEvent],
      ["session:block", fx.unblockEvent],
      ["session:ready", fx.readyEvent],
      ["automerge:status", fx.automergeEvent],
      ["usage:limits", fx.usageEvent],
    ];
    const frames = await collectEvents(s, token, async () => {
      for (const [name, data] of emits) s.deps.events.emit(name, data);
    });
    for (const [name, data] of emits) {
      const seen = frames.find(
        (f) => f.event === name && JSON.stringify(f.data) === JSON.stringify(data),
      );
      expect(seen, `frame ${name} not received`).toBeTruthy();
      validateEvent(name, seen!.data);
    }
  });
});

describe("realtime /pty protocol constants", () => {
  test("contract constants equal the server's", () => {
    const pty = loadContract()["x-shepherd-pty"];
    expect(pty.closeCodes.superseded).toBe(PTY_SUPERSEDED_CODE);
    expect(pty.closeCodes.gone).toBe(PTY_GONE_CODE);
    expect(pty.resizePrefix).toBe(RESIZE_PREFIX);
    expect(pty.path).toBe("/pty/{id}");

    // RESIZE_PREFIX (imported above) is a mirror re-exported for exactly this assertion — the
    // real wire parser is src/pty-demux.mjs, a plain .mjs script outside the TS build that holds
    // its own literal. Read its source and pin that literal too, so the demux can't drift from
    // the contract (and from RESIZE_PREFIX) unnoticed. The file spells the NUL byte as the JS
    // escape `\x00`, not as a literal control character or a JSON \u0000 escape, so assert that exact form.
    const demuxSrc = readFileSync(
      join(import.meta.dir, "..", "..", "src", "pty-demux.mjs"),
      "utf8",
    );
    expect(demuxSrc).toContain('startsWith("\\x00resize:")');
  });
});

describe("contract structure", () => {
  test("declares observed usage windows and git handoff fields", () => {
    const schemas = loadContract().components.schemas;
    expect(schemas.UsageLimits).toMatchObject({
      properties: { observed: { $ref: "#/components/schemas/ObservedLimitWindows" } },
    });
    expect(schemas.ObservedLimitWindow).toMatchObject({
      required: ["pct", "resetAt", "scrapedAt"],
      properties: {
        pct: { type: "number" },
        resetAt: { type: "integer" },
        scrapedAt: { type: "integer" },
      },
    });
    const window = {
      oneOf: [{ $ref: "#/components/schemas/ObservedLimitWindow" }, { type: "null" }],
    };
    expect(schemas.ObservedLimitWindows).toMatchObject({
      required: ["session5h", "week"],
      properties: { session5h: window, week: window },
    });
    expect(schemas.GitState).toMatchObject({
      properties: {
        handoff: { $ref: "#/components/schemas/PrHandoff" },
        handoffWho: { type: "string" },
        reviewBlock: { $ref: "#/components/schemas/PrReviewBlock" },
        headSha: { type: "string" },
      },
    });
    expect(schemas.PrHandoff).toMatchObject({
      "x-shepherd-open-enum": true,
      enum: ["reviewer", "merger"],
    });
    expect(schemas.PrReviewBlock).toMatchObject({
      required: ["reviewer", "state"],
      properties: {
        reviewer: { type: "string" },
        state: { type: "string", enum: ["changes_requested"] },
        latestAt: { type: ["integer", "null"] },
      },
    });
  });

  test("every operation has an operationId and JSON responses reference component schemas", () => {
    const c = loadContract();
    for (const [template, methods] of Object.entries(c.paths)) {
      for (const [method, rawOp] of Object.entries(methods)) {
        if (!HTTP_METHODS.includes(method as never)) continue;
        const op = rawOp as Operation;
        expect(op.operationId, `${method} ${template}`).toBeTruthy();
        for (const [status, r] of Object.entries(op.responses)) {
          const schema = (r as ResponseDecl).content?.["application/json"]?.schema as
            { $ref?: string } | undefined;
          if (schema) {
            expect(schema.$ref, `${method} ${template} ${status}`).toMatch(
              /^#\/components\/schemas\//,
            );
          }
        }
      }
    }
  });

  // The enums are copied into the YAML by hand; these pin each copy to the exported constant it
  // was copied from, so adding a scope/provider/effort/profile in TypeScript fails here instead of
  // shipping a generated Swift enum that silently cannot represent the new member.
  test("enum arrays equal the server constants they were copied from", () => {
    const schemas = loadContract().components.schemas as Record<
      string,
      { enum: unknown[] } | undefined
    >;
    const members = (name: string): unknown[] => {
      const schema = schemas[name];
      expect(schema, `missing schema ${name}`).toBeTruthy();
      return schema!.enum;
    };
    expect(members("TokenScope")).toEqual([...TOKEN_SCOPES]);
    expect(members("AgentProvider")).toEqual([...AGENT_PROVIDERS]);
    expect(members("Effort")).toEqual([...EFFORTS]);
    expect(members("SandboxProfile")).toEqual([...SANDBOX_PROFILES]);
  });

  test("every component schema is referenced at least once", () => {
    const c = loadContract();
    const text = JSON.stringify(c);
    for (const name of Object.keys(c.components.schemas)) {
      expect(text.includes(`#/components/schemas/${name}"`), `unused schema ${name}`).toBe(true);
    }
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
  // Block-aware. A path inside a `# ── stream: … ──` block belongs to the stream that
  // added it, and its fixtures live in that stream's own test/contract/<stream>.test.ts.
  // Bun runs test files in filesystem order, so this gate can run BEFORE those files —
  // policing their paths here would fail every stream branch the day it adds a route.
  // Each stream file ends with its own gate over operationsForStream(<name>).
  test("every declared operation outside a stream block was exercised", () => {
    const { operations } = coverage();
    const owned = streamOwnedPaths();
    const missingOps = declaredOperations().filter(
      (o) => !owned.has(operationTemplate(o)) && !operations.has(o),
    );
    expect(missingOps).toEqual([]);
  });

  // Block-aware for the same reason, and with the same split: `x-shepherd-events` carries
  // a third marked block per stream, and an event declared inside one is covered by that
  // stream's own test/contract/<stream>.test.ts — which ends with a gate over
  // eventsForStream(<name>) — not here, because Bun's file order may put this file first.
  test("every declared event outside a stream block was exercised", () => {
    const { events } = coverage();
    const owned = streamOwnedEvents();
    expect(declaredEvents().filter((e) => !owned.has(e) && !events.has(e))).toEqual([]);
  });
});
