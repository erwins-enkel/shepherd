import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";
import { classifyBlocked } from "../src/blocked";
import { DEFAULT_STALL } from "../src/stall";

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

test("emits onBlock with a classified reason for blocked sessions, clears on resume", () => {
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

test("flags a silent working agent as a stall, fires once, re-arms on resume", () => {
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
    () => ({ lastTs: stalled ? clock - 600_000 : clock, pending: false }),
    { stallMs: 1, pendingStallMs: 1 }, // 10m-old activity counts as stalled; fresh does not
    30_000,
  );

  poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");
  expect((blocks[0]!.block as any).tail).toEqual(["still chewing on it"]);

  // throttled within stallCheckMs → no re-probe
  clock += 1000;
  poller.tick();
  expect(blocks).toHaveLength(1);

  // past the throttle, still stalled → fires only once per episode
  clock += 30_000;
  poller.tick();
  expect(blocks).toHaveLength(1);

  // activity resumes → one clear, then re-arms for the next episode
  stalled = false;
  clock += 30_000;
  poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });

  stalled = true;
  clock += 30_000;
  poller.tick();
  expect(blocks).toHaveLength(3);
  expect((blocks[2]!.block as any).shape).toBe("stall");
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
    () => ({ lastTs: stalled ? clock - 600_000 : clock, pending: false }),
    { stallMs: 1, pendingStallMs: 1 },
    30_000,
  );

  poller.tick(); // stall fires
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // manual dismiss: clears the flag now, but keeps the once-per-episode guard
  expect(poller.acknowledgeStall(s.id)).toBe(true);
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });

  // still stalled on the next probe → does NOT re-announce (episode acknowledged)
  clock += 30_000;
  poller.tick();
  expect(blocks).toHaveLength(2);

  // activity resumes → episode re-arms; acknowledgeStall now no-ops (no live stall)
  stalled = false;
  clock += 30_000;
  poller.tick();
  expect(poller.acknowledgeStall(s.id)).toBe(false);

  // a later stall fires again
  stalled = true;
  clock += 30_000;
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
  const signal = { lastActivityTs: 999, summary: "edited poller.ts" };
  const poller = new StatusPoller(
    store,
    runningHerdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    undefined, // stallProbe
    DEFAULT_STALL,
    30_000,
    () => {}, // onReady
    (id, activity) => activities.push({ id, activity }),
    7000, // activityCheckMs
    () => signal, // activityProbe — always returns the same signal
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
  const signalA = { lastActivityTs: 1234, summary: "$ bun test" };
  const signalB = { lastActivityTs: 5678, summary: "wrote config.ts" };
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
    undefined,
    DEFAULT_STALL,
    30_000,
    () => {},
    (_id, activity) => activities.push(activity),
    7000,
    () => currentSignal, // probe returns whatever currentSignal points to
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
    return { lastActivityTs: clock, summary: `tick ${callCount}` };
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
    undefined,
    DEFAULT_STALL,
    30_000,
    () => {},
    (_id, activity) => activities.push(activity),
    7000, // activityCheckMs
    probe,
  );

  poller.tick(); // probe called, signal emitted
  expect(callCount).toBe(1);
  expect(activities).toHaveLength(1);

  clock += 3000; // within activityCheckMs (7000) → throttled
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
    undefined,
    DEFAULT_STALL,
    30_000,
    () => {},
    (_id, activity) => activities.push(activity),
    7000,
    () => null, // no signal yet
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
    undefined,
    DEFAULT_STALL,
    30_000,
    () => {},
    (_id, activity) => activities.push(activity),
    7000,
    () => {
      probeCallCount++;
      return { lastActivityTs: 1, summary: "edited x.ts" };
    },
  );

  poller.tick();
  expect(probeCallCount).toBe(0);
  expect(activities).toHaveLength(0);
});

test("pruneInactive clears activity tracking for a running-only session that goes away", () => {
  // A session that was only ever running (never blocked) populates lastActivityAt
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
    undefined,
    DEFAULT_STALL,
    30_000,
    () => {},
    (_id, activity) => activities.push(activity),
    7000,
    () => ({ lastActivityTs: clock, summary: "edited x.ts" }),
  );

  poller.tick(); // populates lastActivityAt + lastActivitySig
  expect(activities).toHaveLength(1);

  // session is archived — poller sees empty store list → pruneInactive fires
  store.update(s.id, { status: "archived" });
  agents = [];
  clock += 8000;
  poller.tick(); // pruneInactive must clear lastActivityAt + lastActivitySig

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
