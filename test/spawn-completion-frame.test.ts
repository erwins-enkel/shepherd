// The create route's final `spawn:progress` frame carries the new session id, so the New Task
// dialog can complete from the WS stream when the HTTP answer is slow to arrive.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { SandboxAutoRefused } from "../src/sandbox";
import { PluginSpawnAborted } from "../src/plugins/types";
import { config } from "../src/config";
import type { SpawnPhaseTracker } from "../src/spawn-progress";

const SPAWN_ID = "11111111-2222-3333-4444-555555555555";

let tmpRoot: string;
let validRepo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-spawn-frame-test-"));
  validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeDeps(create: (input: unknown, tracker?: SpawnPhaseTracker) => Promise<unknown>) {
  const events = new EventHub();
  const emitted: { event: string; data: unknown }[] = [];
  const emit = events.emit.bind(events);
  events.emit = ((event: string, data: unknown) => {
    emitted.push({ event, data });
    return emit(event as never, data as never);
  }) as typeof events.emit;
  const deps = {
    store: new SessionStore(":memory:"),
    events,
    service: { create },
    usageLimits: {
      limits: () => ({
        session5h: null,
        week: null,
        credits: null,
        stale: false,
        calibratedAt: null,
        subscriptionOnly: false,
      }),
      projections: () => [],
    },
    distiller: { distillNow: () => {} },
  } as unknown as AppDeps;
  return { deps, emitted };
}

function post(app: ReturnType<typeof makeApp>) {
  return app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Shepherd-Spawn-Id": SPAWN_ID },
      body: JSON.stringify({ repoPath: validRepo, baseBranch: "main", prompt: "go" }),
    }),
  );
}

test("a successful create announces the session on spawn:progress AFTER session:new", async () => {
  const { deps, emitted } = makeDeps(async (_input, tracker) => {
    await tracker!.phase("agent", () => {});
    return { id: "sess-1" };
  });

  const res = await post(makeApp(deps));

  expect(res.status).toBe(201);
  const relevant = emitted.filter((e) => e.event === "session:new" || e.event === "spawn:progress");
  const newIdx = relevant.findIndex((e) => e.event === "session:new");
  const doneIdx = relevant.findIndex(
    (e) => e.event === "spawn:progress" && (e.data as { sessionId?: string }).sessionId,
  );
  expect(newIdx).toBeGreaterThanOrEqual(0);
  expect(doneIdx).toBeGreaterThan(newIdx);
  expect(relevant[doneIdx]!.data).toMatchObject({ spawnId: SPAWN_ID, sessionId: "sess-1" });
});

test("a plugin-held create emits no completion frame", async () => {
  const { deps, emitted } = makeDeps(async () => {
    throw new SandboxAutoRefused("no accounts", new PluginSpawnAborted("no accounts", "swap"));
  });

  const res = await post(makeApp(deps));

  expect(res.status).toBe(200);
  expect(
    emitted.some(
      (e) => e.event === "spawn:progress" && (e.data as { sessionId?: string }).sessionId,
    ),
  ).toBe(false);
});
