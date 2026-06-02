import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { PushService } from "../src/push";

function harness() {
  const store = new SessionStore(":memory:");
  const push = new PushService(
    store,
    async () => ({}),
    () => ({
      publicKey: "TESTPUB",
      privateKey: "TESTPRIV",
    }),
  );
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
    push,
  };
  return { app: makeApp(deps), store };
}

const post = (app: ReturnType<typeof makeApp>, path: string, body: unknown) =>
  app.fetch(
    new Request("http://x" + path, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(body),
    }),
  );

test("GET /api/push/vapid returns the public key", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/push/vapid"));
  expect(res.status).toBe(200);
  expect((await res.json()).publicKey).toBe("TESTPUB");
});

test("POST /api/push/subscribe stores the subscription", async () => {
  const { app, store } = harness();
  const res = await post(app, "/api/push/subscribe", {
    endpoint: "https://push/e1",
    keys: { p256dh: "p", auth: "a" },
  });
  expect(res.status).toBe(200);
  expect(store.listPushSubs().map((r) => r.endpoint)).toEqual(["https://push/e1"]);
});

test("POST /api/push/subscribe rejects a malformed body", async () => {
  const { app } = harness();
  const res = await post(app, "/api/push/subscribe", { endpoint: "x" });
  expect(res.status).toBe(400);
});

test("POST /api/push/unsubscribe removes the subscription", async () => {
  const { app, store } = harness();
  store.putPushSub({ endpoint: "e1", keys: { p256dh: "p", auth: "a" } }, "");
  const res = await post(app, "/api/push/unsubscribe", { endpoint: "e1" });
  expect(res.status).toBe(200);
  expect(store.listPushSubs().length).toBe(0);
});

test("GET /api/push/prefs defaults to all-on for an unknown endpoint", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/push/prefs?endpoint=ghost"));
  expect(res.status).toBe(200);
  expect((await res.json()).categories).toEqual({ agent: true, reviews: true, ci: true });
});

test("GET /api/push/prefs requires the endpoint query param", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/push/prefs"));
  expect(res.status).toBe(400);
});

test("POST /api/push/prefs persists the category selection", async () => {
  const { app, store } = harness();
  store.putPushSub({ endpoint: "e1", keys: { p256dh: "p", auth: "a" } }, "");
  const res = await post(app, "/api/push/prefs", {
    endpoint: "e1",
    categories: { agent: false, reviews: true, ci: false },
  });
  expect(res.status).toBe(200);
  expect(store.getPushPrefs("e1")).toEqual({ agent: false, reviews: true, ci: false });
  const read = await app.fetch(new Request("http://x/api/push/prefs?endpoint=e1"));
  expect((await read.json()).categories).toEqual({ agent: false, reviews: true, ci: false });
});

test("POST /api/push/prefs rejects a malformed body", async () => {
  const { app } = harness();
  const res = await post(app, "/api/push/prefs", { endpoint: "e1", categories: { agent: true } });
  expect(res.status).toBe(400);
});

test("POST /api/push/prefs 404s for an endpoint with no subscription", async () => {
  const { app } = harness();
  const res = await post(app, "/api/push/prefs", {
    endpoint: "ghost",
    categories: { agent: true, reviews: true, ci: true },
  });
  expect(res.status).toBe(404);
});
