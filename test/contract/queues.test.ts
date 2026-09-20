import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { config } from "../../src/config";
import { firstRun } from "../../src/first-run";
import { SandboxAutoRefused } from "../../src/sandbox";
import { SpawnCanceled } from "../../src/spawn-progress";
import {
  WorktreeMissingBaseError,
  WorktreeOccupiedError,
  WorktreeRestoreError,
} from "../../src/worktree";
import * as fx from "./queues-fixtures";
import {
  bearer,
  collectEvents,
  coverage,
  loadContract,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";

const OPERATIONS = operationsForStream("queues");
const EVENTS = eventsForStream("queues");
let s: ContractServer;
let token: string;
async function request(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
  contentType = "application/json",
) {
  return fetch(`${s.baseUrl}${path}`, {
    method,
    headers: { "content-type": contentType, ...(auth ? bearer(token) : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function check(
  method: string,
  template: string,
  status: number,
  path = template,
  body?: unknown,
) {
  const res = await request(method, path, body);
  expect(res.status, await res.clone().text()).toBe(status);
  return validateResponse(method, template, res);
}
async function createSession() {
  const res = await request("POST", "/api/sessions", fx.held(s.validRepo).input);
  expect(res.status).toBe(201);
  return (await res.json()) as import("../../src/types").Session;
}
function addHeld(id = "held-fixture") {
  const entry = fx.held(s.validRepo, id);
  s.deps.store.addHeldTask(entry);
  return entry;
}
beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "queues contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("held queue", () => {
  test("stored inputs mirror core create fields while allowing server-owned metadata", () => {
    const schemas = loadContract().components.schemas;
    const core = schemas.CreateSessionRequest as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const stored = schemas.HeldQueueInput as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(stored.required).toEqual(core.required);
    expect(stored.additionalProperties).toBe(true);
    for (const [name, schema] of Object.entries(core.properties)) {
      expect(stored.properties[name], name).toEqual(schema);
    }
  });
  test("lists usage FIFO before capacity; replaces input and discards idempotently", async () => {
    const capacity = fx.held(s.validRepo, "capacity", "capacity", 1);
    s.deps.store.addHeldTask(capacity);
    const entry = addHeld();
    expect(await check("GET", "/api/held", 200)).toEqual([entry, capacity]);
    const input = { ...entry.input, prompt: "Edited" };
    const updated = await check("PATCH", "/api/held/{id}", 200, `/api/held/${entry.id}`, input);
    expect(updated).toMatchObject({ id: entry.id, input: { prompt: "Edited" } });
    const crossOrigin = await fetch(`${s.baseUrl}/api/held/${entry.id}`, {
      method: "PATCH",
      headers: {
        ...bearer(token),
        "content-type": "application/json",
        origin: "https://untrusted.invalid",
      },
      body: JSON.stringify(input),
    });
    expect(crossOrigin.status).toBe(200);
    await validateResponse("PATCH", "/api/held/{id}", crossOrigin);
    await check("PATCH", "/api/held/{id}", 400, `/api/held/${entry.id}`, {});
    await check("PATCH", "/api/held/{id}", 400, `/api/held/${entry.id}`, {
      terminal: true,
      repoPath: s.validRepo,
    });
    const ct = await request("PATCH", `/api/held/${entry.id}`, input, true, "text/plain");
    expect(ct.status).toBe(415);
    await validateResponse("PATCH", "/api/held/{id}", ct);
    await check("PATCH", "/api/held/{id}", 404, "/api/held/missing", input);
    for (const id of [entry.id, entry.id, capacity.id, "missing"]) {
      expect(await check("DELETE", "/api/held/{id}", 200, `/api/held/${id}`)).toEqual({ ok: true });
    }
    expect(await check("GET", "/api/held", 200)).toEqual([]);
  });
  test("spawn validates overrides, preserves failures and returns a Session with 201", async () => {
    const entry = addHeld();
    const path = `/api/held/${entry.id}/spawn`;
    for (const body of [[], { unexpected: true }, { agentProvider: "invalid" }]) {
      await check("POST", "/api/held/{id}/spawn", 400, path, body);
    }
    await check("POST", "/api/held/{id}/spawn", 404, "/api/held/missing/spawn");
    const failures: [number, Error][] = [
      [403, new SandboxAutoRefused("refused")],
      [422, new WorktreeMissingBaseError("main")],
      [409, new WorktreeOccupiedError("/wt")],
      [409, new SpawnCanceled()],
      [409, new Error("agent_name_taken")],
      [502, new Error("spawn failed")],
    ];
    for (const [status, error] of failures) {
      const mock = spyOn(s.deps.service, "create").mockRejectedValueOnce(error);
      try {
        await check("POST", "/api/held/{id}/spawn", status, path);
        expect(s.deps.store.getHeldTask(entry.id)).not.toBeNull();
      } finally {
        mock.mockRestore();
      }
    }
    const created = await check("POST", "/api/held/{id}/spawn", 201, path, {
      agentProvider: "codex",
    });
    expect(created).toMatchObject({ agentProvider: "codex" });
    expect(s.deps.store.getHeldTask(entry.id)).toBeNull();
  });
});

describe("Up Next", () => {
  test("refresh is accepted or unavailable; GET is deliberately absent", async () => {
    expect(loadContract().paths["/api/up-next"]).toBeUndefined();
    await check("POST", "/api/up-next/refresh", 503);
    s.deps.upNext = {
      snapshot: () => fx.snapshot,
      refresh: async () => fx.snapshot,
      recomputeUntilCleared: async () => {},
      hiddenRepoPathsRaw: () => new Set(),
    };
    try {
      expect(await check("POST", "/api/up-next/refresh", 202)).toEqual({ ok: true });
    } finally {
      delete s.deps.upNext;
    }
  });
  test("start distinguishes created, held/reused and errors over one shape", async () => {
    const item = { repoPath: s.validRepo, issueRef: fx.issueRef };
    const body = { items: [item], agentProvider: "claude" };
    expect(await check("POST", "/api/up-next/start", 502, undefined, body)).toMatchObject({
      created: [],
      held: [],
      errors: [{ number: 42, error: "no forge for repo" }],
    });
    s.stubs.resolveForge.forge = {
      defaultBranch: async () => "main",
      addIssueLabel: async () => {},
    };
    const saved = {
      enabled: config.usageHoldEnabled,
      pct: config.usageHoldPct,
      limits: s.stubs.usageLimits.limits,
    };
    try {
      config.usageHoldEnabled = false;
      const mixed = {
        ...body,
        items: [item, { ...item, issueRef: { ...fx.issueRef, number: 43 } }],
      };
      const mock = spyOn(s.deps.service, "create").mockRejectedValueOnce(new Error("one failed"));
      try {
        const result = await check("POST", "/api/up-next/start", 201, undefined, mixed);
        expect(result).toMatchObject({ held: [], errors: [{ number: 42, error: "one failed" }] });
      } finally {
        mock.mockRestore();
      }
      config.usageHoldEnabled = true;
      config.usageHoldPct = 0;
      for (const reused of [false, true]) {
        const result = (await check("POST", "/api/up-next/start", 200, undefined, body)) as {
          held: { reused?: boolean }[];
        };
        expect(result.held).toHaveLength(1);
        expect(result.held[0]?.reused ?? false).toBe(reused);
        await check("GET", "/api/held", 200);
      }
    } finally {
      config.usageHoldEnabled = saved.enabled;
      config.usageHoldPct = saved.pct;
      s.stubs.usageLimits.limits = saved.limits;
      s.stubs.resolveForge.forge = null;
    }
    for (const bad of [
      {},
      { items: [{}] },
      { ...body, model: "auto", agentProvider: undefined },
      { ...body, agentProvider: "invalid" },
    ])
      await check("POST", "/api/up-next/start", 400, undefined, bad);
    const ct = await request("POST", "/api/up-next/start", body, true, "text/plain");
    expect(ct.status).toBe(415);
    await validateResponse("POST", "/api/up-next/start", ct);
  });
  test("first-run gate blocks both spawning routes", async () => {
    const saved = firstRun.pending;
    firstRun.pending = true;
    try {
      await check("POST", "/api/up-next/start", 409, undefined, {});
      await check("POST", "/api/held/{id}/spawn", 409, "/api/held/missing/spawn");
    } finally {
      firstRun.pending = saved;
    }
  });
});

describe("herd controls", () => {
  test("halt emits its result and rejects another verb", async () => {
    await createSession();
    const frames = await collectEvents(s, token, async () => {
      const result = (await check("POST", "/api/halt", 200)) as { halted: number };
      expect(result.halted).toBeGreaterThan(0);
    });
    const frame = frames.find((f) => f.event === "halt:done");
    expect(frame).toBeDefined();
    validateEvent("halt:done", frame!.data);
    const res = await request("GET", "/api/halt");
    expect(res.status).toBe(405);
    await validateResponse("POST", "/api/halt", res);
  });
  test("an unreachable herdr is a genuine halt failure, without a success event", async () => {
    const saved = s.stubs.herdr.list;
    s.stubs.herdr.list = () => {
      throw new Error("herdr unreachable");
    };
    try {
      const frames = await collectEvents(s, token, async () => {
        const res = await request("POST", "/api/halt");
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "herdr unreachable" });
      });
      expect(frames.some((frame) => frame.event === "halt:done")).toBe(false);
    } finally {
      s.stubs.herdr.list = saved;
    }
  });
  test("retry counts requested ids, broadcast classifies missing ids", async () => {
    const session = await createSession();
    const ids = [session.id, "unknown"];
    expect(await check("POST", "/api/retry", 200, undefined, { ids, text: "Continue" })).toEqual({
      resumed: 0,
      steered: 1,
      total: 2,
    });
    expect(
      await check("POST", "/api/broadcast", 200, undefined, { ids, text: "Review" }),
    ).toMatchObject({ queued: 1, offline: 1, total: 2 });
    for (const path of ["/api/retry", "/api/broadcast"]) {
      await check("POST", path, 400, undefined, {});
      const ct = await request("POST", path, {}, true, "text/plain");
      expect(ct.status).toBe(415);
      await validateResponse("POST", path, ct);
    }
  });
  test("stranded ids bootstrap and revive reports success and failure", async () => {
    const session = await createSession();
    s.deps.store.update(session.id, { claudeSessionId: "conversation-fixture" });
    s.stubs.stranded.ids = [session.id, "missing"];
    try {
      expect(await check("GET", "/api/stranded", 200)).toEqual([session.id, "missing"]);
      expect(await check("POST", "/api/revive-stranded", 200)).toEqual({ revived: 1, failed: 1 });
    } finally {
      s.stubs.stranded.ids = [];
    }
  });
});

describe("restore and usage", () => {
  test("restore covers all six conflict codes and the successful Session", async () => {
    const session = await createSession();
    const path = `/api/sessions/${session.id}/restore`;
    const conflict = async (code: string) =>
      expect(await check("POST", "/api/sessions/{id}/restore", 409, path)).toMatchObject({ code });
    await check("POST", "/api/sessions/{id}/restore", 404, "/api/sessions/missing/restore");
    await conflict("not_archived");
    s.deps.store.update(session.id, { status: "archived", claudeSessionId: "" });
    await conflict("cannot_restore");
    s.deps.store.update(session.id, { claudeSessionId: "conversation-fixture" });
    const saved = s.stubs.worktree.restoreExisting;
    try {
      for (const code of ["branch_gone", "branch_in_use"] as const) {
        s.stubs.worktree.restoreExisting = () => {
          throw new WorktreeRestoreError(code);
        };
        await conflict(code);
      }
      s.stubs.worktree.restoreExisting = () => {};
      const mock = spyOn(s.deps.service, "restore").mockResolvedValueOnce(null);
      try {
        await conflict("spawn_refused");
      } finally {
        mock.mockRestore();
      }
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const restore = s.deps.service.restore.bind(s.deps.service);
      const pendingMock = spyOn(s.deps.service, "restore").mockImplementationOnce(async (id) => {
        entered();
        await gate;
        return restore(id);
      });
      const pending = request("POST", path);
      try {
        await started;
        await conflict("in_progress");
      } finally {
        release();
        pendingMock.mockRestore();
      }
      const res = await pending;
      expect(res.status).toBe(200);
      expect(await validateResponse("POST", "/api/sessions/{id}/restore", res)).toMatchObject({
        id: session.id,
      });
    } finally {
      s.stubs.worktree.restoreExisting = saved;
    }
  });
  test("usage distinguishes an unavailable source from an available zero snapshot", async () => {
    const session = await createSession();
    const path = `/api/sessions/${session.id}/usage`;
    expect(await check("GET", "/api/sessions/{id}/usage", 200, path)).toEqual(fx.noUsage);
    s.deps.store.update(session.id, { status: "archived" });
    s.deps.store.upsertSessionUsage(fx.usageSnapshot(session));
    expect(await check("GET", "/api/sessions/{id}/usage", 200, path)).toMatchObject({
      available: true,
      source: "snapshot",
      total: 0,
      byModel: null,
    });
    await check("GET", "/api/sessions/{id}/usage", 404, "/api/sessions/missing/usage");
  });
});

test("all queue operations require authentication", async () => {
  const ops = OPERATIONS.filter((op) => op.endsWith(" 401"));
  expect(ops).toHaveLength(13);
  for (const op of ops) {
    const [method, template] = op.split(" ") as [string, string, string];
    const res = await request(method, template.replace("{id}", "missing"), undefined, false);
    expect(res.status).toBe(401);
    await validateResponse(method, template, res);
  }
});

test("six queue events travel over the real websocket, including cleared nullable flags", async () => {
  // Poller/up-next/hold services aren't running in the harness; emit their typed wire payloads.
  const payloads = [
    ["upnext:snapshot", { snapshot: fx.snapshot }],
    [
      "upnext:snapshot",
      {
        snapshot: { ...fx.snapshot, sections: [], fallback: "warm-repos-only", failedRepoCount: 1 },
      },
    ],
    ["session:halt", fx.halted],
    ["session:halt", { id: "fixture", haltReason: null, haltedAt: null }],
    ["session:hold", { id: "fixture", hold: fx.hold }],
    ["session:hold", { id: "fixture", hold: null }],
    ["app:sessions-stranded", { count: 2 }],
    ["app:auto-revived", { revived: 1, failed: 1 }],
  ] as const;
  const frames = await collectEvents(s, token, async () => {
    for (const [name, data] of payloads) s.deps.events.emit(name, data);
  });
  for (const [name, payload] of payloads) {
    expect(frames).toContainEqual({ event: name, data: payload });
    validateEvent(name, payload);
  }
  expect(EVENTS).toHaveLength(6);
  expect(() => validateEvent("upnext:snapshot", { snapshot: null })).toThrow();
});

// Stays LAST: independently police every status/event declared by this stream.
describe("queues coverage gate", () => {
  test("every queues operation and event was exercised", () => {
    const { operations, events } = coverage();
    expect(OPERATIONS.filter((op) => !operations.has(op))).toEqual([]);
    expect(EVENTS.filter((name) => !events.has(name))).toEqual([]);
  });
});
