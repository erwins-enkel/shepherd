// #3165: the poller carries the PreToolUse(AskUserQuestion) dialog on the announced block as
// `ask`, re-emits on ask arrival / end, and exposes it only while a block is announced.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import { classifyBlocked, type BlockReason } from "../src/blocked";
import type { HerdrAgent } from "../src/herdr";
import type { PendingAsk } from "../src/ask-user-question";

const MENU = "Pick a color?\n❯ 1. Red\n  2. Blue\nEnter to select · Esc to cancel";
const ASK: PendingAsk = {
  toolUseId: "toolu_1",
  questions: [
    {
      question: "Pick a color?",
      header: "Color",
      multiSelect: false,
      options: [
        { label: "Red", description: "" },
        { label: "Blue", description: "" },
      ],
    },
  ],
};

function rig() {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
  });
  const blocks: (BlockReason | null)[] = [];
  let clock = 100_000;
  const list = (): HerdrAgent[] => [
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
  const herdr = {
    list,
    listAsync: () => Promise.resolve(list()),
    read: () => MENU,
    readAsync: () => Promise.resolve(MENU),
  };
  const poller = new StatusPoller(
    store,
    herdr as never,
    () => {},
    (_id, block) => blocks.push(block),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );
  return {
    poller,
    blocks,
    id: s.id,
    tick: async () => {
      clock += 5000;
      await poller.tick();
    },
  };
}

test("an ask arriving before the block rides the first announcement", async () => {
  const r = rig();
  r.poller.ingestAsk(r.id, ASK);
  expect(r.blocks).toHaveLength(0); // nothing announced yet → nothing to re-emit
  expect(r.poller.currentAsk(r.id)).toBeNull();
  await r.tick();
  expect(r.blocks.at(-1)?.shape).toBe("menu");
  expect(r.blocks.at(-1)?.ask).toEqual(ASK);
  expect(r.poller.currentAsk(r.id)).toEqual(ASK);
  expect(r.poller.blockSnapshot()[r.id]?.ask).toEqual(ASK);
});

test("an ask arriving after the block re-emits it with ask; resolve by id re-emits without", async () => {
  const r = rig();
  await r.tick();
  expect(r.blocks.at(-1)?.ask).toBeUndefined();
  r.poller.ingestAsk(r.id, ASK);
  expect(r.blocks.at(-1)?.ask).toEqual(ASK);

  r.poller.resolveAsk(r.id, "toolu_other"); // a different tool's PostToolUse → ignored
  expect(r.poller.currentAsk(r.id)).toEqual(ASK);

  r.poller.resolveAsk(r.id, "toolu_1");
  expect(r.blocks.at(-1)?.shape).toBe("menu");
  expect(r.blocks.at(-1)?.ask).toBeUndefined();
  expect(r.poller.currentAsk(r.id)).toBeNull();
});

test("resolve without id (Stop / SessionEnd) clears whatever is pending", async () => {
  const r = rig();
  r.poller.ingestAsk(r.id, ASK);
  await r.tick();
  r.poller.resolveAsk(r.id);
  expect(r.poller.currentAsk(r.id)).toBeNull();
  const n = r.blocks.length;
  r.poller.resolveAsk(r.id); // idempotent: nothing pending → no emit
  expect(r.blocks).toHaveLength(n);
});
