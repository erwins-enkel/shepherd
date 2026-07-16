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
import type { LivenessState } from "../src/types";

/**
 * tick() (issue #1529) now reads agents over the socket via `listAsync()`, not the
 * sync `list()` these pre-existing herdr fakes were written against. Rather than
 * duplicate each fake's (sometimes stateful) `list()` logic, mirror it: `listAsync`
 * resolves to whatever `list()` returns at call time.
 */
function withListAsync<T extends { list: () => HerdrAgent[] }>(
  herdr: T,
): T & { listAsync: () => Promise<HerdrAgent[]> } {
  return { ...herdr, listAsync: () => Promise.resolve(herdr.list()) };
}

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
  onChange: (id: string, alive: boolean, liveness: LivenessState) => void;
  sweepMs?: number;
  now?: () => number;
}) {
  return new StatusPoller(
    opts.store,
    withListAsync({ list: () => opts.agents, read: () => "" } as any),
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

test("liveness sweep: emits on first sighting and on flips, not steady state", async () => {
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

  await poller.tick(); // first sweep → first sighting emits
  expect(changes).toEqual([{ id: s.id, alive: true }]);

  clock += 5000;
  await poller.tick(); // unchanged → no emit
  expect(changes.length).toBe(1);

  alive = false; // claude exited → husk
  clock += 5000;
  await poller.tick();
  expect(changes).toEqual([
    { id: s.id, alive: true },
    { id: s.id, alive: false },
  ]);
  expect(poller.claudeAliveSnapshot()).toEqual({ [s.id]: false });
});

test("liveness sweep: throttle — ticks within sweepMs don't re-scan", async () => {
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

  await poller.tick();
  expect(scans).toBe(1);
  clock += 2000; // within sweepMs
  await poller.tick();
  expect(scans).toBe(1);
  clock += 3000; // past sweepMs
  await poller.tick();
  expect(scans).toBe(2);
});

test("liveness sweep: tracking pruned when a session leaves the active set", async () => {
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

  await poller.tick();
  expect(poller.claudeAliveSnapshot()).toEqual({ [s.id]: true });

  store.archive(s.id);
  clock += 5000;
  await poller.tick();
  expect(poller.claudeAliveSnapshot()).toEqual({});
});

test("liveness sweep: a throwing scan is swallowed; later sweep recovers", async () => {
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

  await expect(poller.tick()).resolves.toBeUndefined();
  expect(changes).toEqual([]);

  shouldThrow = false;
  clock += 5000;
  await poller.tick();
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

// ── stranded detection + auto-revive (#1630) ────────────────────────────────

import { config } from "../src/config";

/** A restored-pane husk: the session's spawnTerminalId ("spawn_old") differs from the matched
 *  agent's terminalId ("term_a"), and the /proc scan reports it dead → stranded. */
function makeStrandedSession(store: SessionStore, over: Record<string, unknown> = {}) {
  const s = store.create({ ...baseSessionInput });
  // default account (spawnAccountDir null) with a prior verified spawn on a DIFFERENT terminal
  store.setSpawnIdentity(s.id, "spawn_old", null);
  if (Object.keys(over).length) store.update(s.id, over);
  return store.get(s.id)!;
}

test("liveness: a restored-pane husk emits liveness=stranded and grows the stranded set", async () => {
  const store = new SessionStore(":memory:");
  const s = makeStrandedSession(store);
  const emits: Array<{ id: string; alive: boolean; liveness: string }> = [];
  const grew: number[] = [];
  const clock = 100_000;
  const poller = makePoller({
    store,
    agents: [baseHerdrAgent], // terminalId term_a === herdrAgentId term_a → matched; != spawn_old
    scan: (worktrees) => new Map(worktrees.map((w) => [w, false])), // husk
    onChange: (id, alive, liveness) => {
      emits.push({ id, alive, liveness });
    },
    sweepMs: 4000,
    now: () => clock,
  });
  poller.onStrandedGrew = (count) => grew.push(count);

  await poller.tick();
  expect(emits).toEqual([{ id: s.id, alive: false, liveness: "stranded" }]);
  expect(grew).toEqual([1]);
  expect(poller.strandedIds()).toEqual([s.id]);
});

test("liveness: auto-revive fires (default account) only after the 2-sweep debounce, when enabled", async () => {
  const store = new SessionStore(":memory:");
  const s = makeStrandedSession(store);
  const revived: string[] = [];
  let clock = 100_000;
  const prev = config.autoReviveEnabled;
  config.autoReviveEnabled = true; // ON before construction → no rising-edge arm, isolates the debounce
  try {
    const poller = makePoller({
      store,
      agents: [baseHerdrAgent],
      scan: (worktrees) => new Map(worktrees.map((w) => [w, false])),
      onChange: () => {},
      sweepMs: 4000,
      now: () => clock,
    });
    poller.revive = async (id) => {
      revived.push(id);
      return "revived";
    };
    await poller.tick(); // sweep 1 → stranded, debounce not yet met
    expect(revived).toEqual([]);
    clock += 5000;
    await poller.tick(); // sweep 2 → debounce met → dispatch
    expect(revived).toEqual([s.id]);
  } finally {
    config.autoReviveEnabled = prev;
  }
});

test("liveness: an account session is NOT auto-revived (reDriveAccount owns it)", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSessionInput });
  store.setSpawnIdentity(s.id, "spawn_old", "/cfg/acct"); // account session (spawnAccountDir set)
  const revived: string[] = [];
  let clock = 100_000;
  const poller = makePoller({
    store,
    agents: [baseHerdrAgent],
    scan: (worktrees) => new Map(worktrees.map((w) => [w, false])),
    onChange: () => {},
    sweepMs: 4000,
    now: () => clock,
  });
  poller.revive = async (id) => {
    revived.push(id);
    return "revived";
  };
  const prev = config.autoReviveEnabled;
  config.autoReviveEnabled = true;
  try {
    await poller.tick();
    clock += 5000;
    await poller.tick();
    clock += 5000;
    await poller.tick();
    expect(revived).toEqual([]); // never — account panes stay with reDriveAccount
  } finally {
    config.autoReviveEnabled = prev;
  }
});

test("liveness: sweep-on-arm force-resumes the current stranded set on the toggle rising edge (single sweep)", async () => {
  const store = new SessionStore(":memory:");
  const s = makeStrandedSession(store);
  const revived: string[] = [];
  let clock = 100_000;
  const poller = makePoller({
    store,
    agents: [baseHerdrAgent],
    scan: (worktrees) => new Map(worktrees.map((w) => [w, false])),
    onChange: () => {},
    sweepMs: 4000,
    now: () => clock,
  });
  poller.revive = async (id) => {
    revived.push(id);
    return "revived";
  };
  const prev = config.autoReviveEnabled;
  config.autoReviveEnabled = false;
  try {
    await poller.tick(); // stranded observed, but toggle off → no dispatch
    expect(revived).toEqual([]);
    config.autoReviveEnabled = true; // operator flips it ON
    clock += 5000;
    await poller.tick(); // rising edge → dispatch immediately (no 2-sweep wait)
    expect(revived).toEqual([s.id]);
  } finally {
    config.autoReviveEnabled = prev;
  }
});

test("liveness: auto-revive stops dispatching + re-counting once the service gives up", async () => {
  const store = new SessionStore(":memory:");
  makeStrandedSession(store);
  const dispatches: string[] = [];
  const outcomes: Array<{ revived: number; failed: number }> = [];
  let clock = 100_000;
  const prev = config.autoReviveEnabled;
  config.autoReviveEnabled = true; // ON before construction → debounced path (no arm)
  try {
    const poller = makePoller({
      store,
      agents: [baseHerdrAgent],
      scan: (worktrees) => new Map(worktrees.map((w) => [w, false])),
      onChange: () => {},
      sweepMs: 4000,
      now: () => clock,
    });
    // The service has permanently given up (bounded cap reached).
    poller.revive = async (id) => {
      dispatches.push(id);
      return "gaveup";
    };
    poller.onAutoRevived = (revived, failed) => outcomes.push({ revived, failed });
    for (let i = 0; i < 5; i++) {
      await poller.tick();
      // flush the fire-and-forget revive().then().finally() chain before the next sweep
      for (let f = 0; f < 4; f++) await Promise.resolve();
      clock += 5000;
    }
    // dispatched exactly once (2-sweep debounce), then frozen — not every sweep forever
    expect(dispatches).toEqual([store.list({ activeOnly: true })[0]!.id]);
    // failed counted exactly once; the outcome toast does not re-emit a climbing count
    expect(outcomes.at(-1)).toEqual({ revived: 0, failed: 1 });
    expect(outcomes.filter((o) => o.failed > 1)).toEqual([]);
  } finally {
    config.autoReviveEnabled = prev;
  }
});
