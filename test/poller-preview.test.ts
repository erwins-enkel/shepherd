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
    withListAsync({ list: () => agents, read: () => "" } as any),
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

  await poller.tick(); // first tick: lastPreviewSweepAt=0 → sweep starts (async)
  await new Promise((r) => setTimeout(r, 10)); // wait for async sweep to finish
  expect(service._convergeArgs.length).toBe(1); // one sweep
  expect(scanCalls.count).toBe(1);

  clock += 2000; // still within sweepMs (4000)
  await poller.tick();
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

  await poller.tick();
  await new Promise((r) => setTimeout(r, 10)); // wait for first async sweep
  expect(service._convergeArgs.length).toBe(1);

  clock += 5000; // past sweepMs
  await poller.tick();
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
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
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

  await poller.tick(); // starts first sweep (in flight, pick is pending)
  expect(scanCalls.count).toBe(1);

  // advance past sweepMs so throttle would allow a second
  clock += 5000;
  await poller.tick(); // re-entrancy guard must block this
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

  await poller.tick();
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

  await poller.tick();
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

  await poller.tick();
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
    withListAsync({
      list: () => [{ ...baseHerdrAgent, agentStatus: "done" as const }],
      read: () => "",
    } as any),
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
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs[0]).toContainEqual({ sessionId: s.id, devPort: 5173 });

  // Port disappears
  currentPorts = [];
  pickResult = null;

  // Advance past sweepMs → second sweep
  clock += 5000;
  await poller.tick();
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

  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  // scan called EXACTLY once for all 3 sessions
  expect(scanCalls.count).toBe(1);
});

// ── pick receives worktreePath ────────────────────────────────────────────────

test("preview sweep: pick is called with the session's worktreePath", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput); // worktreePath = "/wt-a"

  const pickCalls: Array<{ ports: number[]; worktreePath: string }> = [];
  const service = makePreviewService();
  const clock = 100_000;

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
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
        const m = new Map<string, number[]>();
        for (const wt of worktrees) m.set(wt, [5173]);
        return m;
      },
      pick: async (ports, worktreePath) => {
        pickCalls.push({ ports, worktreePath });
        return 5173;
      },
    },
  );

  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));

  expect(pickCalls.length).toBeGreaterThanOrEqual(1);
  expect(pickCalls[0]!.worktreePath).toBe(s.worktreePath);
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

// ── swallowed-throw paths ─────────────────────────────────────────────────────

test("preview sweep: throwing scan → no crash + previewSweeping resets → later tick sweeps again", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSessionInput);
  const service = makePreviewService();

  let shouldThrow = true;
  let clock = 100_000;

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
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
      scan: () => {
        if (shouldThrow) throw new Error("scan boom");
        return new Map([["/wt-a", [5173]]]);
      },
      pick: async () => 5173,
    },
  );

  // First tick: scan throws → poller must not crash
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  // no converge called (threw before reaching it)
  expect(service._convergeArgs.length).toBe(0);

  // previewSweeping must have been reset (finally ran) → a later tick past sweepMs must sweep
  shouldThrow = false;
  clock += 5000; // past sweepMs
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  // second sweep succeeded
  expect(service._convergeArgs.length).toBe(1);
});

test("preview sweep: rejecting pick → no crash + previewSweeping resets → later tick sweeps again", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSessionInput);
  const service = makePreviewService();

  let shouldReject = true;
  let clock = 100_000;

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
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
      scan: () => new Map([["/wt-a", [5173]]]),
      pick: async () => {
        if (shouldReject) throw new Error("pick boom");
        return 5173;
      },
    },
  );

  // First tick: pick rejects → poller must not crash
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs.length).toBe(0);

  // previewSweeping must have reset → later tick past sweepMs must sweep normally
  shouldReject = false;
  clock += 5000;
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(service._convergeArgs.length).toBe(1);
  expect(service._convergeArgs[0]).toContainEqual({ sessionId: expect.any(String), devPort: 5173 });
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

// ── idle-stop tests ───────────────────────────────────────────────────────────

/** Helper: build a poller with full idle-stop wiring for idle-stop tests. */
function makeIdleStopPoller(opts: {
  store: SessionStore;
  agents: HerdrAgent[];
  /** Controllable clock (mutate `.v` between sweeps). */
  clock: { v: number };
  /** idleSince return value per session (null = unbound). */
  idleSinceMs: number | null;
  pickResult: number | null;
  idleMs: number;
  stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }>;
  /** Override pick to be dynamic — takes precedence over pickResult. */
  pickFn?: () => Promise<number | null>;
  /** When true, `idleStop.stop` reports `unsupported` (darwin, no signal authority). */
  unsupportedStop?: boolean;
}) {
  const { store, agents, clock, idleSinceMs, pickResult, idleMs, stopCalls, pickFn } = opts;

  const convergeArgs: Array<Array<{ sessionId: string; devPort: number }>> = [];

  const service = {
    ensure: () => null as number | null,
    release: () => {},
    converge(active: Array<{ sessionId: string; devPort: number }>) {
      convergeArgs.push([...active]);
    },
    snapshot: () => ({}) as Record<string, { previewPort: number | null }>,
    idleSince: () => idleSinceMs,
  };

  return {
    convergeArgs,
    poller: new StatusPoller(
      store,
      withListAsync({ list: () => agents, read: () => "" } as any),
      () => {},
      () => {},
      1000, // intervalMs
      3000, // reclassifyMs
      undefined, // classify
      () => clock.v,
      undefined, // probe
      undefined, // stallCfg
      undefined, // probeCheckMs
      undefined, // onReady
      undefined, // onActivity
      {
        service,
        sweepMs: 4000,
        scan: (worktrees) => {
          const m = new Map<string, number[]>();
          for (const wt of worktrees) m.set(wt, [5173]);
          return m;
        },
        pick: pickFn ?? (async () => pickResult),
        idleStop: {
          idleMs,
          stop: (sessionId, signal) => {
            stopCalls.push({ sessionId, signal });
            return opts.unsupportedStop
              ? { result: "unsupported" as const, killed: 0 }
              : { result: "stopped" as const, killed: 1 };
          },
        },
      },
    ),
  };
}

/** Drive a fresh sweep: advance clock past sweepMs, call tick(), await microtasks. */
async function runSweep(clock: { v: number }, poller: StatusPoller): Promise<void> {
  clock.v += 5000; // past the 4000ms sweepMs
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
}

test("idle-stop: disabled by default — no stop called even when idle+stale", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };

  // No idleStop wired (use makePollerWithPreview without idleStop)
  const service = makePreviewService();

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock.v,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service,
      sweepMs: 4000,
      scan: (worktrees) => {
        const m = new Map<string, number[]>();
        for (const wt of worktrees) m.set(wt, [5173]);
        return m;
      },
      pick: async () => 5173,
      // no idleStop
    },
  );

  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(0); // no stop, ever
  expect(service._convergeArgs[0]).toContainEqual({ sessionId: s.id, devPort: 5173 });
});

test("idle-stop: fires SIGTERM when idle+stale and stays in converge active set", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  const { convergeArgs, poller } = makeIdleStopPoller({
    store,
    agents: [baseHerdrAgent],
    clock,
    idleSinceMs: 60_000, // 60s idle

    pickResult: 5173,
    idleMs: 30_000,
    stopCalls,
  });

  await runSweep(clock, poller);

  expect(stopCalls.length).toBe(1);
  expect(stopCalls[0]!.sessionId).toBe(s.id);
  expect(stopCalls[0]!.signal).toBe("SIGTERM");
  // Session stays in active set (port still up; converge will clear only when port dies)
  expect(convergeArgs[0]).toContainEqual({ sessionId: s.id, devPort: 5173 });
});

test("idle-stop: fires for status=done as well as idle", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "done" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  const { poller } = makeIdleStopPoller({
    store,
    agents: [{ ...baseHerdrAgent, agentStatus: "done" }],
    clock,
    idleSinceMs: 60_000,

    pickResult: 5173,
    idleMs: 30_000,
    stopCalls,
  });

  await runSweep(clock, poller);

  expect(stopCalls.length).toBe(1);
  expect(stopCalls[0]!.signal).toBe("SIGTERM");
});

test("idle-stop: stale-status guard — s.status is idle (stale snapshot) but store.get says running → no stop", async () => {
  // Scenario: store starts with status "idle" so store.list() returns sessions with status "idle".
  // The herdr agent reports "working" (HerdrState that maps to SessionStatus "running"), so
  // reconcileAgent() updates store to "running" during tick().
  // The async runPreviewSweep fires after reconcileAgent, so store.get(id).status = "running".
  // A naive read of s.status (from the captured sessions list) would be "idle" → would wrongly stop.
  // The correct impl reads store.get(id).status (fresh) → "running" → no stop.
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  // Pre-set status to "idle" so that store.list() returns sessions with status "idle"
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };

  const convergeArgs: Array<Array<{ sessionId: string; devPort: number }>> = [];
  const service = {
    ensure: () => null as number | null,
    release: () => {},
    converge(active: Array<{ sessionId: string; devPort: number }>) {
      convergeArgs.push([...active]);
    },
    snapshot: () => ({}) as Record<string, { previewPort: number | null }>,
    idleSince: (): number | null => 60_000, // 60s idle — would trigger stop if status check is wrong
  };

  const poller = new StatusPoller(
    store,
    // Agent reports "working" (HerdrState) → mapState → "running" → reconcileAgent updates store
    // to "running" before async sweep fires, so store.get(id).status = "running"
    withListAsync({
      list: () => [{ ...baseHerdrAgent, agentStatus: "working" as const }],
      read: () => "",
    } as any),
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock.v,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service,
      sweepMs: 4000,
      scan: (worktrees) => {
        const m = new Map<string, number[]>();
        for (const wt of worktrees) m.set(wt, [5173]);
        return m;
      },
      pick: async () => 5173,
      idleStop: {
        idleMs: 30_000,
        stop: (sessionId, signal) => {
          stopCalls.push({ sessionId, signal });
        },
      },
    },
  );

  await runSweep(clock, poller);

  // Fresh store says "running" → no stop (proves it reads fresh store status, not the stale s.status)
  expect(stopCalls.length).toBe(0);
  void convergeArgs;
});

test("idle-stop: not stale enough — idleSince < idleMs → no stop", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  const { poller } = makeIdleStopPoller({
    store,
    agents: [baseHerdrAgent],
    clock,
    idleSinceMs: 10_000, // only 10s, below idleMs=30s

    pickResult: 5173,
    idleMs: 30_000,
    stopCalls,
  });

  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(0);
});

test("idle-stop: wrong status (running/blocked fresh) → no stop even if very stale", async () => {
  // HerdrState "working" maps to SessionStatus "running"; "blocked" maps to "blocked".
  // Neither is "idle" or "done", so idle-stop must not fire regardless of idleSince.

  // Test "running" (via HerdrState "working")
  const store = new SessionStore(":memory:");
  store.create(baseSessionInput); // default status "running"

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  const { poller } = makeIdleStopPoller({
    store,
    agents: [{ ...baseHerdrAgent, agentStatus: "working" as const }], // maps to "running"
    clock,
    idleSinceMs: 999_999, // extremely stale

    pickResult: 5173,
    idleMs: 30_000,
    stopCalls,
  });

  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(0);

  // Test "blocked"
  const store2 = new SessionStore(":memory:");
  const s2 = store2.create(baseSessionInput);
  store2.update(s2.id, { status: "blocked" }); // pre-set to blocked

  const stopCalls2: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock2 = { v: 100_000 };
  const { poller: poller2 } = makeIdleStopPoller({
    store: store2,
    agents: [{ ...baseHerdrAgent, agentStatus: "blocked" as const }], // maps to "blocked"
    clock: clock2,
    idleSinceMs: 999_999,

    pickResult: 5173,
    idleMs: 30_000,
    stopCalls: stopCalls2,
  });

  await runSweep(clock2, poller2);
  expect(stopCalls2.length).toBe(0);
});

test("idle-stop: idleSince null (unbound/absent) → no stop", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  const { poller } = makeIdleStopPoller({
    store,
    agents: [baseHerdrAgent],
    clock,
    idleSinceMs: null, // unbound

    pickResult: 5173,
    idleMs: 30_000,
    stopCalls,
  });

  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(0);
});

test("idle-stop: escalation — SIGTERM→SIGKILL→give-up across sweeps", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  const { poller } = makeIdleStopPoller({
    store,
    agents: [baseHerdrAgent],
    clock,
    idleSinceMs: 60_000,

    pickResult: 5173,
    idleMs: 30_000,
    stopCalls,
  });

  // 1st sweep → SIGTERM
  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(1);
  expect(stopCalls[0]!.signal).toBe("SIGTERM");

  // 2nd sweep (port still up, still idle) → SIGKILL
  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(2);
  expect(stopCalls[1]!.signal).toBe("SIGKILL");

  // 3rd sweep → no further stop, console.warn emitted once
  const warnCalls: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnCalls.push(args.join(" "));
  try {
    await runSweep(clock, poller);
    expect(stopCalls.length).toBe(2); // no 3rd stop call
    expect(warnCalls.some((w) => w.includes("idle-stop could not reclaim"))).toBe(true);

    // 4th sweep → still no further stop (gaveUp stays)
    await runSweep(clock, poller);
    expect(stopCalls.length).toBe(2);
  } finally {
    console.warn = origWarn;
  }
});

test("idle-stop: reset on recovery — after SIGTERM, next sweep with low idleSince resets to fresh SIGTERM", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  let currentIdleSince: number | null = 60_000;

  // Build manually to control idleSince dynamically
  const convergeArgs: Array<Array<{ sessionId: string; devPort: number }>> = [];
  const service = {
    ensure: () => null as number | null,
    release: () => {},
    converge(active: Array<{ sessionId: string; devPort: number }>) {
      convergeArgs.push([...active]);
    },
    snapshot: () => ({}) as Record<string, { previewPort: number | null }>,
    idleSince: (): number | null => currentIdleSince,
  };

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock.v,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service,
      sweepMs: 4000,
      scan: (worktrees) => {
        const m = new Map<string, number[]>();
        for (const wt of worktrees) m.set(wt, [5173]);
        return m;
      },
      pick: async () => 5173,
      idleStop: {
        idleMs: 30_000,
        stop: (sessionId, signal) => {
          stopCalls.push({ sessionId, signal });
        },
      },
    },
  );

  // 1st sweep → SIGTERM (stale)
  await runSweep(clock, poller);
  expect(stopCalls[0]!.signal).toBe("SIGTERM");

  // Recovery: someone viewed it, idleSince drops below threshold
  currentIdleSince = 5_000;
  await runSweep(clock, poller);
  // No further stop during recovery
  expect(stopCalls.length).toBe(1);

  // Goes stale again → fresh SIGTERM (not SIGKILL), proving escalation was reset
  currentIdleSince = 60_000;
  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(2);
  expect(stopCalls[1]!.signal).toBe("SIGTERM"); // fresh episode, not SIGKILL

  void convergeArgs;
});

test("idle-stop: reset on port death — after SIGTERM, port disappears then reappears → fresh SIGTERM", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  let currentPick: number | null = 5173;

  const service = {
    ensure: () => null as number | null,
    release: () => {},
    converge: () => {},
    snapshot: () => ({}) as Record<string, { previewPort: number | null }>,
    idleSince: (): number | null => 60_000, // always stale
  };

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock.v,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service,
      sweepMs: 4000,
      scan: (worktrees) => {
        const m = new Map<string, number[]>();
        for (const wt of worktrees) m.set(wt, currentPick !== null ? [5173] : []);
        return m;
      },
      pick: async () => currentPick,
      idleStop: {
        idleMs: 30_000,
        stop: (sessionId, signal) => {
          stopCalls.push({ sessionId, signal });
        },
      },
    },
  );

  // 1st sweep → SIGTERM
  await runSweep(clock, poller);
  expect(stopCalls[0]!.signal).toBe("SIGTERM");

  // Port dies → previewStopState cleared
  currentPick = null;
  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(1); // no signal when port is gone

  // New server appears → fresh SIGTERM (not SIGKILL)
  currentPick = 5173;
  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(2);
  expect(stopCalls[1]!.signal).toBe("SIGTERM");
});

test("idle-stop: devPort change mid-escalation → resets to fresh SIGTERM (not SIGKILL)", async () => {
  // A session in "term" escalation state (already received SIGTERM) whose dev server
  // restarts on a DIFFERENT port triggers the else branch of the devPort === devPort
  // guard in escalateIdleStop, producing a fresh SIGTERM rather than escalating to SIGKILL.
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  let currentDevPort: number = 5173;

  const service = {
    ensure: () => null as number | null,
    release: () => {},
    converge: () => {},
    snapshot: () => ({}) as Record<string, { previewPort: number | null }>,
    idleSince: (): number | null => 60_000, // always stale
  };

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock.v,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service,
      sweepMs: 4000,
      scan: (worktrees) => {
        const m = new Map<string, number[]>();
        for (const wt of worktrees) m.set(wt, [currentDevPort]);
        return m;
      },
      pick: async () => currentDevPort,
      idleStop: {
        idleMs: 30_000,
        stop: (sessionId, signal) => {
          stopCalls.push({ sessionId, signal });
        },
      },
    },
  );

  // Sweep 1: devPort=5173, idle+stale → SIGTERM (enters "term" escalation state)
  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(1);
  expect(stopCalls[0]!.sessionId).toBe(s.id);
  expect(stopCalls[0]!.signal).toBe("SIGTERM");

  // Dev server restarts on a different port (devPort=5174).
  // The "term" escalation state stored devPort=5173; the new port doesn't match,
  // so escalateIdleStop falls to the else branch → fresh SIGTERM, not SIGKILL.
  currentDevPort = 5174;
  await runSweep(clock, poller);
  expect(stopCalls.length).toBe(2);
  expect(stopCalls[1]!.sessionId).toBe(s.id);
  expect(stopCalls[1]!.signal).toBe("SIGTERM"); // fresh episode, NOT SIGKILL
});

// ── #1912: unsupported stop (darwin) must not burn the escalation ladder ──────

test("idle-stop (unsupported): repeated sweeps never advance the ladder or give up", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  store.update(s.id, { status: "idle" });

  const stopCalls: Array<{ sessionId: string; signal: NodeJS.Signals }> = [];
  const clock = { v: 100_000 };
  const { poller } = makeIdleStopPoller({
    store,
    agents: [baseHerdrAgent],
    clock,
    idleSinceMs: 60_000,
    pickResult: 5173,
    idleMs: 30_000,
    stopCalls,
    unsupportedStop: true, // darwin: no signal authority
  });

  // Three sweeps that would, on a Linux host, burn SIGTERM → SIGKILL → gaveUp.
  for (let i = 0; i < 3; i++) await runSweep(clock, poller);

  // Every attempt reports the SAME first rung (SIGTERM): the ladder never advanced,
  // so no SIGKILL was ever "escalated" to and no "could not reclaim" state was set.
  expect(stopCalls.length).toBe(3);
  expect(stopCalls.every((c) => c.signal === "SIGTERM")).toBe(true);
});

// ── #1912: a null preview scan leaves bound listeners alone (no converge teardown) ──

test("preview sweep (null scan): does not converge, so bound listeners are not torn down", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);

  const convergeArgs: Array<Array<{ sessionId: string; devPort: number }>> = [];
  const clock = { v: 100_000 };
  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [baseHerdrAgent], read: () => "" } as any),
    () => {},
    () => {},
    1000,
    3000,
    undefined,
    () => clock.v,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service: {
        ensure: () => null,
        release: () => {},
        converge: (active: Array<{ sessionId: string; devPort: number }>) =>
          convergeArgs.push([...active]),
        snapshot: () => ({}),
      },
      sweepMs: 4000,
      scan: () => null, // unknown (darwin, stale/none cell)
      pick: async () => 5173,
    },
  );

  clock.v += 5000;
  await poller.tick();
  await new Promise((r) => setTimeout(r, 10));
  // converge was NEVER called: an empty/partial map would have released listeners.
  expect(convergeArgs).toEqual([]);
  void s;
});
