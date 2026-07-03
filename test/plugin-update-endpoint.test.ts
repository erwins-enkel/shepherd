import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { PluginRegistry } from "../src/plugins/loader";
import type { PluginInfo } from "../src/plugins/types";
import type { PluginApplyResult } from "../src/plugin-update";
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

/** A pluginUpdates dep whose `apply` returns a fixed result and whose `current` is
 *  stubbed. Records the last applied id so tests can assert the wiring. */
function fakeUpdates(applyResult: PluginApplyResult, applied: string[] = []) {
  return {
    current: () => status,
    apply: async (id: string) => {
      applied.push(id);
      return applyResult;
    },
  };
}

const pluginInfo = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  id: "voice",
  name: "Voice",
  version: "1.3.0",
  health: "ok",
  lastError: null,
  status: null,
  ui: null,
  gearItem: null,
  ...over,
});

/** A registry stub: `loadedIds` decides `list()`, and `activateOne` returns `activate`. */
function fakeRegistry(
  loadedIds: string[],
  activate: { ok: true; plugin: PluginInfo } | { ok: false; error: string } = {
    ok: true,
    plugin: pluginInfo(),
  },
) {
  return {
    list: () => loadedIds.map((id) => pluginInfo({ id })),
    activateOne: async () => activate,
  } as unknown as PluginRegistry;
}

test("GET /api/plugin-update returns the current status", async () => {
  const app = makeApp(
    makeDeps({ pluginUpdates: fakeUpdates({ ok: true, folder: "v", updatedTo: "1.3.0" }) }),
  );
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

test("POST /api/plugin-update (no /apply) falls through to 404", async () => {
  const app = makeApp(
    makeDeps({ pluginUpdates: fakeUpdates({ ok: true, folder: "v", updatedTo: "1.3.0" }) }),
  );
  const res = await app.fetch(
    new Request("http://localhost/api/plugin-update", { method: "POST" }),
  );
  expect(res.status).toBe(404);
});

function applyReq(body: unknown): Request {
  return new Request("http://localhost/api/plugin-update/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/plugin-update/apply on a NOT-loaded plugin activates it live", async () => {
  const applied: string[] = [];
  const app = makeApp(
    makeDeps({
      pluginUpdates: fakeUpdates({ ok: true, folder: "voice", updatedTo: "1.3.0" }, applied),
      pluginRegistry: fakeRegistry([], { ok: true, plugin: pluginInfo() }),
    }),
  );
  const res = await app.fetch(applyReq({ id: "voice" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(applied).toEqual(["voice"]);
  expect(body.ok).toBe(true);
  expect(body.restartRequired).toBe(false);
  expect(body.updatedTo).toBe("1.3.0");
  expect(body.plugin?.id).toBe("voice");
  expect(body.status).toEqual(status);
});

test("POST /api/plugin-update/apply on an ALREADY-loaded plugin signals a restart", async () => {
  const app = makeApp(
    makeDeps({
      pluginUpdates: fakeUpdates({ ok: true, folder: "voice", updatedTo: "1.3.0" }),
      pluginRegistry: fakeRegistry(["voice"]),
    }),
  );
  const res = await app.fetch(applyReq({ id: "voice" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.restartRequired).toBe(true);
  expect(body.plugin).toBeUndefined();
});

test("POST /api/plugin-update/apply signals a restart when live activation fails", async () => {
  const app = makeApp(
    makeDeps({
      pluginUpdates: fakeUpdates({ ok: true, folder: "voice", updatedTo: "1.3.0" }),
      pluginRegistry: fakeRegistry([], { ok: false, error: "activation_failed" }),
    }),
  );
  const res = await app.fetch(applyReq({ id: "voice" }));
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.restartRequired).toBe(true);
});

test("POST /api/plugin-update/apply maps not_installed to 404", async () => {
  const app = makeApp(
    makeDeps({ pluginUpdates: fakeUpdates({ ok: false, error: "not_installed" }) }),
  );
  const res = await app.fetch(applyReq({ id: "ghost" }));
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe("not_installed");
});

test("POST /api/plugin-update/apply maps already_up_to_date to 409", async () => {
  const app = makeApp(
    makeDeps({ pluginUpdates: fakeUpdates({ ok: false, error: "already_up_to_date" }) }),
  );
  const res = await app.fetch(applyReq({ id: "voice" }));
  expect(res.status).toBe(409);
});

test("POST /api/plugin-update/apply carries a detail for a failed update", async () => {
  const app = makeApp(
    makeDeps({
      pluginUpdates: fakeUpdates({
        ok: false,
        error: "update_failed",
        detail: "not a fast-forward",
      }),
    }),
  );
  const res = await app.fetch(applyReq({ id: "voice" }));
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe("update_failed");
  expect(body.detail).toBe("not a fast-forward");
});

test("POST /api/plugin-update/apply requires an id", async () => {
  const app = makeApp(
    makeDeps({ pluginUpdates: fakeUpdates({ ok: true, folder: "voice", updatedTo: "1.3.0" }) }),
  );
  const res = await app.fetch(applyReq({}));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("id_required");
});

test("POST /api/plugin-update/apply is 503 when the service is unwired", async () => {
  const app = makeApp(makeDeps());
  const res = await app.fetch(applyReq({ id: "voice" }));
  expect(res.status).toBe(503);
});
