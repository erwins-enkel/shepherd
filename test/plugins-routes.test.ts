// Plugin HTTP routes (issue #1124): GET /api/plugins listing + /api/plugins/<id>/<sub>
// dispatch, end-to-end through makeApp. Verifies the zero-plugin no-op (no registry →
// empty list + 404 for sub-routes) and example-plugin dispatch.
import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { SessionService } from "../src/service";
import { PluginRegistry } from "../src/plugins/loader";

function baseDeps(pluginRegistry?: PluginRegistry): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => {},
    } as never,
    herdr: { start: () => ({ terminalId: "t" }) as never, list: () => [] } as never,
    events,
  });
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  };
  return { store, service, events, usageLimits, pluginRegistry } as AppDeps;
}

async function loadedRegistry(): Promise<PluginRegistry> {
  const r = new PluginRegistry({
    pluginsDir: resolve(import.meta.dir, "fixtures"),
    store: new SessionStore(":memory:"),
    events: new EventHub(),
  });
  await r.loadAll();
  return r;
}

test("GET /api/plugins lists loaded plugins", async () => {
  const app = makeApp(baseDeps(await loadedRegistry()));
  const res = await app.fetch(new Request("http://x/api/plugins"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { plugins: Array<{ id: string; health: string }> };
  expect(body.plugins.find((p) => p.id === "example-plugin")?.health).toBe("ok");
});

test("GET /api/plugins is an empty list when no registry is wired (zero-plugin no-op)", async () => {
  const app = makeApp(baseDeps(undefined));
  const res = await app.fetch(new Request("http://x/api/plugins"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ plugins: [] });
});

test("a plugin-registered route serves under /api/plugins/<id>/<sub>", async () => {
  const app = makeApp(baseDeps(await loadedRegistry()));
  const res = await app.fetch(new Request("http://x/api/plugins/example-plugin/status"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { spawnCount: number };
  expect(typeof body.spawnCount).toBe("number");
});

test("unknown plugin / sub-route → 404", async () => {
  const app = makeApp(baseDeps(await loadedRegistry()));
  expect((await app.fetch(new Request("http://x/api/plugins/nope/status"))).status).toBe(404);
  expect((await app.fetch(new Request("http://x/api/plugins/example-plugin/nope"))).status).toBe(
    404,
  );
  // /api/plugins/<id> with no sub-route → 404
  expect((await app.fetch(new Request("http://x/api/plugins/example-plugin"))).status).toBe(404);
});

test("plugin sub-route 404s when no registry is wired", async () => {
  const app = makeApp(baseDeps(undefined));
  expect((await app.fetch(new Request("http://x/api/plugins/x/y"))).status).toBe(404);
});
