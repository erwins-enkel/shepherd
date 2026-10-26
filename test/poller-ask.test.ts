// #3165: the poller carries the PreToolUse(AskUserQuestion) dialog on the announced block as
// `ask`, re-emits on ask arrival / end, and exposes it only while a block is announced.
// #2779: the same for ExitPlanMode's `plan`, plus the PreToolUse early block edge.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import { classifyBlocked, type BlockReason } from "../src/blocked";
import type { HerdrAgent } from "../src/herdr";
import type { PendingAsk } from "../src/ask-user-question";
import type { PendingPlan } from "../src/plan-approval";
import type { HerdrState } from "../src/types";
import { config } from "../src/config";

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
  let status: HerdrState = "blocked";
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
    setStatus: (v: HerdrState) => (status = v),
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

// ── #2779: ExitPlanMode's plan + the PreToolUse early edge ───────────────────

const PLAN: PendingPlan = { toolUseId: "toolu_p", plan: "Step 1\nStep 2\n", truncated: false };
const PLAN_MENU =
  "Would you like to proceed?\n❯ 1. Yes, and use auto mode\n  2. Yes, manually approve edits\n" +
  "  3. Tell Claude what to change";

test("a plan rides the announced menu; resolve by id, then Stop, clear it", async () => {
  const r = rig(PLAN_MENU);
  r.poller.ingestPlan(r.id, PLAN);
  await r.tick();
  expect(r.blocks.at(-1)?.shape).toBe("menu");
  expect(r.blocks.at(-1)?.plan).toEqual(PLAN);
  expect(r.poller.blockSnapshot()[r.id]?.plan).toEqual(PLAN);

  r.poller.resolvePlan(r.id, "toolu_other"); // another tool's PostToolUse → ignored
  expect(r.blocks.at(-1)?.plan).toEqual(PLAN);
  r.poller.resolvePlan(r.id, "toolu_p"); // approved → PostToolUse
  expect(r.blocks.at(-1)?.shape).toBe("menu");
  expect(r.blocks.at(-1)?.plan).toBeUndefined();

  r.poller.ingestPlan(r.id, { ...PLAN, toolUseId: "toolu_q" });
  expect(r.blocks.at(-1)?.plan?.toolUseId).toBe("toolu_q");
  r.poller.resolvePlan(r.id); // Stop / SessionEnd
  expect(r.blocks.at(-1)?.plan).toBeUndefined();
});

test("a rejected plan (no PostToolUse) is dropped with its block — no ride on a later menu", async () => {
  const r = rig(PLAN_MENU);
  r.poller.ingestPlan(r.id, PLAN);
  await r.tick();
  expect(r.blocks.at(-1)?.plan).toEqual(PLAN);
  r.setStatus("working"); // "Tell Claude what to change" → the agent just carries on
  await r.tick();
  expect(r.blocks.at(-1)).toBeNull();
  r.setStatus("blocked");
  await r.tick();
  expect(r.blocks.at(-1)?.shape).toBe("menu");
  expect(r.blocks.at(-1)?.plan).toBeUndefined();
});

test("a chrome-less numbered run is a menu only while a hooked dialog is pending", async () => {
  const painting = " 1. Yes, and use auto mode\n 2. Yes, manually approve edits";
  const bare = rig(painting);
  await bare.tick();
  expect(bare.blocks.at(-1)?.shape).toBe("awaiting-input"); // #2281: prose until proven otherwise

  const hooked = rig(painting);
  hooked.poller.ingestPlan(hooked.id, PLAN);
  await hooked.tick();
  expect(hooked.blocks.at(-1)?.shape).toBe("menu");
  expect(hooked.blocks.at(-1)?.options.map((o) => o.send)).toEqual(["1", "2"]);
  expect(hooked.blocks.at(-1)?.plan).toEqual(PLAN);
});

async function withHookSignals(fn: () => Promise<void>, on = true): Promise<void> {
  const orig = config.hooksSignals;
  config.hooksSignals = on;
  try {
    await fn();
  } finally {
    config.hooksSignals = orig;
  }
}

test("PreToolUse arms the block edge without waiting for herdr or the Notification", () =>
  withHookSignals(async () => {
    const r = rig();
    r.setStatus("working"); // herdr has not latched `blocked` (or never will, 0.7.5)
    r.poller.ingestDialogOpen(r.id);
    r.poller.ingestAsk(r.id, ASK);
    await r.tick();
    expect(r.blocks.at(-1)?.shape).toBe("menu");
    expect(r.blocks.at(-1)?.ask).toEqual(ASK);
  }));

test("the early edge keeps classifying until the dialog paints as a menu", () =>
  withHookSignals(async () => {
    const r = rig("Let me ask you something");
    r.setStatus("working");
    r.poller.ingestDialogOpen(r.id);
    await r.tick(); // not painted yet → withheld (a steerable awaiting-input), marker kept
    expect(r.blocks).toHaveLength(0);
    r.setScreen(MENU);
    await r.tick();
    expect(r.blocks.at(-1)?.shape).toBe("menu");
  }));

test("a pre-paint awaiting-input is withheld on herdr's blocked path too, until the grace ends", async () => {
  await withHookSignals(async () => {
    const r = rig("Let me ask you something"); // herdr already latched `blocked`
    r.poller.ingestDialogOpen(r.id); // hooks off: arms nothing, withholds nothing
    await r.tick();
    expect(r.blocks.at(-1)?.shape).toBe("awaiting-input");
  }, false);

  await withHookSignals(async () => {
    const h = rig("Let me ask you something");
    h.poller.ingestDialogOpen(h.id);
    await h.tick(); // +5 s: withheld
    expect(h.blocks).toHaveLength(0);
    await h.tick(); // +10 s: grace spent → announced as usual
    expect(h.blocks.at(-1)?.shape).toBe("awaiting-input");
  });
});

test("the early edge gives up after the paint grace", () =>
  withHookSignals(async () => {
    const r = rig("Let me ask you something");
    r.setStatus("working");
    r.poller.ingestDialogOpen(r.id);
    await r.tick(); // +5 s: withheld, marker kept
    await r.tick(); // +10 s: grace spent → announced, this classify consumes the marker
    r.setScreen(MENU);
    await r.tick(); // no marker → normal working-path routing, no hook-driven menu
    expect(r.blocks.some((b) => b?.shape === "menu")).toBe(false);
  }));

test("a dialog answered before any classify leaves nothing armed (#2779)", () =>
  withHookSignals(async () => {
    for (const parsed of [true, false]) {
      const r = rig("Let me ask you something"); // working, no spinner: would read awaiting-input
      r.setStatus("working");
      r.poller.ingestDialogOpen(r.id);
      if (parsed) r.poller.ingestAsk(r.id, ASK); // false: tool_input did not parse → no ask
      r.poller.ingestDialogClosed(r.id); // its PostToolUse lands before the next tick
      r.poller.resolveAsk(r.id, "toolu_1");
      await r.tick();
      await r.tick(); // past the grace too
      expect(r.blocks.filter((b) => b !== null)).toHaveLength(0);
    }
  }));

test("closing a dialog leaves a Notification-armed marker alone", () =>
  withHookSignals(async () => {
    const r = rig();
    r.setStatus("working");
    r.poller.ingestNotification(r.id, "permission_prompt");
    r.poller.ingestDialogClosed(r.id); // no hooked dialog was open → no-op
    await r.tick();
    expect(r.blocks.at(-1)?.shape).toBe("menu");
  }));

// ── herdr reads an open dialog as resting (done/idle) ────────────────────────

test("a resting herdr status keeps the hooked dialog's block and its ask while the menu shows", () =>
  withHookSignals(async () => {
    const r = rig();
    r.setStatus("done"); // herdr flickers to done with the dialog on screen
    r.poller.ingestDialogOpen(r.id);
    r.poller.ingestAsk(r.id, ASK);
    await r.tick(); // the hook edge announces the menu with its ask
    expect(r.blocks.at(-1)?.ask).toEqual(ASK);
    await r.tick(); // marker spent → the resting branch, which used to clear it
    expect(r.blocks).not.toContain(null);
    expect(r.poller.currentAsk(r.id)).toEqual(ASK);
    expect(r.poller.askStillOpen(r.id, "toolu_1")).toBe(true);
    expect(r.poller.blockSnapshot()[r.id]?.ask).toEqual(ASK);
  }));

test("a resting herdr status still clears the dialog's block once its menu is gone", () =>
  withHookSignals(async () => {
    const r = rig();
    r.setStatus("done");
    r.poller.ingestDialogOpen(r.id);
    r.poller.ingestAsk(r.id, ASK);
    await r.tick();
    r.setScreen("Interrupted · What should Claude do instead?"); // Esc: no PostToolUse, no Stop
    await r.tick();
    expect(r.blocks.at(-1)).toBeNull();
    expect(r.poller.askStillOpen(r.id, "toolu_1")).toBe(false);
    r.setScreen(MENU); // a later, unrelated menu
    r.setStatus("blocked");
    await r.tick();
    expect(r.blocks.at(-1)?.shape).toBe("menu");
    expect(r.blocks.at(-1)?.ask).toBeUndefined();
  }));

test("a resting herdr status keeps the plan approval's block and its plan", () =>
  withHookSignals(async () => {
    const r = rig(PLAN_MENU);
    r.setStatus("idle");
    r.poller.ingestDialogOpen(r.id);
    r.poller.ingestPlan(r.id, PLAN);
    await r.tick();
    expect(r.blocks.at(-1)?.plan).toEqual(PLAN);
    await r.tick();
    expect(r.blocks).not.toContain(null);
    expect(r.poller.blockSnapshot()[r.id]?.plan).toEqual(PLAN);
  }));

test("a held dialog moving to its next question re-emits the menu with the ask", () =>
  withHookSignals(async () => {
    const r = rig();
    r.setStatus("done");
    r.poller.ingestDialogOpen(r.id);
    r.poller.ingestAsk(r.id, ASK);
    await r.tick();
    r.setScreen("Pick a size?\n❯ 1. Small\n  2. Large\nEnter to select · Esc to cancel");
    await r.tick();
    expect(r.blocks.at(-1)?.options.map((o) => o.label)).toEqual(["Small", "Large"]);
    expect(r.blocks.at(-1)?.ask).toEqual(ASK);
  }));
