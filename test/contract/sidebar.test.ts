import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fx from "./sidebar-fixtures";
import {
  bearer,
  collectEvents,
  coverage,
  login,
  mintToken,
  restoreAuth,
  startContractServer,
  validateEvent,
  validateRequest,
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { DISABLED_HEAVY_SLOT } from "../../src/heavy-slot-snapshot";
import { eventsForStream, operationsForStream } from "./stream-blocks";

/** The four frames this stream declares: three driven through the server's own EventHub below,
 *  project-icons:update by the real PUT route. The coverage gate at the bottom derives its
 *  expectation from the contract instead, so a frame added to the sidebar block without a fixture
 *  fails there rather than passing unnoticed. */
const EVENTS = [
  "held:changed",
  "session:working-blocked",
  "session:background-busy",
  "project-icons:update",
];
const ROUTES = [
  "/api/working-blocked",
  "/api/background-busy",
  "/api/holds",
  "/api/blocks",
  "/api/usage/limits",
  "/api/project-icons",
];

let s: ContractServer;
let token: string;

const putIcon = (body: unknown, auth = true) =>
  fetch(`${s.baseUrl}/api/project-icons`, {
    method: "PUT",
    headers: { ...(auth ? bearer(token) : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await withAuth();
  s = startContractServer();
  ({ token } = await mintToken(s, await login(s), "sidebar contract test"));
});
afterAll(() => {
  try {
    s?.stop();
  } finally {
    restoreAuth();
  }
});

describe("sidebar reads", () => {
  test("the six snapshot routes answer the declared shapes, and 401 without a credential", async () => {
    for (const path of ROUTES) {
      const ok = await fetch(`${s.baseUrl}${path}`, { headers: bearer(token) });
      expect(ok.status, path).toBe(200);
      await validateResponse("GET", path, ok);
      const anon = await fetch(`${s.baseUrl}${path}`);
      expect(anon.status, path).toBe(401);
      await validateResponse("GET", path, anon);
    }
  });

  test("an unwired snapshot route is an empty map, not null", async () => {
    const res = await fetch(`${s.baseUrl}/api/holds`, { headers: bearer(token) });
    expect(await validateResponse("GET", "/api/holds", res)).toEqual({});
  });

  test("GET /api/usage/limits wraps the limits", async () => {
    const res = await fetch(`${s.baseUrl}/api/usage/limits`, { headers: bearer(token) });
    const body = (await validateResponse("GET", "/api/usage/limits", res)) as {
      limits: { subscriptionOnly: boolean };
      projections: unknown[];
    };
    expect(typeof body.limits.subscriptionOnly).toBe("boolean");
    expect(Array.isArray(body.projections)).toBe(true);
  });
});

describe("heavy slot", () => {
  const post = (body: unknown, auth = true) =>
    fetch(`${s.baseUrl}/api/heavy-slot/release`, {
      method: "POST",
      headers: { ...(auth ? bearer(token) : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("GET /api/heavy-slot answers the switched-off snapshot, and 401 without a credential", async () => {
    const ok = await fetch(`${s.baseUrl}/api/heavy-slot`, { headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(await validateResponse("GET", "/api/heavy-slot", ok)).toMatchObject({ enabled: false });
    const anon = await fetch(`${s.baseUrl}/api/heavy-slot`);
    expect(anon.status).toBe(401);
    await validateResponse("GET", "/api/heavy-slot", anon);
  });

  test("POST /api/heavy-slot/release answers 200, 400, 404 and 401", async () => {
    s.deps.heavySlot = { snapshot: () => DISABLED_HEAVY_SLOT, release: (id) => id === "holder" };
    try {
      const path = "/api/heavy-slot/release";
      validateRequest("POST", path, { sessionId: "holder" });
      const ok = await post({ sessionId: "holder" });
      expect(ok.status).toBe(200);
      expect(await validateResponse("POST", path, ok)).toEqual({ released: true });
      const bad = await post({ sessionId: 7 });
      expect(bad.status).toBe(400);
      await validateResponse("POST", path, bad);
      const none = await post({ sessionId: "nobody" });
      expect(none.status).toBe(404);
      await validateResponse("POST", path, none);
      const anon = await post({ sessionId: "holder" }, false);
      expect(anon.status).toBe(401);
      await validateResponse("POST", path, anon);
    } finally {
      delete s.deps.heavySlot;
    }
  });
});

describe("heavy slot operator route (#3550)", () => {
  const PATH = "/api/heavy-slot/operator";
  const post = (body: unknown, auth = true) =>
    fetch(`${s.baseUrl}${PATH}`, {
      method: "POST",
      headers: { ...(auth ? bearer(token) : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("POST answers 200, 400, 503 and 401", async () => {
    const unavailable = await post({ op: "acquire", command: "x" });
    expect(unavailable.status).toBe(503);
    await validateResponse("POST", PATH, unavailable);
    s.deps.heavySlot = {
      snapshot: () => DISABLED_HEAVY_SLOT,
      release: () => false,
      acquireOperator: async () => ({ decision: "run", jobId: "j1" }),
      started: async () => true,
      finish: async () => true,
    } as unknown as NonNullable<typeof s.deps.heavySlot>;
    try {
      validateRequest("POST", PATH, { op: "acquire", command: "cargo clippy", cwd: "/repo" });
      const ok = await post({ op: "acquire", command: "cargo clippy", cwd: "/repo" });
      expect(ok.status).toBe(200);
      expect(await validateResponse("POST", PATH, ok)).toEqual({ decision: "run", jobId: "j1" });
      const bad = await post({ op: "nope" });
      expect(bad.status).toBe(400);
      await validateResponse("POST", PATH, bad);
      const anon = await post({ op: "acquire", command: "x" }, false);
      expect(anon.status).toBe(401);
      await validateResponse("POST", PATH, anon);
    } finally {
      delete s.deps.heavySlot;
    }
  });
});

describe("project icons", () => {
  const PATH = "/api/project-icons";

  test("PUT sets an emoji and answers the whole map", async () => {
    validateRequest("PUT", PATH, fx.iconSet);
    const res = await putIcon(fx.iconSet);
    expect(res.status).toBe(200);
    expect(await validateResponse("PUT", PATH, res)).toMatchObject({
      [fx.iconSet.path]: fx.iconSet.emoji,
    });
  });

  test("PUT with an empty emoji removes the entry", async () => {
    expect((await putIcon(fx.iconSet)).status).toBe(200);
    validateRequest("PUT", PATH, fx.iconClear);
    const res = await putIcon(fx.iconClear);
    expect(res.status).toBe(200);
    expect(Object.keys((await validateResponse("PUT", PATH, res)) as object)).not.toContain(
      fx.iconClear.path,
    );
    const get = await fetch(`${s.baseUrl}${PATH}`, { headers: bearer(token) });
    expect(Object.keys((await validateResponse("GET", PATH, get)) as object)).not.toContain(
      fx.iconClear.path,
    );
  });

  test("an emoji the schema admits but the server's 8-code-point rule refuses is 400", async () => {
    validateRequest("PUT", PATH, fx.iconInvalid);
    const res = await putIcon(fx.iconInvalid);
    expect(res.status).toBe(400);
    await validateResponse("PUT", PATH, res);
  });

  test("PUT without a credential is 401", async () => {
    const res = await putIcon(fx.iconSet, false);
    expect(res.status).toBe(401);
    await validateResponse("PUT", PATH, res);
  });
});

describe("sidebar events", () => {
  test("held:changed, session:working-blocked, session:background-busy and project-icons:update match the contract", async () => {
    const frames = await collectEvents(s, token, async () => {
      s.deps.events.emit("held:changed", fx.heldChangedEvent);
      s.deps.events.emit("session:working-blocked", fx.workingBlockedEvent);
      s.deps.events.emit("session:background-busy", fx.backgroundBusyEvent);
      // No fixture: the route emits this frame itself.
      expect((await putIcon(fx.iconSet)).status).toBe(200);
    });
    const seen = new Set<string>();
    for (const frame of frames) {
      if (!EVENTS.includes(frame.event)) continue;
      validateEvent(frame.event, frame.data);
      seen.add(frame.event);
    }
    expect([...seen].sort()).toEqual([...EVENTS].sort());
    expect(frames.find((f) => f.event === "project-icons:update")?.data).toMatchObject({
      [fx.iconSet.path]: fx.iconSet.emoji,
    });
    expect((await putIcon(fx.iconClear)).status).toBe(200);
  });

  test("the hold and block fixtures are the shapes the schemas describe", () => {
    expect(fx.hold.code).toBe("quota-rework");
    expect(fx.hold.params?.round).toBe(2);
    expect(fx.block.shape).toBe("quota");
    expect(fx.block.quotaKind).toBe("rework");
  });
});

test("Codex reset operator routes validate their contract and require authentication", async () => {
  const status = {
    autoEnabled: false,
    state: "verifying",
    checkedAt: 1,
    availableCount: 3,
    nextExpiryAt: 2,
    reason: "manual",
    lastOutcome: "reset",
    waitingCount: 1,
  };
  s.deps.codexReset = {
    redeemManual: async () => {},
    snapshot: () => ({ measurement: null, resetStatus: status }),
  } as any;
  for (const [path, method, body] of [
    ["/api/usage/codex/reset", "POST", { requestId: crypto.randomUUID() }],
    ["/api/usage/codex/automation", "PUT", { enabled: false }],
  ] as const) {
    const res = await fetch(s.baseUrl + path, {
      method,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(method === "POST" ? 202 : 200);
    await validateResponse(method, path, res);
    const anon = await fetch(s.baseUrl + path, { method, body: JSON.stringify(body) });
    expect(anon.status).toBe(401);
    await validateResponse(method, path, anon);
  }
});

test("Codex reset routes also cover settled, invalid and unavailable responses", async () => {
  const request = (path: string, method: string, body: unknown) =>
    fetch(s.baseUrl + path, {
      method,
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const [path, method] of [
    ["/api/usage/codex/reset", "POST"],
    ["/api/usage/codex/automation", "PUT"],
  ] as const) {
    const bad = await request(path, method, {});
    expect(bad.status).toBe(400);
    await validateResponse(method, path, bad);
  }
  s.deps.codexReset = {
    redeemManual: async () => {},
    snapshot: () => ({
      measurement: null,
      resetStatus: {
        autoEnabled: false,
        state: "ready",
        checkedAt: 1,
        availableCount: 2,
        nextExpiryAt: 2,
        reason: "manual",
        lastOutcome: "reset",
        waitingCount: 0,
      },
    }),
  } as any;
  const settled = await request("/api/usage/codex/reset", "POST", {
    requestId: crypto.randomUUID(),
  });
  expect(settled.status).toBe(200);
  await validateResponse("POST", "/api/usage/codex/reset", settled);
  delete s.deps.codexReset;
  for (const [path, method] of [
    ["/api/usage/codex/reset", "POST"],
    ["/api/usage/codex/automation", "PUT"],
  ] as const) {
    const missing = await request(path, method, {});
    expect(missing.status).toBe(503);
    await validateResponse(method, path, missing);
  }
});

// Stays LAST in this file. This block's own coverage gate, so the stream proves its surface
// whichever file Bun runs first; the gate in openapi.test.ts covers everything outside the
// markers.
describe("sidebar coverage gate", () => {
  test("every sidebar operation and event was exercised", () => {
    const { operations, events } = coverage();
    expect(operationsForStream("sidebar").filter((o) => !operations.has(o))).toEqual([]);
    expect(eventsForStream("sidebar").filter((e) => !events.has(e))).toEqual([]);
  });
});
