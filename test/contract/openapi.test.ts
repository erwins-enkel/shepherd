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
import { AGENT_PROVIDERS, DISPATCH_STATES, EFFORTS } from "../../src/types";
import { WorktreeMissingBaseError } from "../../src/worktree";
import type {
  RemoteCancelResult,
  RemoteDispatchView,
  RemoteOutcome,
} from "../../src/remote-instances/dispatch";
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
  validateRequest,
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

describe("instance", () => {
  test("GET /api/instance matches the contract and keeps its id", async () => {
    const read = async () => {
      const res = await fetch(`${s.baseUrl}/api/instance`, { headers: bearer(token) });
      return (await validateResponse("GET", "/api/instance", res)) as {
        instanceId: string;
        federationApi: number;
      };
    };
    const first = await read();
    expect(first.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.federationApi).toBe(1);
    expect((await read()).instanceId).toBe(first.instanceId);
  });

  // Both arms of the nullable `capabilities` (#2770): null before the first probe, then a report.
  test("GET /api/instance carries the capability report once a probe finished", async () => {
    const read = async () => {
      const res = await fetch(`${s.baseUrl}/api/instance`, { headers: bearer(token) });
      return (await validateResponse("GET", "/api/instance", res)) as {
        capabilities: { stale: boolean; checks: { id: string; ok: boolean }[] } | null;
      };
    };
    expect((await read()).capabilities).toBeNull();
    await s.deps.capabilities!.refresh();
    const { capabilities } = await read();
    expect(capabilities?.stale).toBe(false);
    expect(capabilities?.checks).toHaveLength(13);
    expect(capabilities?.checks.find((c) => c.id === "agent:claude")?.ok).toBe(true);
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

  test("GET /api/me returns current token grants without secrets", async () => {
    for (const headers of [bearer(token), { cookie }]) {
      const res = await fetch(`${s.baseUrl}/api/me`, { headers });
      const body = (await validateResponse("GET", "/api/me", res)) as {
        access?: { tokenId: string; repoPaths: string[] | null };
      };
      expect(res.status).toBe(200);
      if ("cookie" in headers) expect(body.access).toBeUndefined();
      else expect(body.access).toMatchObject({ tokenId, repoPaths: null });
    }
  });

  test("PATCH /api/access-tokens/{id} changes grants only with an operator session", async () => {
    const { id, token: editable } = await mintToken(s, cookie, "editable");
    for (const [path, headers, body, status] of [
      [id, { cookie }, { repoPaths: [] }, 200],
      [id, { cookie }, { scope: "full" }, 400],
      [id, bearer(editable), { repoPaths: null }, 403],
      ["missing", { cookie }, { repoPaths: [] }, 404],
    ] as const) {
      const res = await fetch(`${s.baseUrl}/api/access-tokens/${path}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(status);
      await validateResponse("PATCH", "/api/access-tokens/{id}", res);
    }
    const res = await fetch(`${s.baseUrl}/api/me`, { headers: bearer(editable) });
    const body = (await validateResponse("GET", "/api/me", res)) as {
      access: { repoPaths: string[] };
    };
    expect(body.access.repoPaths).toEqual([]);
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

  async function createSession(prompt: string): Promise<{ id: string; desig: string }> {
    const res = await post({ prompt });
    const body = (await validateResponse("POST", "/api/sessions", res)) as {
      id: string;
      desig: string;
    };
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

  // Readiness at acceptance (#2770): the harness probes a fixed Linux host (src: test/contract/
  // deps.ts), so platform:linux is met and xcode is not — refused with its reason, nothing spawned.
  test("POST /api/sessions checks requirements: met spawns (201), missing is 422", async () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(loadContract() as unknown as object, "contract");
    const validate = ajv.compile({ $ref: "contract#/components/schemas/CreateSessionRequest" });
    const body = { repoPath: s.validRepo, baseBranch: "main", prompt: "needs linux" };
    expect(validate({ ...body, requirements: ["platform:linux"] })).toBe(true);

    const met = await post({ prompt: "needs linux", requirements: ["platform:linux"] });
    await validateResponse("POST", "/api/sessions", met);
    expect(met.status).toBe(201);

    const before = s.deps.store.list().length;
    const missing = await post({ prompt: "needs xcode", requirements: ["xcode"] });
    const refused = (await validateResponse("POST", "/api/sessions", missing)) as {
      code: string;
      missing: unknown[];
    };
    expect(missing.status).toBe(422);
    expect(refused.code).toBe("missing_capabilities");
    expect(refused.missing).toEqual([{ capability: "xcode", reason: "other_platform" }]);
    expect(s.deps.store.list().length).toBe(before);
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

  // #2763: a create with a target is handed to the remote dispatcher; each of its outcomes keeps
  // to the declared shapes. The dispatcher is stubbed — the network side is covered end to end in
  // test/server-remote-dispatch.test.ts.
  test("POST /api/sessions with a target starts (201), holds (200), refuses (422), fails its attachments (502), is unknown (504) or was canceled (409) on the machine", async () => {
    const host = {
      instanceId: "0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d",
      name: "MacBook",
      platform: "macos",
    };
    const machineSession = await createSession("on the machine");
    const outcomes: RemoteOutcome[] = [
      {
        kind: "started",
        session: {
          ...machineSession,
          id: "remote-1",
          host,
          connection: { state: "connected", since: 1 },
        },
      },
      { kind: "held", id: "held-1", count: 2, host },
      { kind: "rejected", host, reason: "base missing", remoteStatus: 422, remoteCode: null },
      { kind: "unknown", host, dispatchKey: "key-1" },
      { kind: "upload_failed", host, reason: "attachment 1 of 1: the machine answered 413" },
      { kind: "canceled", host },
      { kind: "cancel_pending", host },
      { kind: "refused", code: "remote_target_unavailable", reason: "timeout" },
    ];
    const savedForge = s.stubs.resolveForge.forge;
    s.stubs.resolveForge.forge = { slug: "acme/app" };
    try {
      for (const outcome of outcomes) {
        s.deps.remoteDispatch = {
          submit: async () => outcome,
          list: () => [],
          cancel: async () => ({ kind: "not_found" }),
        };
        const body = { prompt: "remote", target: { instanceId: host.instanceId } };
        validateRequest("POST", "/api/sessions", {
          repoPath: s.validRepo,
          baseBranch: "main",
          ...body,
        });
        const res = await post(body);
        const answer = (await validateResponse("POST", "/api/sessions", res)) as Record<
          string,
          unknown
        >;
        if (outcome.kind !== "refused") expect(answer.host).toEqual(host);
      }
    } finally {
      s.deps.remoteDispatch = undefined;
      s.stubs.resolveForge.forge = savedForge;
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

    const byDesig = await fetch(`${s.baseUrl}/api/sessions/${created.desig}`, {
      headers: bearer(token),
    });
    expect(
      ((await validateResponse("GET", "/api/sessions/{id}", byDesig)) as { id: string }).id,
    ).toBe(created.id);

    const missing = await fetch(`${s.baseUrl}/api/sessions/nope`, { headers: bearer(token) });
    await validateResponse("GET", "/api/sessions/{id}", missing);
    expect(missing.status).toBe(404);
  });

  test("GET /api/sessions appends sessions mirrored from a connected machine", async () => {
    const created = await createSession("mirrored");
    const host = {
      instanceId: "0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d",
      name: "MacBook",
      platform: "macos",
    };
    const connection = { state: "disconnected", since: 1_790_000_000_000 };
    const ref = { ...created, id: "remote-session", desig: "TASK-07", host, connection };
    s.deps.remoteSessions = { list: () => [ref], subscribe: () => () => {} } as never;
    try {
      const res = await fetch(`${s.baseUrl}/api/sessions`, { headers: bearer(token) });
      const sessions = (await validateResponse("GET", "/api/sessions", res)) as object[];
      expect(sessions.at(-1)).toEqual(ref);
      expect(sessions.filter((x) => "host" in x)).toEqual([ref]);
      // A relayed frame about a mirrored session carries the same annotation.
      validateEvent("session:new", ref);
      validateEvent("session:status", { id: ref.id, status: "idle", host, connection });
      // A machine's whole mirrored set, and the empty set once it is removed.
      validateEvent("remote:sessions", { instanceId: host.instanceId, sessions: [ref] });
      validateEvent("remote:sessions", { instanceId: host.instanceId, sessions: [] });
    } finally {
      s.deps.remoteSessions = undefined;
    }
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
  test("DELETE /api/sessions/{id} archives; GET /api/sessions/done and /archived list it", async () => {
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
    const archived = await fetch(`${s.baseUrl}/api/sessions/archived`, { headers: bearer(token) });
    const all = (await validateResponse("GET", "/api/sessions/archived", archived)) as {
      id: string;
    }[];
    expect(all.map((x) => x.id)).toContain(created.id);
  });
});

// Idempotent acceptance (#2761): a keyed POST /api/sessions runs at most once, and
// /api/dispatches/{id} reports or withdraws it. Every declared status of both operations is
// exercised here (the coverage gate below checks), plus the outcomes the issue pins: a replay is
// the same session, a hold later released reads as started, a withdrawn key never starts.
describe("dispatches", () => {
  const send = (key: string, body: Record<string, unknown>) =>
    fetch(`${s.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token), "Idempotency-Key": key },
      body: JSON.stringify({ repoPath: s.validRepo, baseBranch: "main", ...body }),
    });
  const dispatch = (key: string, method = "GET") =>
    fetch(`${s.baseUrl}/api/dispatches/${key}`, { method, headers: bearer(token) });

  test("a keyed create is replayed, not repeated; a different body is 409", async () => {
    const key = `contract-${crypto.randomUUID()}`;
    const first = await send(key, { prompt: "keyed" });
    const created = (await validateResponse("POST", "/api/sessions", first)) as { id: string };
    expect(first.status).toBe(201);
    const before = s.deps.store.list().length;

    const again = await send(key, { prompt: "keyed" });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await validateResponse("POST", "/api/sessions", again)) as { id: string }).id).toBe(
      created.id,
    );
    const other = await send(key, { prompt: "a different task" });
    expect(other.status).toBe(409);
    expect(await validateResponse("POST", "/api/sessions", other)).toMatchObject({
      code: "dispatch_payload_mismatch",
    });
    expect(s.deps.store.list().length).toBe(before);

    const got = await dispatch(key);
    expect(got.status).toBe(200);
    expect(await validateResponse("GET", "/api/dispatches/{id}", got)).toMatchObject({
      id: key,
      state: "started",
      sessionId: created.id,
    });
    // Once arrived it can't be withdrawn here: 409 with the current dispatch.
    const late = await dispatch(key, "DELETE");
    expect(late.status).toBe(409);
    expect(await validateResponse("DELETE", "/api/dispatches/{id}", late)).toMatchObject({
      code: "dispatch_arrived",
      dispatch: { state: "started" },
    });
  });

  test("a held dispatch turns started when the hold is released", async () => {
    const saved = s.stubs.usageLimits.limits;
    s.stubs.usageLimits.limits = (now: number) => ({
      ...saved(now),
      session5h: { pct: config.usageHoldPct + 5, resetAt: now + 3_600_000 },
    });
    const key = `contract-${crypto.randomUUID()}`;
    let heldId: string | undefined;
    try {
      const res = await send(key, { prompt: "held dispatch" });
      expect(res.status).toBe(200);
      heldId = ((await validateResponse("POST", "/api/sessions", res)) as { id: string }).id;
      const held = await dispatch(key);
      expect(await validateResponse("GET", "/api/dispatches/{id}", held)).toMatchObject({
        state: "held",
        heldId,
      });
    } finally {
      s.stubs.usageLimits.limits = saved;
    }
    const spawned = await fetch(`${s.baseUrl}/api/held/${heldId}/spawn`, {
      method: "POST",
      headers: bearer(token),
    });
    expect(spawned.status).toBe(201);
    const session = (await spawned.json()) as { id: string };
    const started = await dispatch(key);
    expect(await validateResponse("GET", "/api/dispatches/{id}", started)).toMatchObject({
      state: "started",
      sessionId: session.id,
      heldId,
    });
  });

  test("a withdrawn key never starts; unknown is 404, malformed is 400", async () => {
    const key = `contract-${crypto.randomUUID()}`;
    const missing = await dispatch(key);
    await validateResponse("GET", "/api/dispatches/{id}", missing);
    expect(missing.status).toBe(404);

    const withdrawn = await dispatch(key, "DELETE");
    expect(withdrawn.status).toBe(200);
    expect(await validateResponse("DELETE", "/api/dispatches/{id}", withdrawn)).toMatchObject({
      state: "failed",
      code: "dispatch_canceled",
    });
    const before = s.deps.store.list().length;
    const late = await send(key, { prompt: "arrives late" });
    expect(late.status).toBe(409);
    expect(await validateResponse("POST", "/api/sessions", late)).toMatchObject({
      code: "dispatch_canceled",
    });
    expect(s.deps.store.list().length).toBe(before);

    for (const method of ["GET", "DELETE"]) {
      const bad = await dispatch("-not-a-key", method);
      await validateResponse(method, "/api/dispatches/{id}", bad);
      expect(bad.status).toBe(400);
    }
  });

  test("the session carries the base commit it was created from; an explicit one is used as-is", async () => {
    const head = "c".repeat(40);
    const pinned = "d".repeat(40);
    const savedCreate = s.stubs.worktree.create;
    const bases: string[] = [];
    s.stubs.worktree.ensureCommit = async () => {};
    s.stubs.worktree.create = (_repo: string, base: string) => {
      bases.push(base);
      return {
        worktreePath: "/wt",
        branch: "shepherd/x",
        isolated: true,
        baseCommit: base === pinned ? pinned : head,
      };
    };
    try {
      const res = await send(`contract-${crypto.randomUUID()}`, { prompt: "base commit" });
      const created = (await validateResponse("POST", "/api/sessions", res)) as {
        id: string;
        baseCommit: string;
      };
      expect(created.baseCommit).toBe(head);
      const read = await fetch(`${s.baseUrl}/api/sessions/${created.id}`, {
        headers: bearer(token),
      });
      expect(await validateResponse("GET", "/api/sessions/{id}", read)).toMatchObject({
        baseCommit: head,
      });

      const explicit = await send(`contract-${crypto.randomUUID()}`, {
        prompt: "pinned base",
        baseCommit: pinned,
      });
      expect(explicit.status).toBe(201);
      expect(await validateResponse("POST", "/api/sessions", explicit)).toMatchObject({
        baseBranch: "main",
        baseCommit: pinned,
      });
      expect(bases.at(-1)).toBe(pinned);
    } finally {
      s.stubs.worktree.create = savedCreate;
      delete s.stubs.worktree.ensureCommit;
    }
  });
});

// Start status unknown (#2774): what this instance sent to connected machines that no machine has
// confirmed, and canceling one. The dispatcher is stubbed — reconciling and canceling against a
// real machine are covered end to end in test/server-remote-dispatch.test.ts.
describe("remote dispatches", () => {
  const host = {
    instanceId: "0b6f2c1e-7c1d-4e53-9d1a-3c1f2e4b5a6d",
    name: "MacBook",
    platform: "macos",
  };
  const dispatch = (
    state: RemoteDispatchView["state"],
    extra: Partial<RemoteDispatchView> = {},
  ): RemoteDispatchView => ({
    id: "d-1",
    state,
    host,
    summary: "port the settings screen",
    createdAt: 1,
    updatedAt: 2,
    ...extra,
  });
  const stub = (over: Partial<NonNullable<typeof s.deps.remoteDispatch>>) => {
    s.deps.remoteDispatch = {
      submit: async () => ({ kind: "refused", code: "remote_target_unknown", reason: null }),
      list: () => [],
      cancel: async () => ({ kind: "not_found" }),
      ...over,
    };
  };
  const list = () => fetch(`${s.baseUrl}/api/remote-dispatches`, { headers: bearer(token) });

  test("GET /api/remote-dispatches lists the unconfirmed ones; remote:dispatch carries one", async () => {
    try {
      // Nothing was sent: nothing listed.
      const empty = await list();
      expect(await validateResponse("GET", "/api/remote-dispatches", empty)).toEqual({
        dispatches: [],
      });
      const open = [dispatch("unknown"), dispatch("canceling", { id: "d-2" })];
      stub({ list: () => open });
      const res = await list();
      expect(res.status).toBe(200);
      expect(await validateResponse("GET", "/api/remote-dispatches", res)).toEqual({
        dispatches: open,
      });
    } finally {
      s.deps.remoteDispatch = undefined;
    }
    validateEvent("remote:dispatch", dispatch("unknown"));
    validateEvent("remote:dispatch", dispatch("started", { sessionId: "s-1" }));
    validateEvent(
      "remote:dispatch",
      dispatch("rejected", {
        reason: "Shepherd restarted before this start finished",
        code: "dispatch_interrupted",
      }),
    );
  });

  test("DELETE /api/remote-dispatches/{id} cancels (200), queues the cancel (202), is 404 or not cancelable (409)", async () => {
    const cases: [RemoteCancelResult, number][] = [
      [{ kind: "canceled", dispatch: dispatch("canceled") }, 200],
      [{ kind: "canceling", dispatch: dispatch("canceling") }, 202],
      [{ kind: "not_found" }, 404],
      [{ kind: "not_cancelable", dispatch: dispatch("started", { sessionId: "s-1" }) }, 409],
    ];
    try {
      for (const [result, status] of cases) {
        stub({ cancel: async () => result });
        const res = await fetch(`${s.baseUrl}/api/remote-dispatches/d-1`, {
          method: "DELETE",
          headers: bearer(token),
        });
        const body = await validateResponse("DELETE", "/api/remote-dispatches/{id}", res);
        expect(res.status).toBe(status);
        if (result.kind === "not_cancelable") {
          expect(body).toMatchObject({
            code: "remote_dispatch_not_cancelable",
            dispatch: result.dispatch,
          });
        } else if (result.kind !== "not_found") {
          expect(body).toEqual(result.dispatch);
        }
      }
    } finally {
      s.deps.remoteDispatch = undefined;
    }
  });
});

describe("usage snapshots", () => {
  for (const [name, limits] of fx.usageCases) {
    test(`GET /api/usage/limits: ${name}`, async () => {
      const saved = s.stubs.usageLimits.limits;
      s.stubs.usageLimits.limits = () => limits;
      try {
        const res = await fetch(`${s.baseUrl}/api/usage/limits`, { headers: bearer(token) });
        expect(res.status).toBe(200);
        expect(await validateResponse("GET", "/api/usage/limits", res)).toEqual({
          limits,
          projections: [],
        });
      } finally {
        s.stubs.usageLimits.limits = saved;
      }
    });
  }

  test("provider fields are validated, not merely accepted as extra properties", () => {
    const invalid = [
      { ...fx.usageEvent, providers: null },
      { ...fx.usageEvent, providers: [{ provider: "codex", kind: "tokens" }] },
      {
        ...fx.providerUsageEvent,
        providers: fx.providerUsageEvent.providers!.map((p) =>
          p.provider === "codex" ? { ...p, week: { pct: "7", resetAt: 1_800_500_000_000 } } : p,
        ),
      },
      {
        ...fx.providerUsageEvent,
        providers: fx.providerUsageEvent.providers!.map((p) =>
          p.provider === "codex" ? { ...p, kind: "limits" } : p,
        ),
      },
    ];
    for (const limits of invalid) {
      expect(() => validateEvent("usage:limits", limits)).toThrow("violates contract");
    }
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
      ...fx.usageCases.map(([, data]): [string, unknown] => ["usage:limits", data]),
      ...fx.cliSessionEvents,
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
    expect(members("DispatchState")).toEqual([...DISPATCH_STATES]);
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
      (o) =>
        !owned.has(operationTemplate(o)) &&
        !o.startsWith("PATCH /api/settings ") &&
        !operations.has(o),
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
