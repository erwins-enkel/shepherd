import { test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { config } from "../src/config";
import type { TelemetryService } from "../src/telemetry";

// All other `put*` settings handlers in src/server.ts are module-private and exercised
// through the real PUT /api/settings dispatch (see test/server-settings.test.ts) rather
// than exported individually. putTelemetryConsent follows the same convention, so this
// test drives it the same way: through makeApp() + app.fetch, not a direct import.

let savedConsent: typeof config.telemetryConsent;

beforeEach(() => {
  savedConsent = config.telemetryConsent;
  config.telemetryConsent = "unset"; // deterministic starting point for the wasGranted transition check
});

afterEach(() => {
  config.telemetryConsent = savedConsent;
});

function harness(): { app: ReturnType<typeof makeApp>; store: SessionStore; events: string[] } {
  const store = new SessionStore(":memory:");
  const events: string[] = [];
  const telemetry = { event: (n: string) => events.push(n) } as unknown as TelemetryService;
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as any,
    usageLimits: { limits: () => ({}) } as any,
    telemetry,
  };
  return { app: makeApp(deps), store, events };
}

const put = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.fetch(
    new Request("http://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("GET /api/settings includes telemetryConsent and telemetryAvailable", async () => {
  config.telemetryConsent = "granted";
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/settings"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.telemetryConsent).toBe("granted");
  expect(typeof body.telemetryAvailable).toBe("boolean");
});

test("PUT /api/settings rejects invalid/'unset' telemetryConsent values with 400", async () => {
  const { app } = harness();
  for (const bad of ["maybe", "unset", 42, null, true, undefined]) {
    const res = await put(app, { telemetryConsent: bad });
    expect(res.status).toBe(400);
  }
  expect(config.telemetryConsent).toBe("unset"); // unchanged on failure
});

test("PUT /api/settings sets telemetryConsent to granted, persists, and emits app_launched once on unset->granted", async () => {
  const { app, store, events } = harness();
  const res = await put(app, { telemetryConsent: "granted" });
  expect(res.status).toBe(200);
  expect((await res.json()).telemetryConsent).toBe("granted");
  expect(config.telemetryConsent).toBe("granted"); // live
  expect(store.getSetting("telemetryConsent")).toBe("granted"); // persisted
  expect(events).toEqual(["app_launched"]); // unset -> granted fires once
  const got = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(got.telemetryConsent).toBe("granted"); // reflected by GET
});

test("PUT /api/settings sets telemetryConsent to denied, persists, and emits nothing", async () => {
  const { app, store, events } = harness();
  const res = await put(app, { telemetryConsent: "denied" });
  expect(res.status).toBe(200);
  expect((await res.json()).telemetryConsent).toBe("denied");
  expect(config.telemetryConsent).toBe("denied");
  expect(store.getSetting("telemetryConsent")).toBe("denied");
  expect(events).toEqual([]);
});

test("PUT /api/settings does not re-emit app_launched on a granted->granted no-op transition", async () => {
  const { app, events } = harness();
  await put(app, { telemetryConsent: "granted" });
  expect(events).toEqual(["app_launched"]);
  const res = await put(app, { telemetryConsent: "granted" });
  expect(res.status).toBe(200);
  expect(events).toEqual(["app_launched"]); // no second emit
});

test("PUT /api/settings emits app_launched again on denied->granted", async () => {
  const { app, events } = harness();
  await put(app, { telemetryConsent: "denied" });
  expect(events).toEqual([]);
  const res = await put(app, { telemetryConsent: "granted" });
  expect(res.status).toBe(200);
  expect(events).toEqual(["app_launched"]);
});
