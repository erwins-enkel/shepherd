import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";
import { classifyBlocked } from "../src/blocked";
import { config } from "../src/config";

// Observe-only Stop↔herdr-done window measurement (issue #713). Polling stays authoritative;
// these tests assert the SIGNED window emission + marker bookkeeping only, never any routing
// change. `config.hooksSignals` gates the whole feature — save/restore it per-test so the
// flag never leaks across the suite.

const baseSession = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
};

/** A swappable-status herdr agent + an injected clock; captures every onStopWindow call and
 *  the status onChange edges. The transcript probe returns null (interim path) so a done-flip
 *  routes through `clearBlock`, never a stall. */
function stopHarness() {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const windows: Array<{ id: string; windowMs: number | null }> = [];
  const changes: Array<{ id: string; status: string }> = [];
  let agentStatus = "working";
  let clock = 1_700_000_000_000;
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      } as HerdrAgent,
    ],
    read: () => "",
    readAsync: () => Promise.resolve(""),
  };
  const poller = new StatusPoller(
    store,
    herdr as any,
    (id, status) => changes.push({ id, status }),
    () => {},
    1000, // intervalMs
    3000, // reclassifyMs
    classifyBlocked,
    () => clock, // now (controllable)
    () => ({ snapshot: null, activity: null }), // probe
    { stallMs: 1, pendingStallMs: 1 }, // stallCfg
    7000, // probeCheckMs
    () => {}, // onReady
    () => {}, // onActivity
    undefined, // preview
    undefined, // liveness
    () => {}, // onWorkingBlocked
    () => {}, // pruneHooks
    (id, windowMs) => windows.push({ id, windowMs }), // onStopWindow
  );
  return {
    poller,
    store,
    windows,
    changes,
    id: s.id,
    setStatus: (st: string) => (agentStatus = st),
    setClock: (ms: number) => (clock = ms),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

test("stop-window: inert when config.hooksSignals is off", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = false;
  try {
    const h = stopHarness();
    h.poller.ingestStopMeasure(h.id, h.now());
    h.setStatus("done");
    h.poller.tick();
    expect(h.windows).toHaveLength(0);
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: stop-wins emits a positive window on the done-flip", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    const t1 = h.now();
    h.poller.ingestStopMeasure(h.id, t1);
    h.advance(2000); // t2 within window
    const t2 = h.now();
    h.setStatus("done");
    h.poller.tick();
    expect(h.windows).toEqual([{ id: h.id, windowMs: t2 - t1 }]);
    expect(t2 - t1).toBeGreaterThan(0);
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: herdr-wins emits a negative window when Stop arrives after the done-flip", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    const t1 = h.now();
    h.setStatus("done"); // done flip, no pending stop → parks pendingDone, no emit yet
    h.poller.tick();
    expect(h.windows).toHaveLength(0);

    h.advance(1500); // t2 within window
    const t2 = h.now();
    h.poller.ingestStopMeasure(h.id, t2);
    expect(h.windows).toEqual([{ id: h.id, windowMs: t1 - t2 }]);
    expect(t1 - t2).toBeLessThan(0);
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: no-stop null emitted on expiry when a done-flip never pairs", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    h.setStatus("done"); // done flip, no stop → pendingDone parked
    h.poller.tick();
    expect(h.windows).toHaveLength(0);

    h.advance(31_000); // past the 30s horizon
    h.poller.tick(); // expiry sweep fires the null
    expect(h.windows).toEqual([{ id: h.id, windowMs: null }]);
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: a stale Stop with no done-flip is dropped silently (no emit)", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    h.poller.ingestStopMeasure(h.id, h.now());
    // never flips to done; advance past the horizon and tick the expiry sweep
    h.advance(31_000);
    h.poller.tick();
    expect(h.windows).toHaveLength(0); // a Stop with no done-flip is not a done-flip
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: a superseded prior done emits null when overwritten by a fresh done", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    h.setStatus("done"); // done flip #1 at t1 (no stop → pendingDone parked)
    h.poller.tick();
    expect(h.windows).toHaveLength(0);

    // leave done so a later done flip is a fresh EDGE
    h.advance(1000);
    h.setStatus("working");
    h.poller.tick();

    // done flip #2 within the horizon, still no stop → supersedes the parked t1 done
    h.advance(1000);
    h.setStatus("done");
    h.poller.tick();
    expect(h.windows).toEqual([{ id: h.id, windowMs: null }]); // the superseded t1 done
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: a Stop arriving past the horizon after a parked done parks instead of pairing", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    // done flip parks pendingDoneAt at t1 (no stop yet); same-tick expiry can't clear it (age 0)
    h.setStatus("done");
    h.poller.tick();
    expect(h.windows).toHaveLength(0);

    // a Stop arrives MORE than the horizon later — but no tick ran, so the parked done survives.
    // ingestStopMeasure's out-of-horizon branch must park the Stop, NOT pair it (no herdr-wins emit).
    h.advance(31_000);
    h.poller.ingestStopMeasure(h.id, h.now());
    expect(h.windows).toHaveLength(0);
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: a stale hookAwaitingInput marker does not swallow the measurement", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    // arm the awaiting-input marker (would short-circuit reconcileAgent at tryHookAwaitingBlock)
    h.poller.ingestNotification(h.id, "permission_prompt");
    const t1 = h.now();
    h.poller.ingestStopMeasure(h.id, t1);

    h.advance(2000);
    const t2 = h.now();
    h.setStatus("done");
    h.poller.tick();
    // the measurement still fires — emit is structurally before reconcileAgent's tryHookAwaitingBlock early-return
    expect(h.windows).toEqual([{ id: h.id, windowMs: t2 - t1 }]);
  } finally {
    config.hooksSignals = orig;
  }
});

test("stop-window: measurement is observe-only — status still flips and onChange fires once", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = stopHarness();
    h.poller.tick(); // prime: working → onChange(running)
    const beforeDone = h.changes.length;

    const t1 = h.now();
    h.poller.ingestStopMeasure(h.id, t1);
    h.advance(2000);
    const t2 = h.now();
    h.setStatus("done");
    h.poller.tick();

    expect(h.windows).toEqual([{ id: h.id, windowMs: t2 - t1 }]); // stop-wins
    expect(h.store.get(h.id)?.status).toBe("done"); // routing untouched
    const doneEdges = h.changes.slice(beforeDone).filter((c) => c.status === "done");
    expect(doneEdges).toEqual([{ id: h.id, status: "done" }]); // exactly one done edge
  } finally {
    config.hooksSignals = orig;
  }
});
