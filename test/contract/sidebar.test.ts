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
  validateResponse,
  withAuth,
  type ContractServer,
} from "./harness";
import { eventsForStream, operationsForStream } from "./stream-blocks";

/** The two frames this stream declares, driven through the server's own EventHub below. The
 *  coverage gate at the bottom derives its expectation from the contract instead, so a frame
 *  added to the sidebar block without a fixture fails there rather than passing unnoticed. */
const EVENTS = ["held:changed", "session:working-blocked"];
const ROUTES = ["/api/working-blocked", "/api/holds", "/api/blocks", "/api/usage/limits"];

let s: ContractServer;
let token: string;

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
  test("the four snapshot routes answer the declared shapes, and 401 without a credential", async () => {
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

describe("sidebar events", () => {
  test("held:changed and session:working-blocked match the contract", async () => {
    const frames = await collectEvents(s, token, async () => {
      s.deps.events.emit("held:changed", fx.heldChangedEvent);
      s.deps.events.emit("session:working-blocked", fx.workingBlockedEvent);
    });
    const seen = new Set<string>();
    for (const frame of frames) {
      if (!EVENTS.includes(frame.event)) continue;
      validateEvent(frame.event, frame.data);
      seen.add(frame.event);
    }
    expect([...seen].sort()).toEqual([...EVENTS].sort());
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
