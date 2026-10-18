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

function rig(screen = MENU) {
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
  let buffer = screen;
  let status: "blocked" | "working" = "blocked";
  let clock = 100_000;
  const list = (): HerdrAgent[] => [
    {
      agent: "claude",
      agentStatus: status,
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
    read: () => buffer,
    readAsync: () => Promise.resolve(buffer),
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
    setScreen: (text: string) => (buffer = text),
    setStatus: (v: "blocked" | "working") => (status = v),
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

  expect(r.poller.askStillOpen(r.id, "toolu_1")).toBe(true);
  r.poller.resolveAsk(r.id, "toolu_1");
  expect(r.poller.askStillOpen(r.id, "toolu_1")).toBe(false);
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

test("only a menu block carries the ask — never a stall or bare awaiting-input", async () => {
  const r = rig("I wonder what to do next");
  r.poller.ingestAsk(r.id, ASK);
  await r.tick();
  expect(r.blocks.at(-1)?.shape).toBe("awaiting-input");
  expect(r.blocks.at(-1)?.ask).toBeUndefined();
  expect(r.poller.currentAsk(r.id)).toBeNull();
});

test("the clear of the block that carried the ask drops it — no ride on a later menu", async () => {
  const r = rig();
  r.poller.ingestAsk(r.id, ASK);
  await r.tick();
  expect(r.blocks.at(-1)?.ask).toEqual(ASK);
  r.setStatus("working"); // e.g. an Esc cancel: no PostToolUse, the session just moves on
  await r.tick();
  expect(r.blocks.at(-1)).toBeNull();
  expect(r.poller.askStillOpen(r.id, "toolu_1")).toBe(false);
  r.setStatus("blocked"); // a later, unrelated permission menu
  await r.tick();
  expect(r.blocks.at(-1)?.shape).toBe("menu");
  expect(r.blocks.at(-1)?.ask).toBeUndefined();
});

test("an ask not yet announced is not dropped by a tick with nothing announced", async () => {
  const r = rig();
  r.setStatus("working"); // the PreToolUse lands before the dialog paints
  await r.tick();
  r.poller.ingestAsk(r.id, ASK);
  await r.tick();
  expect(r.poller.askStillOpen(r.id, "toolu_1")).toBe(true);
  r.setStatus("blocked");
  await r.tick();
  expect(r.blocks.at(-1)?.ask).toEqual(ASK);
});
