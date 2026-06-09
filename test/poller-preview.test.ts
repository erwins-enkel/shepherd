/**
 * Tests for the preview sweep wired into StatusPoller (Task 4).
 *
 * Covers:
 * - Throttle: two ticks within sweepMs → one sweep; after sweepMs → second sweep.
 * - Re-entrancy: pending async sweep → next tick skips.
 * - Zero isolated sessions → converge([]) called, scan NOT called.
 * - Sweep covers sessions of ANY status (idle/done, not just running).
 * - Port disappears next sweep → converge excludes it (badge clears).
 * - Single /proc scan per sweep regardless of session count.
 * - GET /api/preview returns the snapshot.
 */
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import { makeApp } from "../src/server";
import type { HerdrAgent } from "../src/herdr";

// ── shared test fixtures ─────────────────────────────────────────────────────

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

/** Build a fake PreviewService that records calls and drives onChange. */
function makePreviewService() {
  const convergeArgs: Array<{ sessionId: string; devPort: number }[]> = [];
  const onChangeCbs: Array<(sessionId: string, port: number | null) => void> = [];
  let snapshotData: Record<string, { previewPort: number | null }> = {};

  const service = {
    converge(active: Array<{ sessionId: string; devPort: number }>) {
      convergeArgs.push([...active]);
      // drive onChange: if a session appears with a port, call the callback
      for (const cb of onChangeCbs) {
        for (const a of active) cb(a.sessionId, a.devPort);
      }
    },
    ensure(): number | null {
      return null;
    },
    release(): void {},
    snapshot(): Record<string, { previewPort: number | null }> {
      return snapshotData;
    },
    stopAll(): void {},
    // test helpers
    _convergeArgs: convergeArgs,
    _setSnapshot(data: Record<string, { previewPort: number | null }>) {
      snapshotData = data;
    },
    _registerOnChange(cb: (sessionId: string, port: number | null) => void) {
      onChangeCbs.push(cb);
    },
  };
  return service;
}

/** Build a StatusPoller with the preview wiring injected. */
function makePollerWithPreview(opts: {
  store: SessionStore;
  agents: HerdrAgent[];
  previewService: ReturnType<typeof makePreviewService>;
  scanCalls: { count: number };
  scanResult: Map<string, number[]>;
  pickResult: number | null;
  sweepMs?: number;
  now?: () => number;
}) {
  const {
    store,
    agents,
    previewService,
    scanCalls,
    scanResult,
    pickResult,
    sweepMs = 4000,
    now = () => Date.now(),
  } = opts;

  const scan = (worktrees: string[]): Map<string, number[]> => {
    scanCalls.count++;
    const result = new Map<string, number[]>();
    for (const wt of worktrees) {
      result.set(wt, scanResult.get(wt) ?? []);
    }
    return result;
  };
  const pick = async (): Promise<number | null> => pickResult;

  return new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as any,
    () => {},
    () => {},
    1000, // intervalMs
    3000, // reclassifyMs
    undefined, // classify
    now,
    undefined, // probe
    undefined, // stallCfg
    undefined, // probeCheckMs
    undefined, // onReady
    undefined, // onActivity
    {
      service: previewService,
      sweepMs,
      scan,
      pick,
    },
  );
}

// ── throttle ─────────────────────────────────────────────────────────────────

test("preview sweep: throttle — two ticks within sweepMs → one sweep only", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSessionInput);
  const scanCalls = { count: 0 };
  const scanResult = new Map([["/wt-a", [5173]]]);
  const service = makePreviewService();

  let clock = 100_000;
  const poller = makePollerWithPreview({
    store,
    agents: [baseHerdrAgent],
    previewService: service,
    scanCalls,
    scanResult,
    pickResult: 5173,
    sweepMs: 4000,
    now: () => clock,
  });

  poller.tick(); // first tick: lastPreviewSweepAt=0 → sweep starts (async)
  await new Promise((r) => setTimeout(r, 10)); // wait for async sweep to finish
  expect(service._convergeArgs.length).toBe(1); // one sweep
  expect(scanCalls.count).toBe(1);

  clock += 2000; // still within sweepMs (4000)
  poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs.length).toBe(1); // NO second sweep
  expect(scanCalls.count).toBe(1);
});

test("preview sweep: throttle — tick after sweepMs → second sweep fires", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSessionInput);
  const scanCalls = { count: 0 };
  const scanResult = new Map([["/wt-a", [5173]]]);
  const service = makePreviewService();

  let clock = 100_000;
  const poller = makePollerWithPreview({
    store,
    agents: [baseHerdrAgent],
    previewService: service,
    scanCalls,
    scanResult,
    pickResult: 5173,
    sweepMs: 4000,
    now: () => clock,
  });

  poller.tick();
  await new Promise((r) => setTimeout(r, 10)); // wait for first async sweep
  expect(service._convergeArgs.length).toBe(1);

  clock += 5000; // past sweepMs
  poller.tick();
  await new Promise((r) => setTimeout(r, 10)); // wait for second async sweep
  expect(service._convergeArgs.length).toBe(2); // second sweep fired
  expect(scanCalls.count).toBe(2);
});

// ── re-entrancy ───────────────────────────────────────────────────────────────

test("preview sweep: re-entrancy — pending sweep blocks a concurrent second sweep", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSessionInput);
  const scanCalls = { count: 0 };

  // slow pick: doesn't resolve until we release it
  let resolveSlowPick!: (v: number | null) => void;
  const slowPickPromise = new Promise<number | null>((res) => {
    resolveSlowPick = res;
  });

  const service = makePreviewService();
  const pickFn = () => slowPickPromise;

  let clock = 100_000;
  const poller = new StatusPoller(
    store,
    { list: () => [baseHerdrAgent], read: () => "" } as any,
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service,
      sweepMs: 4000,
      scan: (worktrees) => {
        scanCalls.count++;
        const result = new Map<string, number[]>();
        for (const wt of worktrees) result.set(wt, [5173]);
        return result;
      },
      pick: pickFn,
    },
  );

  poller.tick(); // starts first sweep (in flight, pick is pending)
  expect(scanCalls.count).toBe(1);

  // advance past sweepMs so throttle would allow a second
  clock += 5000;
  poller.tick(); // re-entrancy guard must block this
  expect(scanCalls.count).toBe(1); // scan NOT called again while first is in flight

  // release the slow pick
  resolveSlowPick(5173);
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs.length).toBe(1); // only one converge from the first sweep
});

// ── zero isolated sessions ────────────────────────────────────────────────────

test("preview sweep: zero isolated sessions → converge([]) called, scan NOT called", async () => {
  const store = new SessionStore(":memory:");
  // Create a NON-isolated session (no worktree)
  store.create({
    ...baseSessionInput,
    isolated: false,
  });
  const scanCalls = { count: 0 };
  const service = makePreviewService();

  const poller = makePollerWithPreview({
    store,
    agents: [{ ...baseHerdrAgent }],
    previewService: service,
    scanCalls,
    scanResult: new Map(),
    pickResult: null,
    sweepMs: 1000,
    now: () => 100_000,
  });

  poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs.length).toBe(1);
  expect(service._convergeArgs[0]).toEqual([]); // converge([]) called
  expect(scanCalls.count).toBe(0); // scan NOT called
});

test("preview sweep: no sessions at all → converge([]) called, scan NOT called", async () => {
  const store = new SessionStore(":memory:");
  // no sessions created
  const scanCalls = { count: 0 };
  const service = makePreviewService();

  const poller = makePollerWithPreview({
    store,
    agents: [],
    previewService: service,
    scanCalls,
    scanResult: new Map(),
    pickResult: null,
    sweepMs: 1000,
    now: () => 100_000,
  });

  poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs.length).toBe(1);
  expect(service._convergeArgs[0]).toEqual([]);
  expect(scanCalls.count).toBe(0);
});

// ── any status is swept (idle/done agents) ────────────────────────────────────

test("preview sweep: idle/done session with a live port → converge includes it", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  // Set session as done (idle agent that left a dev server running)
  store.update(s.id, { status: "done" });

  const scanCalls = { count: 0 };
  const scanResult = new Map([["/wt-a", [5173]]]);
  const service = makePreviewService();

  const poller = makePollerWithPreview({
    store,
    agents: [{ ...baseHerdrAgent, agentStatus: "done" }],
    previewService: service,
    scanCalls,
    scanResult,
    pickResult: 5173,
    sweepMs: 1000,
    now: () => 100_000,
  });

  poller.tick();
  await new Promise((r) => setTimeout(r, 10));

  expect(service._convergeArgs.length).toBeGreaterThanOrEqual(1);
  const lastConverge = service._convergeArgs[service._convergeArgs.length - 1]!;
  expect(lastConverge).toContainEqual({ sessionId: s.id, devPort: 5173 });
});

test("preview sweep: when idle agent's port disappears → converge excludes it (badge clears)", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "done" });

  const scanCalls = { count: 0 };
  // First sweep: port is present
  let currentPorts: number[] = [5173];
  let pickResult: number | null = 5173;

  const service = makePreviewService();
  let clock = 100_000;

  const poller = new StatusPoller(
    store,
    { list: () => [{ ...baseHerdrAgent, agentStatus: "done" as const }], read: () => "" } as any,
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service,
      sweepMs: 4000,
      scan: (worktrees) => {
        scanCalls.count++;
        const m = new Map<string, number[]>();
        for (const wt of worktrees) m.set(wt, currentPorts);
        return m;
      },
      pick: async () => pickResult,
    },
  );

  // First sweep: port present → converge includes session
  poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs[0]).toContainEqual({ sessionId: s.id, devPort: 5173 });

  // Port disappears
  currentPorts = [];
  pickResult = null;

  // Advance past sweepMs → second sweep
  clock += 5000;
  poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  const secondConverge = service._convergeArgs[1]!;
  // session absent from the active list → converge([]) → release will be called by real PreviewService
  expect(secondConverge).toEqual([]); // no active sessions when port is gone
});

// ── single /proc scan per sweep ───────────────────────────────────────────────

test("preview sweep: single scan per sweep regardless of session count", async () => {
  const store = new SessionStore(":memory:");
  // Create multiple isolated sessions
  const sessions = ["s1", "s2", "s3"].map((_, i) =>
    store.create({ ...baseSessionInput, worktreePath: `/wt-${i}` }),
  );
  const agents: HerdrAgent[] = sessions.map((s, i) => ({
    ...baseHerdrAgent,
    cwd: `/wt-${i}`,
    terminalId: `term_${i}`,
  }));
  // Update store sessions to have matching herdrAgentIds
  sessions.forEach((s, i) => store.update(s.id, { herdrAgentId: `term_${i}` }));

  const scanCalls = { count: 0 };
  const service = makePreviewService();

  const poller = makePollerWithPreview({
    store,
    agents,
    previewService: service,
    scanCalls,
    scanResult: new Map([
      ["/wt-0", [5173]],
      ["/wt-1", [5174]],
      ["/wt-2", []],
    ]),
    pickResult: 5173,
    sweepMs: 1000,
    now: () => 100_000,
  });

  poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  // scan called EXACTLY once for all 3 sessions
  expect(scanCalls.count).toBe(1);
});

// ── GET /api/preview server endpoint ─────────────────────────────────────────

test("GET /api/preview returns the preview snapshot", async () => {
  const snap = { "session-1": { previewPort: 8005 } };

  const store = new SessionStore(":memory:");
  const usageLimits = {
    limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
  };

  const deps = {
    store,
    service: {} as any,
    events: { subscribe: () => () => {}, emit: () => {} } as any,
    usageLimits,
    preview: { snapshot: () => snap },
  };

  const app = makeApp(deps as any);
  const res = await app.fetch(new Request("http://localhost/api/preview"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(snap);
});

test("GET /api/preview → {} when no preview dep is wired", async () => {
  const store = new SessionStore(":memory:");
  const usageLimits = {
    limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
  };

  const deps = {
    store,
    service: {} as any,
    events: { subscribe: () => () => {}, emit: () => {} } as any,
    usageLimits,
    // no preview wired
  };

  const app = makeApp(deps as any);
  const res = await app.fetch(new Request("http://localhost/api/preview"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});
