/**
 * Tests for the claude-liveness sweep wired into StatusPoller.
 *
 * Covers:
 * - onChange fires on flips only (first sighting + transitions, not steady state).
 * - Throttle: ticks within sweepMs don't re-scan.
 * - Tracking is pruned when a session leaves the active set.
 * - claudeAliveSnapshot() exposes the last-swept map for client bootstrap.
 * - A throwing scan is swallowed (tick must never crash shepherd).
 * - GET /api/claude-alive returns the snapshot ({} when unwired).
 */
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import { makeApp } from "../src/server";
import type { HerdrAgent } from "../src/herdr";

const baseHerdrAgent: HerdrAgent = {
  agent: "claude",
  agentStatus: "done",
  cwd: "/wt-a",
  paneId: "p",
  tabId: "t",
  name: "",
  terminalId: "term_a",
  workspaceId: "w",
};

const baseSessionInput = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt-a",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
};

function makePoller(opts: {
  store: SessionStore;
  agents: HerdrAgent[];
  scan: (worktrees: string[]) => Map<string, boolean>;
  onChange: (id: string, alive: boolean) => void;
  sweepMs?: number;
  now?: () => number;
}) {
  return new StatusPoller(
    opts.store,
    { list: () => opts.agents, read: () => "" } as any,
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    opts.now ?? (() => 100_000),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // preview wiring: no-op service so the preview sweep stays inert
    {
      service: { ensure: () => null, release: () => {}, converge: () => {}, snapshot: () => ({}) },
      sweepMs: 4000,
      scan: () => new Map(),
      pick: async () => null,
    },
    { scan: opts.scan, sweepMs: opts.sweepMs ?? 4000, onChange: opts.onChange },
  );
}

test("liveness sweep: emits on first sighting and on flips, not steady state", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  let alive = true;
  const changes: Array<{ id: string; alive: boolean }> = [];
  let clock = 100_000;

  const poller = makePoller({
    store,
    agents: [baseHerdrAgent],
    scan: (worktrees) => new Map(worktrees.map((w) => [w, alive])),
    onChange: (id, a) => changes.push({ id, alive: a }),
    sweepMs: 4000,
    now: () => clock,
  });

  poller.tick(); // first sweep → first sighting emits
  expect(changes).toEqual([{ id: s.id, alive: true }]);

  clock += 5000;
  poller.tick(); // unchanged → no emit
  expect(changes.length).toBe(1);

  alive = false; // claude exited → husk
  clock += 5000;
  poller.tick();
  expect(changes).toEqual([
    { id: s.id, alive: true },
    { id: s.id, alive: false },
  ]);
  expect(poller.claudeAliveSnapshot()).toEqual({ [s.id]: false });
});

test("liveness sweep: throttle — ticks within sweepMs don't re-scan", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSessionInput);
  let scans = 0;
  let clock = 100_000;

  const poller = makePoller({
    store,
    agents: [baseHerdrAgent],
    scan: (worktrees) => {
      scans++;
      return new Map(worktrees.map((w) => [w, true]));
    },
    onChange: () => {},
    sweepMs: 4000,
    now: () => clock,
  });

  poller.tick();
  expect(scans).toBe(1);
  clock += 2000; // within sweepMs
  poller.tick();
  expect(scans).toBe(1);
  clock += 3000; // past sweepMs
  poller.tick();
  expect(scans).toBe(2);
});

test("liveness sweep: tracking pruned when a session leaves the active set", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  let clock = 100_000;

  const poller = makePoller({
    store,
    agents: [baseHerdrAgent],
    scan: (worktrees) => new Map(worktrees.map((w) => [w, true])),
    onChange: () => {},
    sweepMs: 4000,
    now: () => clock,
  });

  poller.tick();
  expect(poller.claudeAliveSnapshot()).toEqual({ [s.id]: true });

  store.archive(s.id);
  clock += 5000;
  poller.tick();
  expect(poller.claudeAliveSnapshot()).toEqual({});
});

test("liveness sweep: a throwing scan is swallowed; later sweep recovers", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  let shouldThrow = true;
  let clock = 100_000;
  const changes: string[] = [];

  const poller = makePoller({
    store,
    agents: [baseHerdrAgent],
    scan: (worktrees) => {
      if (shouldThrow) throw new Error("scan boom");
      return new Map(worktrees.map((w) => [w, false]));
    },
    onChange: (id) => changes.push(id),
    sweepMs: 4000,
    now: () => clock,
  });

  expect(() => poller.tick()).not.toThrow();
  expect(changes).toEqual([]);

  shouldThrow = false;
  clock += 5000;
  poller.tick();
  expect(changes).toEqual([s.id]);
});

test("GET /api/claude-alive returns the snapshot", async () => {
  const store = new SessionStore(":memory:");
  const deps = {
    store,
    service: {} as any,
    events: { subscribe: () => () => {}, emit: () => {} } as any,
    usageLimits: {
      limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
    },
    claudeAlive: { snapshot: () => ({ "session-1": false }) },
  };
  const app = makeApp(deps as any);
  const res = await app.fetch(new Request("http://localhost/api/claude-alive"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ "session-1": false });
});

test("GET /api/claude-alive → {} when unwired", async () => {
  const store = new SessionStore(":memory:");
  const deps = {
    store,
    service: {} as any,
    events: { subscribe: () => () => {}, emit: () => {} } as any,
    usageLimits: {
      limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
    },
  };
  const app = makeApp(deps as any);
  const res = await app.fetch(new Request("http://localhost/api/claude-alive"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});
