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
