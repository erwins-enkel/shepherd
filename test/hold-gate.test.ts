import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { UsageLimits } from "../src/usage-limits";

let tmpRoot: string;
let repoDir: string;
// save/restore config fields modified in tests
let savedEnabled: boolean;
let savedPct: number;
let savedDefaultAgentProvider: typeof config.defaultAgentProvider;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-hold-gate-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  savedEnabled = config.usageHoldEnabled;
  savedPct = config.usageHoldPct;
  savedDefaultAgentProvider = config.defaultAgentProvider;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  config.usageHoldEnabled = savedEnabled;
  config.usageHoldPct = savedPct;
  config.defaultAgentProvider = savedDefaultAgentProvider;
});

interface FakeSession {
  id: string;
  status: string;
  [k: string]: unknown;
}

function harness(limitsOverride?: Partial<UsageLimits>): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
  emitted: { event: string; data: unknown }[];
  creates: unknown[];
  labeled: number[];
} {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: unknown }[] = [];
  const creates: unknown[] = [];
  const labeled: number[] = [];

  const hub = new EventHub();
  hub.subscribe((event, data) => emitted.push({ event, data }));

  const defaultLimits: UsageLimits = {
    session5h: null,
    week: null,
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
    ...limitsOverride,
  };

  let createCount = 0;
  const fakeService = {
    async create(input: unknown): Promise<FakeSession> {
      creates.push(input);
      return {
        id: `fake-session-${++createCount}`,
        status: "running",
        repoPath: (input as { repoPath: string }).repoPath,
      };
    },
  };

  const deps: AppDeps = {
    store,
    service: fakeService as any,
    events: hub,
    usageLimits: { limits: () => defaultLimits } as any,
    resolveForge: () =>
      ({
        async addIssueLabel(n: number) {
          labeled.push(n);
        },
      }) as any,
  };
  return { app: makeApp(deps), store, emitted, creates, labeled };
}

function postSession(app: ReturnType<typeof makeApp>, extra?: Record<string, unknown>) {
  return app.fetch(
    new Request("http://x/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoPath: repoDir,
        baseBranch: "main",
        prompt: "do something",
        model: null,
        images: [],
        ...extra,
      }),
    }),
  );
}

// ── hold gate tests ──────────────────────────────────────────────────────────

test("high usage + enabled → held:true, service not called", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;

  const { app, store, emitted, creates } = harness({
    session5h: { pct: 85, resetAt: 0 },
    week: { pct: 0, resetAt: 0 },
  });

  const res = await postSession(app);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.held).toBe(true);
  expect(typeof body.id).toBe("string");
  expect(body.count).toBe(1);

  // store recorded it
  expect(store.countHeldTasks()).toBe(1);

  // service.create NOT called
  expect(creates).toHaveLength(0);

  // no session:new emitted
  expect(emitted.some((e) => e.event === "session:new")).toBe(false);

  // held:changed emitted
  expect(emitted.some((e) => e.event === "held:changed")).toBe(true);
});

test("high usage + force:true → spawns (not held)", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;

  const { app, store, creates } = harness({
    session5h: { pct: 85, resetAt: 0 },
    week: { pct: 0, resetAt: 0 },
  });

  const res = await postSession(app, { force: true });
  expect(res.status).toBe(201);
  expect(creates).toHaveLength(1);
  expect(store.countHeldTasks()).toBe(0);
});

test("high usage + codex provider → spawns (not held by Claude usage)", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;

  const { app, store, creates } = harness({
    session5h: { pct: 85, resetAt: 0 },
    week: { pct: 0, resetAt: 0 },
  });

  const res = await postSession(app, { agentProvider: "codex" });
  expect(res.status).toBe(201);
  expect(creates).toHaveLength(1);
  expect((creates[0] as { agentProvider?: string }).agentProvider).toBe("codex");
  expect(store.countHeldTasks()).toBe(0);
});

test("high usage + default codex provider → spawns (not held by Claude usage)", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;
  config.defaultAgentProvider = "codex";

  const { app, store, creates } = harness({
    session5h: { pct: 85, resetAt: 0 },
    week: { pct: 0, resetAt: 0 },
  });

  const res = await postSession(app);
  expect(res.status).toBe(201);
  expect(creates).toHaveLength(1);
  expect(store.countHeldTasks()).toBe(0);
});

test("high usage + 0 running sessions (idle herd) → still held", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;

  // no running sessions planted — the idle-herd carve-out was removed, so a high
  // usage submit holds on usage alone (matching release sweeper + drain).
  const { app, store, creates } = harness({
    session5h: { pct: 85, resetAt: 0 },
    week: { pct: 0, resetAt: 0 },
  });

  const res = await postSession(app);
  expect(res.status).toBe(200);
  expect((await res.json()).held).toBe(true);
  expect(creates).toHaveLength(0);
  expect(store.countHeldTasks()).toBe(1);
});

test("below threshold (50%) → spawns", async () => {
  config.usageHoldEnabled = true;
  config.usageHoldPct = 80;

  const { app, creates } = harness({
    session5h: { pct: 50, resetAt: 0 },
    week: { pct: 50, resetAt: 0 },
  });

  const res = await postSession(app);
  expect(res.status).toBe(201);
  expect(creates).toHaveLength(1);
});

// ── /api/held endpoints ───────────────────────────────────────────────────────

test("GET /api/held returns FIFO held tasks", async () => {
  const { app, store } = harness();

  store.addHeldTask({
    id: "held-1",
    repoPath: repoDir,
    input: {
      repoPath: repoDir,
      baseBranch: "main",
      prompt: "task 1",
      model: null,
      images: [],
    },
    createdAt: 1000,
  });
  store.addHeldTask({
    id: "held-2",
    repoPath: repoDir,
    input: {
      repoPath: repoDir,
      baseBranch: "main",
      prompt: "task 2",
      model: null,
      images: [],
    },
    createdAt: 2000,
  });

  const res = await app.fetch(new Request("http://x/api/held"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body)).toBe(true);
  expect(body).toHaveLength(2);
  expect(body[0].id).toBe("held-1");
  expect(body[1].id).toBe("held-2");
});

test("POST /api/held/:id/spawn → calls service.create, removes row, returns 201", async () => {
  const { app, store, creates, emitted } = harness();

  const input = {
    repoPath: repoDir,
    baseBranch: "main",
    prompt: "task to spawn",
    model: null,
    images: [],
  };
  store.addHeldTask({ id: "held-1", repoPath: repoDir, input, createdAt: 1000 });

  const res = await app.fetch(new Request("http://x/api/held/held-1/spawn", { method: "POST" }));
  expect(res.status).toBe(201);

  expect(creates).toHaveLength(1);
  expect((creates[0] as typeof input).prompt).toBe("task to spawn");
  expect(store.countHeldTasks()).toBe(0);
  expect(emitted.some((e) => e.event === "held:changed")).toBe(true);
  // the spawned session must surface in the Herd live via session:new (the bug: it didn't)
  const spawned = emitted.find((e) => e.event === "session:new");
  expect(spawned).toBeDefined();
  expect((spawned!.data as { id: string }).id).toBe((await res.json()).id);
});

test("POST /api/held/:id/spawn with linked issue → re-stamps the drain claim", async () => {
  const { app, store, labeled } = harness();

  store.addHeldTask({
    id: "held-1",
    repoPath: repoDir,
    input: {
      repoPath: repoDir,
      baseBranch: "main",
      prompt: "linked task",
      model: null,
      images: [],
      issueRef: { number: 99, url: "http://x/i/99", title: "t", body: "" },
    },
    createdAt: 1000,
  });

  const res = await app.fetch(new Request("http://x/api/held/held-1/spawn", { method: "POST" }));
  expect(res.status).toBe(201);
  // claim stamp is deferred onto setTimeout(0) — flush the macrotask before asserting
  await new Promise((r) => setTimeout(r, 0));
  expect(labeled).toEqual([99]);
});

test("POST /api/held/:id/spawn with unknown id → 404", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request("http://x/api/held/no-such-id/spawn", { method: "POST" }),
  );
  expect(res.status).toBe(404);
});

test("DELETE /api/held/:id → removes row, returns {ok:true}", async () => {
  const { app, store, emitted } = harness();

  store.addHeldTask({
    id: "held-1",
    repoPath: repoDir,
    input: {
      repoPath: repoDir,
      baseBranch: "main",
      prompt: "task 1",
      model: null,
      images: [],
    },
    createdAt: 1000,
  });

  const res = await app.fetch(new Request("http://x/api/held/held-1", { method: "DELETE" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(store.countHeldTasks()).toBe(0);
  expect(emitted.some((e) => e.event === "held:changed")).toBe(true);
});
