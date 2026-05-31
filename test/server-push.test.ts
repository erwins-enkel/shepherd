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
