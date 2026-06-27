// Runtime smoke test for the canonical teaching example, examples/plugins/spawn-labeler/.
// The throwaway echo fixture has loader tests (plugins.test.ts); this gives the
// recommended copy-me reference the same loader-level coverage — not just typecheck — so
// it can't silently rot. Additive: points a registry at examples/plugins/ and exercises
// the real load → onSpawn patch → routes path.
import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import type { SpawnDescriptor } from "../src/plugins/types";

const EXAMPLES_DIR = resolve(import.meta.dir, "../examples/plugins");

const DESC: SpawnDescriptor = {
  sessionId: "sess-1",
  repoRoot: "/home/me/myrepo",
  model: null,
  agentProvider: "claude",
  argv: ["claude", "--session-id", "x"],
  env: {},
  isolated: true,
};

test("spawn-labeler example loads, patches the spawn env, and serves its routes", async () => {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const registry = new PluginRegistry({ pluginsDir: EXAMPLES_DIR, store, events });
  await registry.loadAll();

  // loads with ok health
  const info = registry.list().find((p) => p.id === "spawn-labeler");
  expect(info).toBeDefined();
  expect(info!.health).toBe("ok");

  // onSpawn returns a real SpawnPatch built from descriptor fields (basename#count)
  expect(await registry.runSpawnHooks(DESC)).toEqual({ env: { SHEPHERD_SPAWN_LABEL: "myrepo#1" } });
  // a second spawn in the same repo increments the per-repo count
  expect(await registry.runSpawnHooks(DESC)).toEqual({ env: { SHEPHERD_SPAWN_LABEL: "myrepo#2" } });

  // GET stats reads state
  const statsRes = await registry.handleRoute(
    "GET",
    "spawn-labeler",
    "stats",
    new Request("http://x/"),
  );
  expect(statsRes?.status).toBe(200);
  const stats = (await statsRes!.json()) as { totalSpawns: number; repos: Record<string, number> };
  expect(stats.totalSpawns).toBe(2);
  expect(stats.repos).toEqual({ myrepo: 2 });

  // POST reset writes state
  const resetRes = await registry.handleRoute(
    "POST",
    "spawn-labeler",
    "reset",
    new Request("http://x/", { method: "POST" }),
  );
  expect(resetRes?.status).toBe(200);
  expect(await resetRes!.json()).toEqual({ ok: true, cleared: true });

  const after = await registry.handleRoute(
    "GET",
    "spawn-labeler",
    "stats",
    new Request("http://x/"),
  );
  const afterStats = (await after!.json()) as {
    totalSpawns: number;
    repos: Record<string, number>;
  };
  expect(afterStats.totalSpawns).toBe(0);
  expect(afterStats.repos).toEqual({});
});
