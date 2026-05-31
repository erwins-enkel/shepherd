import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";
import { classifyBlocked } from "../src/blocked";

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
