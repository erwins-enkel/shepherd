// server-hold-capacity.test.ts — TDD tests for plugin-refused New-Task capacity hold
// Step 5 of feat/hold-on-plugin-capacity-refuse
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";
import { SandboxAutoRefused } from "../src/sandbox";
import { PluginSpawnAborted } from "../src/plugins/types";
import { config } from "../src/config";

let tmpRoot: string;
let validRepo: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-cap-test-"));
  validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
});

afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function postSessions(app: ReturnType<typeof makeApp>, body: unknown) {
  return app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function makeBody() {
  return { repoPath: validRepo, baseBranch: "main", prompt: "go" };
}

function makeDeps(): AppDeps {
  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const usageLimits = {
    limits: () => ({
      session5h: null,
      week: null,
      credits: null,
      stale: false,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  };
  const distiller = { distillNow: () => {} };
  return { store, events, usageLimits, distiller } as unknown as AppDeps;
}

// ── New-Task create: plugin-refused → 200 { held:true } + capacity row ────────

test("POST /api/sessions: SandboxAutoRefused with PluginSpawnAborted cause → 200 held:true", async () => {
  const deps = makeDeps();
  const pluginErr = new PluginSpawnAborted("no accounts", "claude-swap");
  deps.service = {
    create: async () => {
      throw new SandboxAutoRefused("plugin claude-swap aborted spawn: no accounts", pluginErr);
    },
  } as unknown as AppDeps["service"];

  const res = await postSessions(makeApp(deps), makeBody());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.held).toBe(true);
  expect(typeof body.id).toBe("string");
  expect(typeof body.count).toBe("number");
});

test("POST /api/sessions: capacity hold inserts row with reason='capacity'", async () => {
  const deps = makeDeps();
  const pluginErr = new PluginSpawnAborted("no accounts", "claude-swap");
  deps.service = {
    create: async () => {
      throw new SandboxAutoRefused("plugin aborted: no accounts", pluginErr);
    },
  } as unknown as AppDeps["service"];

  await postSessions(makeApp(deps), makeBody());

  const held = deps.store.listHeldTasks();
  expect(held).toHaveLength(1);
  expect(held[0]!.reason).toBe("capacity");
  expect(held[0]!.input.repoPath).toBe(validRepo);
});

test("POST /api/sessions: SandboxAutoRefused WITHOUT cause → 403 (unchanged behavior)", async () => {
  const deps = makeDeps();
  deps.service = {
    create: async () => {
      throw new SandboxAutoRefused("autonomous mode requires sandbox");
    },
  } as unknown as AppDeps["service"];

  const res = await postSessions(makeApp(deps), makeBody());
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.held).toBeUndefined();
  expect(deps.store.listHeldTasks()).toHaveLength(0);
});

test("POST /api/sessions: held:changed event emitted on capacity hold", async () => {
  const deps = makeDeps();
  const emitted: unknown[] = [];
  deps.events.subscribe((event, d) => {
    if (event === "held:changed") emitted.push(d);
  });

  const pluginErr = new PluginSpawnAborted("no accounts", "claude-swap");
  deps.service = {
    create: async () => {
      throw new SandboxAutoRefused("plugin aborted: no accounts", pluginErr);
    },
  } as unknown as AppDeps["service"];

  await postSessions(makeApp(deps), makeBody());
  expect(emitted).toHaveLength(1);
});
