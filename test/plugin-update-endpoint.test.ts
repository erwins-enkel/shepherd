import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { PluginUpdatesStatus } from "../src/types";

function makeDeps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    store: {} as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    ...over,
  };
}

const status: PluginUpdatesStatus = {
  plugins: [
    {
      id: "voice",
      name: "Voice",
      currentVersion: "1.2.0",
      latestVersion: "1.3.0",
      source: "repository",
      state: "update-available",
    },
  ],
  updateAvailable: true,
  checkedAt: 5,
};

test("GET /api/plugin-update returns the current status", async () => {
  const app = makeApp(makeDeps({ pluginUpdates: { current: () => status } }));
  const res = await app.fetch(new Request("http://localhost/api/plugin-update"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(status);
});

test("GET /api/plugin-update falls back to an empty snapshot when unwired", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(new Request("http://localhost/api/plugin-update"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.plugins).toEqual([]);
  expect(body.updateAvailable).toBe(false);
});

test("POST /api/plugin-update is not a valid method (informational, no apply)", async () => {
  const app = makeApp(makeDeps({ pluginUpdates: { current: () => status } }));
  const res = await app.fetch(
    new Request("http://localhost/api/plugin-update", { method: "POST" }),
  );
  // No POST handler for plugin updates — the route falls through to a 404.
  expect(res.status).toBe(404);
});
