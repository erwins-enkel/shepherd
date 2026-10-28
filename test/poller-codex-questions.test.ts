import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { BlockReason } from "../src/blocked";
import type { PendingAsk } from "../src/ask-user-question";

const ASK: PendingAsk = {
  toolUseId: "q",
  questions: [
    {
      id: "0",
      question: "Color?",
      header: "",
      options: [{ label: "Blue", description: "" }],
      multiSelect: false,
    },
  ],
};

test("Codex poller publishes queued questions while working and clears native resolution", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "probe",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "s",
    herdrAgentId: "t",
    agentProvider: "codex",
  });
  let asks = [ASK];
  let visible = asks;
  const blocks: (BlockReason | null)[] = [];
  let readFailed = false;
  const herdr = {
    listAsync: async () => [
      {
        agent: "codex",
        agentStatus: "working",
        cwd: "/wt",
        paneId: "p",
        tabId: "tab",
        name: "",
        terminalId: "t",
        workspaceId: "w",
      },
    ],
    readAsync: async () => {
      if (readFailed) throw new Error("terminal unavailable");
      return "• Working\n? 1 question\nshift+← to answer";
    },
  };
  let now = 0;
  const poller = new StatusPoller(
    store,
    herdr as never,
    () => {},
    (_id, b) => blocks.push(b),
    1000,
    3000,
    undefined,
    () => now,
  );
  poller.codexQuestions = {
    refresh: async () => {},
    observe: () => (visible = asks),
    pending: () => visible,
    prune: () => {},
  };
  await poller.tick();
  expect(poller.blockSnapshot()[s.id]?.asks).toEqual([ASK]);
  expect(poller.blockSnapshot()[s.id]?.ask).toEqual(ASK);
  await poller.tick();
  expect(blocks.filter(Boolean)).toHaveLength(1);
  readFailed = true;
  now += 5000;
  await poller.tick();
  expect(poller.blockSnapshot()[s.id]?.ask).toEqual(ASK);
  readFailed = false;
  asks = [];
  await poller.tick();
  expect(poller.blockSnapshot()[s.id]?.ask).toEqual(ASK);
  now += 2001;
  await poller.tick();
  expect(poller.blockSnapshot()[s.id]?.ask).toBeUndefined();
});
