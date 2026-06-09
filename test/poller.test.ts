import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";
import { classifyBlocked } from "../src/blocked";
import { DEFAULT_STALL } from "../src/stall";
import { maintenance } from "../src/maintenance";

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

/** A running agent with an empty transcript falls into the interim path, whose
 *  terminal read is dispatched fire-and-forget (async `readAsync`) off the
 *  synchronous tick — so its onActivity/onBlock effects (incl. the resume
 *  block-clear) land on a later microtask. Flush a cycle before asserting them. */
const flush = () => new Promise((r) => setTimeout(r, 0));

test("tick maps herdr state to status and emits only on change", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: { id: string; status: string }[] = [];

  let agents: HerdrAgent[] = [
    {
      agent: "claude",
      agentStatus: "working",
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "",
      terminalId: "term_a",
      workspaceId: "w",
    },
  ];

  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as any,
    (id, status) => emitted.push({ id, status }),
    () => {},
  );

  poller.tick();
  expect(store.get(s.id)?.status).toBe("running");
  expect(emitted).toEqual([{ id: s.id, status: "running" }]);

  poller.tick(); // unchanged → no new emit
  expect(emitted.length).toBe(1);

  agents = [{ ...agents[0]!, agentStatus: "blocked" }];
  poller.tick();
  expect(store.get(s.id)?.status).toBe("blocked");
  expect(emitted.length).toBe(2);
});

test("emits onBlock with a classified reason for blocked sessions, clears on resume", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  let agentStatus: "working" | "blocked" = "blocked";
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
      },
    ],
    read: () => "❯ 1. Yes\n  2. No",
    // resume runs the interim path (no injected transcript probe → empty signals),
    // whose block-clear is async; provide the async read so it fires
    readAsync: () => Promise.resolve("❯ 1. Yes\n  2. No"),
  };

  let clock = 100_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );

  poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("menu");

  // within the reclassify window + same content → no new emit
  clock += 1000;
  poller.tick();
  expect(blocks).toHaveLength(1);

  // agent resumes → exactly one clear emit (block === null)
  agentStatus = "working";
  clock += 5000;
  poller.tick();
  await flush();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });
});

test("re-emits onBlock when the blocked reason changes after the cadence", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];
  let text = "❯ 1. Yes\n  2. No";
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "blocked",
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => text,
  };
  let clock = 100_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );
  poller.tick();
  expect(blocks).toHaveLength(1);
  text = "Continue? (y/n)";
  clock += 5000;
  poller.tick();
  expect(blocks).toHaveLength(2);
  expect((blocks[1]!.block as any).shape).toBe("yes-no");
});

test("marks a session done and emits once when its herdr agent is gone", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: { id: string; status: string }[] = [];

  // herdr no longer lists the agent (claude exited / ctrl-c reaped the terminal)
  const poller = new StatusPoller(
    store,
    { list: () => [] as HerdrAgent[], read: () => "" } as any,
    (id, status) => emitted.push({ id, status }),
    () => {},
  );

  poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
  expect(store.get(s.id)?.lastState).toBe("done");
  expect(emitted).toEqual([{ id: s.id, status: "done" }]);

  poller.tick(); // already done → no duplicate emit
  expect(emitted.length).toBe(1);
});

test("clears an active block when the agent disappears", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  let agents: HerdrAgent[] = [
    {
      agent: "claude",
      agentStatus: "blocked",
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "",
      terminalId: "term_a",
      workspaceId: "w",
    },
  ];
  let clock = 100_000;
  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "❯ 1. Yes\n  2. No" } as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );

  poller.tick();
  expect(blocks).toHaveLength(1); // classified the block

  agents = []; // agent gone
  clock += 5000;
  poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
  expect(blocks[blocks.length - 1]).toEqual({ id: s.id, block: null }); // block cleared
});

test("flags a silent working agent with a FROZEN terminal as a stall, fires once, re-arms on resume", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  // a frozen terminal — the visible buffer never changes between probes, so the
  // liveness gate confirms the transcript-silence candidate as a genuine stall.
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working",
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => "still chewing on it",
  };

  let clock = 1_700_000_000_000; // realistic ms epoch so a past lastTs stays positive
  let stalled = true;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    // combined probe: one read → both signals. activity null here (stall-only test).
    () => ({
      snapshot: { lastTs: stalled ? clock - 600_000 : clock, pending: false },
      activity: null,
    }),
    { stallMs: 1, pendingStallMs: 1 }, // 10m-old activity counts as stalled; fresh does not
    7000, // probeCheckMs
  );

  // first candidate probe only captures a terminal baseline — no emit yet
  poller.tick();
  expect(blocks).toHaveLength(0);

  // next probe: terminal unchanged + transcript silent → stall fires
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");
  expect((blocks[0]!.block as any).tail).toEqual(["still chewing on it"]);

  // throttled within probeCheckMs → no re-probe
  clock += 1000;
  poller.tick();
  expect(blocks).toHaveLength(1);

  // past the throttle, still stalled → fires only once per episode
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(1);

  // transcript progresses → one clear, then re-arms for the next episode
  stalled = false;
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });

  // stalled again: baseline was reset on resume, so the first probe defers again…
  stalled = true;
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(2);
  // …and the next confirms the frozen terminal → fires
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(3);
  expect((blocks[2]!.block as any).shape).toBe("stall");
});

test("does NOT flag a transcript-silent agent whose terminal is still moving (live generation)", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  // the agent is mid-generation: no tool-use (transcript silent) but the spinner /
  // token counter ticks, so the visible buffer changes every probe.
  let frame = 0;
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => `Computing… (${frame}s • ${frame}k tokens)`,
  };

  let clock = 1_700_000_000_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({ snapshot: { lastTs: clock - 600_000, pending: false }, activity: null }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
  );

  // probe across several cadences — the terminal changes each time → never a stall
  for (let i = 0; i < 4; i++) {
    frame += 13;
    poller.tick();
    clock += 7000;
  }
  expect(blocks).toHaveLength(0);
});

test("fires a stall for a hung command (pending past the ceiling) even when the terminal keeps ticking", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  // a tool stuck "running" past pendingStallMs: its "esc to interrupt" elapsed
  // timer keeps the visible buffer changing every probe. The liveness diff must
  // NOT treat that motion as alive — the pending path bypasses the gate.
  let frame = 0;
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => `$ slow-cmd  (esc to interrupt · ${frame}s)`,
  };

  let clock = 1_700_000_000_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    // pending=true → the hung-command path; gap (600s) is past pendingStallMs (1ms)
    () => ({ snapshot: { lastTs: clock - 600_000, pending: true }, activity: null }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
  );

  // pending candidate fires immediately (no baseline defer) despite the moving terminal
  frame += 5;
  poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // still hung + still ticking → once per episode, no re-fire / no false clear
  frame += 5;
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(1);
});

test("clears an emitted stall when the terminal resumes moving even before the transcript catches up", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  // transcript stays silent throughout (slow tool-less turn); only the terminal
  // tells us whether the turn is alive.
  let visible = "frozen";
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => visible,
  };

  let clock = 1_700_000_000_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({ snapshot: { lastTs: clock - 600_000, pending: false }, activity: null }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
  );

  poller.tick(); // baseline
  clock += 7000;
  poller.tick(); // frozen → stall fires
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // terminal resumes ticking while the transcript is still silent → clear the stall
  visible = "Computing… (601s)";
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });
});

test("acknowledgeStall clears the flag without re-firing while still stalled", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working",
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => "still chewing on it",
  };

  let clock = 1_700_000_000_000;
  let stalled = true;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({
      snapshot: { lastTs: stalled ? clock - 600_000 : clock, pending: false },
      activity: null,
    }),
    { stallMs: 1, pendingStallMs: 1 },
    7000, // probeCheckMs
  );

  poller.tick(); // baseline capture, no emit yet
  expect(blocks).toHaveLength(0);
  clock += 7000;
  poller.tick(); // frozen terminal → stall fires
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // manual dismiss: clears the flag now, but keeps the once-per-episode guard
  expect(poller.acknowledgeStall(s.id)).toBe(true);
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });

  // still stalled on the next probe → does NOT re-announce (episode acknowledged)
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(2);

  // transcript progresses → episode re-arms; acknowledgeStall now no-ops (no live stall)
  stalled = false;
  clock += 7000;
  poller.tick();
  expect(poller.acknowledgeStall(s.id)).toBe(false);

  // a later stall fires again (baseline reset on resume → defer one probe, then fire)
  stalled = true;
  clock += 7000;
  poller.tick();
  clock += 7000;
  poller.tick();
  expect((blocks[blocks.length - 1]!.block as any).shape).toBe("stall");
});

test.each(["working", "blocked"] as const)(
  "auto-clears readyToMerge when a ready session transitions to %s",
  (agentStatus) => {
    const store = new SessionStore(":memory:");
    const s = store.create(baseSession);
    store.update(s.id, { readyToMerge: true });
    const ready: { id: string; ready: boolean }[] = [];

    const agents: HerdrAgent[] = [
      {
        agent: "claude",
        agentStatus,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ];

    const poller = new StatusPoller(
      store,
      { list: () => agents, read: () => "" } as any,
      () => {},
      () => {},
      1000,
      3000,
      classifyBlocked,
      () => 100_000,
      undefined,
      DEFAULT_STALL,
      30_000,
      (id, ready2) => ready.push({ id, ready: ready2 }),
    );

    poller.tick();
    expect(store.get(s.id)?.readyToMerge).toBe(false);
    expect(ready).toEqual([{ id: s.id, ready: false }]);

    poller.tick(); // already cleared → no duplicate emit
    expect(ready).toHaveLength(1);
  },
);

test("leaves readyToMerge untouched while a ready session stays idle", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  store.update(s.id, { readyToMerge: true });
  const ready: unknown[] = [];

  // herdr "done" maps to idle status — not running/blocked, so the flag is sticky
  const poller = new StatusPoller(
    store,
    {
      list: (): HerdrAgent[] => [
        {
          agent: "claude",
          agentStatus: "done",
          cwd: "/wt",
          paneId: "p",
          tabId: "t",
          name: "",
          terminalId: "term_a",
          workspaceId: "w",
        },
      ],
      read: () => "",
    } as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => 100_000,
    undefined,
    DEFAULT_STALL,
    30_000,
    (id, r) => ready.push({ id, r }),
  );

  poller.tick();
  expect(store.get(s.id)?.readyToMerge).toBe(true);
  expect(ready).toHaveLength(0);
});

test("does not emit onBlock when reading the terminal throws", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: unknown[] = [];
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "blocked",
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => {
      throw new Error("herdr down");
    },
  };
  const clock = 100_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (_id, block) => blocks.push(block),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );
  poller.tick();
  expect(blocks).toHaveLength(0);
});

// ── maybeActivity ─────────────────────────────────────────────────────────────

const runningHerdr = {
  list: (): HerdrAgent[] => [
    {
      agent: "claude",
      agentStatus: "working" as const,
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "",
      terminalId: "term_a",
      workspaceId: "w",
    },
  ],
  read: () => "",
};

test("maybeActivity emits via onActivity when the probe returns a signal", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: { id: string; activity: unknown }[] = [];

  const clock = 100_000;
  const signal = {
    lastActivityTs: 999,
    summary: "edited poller.ts",
    recentTs: [],
    recentErrTs: [],
  };
  const poller = new StatusPoller(
    store,
    runningHerdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({ snapshot: null, activity: signal }), // combined probe — same signal
    DEFAULT_STALL,
    7000, // probeCheckMs
    () => {}, // onReady
    (id, activity) => activities.push({ id, activity }),
  );

  poller.tick();
  expect(activities).toHaveLength(1);
  expect(activities[0]!.activity).toEqual(signal);
});

test("maybeActivity dedups identical signals — does not re-emit unchanged activity", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: unknown[] = [];

  let clock = 100_000;
  const signalA = { lastActivityTs: 1234, summary: "$ bun test", recentTs: [], recentErrTs: [] };
  const signalB = {
    lastActivityTs: 5678,
    summary: "wrote config.ts",
    recentTs: [],
    recentErrTs: [],
  };
  let currentSignal: typeof signalA | typeof signalB = signalA;

  const poller = new StatusPoller(
    store,
    runningHerdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({ snapshot: null, activity: currentSignal }), // probe tracks currentSignal
    DEFAULT_STALL,
    7000,
    () => {},
    (_id, activity) => activities.push(activity),
  );

  poller.tick(); // first emit — signalA
  expect(activities).toHaveLength(1);

  // advance past throttle, same signal → dedup must suppress re-emit
  clock += 8000;
  poller.tick();
  expect(activities).toHaveLength(1);

  // swap signal in place → same poller must detect the change and re-emit
  clock += 8000;
  currentSignal = signalB;
  poller.tick();
  expect(activities).toHaveLength(2);
  expect(activities[1]).toEqual(signalB);
});

test("maybeActivity respects activityCheckMs throttle", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: unknown[] = [];

  let clock = 100_000;
  let callCount = 0;
  const probe = () => {
    callCount++;
    return {
      snapshot: null,
      activity: {
        lastActivityTs: clock,
        summary: `tick ${callCount}`,
        recentTs: [],
        recentErrTs: [],
      },
    };
  };

  const poller = new StatusPoller(
    store,
    runningHerdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    probe,
    DEFAULT_STALL,
    7000, // probeCheckMs
    () => {},
    (_id, activity) => activities.push(activity),
  );

  poller.tick(); // probe called, signal emitted
  expect(callCount).toBe(1);
  expect(activities).toHaveLength(1);

  clock += 3000; // within probeCheckMs (7000) → throttled
  poller.tick();
  expect(callCount).toBe(1); // probe NOT called again yet

  clock += 5000; // now past the 7000ms throttle
  poller.tick();
  expect(callCount).toBe(2); // probe called again
});

test("maybeActivity skips emit when probe returns null", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: unknown[] = [];

  const poller = new StatusPoller(
    store,
    runningHerdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => 100_000,
    () => ({ snapshot: null, activity: null }), // no signal yet
    DEFAULT_STALL,
    7000,
    () => {},
    (_id, activity) => activities.push(activity),
  );

  poller.tick();
  expect(activities).toHaveLength(0);
});

test("maybeActivity does not run for non-running (idle/blocked) sessions", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: unknown[] = [];
  let probeCallCount = 0;

  // herdr reports "done" → maps to idle
  const idleHerdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "done" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => "",
  };

  const poller = new StatusPoller(
    store,
    idleHerdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => 100_000,
    () => {
      probeCallCount++;
      return {
        snapshot: null,
        activity: { lastActivityTs: 1, summary: "edited x.ts", recentTs: [], recentErrTs: [] },
      };
    },
    DEFAULT_STALL,
    7000,
    () => {},
    (_id, activity) => activities.push(activity),
  );

  poller.tick();
  expect(probeCallCount).toBe(0);
  expect(activities).toHaveLength(0);
});

// ── interim terminal-diff path (transcript stopped live-writing) ───────────────

import { STRIP_WINDOW_MS } from "../src/activity-signal";

/** A running agent whose transcript probe yields NOTHING (the CC 2.1.169 case):
 *  both snapshot and activity are null, so the poller falls back to the
 *  terminal-diff interim path. `readAsync("visible")` resolves whatever `visible`
 *  holds. */
function interimHarness(opts: {
  store: SessionStore;
  visible: () => string;
  now: () => number;
  stallCfg?: { stallMs: number; pendingStallMs: number };
  onBlock?: (id: string, block: unknown) => void;
  onActivity?: (id: string, activity: unknown) => void;
}) {
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => opts.visible(),
    readAsync: () => Promise.resolve(opts.visible()),
  };
  return new StatusPoller(
    opts.store,
    herdr as any,
    () => {},
    (id, block) => opts.onBlock?.(id, block),
    1000,
    3000,
    classifyBlocked,
    opts.now,
    () => ({ snapshot: null, activity: null }), // empty transcript → interim path
    opts.stallCfg ?? { stallMs: 1, pendingStallMs: 1 },
    7000, // probeCheckMs
    () => {},
    (id, activity) => opts.onActivity?.(id, activity),
  );
}

test("interim: empty transcript + changing terminal accrues heartbeat ticks, never stalls", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const activities: { id: string; activity: any }[] = [];
  const blocks: unknown[] = [];

  let clock = 1_700_000_000_000;
  let frame = 0;
  const poller = interimHarness({
    store,
    visible: () => `Computing… (${frame}s)`,
    now: () => clock,
    onActivity: (id, activity) => activities.push({ id, activity }),
    onBlock: (_id, block) => blocks.push(block),
  });

  // first probe: captures baseline, no change to diff against yet → no tick, no emit
  poller.tick();
  await flush();
  expect(activities).toHaveLength(0);

  // subsequent probes: terminal changes each cadence → a tick accrues each time
  for (let i = 0; i < 3; i++) {
    frame += 7;
    clock += 7000;
    poller.tick();
    await flush();
  }
  expect(blocks).toHaveLength(0); // moving terminal never stalls
  expect(activities.length).toBeGreaterThan(0);
  const last = activities[activities.length - 1]!.activity;
  expect(last.recentTs.length).toBeGreaterThan(0);
  expect(last.summary).toBeNull();
  expect(last.recentErrTs).toEqual([]);
  expect(last.lastActivityTs).toBe(last.recentTs[last.recentTs.length - 1]);
  expect(last.id ?? s.id).toBe(s.id);
});

test("interim: heartbeat ticks are windowed to STRIP_WINDOW_MS", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: any[] = [];

  let clock = 1_700_000_000_000;
  let frame = 0;
  const poller = interimHarness({
    store,
    visible: () => `frame ${frame}`,
    now: () => clock,
    onActivity: (_id, activity) => activities.push(activity),
  });

  poller.tick(); // baseline
  await flush();
  // accrue ticks well past the window so the oldest must be dropped
  const totalSpan = STRIP_WINDOW_MS * 2;
  let elapsed = 0;
  while (elapsed < totalSpan) {
    frame += 1;
    clock += 7000;
    elapsed += 7000;
    poller.tick();
    await flush();
  }
  const last = activities[activities.length - 1]!;
  for (const ts of last.recentTs) {
    expect(ts).toBeGreaterThanOrEqual(clock - STRIP_WINDOW_MS);
    expect(ts).toBeLessThanOrEqual(clock);
  }
});

test("interim: static terminal for ≥ stallMs fires a stall once, then clears when it moves again", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: any }[] = [];

  let clock = 1_700_000_000_000;
  let visible = "frozen output";
  const poller = interimHarness({
    store,
    visible: () => visible,
    now: () => clock,
    stallCfg: { stallMs: 10_000, pendingStallMs: 10_000 },
    onBlock: (id, block) => blocks.push({ id, block }),
  });

  // first probe: baseline only — must NOT fire even though static
  poller.tick();
  await flush();
  expect(blocks).toHaveLength(0);

  // still static, but not yet past stallMs → no fire
  clock += 7000;
  poller.tick();
  await flush();
  expect(blocks).toHaveLength(0);

  // past stallMs of no change → stall fires once
  clock += 7000;
  poller.tick();
  await flush();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");
  expect((blocks[0]!.block as any).tail).toEqual(["frozen output"]);

  // still static past throttle → once per episode, no re-fire
  clock += 7000;
  poller.tick();
  await flush();
  expect(blocks).toHaveLength(1);

  // terminal moves again → stall clears
  visible = "moving now";
  clock += 7000;
  poller.tick();
  await flush();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });
});

test("interim: first static sample defers — does not fire immediately", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: unknown[] = [];

  const clock = 1_700_000_000_000;
  const poller = interimHarness({
    store,
    visible: () => "static",
    now: () => clock,
    stallCfg: { stallMs: 1, pendingStallMs: 1 }, // even with a 1ms window…
    onBlock: (_id, block) => blocks.push(block),
  });

  // …the very first sample has no baseline to diff against → defer, no fire
  poller.tick();
  await flush();
  expect(blocks).toHaveLength(0);
});

test("interim: terminal read throwing is best-effort — no throw, no emit", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: unknown[] = [];
  const activities: unknown[] = [];

  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    readAsync: () => Promise.reject(new Error("herdr down")),
  };
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (_id, block) => blocks.push(block),
    1000,
    3000,
    classifyBlocked,
    () => 1_700_000_000_000,
    () => ({ snapshot: null, activity: null }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
    () => {},
    (_id, activity) => activities.push(activity),
  );

  expect(() => poller.tick()).not.toThrow();
  await flush();
  expect(blocks).toHaveLength(0);
  expect(activities).toHaveLength(0);
});

test("interim: a second probe while the first read is in flight does not start a second read", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  let reads = 0;
  let resolveFirst!: (text: string) => void;

  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    // first read hangs (caller controls when it resolves); count every call
    readAsync: () => {
      reads++;
      return new Promise<string>((r) => {
        resolveFirst = r;
      });
    },
  };

  let clock = 1_700_000_000_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({ snapshot: null, activity: null }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
    () => {},
    () => {},
  );

  // first tick dispatches a read that never resolves yet
  poller.tick();
  await flush();
  expect(reads).toBe(1);

  // advance past the throttle so the throttle alone wouldn't block a second probe,
  // tick again → the in-flight guard must suppress a second read
  clock += 7000;
  poller.tick();
  await flush();
  expect(reads).toBe(1);

  // let the first read finish → the next probe is free to read again
  resolveFirst("done");
  await flush();
  clock += 7000;
  poller.tick();
  await flush();
  expect(reads).toBe(2);
});

test("interim path is NOT used when the transcript probe returns a non-null signal", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const activities: { id: string; activity: any }[] = [];
  const blocks: unknown[] = [];
  let visibleReads = 0;

  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "working" as const,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        name: "",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    // a healthy (non-stalled) transcript signal must not read the terminal by
    // EITHER path — the interim uses readAsync, evaluateStall the sync read
    read: () => {
      visibleReads++;
      return "irrelevant";
    },
    readAsync: () => {
      visibleReads++;
      return Promise.resolve("irrelevant");
    },
  };

  let clock = 1_700_000_000_000;
  const transcriptSignal = {
    lastActivityTs: 1234,
    summary: "edited poller.ts",
    recentTs: [1234],
    recentErrTs: [],
  };
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (_id, block) => blocks.push(block),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    // transcript yields data → existing path, interim path stays dormant
    () => ({ snapshot: { lastTs: clock, pending: false }, activity: transcriptSignal }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
    () => {},
    (id, activity) => activities.push({ id, activity }),
  );

  poller.tick();
  clock += 7000;
  poller.tick();
  await flush();

  // the transcript-driven emit still happens (real summary, not interim's null)
  expect(activities.length).toBeGreaterThan(0);
  expect(activities[0]!.activity.summary).toBe("edited poller.ts");
  expect(activities[0]!.id).toBe(s.id);
  // a non-stalled transcript snapshot clears the block path without reading the
  // terminal → the interim heartbeat/stall maps never get touched, no visible read
  expect(visibleReads).toBe(0);
  expect(blocks.every((b) => b === null || b === undefined)).toBe(true);
});

test("pruneInactive clears activity tracking for a running-only session that goes away", () => {
  // A session that was only ever running (never blocked) populates lastProbeAt
  // and lastActivitySig but never lastSig — the old pruneInactive iterated only
  // lastSig.keys() and so those entries leaked. After prune, re-adding the same
  // session must re-emit on the first tick (sig map was cleared).
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const activities: unknown[] = [];

  let clock = 100_000;
  let agents: HerdrAgent[] = [
    {
      agent: "claude",
      agentStatus: "working" as const,
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "",
      terminalId: "term_a",
      workspaceId: "w",
    },
  ];

  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({
      snapshot: null,
      activity: { lastActivityTs: clock, summary: "edited x.ts", recentTs: [], recentErrTs: [] },
    }),
    DEFAULT_STALL,
    7000,
    () => {},
    (_id, activity) => activities.push(activity),
  );

  poller.tick(); // populates lastProbeAt + lastActivitySig
  expect(activities).toHaveLength(1);

  // session is archived — poller sees empty store list → pruneInactive fires
  store.update(s.id, { status: "archived" });
  agents = [];
  clock += 8000;
  poller.tick(); // pruneInactive must clear lastProbeAt + lastActivitySig

  // session comes back (status reset to pending then running via herdr)
  store.update(s.id, { status: "running" });
  agents = [
    {
      agent: "claude",
      agentStatus: "working" as const,
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "",
      terminalId: "term_a",
      workspaceId: "w",
    },
  ];
  clock += 8000;
  poller.tick(); // must re-emit — activity sig map was cleared by prune
  expect(activities).toHaveLength(2);
});

test("tick adopts a resurrected agent by cwd, re-points the id, emits, and does NOT reap", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, worktreePath: "/wt", herdrAgentId: "term_stale" });
  const emitted: { id: string; status: string }[] = [];

  const agents: HerdrAgent[] = [
    {
      agent: "claude",
      agentStatus: "working",
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "x",
      terminalId: "term_fresh",
      workspaceId: "w",
    },
  ];

  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as any,
    (id, status) => emitted.push({ id, status }),
    () => {},
  );

  poller.tick();
  const out = store.get(s.id);
  expect(out?.herdrAgentId).toBe("term_fresh"); // adopted, not reaped
  expect(out?.status).toBe("running");
  expect(emitted).toContainEqual({ id: s.id, status: "running" });
});

test("tick reaps when neither terminalId nor cwd matches a live agent", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, worktreePath: "/wt", herdrAgentId: "term_stale" });

  const poller = new StatusPoller(
    store,
    { list: () => [], read: () => "" } as any,
    () => {},
    () => {},
  );

  poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
});

test("activitySnapshot returns last emitted signal, pruned when the session goes away", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);

  let clock = 100_000;
  let agents: HerdrAgent[] = [
    {
      agent: "claude",
      agentStatus: "working" as const,
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "",
      terminalId: "term_a",
      workspaceId: "w",
    },
  ];

  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({
      snapshot: null,
      activity: { lastActivityTs: clock, summary: "edited x.ts", recentTs: [], recentErrTs: [] },
    }),
    DEFAULT_STALL,
    7000,
    () => {},
    () => {},
  );

  poller.tick(); // probe emits → caches the signal
  expect(poller.activitySnapshot()).toEqual({
    [s.id]: { lastActivityTs: 100_000, summary: "edited x.ts", recentTs: [], recentErrTs: [] },
  });

  // session archived → next tick prunes it out of the snapshot too
  store.update(s.id, { status: "archived" });
  agents = [];
  clock += 8000;
  poller.tick();
  expect(poller.activitySnapshot()).toEqual({});
});

test("tick() is a no-op while maintenance is active (no herdr call, no reap)", () => {
  let listCalls = 0;
  const store = {
    list: () => {
      throw new Error("store.list must not be reached during maintenance");
    },
  } as unknown as import("../src/store").SessionStore;
  const herdr = {
    list: () => {
      listCalls++;
      return [];
    },
    read: () => "",
    readAsync: () => Promise.resolve(""),
  };
  const poller = new StatusPoller(
    store,
    herdr,
    () => {},
    () => {},
  );
  maintenance.begin();
  try {
    poller.tick();
    expect(listCalls).toBe(0);
  } finally {
    maintenance.end();
  }
});

test("tick() swallows a herdr.list() throw (no crash, no reap)", () => {
  let reaped = false;
  const store = {
    list: () => {
      // would only be reached if tick() didn't bail on the list() throw; a reap
      // here would flip the session to done
      reaped = true;
      return [{ id: "s1", herdrAgentId: "t1", status: "running" }];
    },
    update: () => {
      reaped = true;
    },
  } as unknown as import("../src/store").SessionStore;
  const herdr = {
    list: () => {
      throw new Error("herdr list timed out"); // simulate HERDR_TIMEOUT_MS firing
    },
    read: () => "",
    readAsync: () => Promise.resolve(""),
  };
  const poller = new StatusPoller(
    store,
    herdr,
    () => {},
    () => {},
  );
  // must NOT throw (an unhandled throw on the 1s interval would crash shepherd)
  expect(() => poller.tick()).not.toThrow();
  expect(reaped).toBe(false); // tick bailed before touching the store
});
