import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";

function harness(
  retryHalted?: (
    ids: string[],
    text: string,
  ) => Promise<{ resumed: number; steered: number; total: number }>,
) {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: { retryHalted } as any,
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

const jsonReq = (path: string, method: string, body: unknown) =>
  new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("POST /api/retry returns resumed+steered+total from service", async () => {
  const calls: { ids: string[]; text: string }[] = [];
  const { app } = harness(async (ids, text) => {
    calls.push({ ids, text });
    return { resumed: 1, steered: 1, total: 2 };
  });
  const res = await app.fetch(
    jsonReq("/api/retry", "POST", { text: "please continue", ids: ["a", "b"] }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ resumed: 1, steered: 1, total: 2 });
  expect(calls).toEqual([{ ids: ["a", "b"], text: "please continue" }]);
});

test("POST /api/retry rejects empty text with 400", async () => {
  const { app } = harness(async () => ({ resumed: 0, steered: 0, total: 0 }));
  const res = await app.fetch(jsonReq("/api/retry", "POST", { text: "", ids: ["a"] }));
  expect(res.status).toBe(400);
});

test("POST /api/retry rejects missing ids with 400", async () => {
  const { app } = harness(async () => ({ resumed: 0, steered: 0, total: 0 }));
  const res = await app.fetch(jsonReq("/api/retry", "POST", { text: "go" }));
  expect(res.status).toBe(400);
});

test("POST /api/retry rejects non-JSON body with 400", async () => {
  const { app } = harness(async () => ({ resumed: 0, steered: 0, total: 0 }));
  const res = await app.fetch(
    new Request("http://x/api/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
  );
  expect(res.status).toBe(400);
});

test("POST /api/retry requires content-type application/json", async () => {
  const { app } = harness(async () => ({ resumed: 0, steered: 0, total: 0 }));
  const res = await app.fetch(
    new Request("http://x/api/retry", {
      method: "POST",
      body: JSON.stringify({ text: "go", ids: ["a"] }),
    }),
  );
  expect(res.status).toBe(415);
});
