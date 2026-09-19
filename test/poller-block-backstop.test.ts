// Poller side of the blocked-pane backstop (#2375). The decision logic lives in
// test/block-backstop.test.ts; what is proved HERE is the wiring: which shapes reach the judge,
// that an announced block is never retracted, that a held (never-announced) episode is still
// released, and that an unwired poller emits exactly as it did before the feature existed.
import { test, expect } from "bun:test";
import { config } from "../src/config";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import { classifyBlocked, type BlockReason } from "../src/blocked";
import { BlockBackstop, BLOCK_JUDGE_QUESTION_ID } from "../src/block-backstop";
import type { HerdrAgent } from "../src/herdr";
import type { BlockJudgeLogRow, BlockJudgeMode } from "../src/types";
import type { Judge } from "../src/judge";

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

const MENU = "❯ 1. Yes\n  2. No";
const PROSE = "I looked at three options and picked the second.";

const flush = () => new Promise((r) => setTimeout(r, 0));

function withListAsync<T extends { list: () => HerdrAgent[] }>(herdr: T) {
  return { ...herdr, listAsync: () => Promise.resolve(herdr.list()) };
}

interface Rig {
  poller: StatusPoller;
  blocks: { id: string; block: BlockReason | null }[];
  rows: BlockJudgeLogRow[];
  asks: number;
  sessionId: string;
  setStatus: (s: "working" | "blocked") => void;
  setBuffer: (text: string) => void;
  advance: (ms: number) => void;
  /** Tick, then let the detached judge call and any async read settle. */
  tick: () => Promise<void>;
}

/** A poller wired to a REAL BlockBackstop over a fake judge that always answers `p`. */
function rig(mode: BlockJudgeMode, p: number): Rig {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: BlockReason | null }[] = [];
  const rows: BlockJudgeLogRow[] = [];
  let agentStatus: "working" | "blocked" = "blocked";
  let buffer = MENU;
  let clock = 100_000;
  const state = { asks: 0 };

  const judge = {
    ask: async () => {
      state.asks++;
      return {
        answers: { [BLOCK_JUDGE_QUESTION_ID]: { type: "noul", p } },
        model: "jev-1.13.0",
        usage: { inputTokens: 400, outputTokens: 0 },
        costUsd: 0.000017,
      };
    },
  } as unknown as Judge;

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
    read: () => buffer,
    readAsync: () => Promise.resolve(buffer),
  };

  const poller = new StatusPoller(
    store,
    withListAsync(herdr as never),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );
  poller.blockBackstop = new BlockBackstop({
    judge,
    mode: () => mode,
    log: (row) => rows.push(row),
    deadlineMs: 8_000,
    now: () => clock,
  });

  return {
    poller,
    blocks,
    rows,
    get asks() {
      return state.asks;
    },
    sessionId: s.id,
    setStatus: (v) => {
      agentStatus = v;
    },
    setBuffer: (text) => {
      buffer = text;
    },
    advance: (ms) => {
      clock += ms;
    },
    tick: async () => {
      await poller.tick();
      await poller.blockBackstop?.settle();
      await flush();
    },
  };
}

test("armed: a confident forgery is held for its band, then announced", async () => {
  const r = rig("armed", 0.95);

  await r.tick(); // first sighting: call fires, block provisionally held
  expect(r.blocks).toHaveLength(0);
  expect(r.asks).toBe(1);

  r.advance(3_000);
  await r.tick();
  expect(r.blocks).toHaveLength(0);

  r.advance(11_000); // 14s in — still inside the 15s band
  await r.tick();
  expect(r.blocks).toHaveLength(0);

  r.advance(3_000); // 17s in — past the band, and a full reclassify cadence later
  await r.tick();
  expect(r.blocks).toHaveLength(1);
  expect(r.blocks[0]!.block!.shape).toBe("menu");
  expect(r.asks).toBe(1); // one ask for the whole episode
});

test("armed: a below-floor answer announces on the next cadence", async () => {
  const r = rig("armed", 0.2);

  await r.tick(); // provisional hold while the call is in flight
  expect(r.blocks).toHaveLength(0);

  r.advance(3_000);
  await r.tick();
  expect(r.blocks).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({ reason: "below-floor", delayMs: 0, p: 0.2 });
});

test("shadow: announces on the first cadence and still logs the recommendation", async () => {
  const r = rig("shadow", 0.95);

  await r.tick();
  expect(r.blocks).toHaveLength(1); // nothing was delayed
  expect(r.asks).toBe(1);
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0]).toMatchObject({
    sessionId: r.sessionId,
    shape: "menu",
    mode: "shadow",
    reason: "hold",
    delayMs: 15_000,
    p: 0.95,
    model: "jev-1.13.0",
  });
});

test("off: never asks, and emits exactly as an unwired poller does", async () => {
  const r = rig("off", 0.95);
  await r.tick();
  expect(r.blocks).toHaveLength(1);
  expect(r.asks).toBe(0);
  expect(r.rows).toHaveLength(0);
});

test("an unwired poller emits on the first cadence", async () => {
  const r = rig("armed", 0.95);
  r.poller.blockBackstop = undefined;
  await r.tick();
  expect(r.blocks).toHaveLength(1);
});

test("an announced block is never retracted while a later repaint is held", async () => {
  const r = rig("armed", 0.95);

  // Let the first dialog through: the hold expires and the block is announced.
  await r.tick();
  r.advance(16_000);
  await r.tick();
  expect(r.blocks).toHaveLength(1);

  // The dialog repaints into a different tail. Whatever the backstop decides about the repaint, the
  // announced block must stay announced — no clear, no null emit.
  r.advance(3_000);
  r.setBuffer("❯ 1. Yes\n  2. No\n  3. Maybe");
  await r.tick();
  expect(r.blocks.some((b) => b.block === null)).toBe(false);
});

test("a non-gated shape is never judged", async () => {
  const r = rig("armed", 0.95);
  r.setBuffer(PROSE); // no option run, no chrome → awaiting-input
  await r.tick();
  expect(r.asks).toBe(0);
  expect(r.blocks).toHaveLength(1);
  expect(r.blocks[0]!.block!.shape).toBe("awaiting-input");
});

test("a HELD, never-announced episode is still released when the block clears", async () => {
  const r = rig("armed", 0.95);

  await r.tick(); // held; nothing announced, so there is no lastSig entry
  expect(r.blocks).toHaveLength(0);
  expect(r.asks).toBe(1);

  // The agent resumes. Nothing was announced, so `clearBlock`'s own early return skips its release
  // entirely — the per-tick drop in reconcileAgent is what has to collect this once the hold is
  // spent, or the episode lives forever and the session can never be judged again.
  r.setStatus("working");
  r.advance(16_000);
  await r.tick();

  // A fresh dialog, past the re-ask interval: the backstop must ask again.
  r.setStatus("blocked");
  r.advance(3_000);
  await r.tick();
  expect(r.asks).toBe(2);
});

test("a held episode whose pane reclassifies to a non-gated shape is released", async () => {
  const r = rig("armed", 0.95);

  await r.tick();
  expect(r.blocks).toHaveLength(0);
  expect(r.asks).toBe(1);

  // The forgery scrolls away: the pane is still `blocked`, so nothing calls clearBlock, but the
  // episode is over.
  r.setBuffer(PROSE);
  r.advance(3_000);
  await r.tick();
  expect(r.blocks).toHaveLength(1); // the awaiting-input fallback, unheld

  // The episode is collected on the first non-gated cadence past its (now spent) hold.
  r.advance(16_000);
  await r.tick();

  r.setBuffer(MENU);
  r.advance(3_000);
  await r.tick();
  expect(r.asks).toBe(2);
});

test("the hook path holds for the full band even though herdr never latches blocked", async () => {
  // The path this regressed on. `tryHookAwaitingBlock` classifies precisely when herdr has NOT
  // latched `blocked` — which is the whole point of the push-hook trigger, and for a sandboxed
  // >=0.7.5 session it is also the steady state, because the pushed agent state derives from
  // `lastBlockReason`, which stays empty for exactly as long as the block is held. So the session
  // sits at a non-blocked status for the entire hold, and the per-tick episode drops on that branch
  // (and in `clearBlock` via `maybeQuota`) run between every cadence. If either of them actually
  // deleted the episode, each classify would build a fresh one: the answer's write-back would be
  // dropped on the identity check, the paid `p` discarded, and the re-ask cooldown would collapse
  // the hold to a single cadence whatever the model said.
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const r = rig("armed", 0.95);
    r.setStatus("working"); // herdr never latches blocked; only the hook can surface this

    r.poller.ingestNotification(r.sessionId, "permission_prompt");
    await r.tick();
    expect(r.blocks).toHaveLength(0); // held
    expect(r.asks).toBe(1);

    // Drive the full band one cadence at a time, as the real loop does.
    for (let t = 3_000; t < 15_000; t += 3_000) {
      r.advance(3_000);
      await r.tick();
      expect(r.blocks).toHaveLength(0);
    }
    expect(r.asks).toBe(1); // one ask for the whole hold — the episode survived every tick

    r.advance(3_000); // past the band
    await r.tick();
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.block!.shape).toBe("menu");
  } finally {
    config.hooksSignals = orig;
  }
});

test("a flapping pane cannot buy an ask on every flip", async () => {
  const r = rig("armed", 0.95);
  await r.tick();
  expect(r.asks).toBe(1);

  for (let i = 0; i < 2; i++) {
    r.setBuffer(PROSE);
    r.advance(3_000);
    await r.tick();
    r.setBuffer(MENU);
    r.advance(3_000);
    await r.tick();
  }
  expect(r.asks).toBe(1); // 12s of flapping, still inside one re-ask interval
});
