import { test, expect, beforeEach } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import {
  SpawnPhaseTracker,
  registerSpawn,
  releaseSpawn,
  resetSpawnRegistry,
} from "../src/spawn-progress";

function makeDeps(): AppDeps {
  return {
    store: {} as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
  };
}

function cancel(spawnId: string): Request {
  return new Request(`http://localhost/api/spawns/${spawnId}/cancel`, { method: "POST" });
}

const SPAWN_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => resetSpawnRegistry());

test("cancels an in-flight spawn and aborts its signal", async () => {
  const tracker = new SpawnPhaseTracker({ spawnId: SPAWN_ID });
  registerSpawn(tracker);

  const res = await makeApp(makeDeps()).fetch(cancel(SPAWN_ID));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ canceled: true });
  expect(tracker.signal.aborted).toBe(true);
});

test("reports canceled:false once the spawn is sealed — the agent is already up", async () => {
  const tracker = new SpawnPhaseTracker({ spawnId: SPAWN_ID });
  registerSpawn(tracker);
  tracker.seal();

  const res = await makeApp(makeDeps()).fetch(cancel(SPAWN_ID));

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ canceled: false });
  expect(tracker.signal.aborted).toBe(false);
});

test("404s for a spawn that is not in flight", async () => {
  const tracker = new SpawnPhaseTracker({ spawnId: SPAWN_ID });
  registerSpawn(tracker);
  releaseSpawn(SPAWN_ID);

  const res = await makeApp(makeDeps()).fetch(cancel(SPAWN_ID));

  expect(res.status).toBe(404);
});

test("400s on a malformed spawn id rather than treating it as a key", async () => {
  const res = await makeApp(makeDeps()).fetch(cancel("nope"));
  expect(res.status).toBe(400);
});

test("only POST …/cancel is routed", async () => {
  const tracker = new SpawnPhaseTracker({ spawnId: SPAWN_ID });
  registerSpawn(tracker);
  const app = makeApp(makeDeps());

  const wrongMethod = await app.fetch(
    new Request(`http://localhost/api/spawns/${SPAWN_ID}/cancel`, { method: "GET" }),
  );
  const wrongSub = await app.fetch(
    new Request(`http://localhost/api/spawns/${SPAWN_ID}/stop`, { method: "POST" }),
  );

  expect(wrongMethod.status).toBe(404);
  expect(wrongSub.status).toBe(404);
  expect(tracker.signal.aborted).toBe(false);
});
