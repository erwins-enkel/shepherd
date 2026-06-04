import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";

function harness(
  broadcast?: (ids: string[], text: string) => { sent: number; total: number },
  haltAll?: () => { halted: number },
) {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: { broadcast, haltAll } as any,
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

test("GET /api/steers seeds + returns the defaults", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/steers"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.map((s: { label: string }) => s.label)).toEqual([
    "commit & push",
    "rebase",
    "run tests",
  ]);
});

test("PUT /api/steers validates, persists, and returns the normalized list", async () => {
  const { app, store } = harness();
  const res = await app.fetch(jsonReq("/api/steers", "PUT", [{ label: " a ", text: " b " }]));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body[0]).toMatchObject({ label: "a", text: "b" });
  expect(body[0].id).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(store.getSetting("steers")!)[0].label).toBe("a");
});

test("PUT /api/steers rejects a bad payload with 400", async () => {
  const { app } = harness();
  const res = await app.fetch(jsonReq("/api/steers", "PUT", [{ label: "" }]));
  expect(res.status).toBe(400);
});

test("PUT /api/steers requires application/json", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/steers", { method: "PUT", body: "[]" }));
  expect(res.status).toBe(415);
});

test("POST /api/broadcast returns the service counts", async () => {
  const calls: { ids: string[]; text: string }[] = [];
  const { app } = harness((ids, text) => {
    calls.push({ ids, text });
    return { sent: ids.length, total: ids.length };
  });
  const res = await app.fetch(jsonReq("/api/broadcast", "POST", { text: "go", ids: ["a", "b"] }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sent: 2, total: 2 });
  expect(calls).toEqual([{ ids: ["a", "b"], text: "go" }]);
});

test("POST /api/broadcast rejects a bad body with 400", async () => {
  const { app } = harness(() => ({ sent: 0, total: 0 }));
  const res = await app.fetch(jsonReq("/api/broadcast", "POST", { text: "", ids: [] }));
  expect(res.status).toBe(400);
});

test("POST /api/halt fires the fleet-wide stop and returns the halted count", async () => {
  let calls = 0;
  const { app } = harness(undefined, () => {
    calls++;
    return { halted: 3 };
  });
  const res = await app.fetch(new Request("http://x/api/halt", { method: "POST" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ halted: 3 });
  expect(calls).toBe(1);
});

test("GET /api/halt is not allowed (POST-only)", async () => {
  const { app } = harness(undefined, () => ({ halted: 0 }));
  const res = await app.fetch(new Request("http://x/api/halt"));
  expect(res.status).toBe(404);
});
