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

const SPINNER_TAIL = "✶ Bunning… (1m 13s · ↑ 1.3k tokens)\n❯";

/** Blocked-status herdr fake whose visible buffer is swappable via `setText`. */
function spinnerHarness(initialText: string) {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];
  let text = initialText;
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
  return {
    poller,
    blocks,
    setText: (t: string) => (text = t),
    advance: (ms: number) => (clock += ms),
  };
}

test("suppresses the awaiting-input fallback when the TUI shows a working spinner", () => {
  const h = spinnerHarness(SPINNER_TAIL);
  h.poller.tick();
  expect(h.blocks).toHaveLength(0);
});

test("clears an announced block exactly once when the buffer flips to a working spinner", () => {
  const h = spinnerHarness("❯ 1. Yes\n  2. No");
  h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("menu");

  // dialog answered, herdr latches blocked, TUI now shows a live turn spinner
  h.setText(SPINNER_TAIL);
  h.advance(5000);
  h.poller.tick();
  expect(h.blocks).toHaveLength(2);
  expect(h.blocks[1]!.block).toBeNull();

  // further suppressed cycles emit nothing
  h.advance(5000);
  h.poller.tick();
  h.advance(5000);
  h.poller.tick();
  expect(h.blocks).toHaveLength(2);
});

test("re-arms after suppression: a later spinner-free awaiting-input tail emits a block", () => {
  const h = spinnerHarness(SPINNER_TAIL);
  h.poller.tick();
  expect(h.blocks).toHaveLength(0);

  h.setText("I need your input on the API design.\n❯");
  h.advance(5000);
  h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("awaiting-input");
});

test("still emits a menu block when a spinner line is also visible", () => {
  const h = spinnerHarness(`✶ Bunning… (1m 13s · ↑ 1.3k tokens)\n❯ 1. Yes\n  2. No`);
  h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("menu");
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

  // Transcript-path stall (evaluateStall) test: the transcript stays LIVE-WRITING
  // throughout (its newest record advances each probe = `clock - 600_000`, a fixed
  // 10m-old gap that always reads as a silence candidate), so every probe runs the
  // transcript path. The recovery is driven by the live TERMINAL moving (not a
  // fresh transcript), which keeps the snapshot ts monotonic and avoids spuriously
  // flipping to the interim path. A frozen terminal confirms the candidate; a
  // moving one clears it and re-arms the episode.
  let visible = "still chewing on it";
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
    read: () => visible,
  };

  let clock = 1_700_000_000_000; // realistic ms epoch so a past lastTs stays positive
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
    // lastTs always advances with the clock (live-writing) yet stays a 10m-old
    // silence candidate, so the transcript path runs every probe.
    () => ({
      snapshot: { lastTs: clock - 600_000, pending: false },
      activity: null,
    }),
    { stallMs: 1, pendingStallMs: 1 }, // 10m-old activity counts as stalled; fresh does not
    7000, // probeCheckMs
  );

  // priming probe: a first sighting (no baseline) is NOT live-writing, so it routes
  // to interim and only RECORDS the transcript baseline (no readAsync injected → the
  // interim read no-ops). The NEXT probe sees the newest record advance → transcript.
  poller.tick();
  expect(blocks).toHaveLength(0);

  // first transcript-path probe (newest record advanced) only captures a terminal
  // baseline — no emit yet
  clock += 7000;
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

  // terminal resumes moving (live generation) → the liveness gate clears the stall
  // and resets the baseline, re-arming the episode.
  visible = "Computing… (1s)";
  clock += 7000;
  poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });

  // frozen again: baseline was reset on recovery, so the first probe defers again…
  visible = "still chewing on it";
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

  // priming probe: first sighting (no baseline) → interim, just records the
  // transcript baseline (no readAsync → no-op). Next probe advances → transcript path.
  poller.tick();
  expect(blocks).toHaveLength(0);

  // pending candidate fires immediately (no baseline defer) despite the moving terminal
  frame += 5;
  clock += 7000;
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

  poller.tick(); // priming: first sighting → interim, just records transcript baseline
  clock += 7000;
  poller.tick(); // first transcript probe → terminal baseline
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

  // transcript stays live-writing (lastTs always advances as a 10m-old silence
  // candidate) → transcript path every probe; recovery is driven by the terminal
  // moving, keeping the snapshot ts monotonic (no spurious interim flip).
  let visible = "still chewing on it";
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
    () => ({
      snapshot: { lastTs: clock - 600_000, pending: false },
      activity: null,
    }),
    { stallMs: 1, pendingStallMs: 1 },
    7000, // probeCheckMs
  );

  poller.tick(); // priming: first sighting → interim, just records transcript baseline
  expect(blocks).toHaveLength(0);
  clock += 7000;
  poller.tick(); // first transcript probe → terminal baseline, no emit yet
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

  // terminal moves → episode re-arms; acknowledgeStall now no-ops (no live stall)
  visible = "Computing… (1s)";
  clock += 7000;
  poller.tick();
  expect(poller.acknowledgeStall(s.id)).toBe(false);

  // a later stall fires again (baseline reset on recovery → defer one probe, then fire)
  visible = "still chewing on it";
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
  // a constant visible buffer: when a probe flips to the interim path (transcript
  // not advancing), the unchanged terminal produces no heartbeat tick → no emit.
  readAsync: () => Promise.resolve("const"),
};

test("maybeActivity emits via onActivity when the probe returns a signal", () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: { id: string; activity: unknown }[] = [];

  let clock = 100_000;
  // newest-record ts must ADVANCE across probes for the transcript path to engage:
  // the first sighting (no baseline) routes to interim, the second (advanced) probe
  // takes the transcript path and emits.
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
    () => ({ snapshot: null, activity: signal }), // combined probe tracks the (mutating) signal
    DEFAULT_STALL,
    7000, // probeCheckMs
    () => {}, // onReady
    (id, activity) => activities.push({ id, activity }),
  );

  poller.tick(); // priming: first sighting → interim (constant terminal → no emit)
  expect(activities).toHaveLength(0);

  clock += 8000; // past throttle
  signal.lastActivityTs = 1000; // newest record advanced → transcript path → emit
  poller.tick();
  expect(activities).toHaveLength(1);
  expect(activities[0]!.activity).toEqual(signal);
});

test("maybeActivity dedups identical signals — does not re-emit unchanged activity", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: unknown[] = [];

  let clock = 100_000;
  // signal0 = the priming baseline (first sighting → interim, records lastTranscriptTs).
  // signalA carries a NEWER ts → advances → transcript path emits. Repeating signalA
  // (ts unchanged) → not advancing → interim path, constant terminal → no new emit.
  // signalB carries a newer lastActivityTs → live-writing again → transcript path re-emits.
  const signal0 = { lastActivityTs: 100, summary: "resumed", recentTs: [], recentErrTs: [] };
  const signalA = { lastActivityTs: 1234, summary: "$ bun test", recentTs: [], recentErrTs: [] };
  const signalB = {
    lastActivityTs: 5678,
    summary: "wrote config.ts",
    recentTs: [],
    recentErrTs: [],
  };
  let currentSignal: typeof signal0 | typeof signalA | typeof signalB = signal0;

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

  poller.tick(); // priming: first sighting → interim (constant terminal → no emit)
  await flush();
  expect(activities).toHaveLength(0);

  // newest record advances → transcript path → first emit (signalA)
  clock += 8000;
  currentSignal = signalA;
  poller.tick();
  await flush();
  expect(activities).toHaveLength(1);

  // advance past throttle, SAME signal (ts unchanged) → not advancing → interim
  // path, constant terminal → no new emit.
  clock += 8000;
  poller.tick();
  await flush();
  expect(activities).toHaveLength(1);

  // swap signal in place (newer ts) → live-writing again → transcript path re-emits
  clock += 8000;
  currentSignal = signalB;
  poller.tick();
  await flush();
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

  poller.tick(); // probe called; first sighting → interim (constant terminal → no emit)
  expect(callCount).toBe(1);
  expect(activities).toHaveLength(0);

  clock += 3000; // within probeCheckMs (7000) → throttled
  poller.tick();
  expect(callCount).toBe(1); // probe NOT called again yet

  clock += 5000; // now past the 7000ms throttle; newest record advanced → transcript emit
  poller.tick();
  expect(callCount).toBe(2); // probe called again
  expect(activities).toHaveLength(1);
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
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (_id, block) => blocks.push(block),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    // transcript yields data and KEEPS advancing (newest record ts climbs with the
    // clock = live-writing) → existing path, interim path stays dormant every probe.
    () => ({
      snapshot: { lastTs: clock, pending: false },
      activity: {
        lastActivityTs: clock,
        summary: "edited poller.ts",
        recentTs: [clock],
        recentErrTs: [],
      },
    }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
    () => {},
    (id, activity) => activities.push({ id, activity }),
  );

  poller.tick(); // priming: first sighting → interim (records the transcript baseline)
  await flush();
  // discount any terminal read from the priming interim probe; from here every probe
  // sees the newest record advance → transcript path, which must never touch the terminal.
  visibleReads = 0;
  const activitiesBefore = activities.length;

  for (let i = 0; i < 2; i++) {
    clock += 7000;
    poller.tick();
    await flush();
  }

  // the transcript-driven emit still happens (real summary, not interim's null)
  const transcriptEmits = activities.slice(activitiesBefore);
  expect(transcriptEmits.length).toBeGreaterThan(0);
  expect(transcriptEmits[0]!.activity.summary).toBe("edited poller.ts");
  expect(transcriptEmits[0]!.id).toBe(s.id);
  // a non-stalled transcript snapshot clears the block path without reading the
  // terminal → the interim heartbeat/stall maps never get touched, no visible read
  expect(visibleReads).toBe(0);
  expect(blocks.every((b) => b === null || b === undefined)).toBe(true);
});

test("interim engages when the transcript parses but its newest record is FROZEN (resumed stale JSONL)", async () => {
  // Finding 2: a resumed session inherits an OLD frozen JSONL, so parseActivity
  // returns stale entries → signals come back NON-null but their newest record ts
  // never advances. The old "both signals null" trigger missed this and left the
  // session on the dead transcript path forever (strip stays empty). The liveness
  // check must flip it to the interim terminal-diff — and since a first sighting (no
  // baseline) is treated as NOT live-writing, that flip happens from the VERY FIRST probe.
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: { id: string; activity: any }[] = [];
  let visibleReads = 0;
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
    read: () => "irrelevant",
    // the interim path's heartbeat reads the live terminal (changing each cadence)
    readAsync: () => {
      visibleReads++;
      return Promise.resolve(`Computing… (${frame}s)`);
    },
  };

  let clock = 1_700_000_000_000;
  // NON-null but FROZEN: lastActivityTs/lastTs are a fixed PAST value, never advancing.
  const staleTs = clock - 600_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({
      snapshot: { lastTs: staleTs, pending: false },
      activity: { lastActivityTs: staleTs, summary: "old", recentTs: [], recentErrTs: [] },
    }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
    () => {},
    (id, activity) => activities.push({ id, activity }),
  );

  // first probe: no baseline → NOT live-writing → interim terminal-diff engages
  // immediately, reading the live terminal (captures the change-baseline this cycle).
  poller.tick();
  await flush();
  expect(visibleReads).toBe(1);

  // subsequent probes: newest record still does NOT advance → interim stays engaged,
  // reading the (changing) live terminal and accruing heartbeat ticks.
  for (let i = 0; i < 3; i++) {
    frame += 7;
    clock += 7000;
    poller.tick();
    await flush();
  }
  expect(visibleReads).toBeGreaterThan(0);
  // the heartbeat now comes from the terminal: a null summary (the diff can't name
  // a tool-use) and non-empty recentTs.
  const last = activities[activities.length - 1]!.activity;
  expect(last.summary).toBeNull();
  expect(last.recentTs.length).toBeGreaterThan(0);
});

test("a resumed stale transcript engages the interim path on the FIRST probe (no baseline = not live)", async () => {
  // A resumed session inherits an OLD frozen JSONL whose newest record is already
  // outside the client strip window. The first-sighting gate must treat "no
  // baseline" as NOT live-writing, so the very FIRST probe routes to the interim
  // terminal-diff (engaging the live heat-strip immediately) rather than taking
  // the transcript path once and emitting one stale, already-out-of-window signal.
  // Reverting the gate (first sighting counts as live) makes this fail: probe 1
  // would take the transcript path, read nothing async, and emit the stale signal.
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: { id: string; activity: any }[] = [];
  let visibleReads = 0;

  const clock = 1_700_000_000_000;
  // NON-null but constant (non-advancing) — the stale-resumed-JSONL shape.
  const staleTs = clock - 600_000;
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
    read: () => "irrelevant",
    readAsync: () => {
      visibleReads++;
      return Promise.resolve("frozen output");
    },
  };

  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    () => {},
    1000,
    3000,
    classifyBlocked,
    () => clock,
    () => ({
      snapshot: { lastTs: staleTs, pending: false },
      activity: { lastActivityTs: staleTs, summary: "old", recentTs: [], recentErrTs: [] },
    }),
    { stallMs: 1, pendingStallMs: 1 },
    7000,
    () => {},
    (id, activity) => activities.push({ id, activity }),
  );

  // FIRST probe: no baseline → NOT live → interim engages (reads the terminal async).
  poller.tick();
  await flush(); // the interim read is async
  expect(visibleReads).toBe(1); // interim path ran on probe 1
  // and crucially the stale transcript activity was NOT emitted (its "old" summary
  // would be out-of-window noise on the heat-strip).
  expect(activities.some((a) => a.activity.summary === "old")).toBe(false);
});

test("a frozen resumed transcript with a frozen terminal fires an interim stall", async () => {
  // The flip-to-interim must also own the stall for a stale-frozen transcript: a
  // non-advancing JSONL + a frozen terminal is a real stall, surfaced by the
  // interim frozen-TUI logic (with its first-sample baseline deferral).
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: { id: string; block: any }[] = [];

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
    read: () => "frozen",
    readAsync: () => Promise.resolve("frozen output"),
  };

  let clock = 1_700_000_000_000;
  const staleTs = clock - 600_000;
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
      snapshot: { lastTs: staleTs, pending: false },
      activity: { lastActivityTs: staleTs, summary: "old", recentTs: [], recentErrTs: [] },
    }),
    { stallMs: 5_000, pendingStallMs: 5_000 }, // < probe cadence so one frozen gap trips it
    7000,
    () => {},
    () => {},
  );

  poller.tick(); // probe 1: no baseline → interim engages, captures terminal baseline → defer
  await flush();
  expect(blocks).toHaveLength(0);
  clock += 7000;
  poller.tick(); // probe 2: terminal still frozen past stallMs → interim stall fires
  await flush();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");
  expect((blocks[0]!.block as any).tail).toEqual(["frozen output"]);
});

test("a live-writing probe resets a stale interim stall baseline (Finding 1)", async () => {
  // Finding 1: when the transcript path runs, nothing used to clear the interim
  // baseline maps. A later re-entry into the interim path could then read a stale
  // `lastInterimChangeAt` from a PRIOR interim episode and fire a false stall
  // immediately, skipping the intended first-sample deferral. The fix calls
  // resetInterim on every live-writing probe; this test drives the session into
  // interim to set a stall baseline far in the past, runs ONE live-writing probe,
  // then re-enters interim and asserts it DEFERS rather than firing off the old
  // baseline — even though wall-clock minus that baseline far exceeds stallMs.
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const blocks: { id: string; block: any }[] = [];

  let live = false; // toggles the transcript between frozen-stale and live-writing
  let clock = 1_700_000_000_000;
  const baseTs = clock;

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
    read: () => "frozen",
    // terminal stays frozen the whole time → the interim stall is driven purely by
    // the change-baseline, which is exactly what resetInterim must clear.
    readAsync: () => Promise.resolve("frozen terminal"),
  };

  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    // live=true → newest record advances (live-writing); live=false → frozen-stale
    () =>
      live
        ? {
            snapshot: { lastTs: clock, pending: false },
            activity: { lastActivityTs: clock, summary: "live", recentTs: [], recentErrTs: [] },
          }
        : {
            snapshot: { lastTs: baseTs - 600_000, pending: false },
            activity: {
              lastActivityTs: baseTs - 600_000,
              summary: "old",
              recentTs: [],
              recentErrTs: [],
            },
          },
    { stallMs: 5_000, pendingStallMs: 5_000 }, // < probe cadence so one frozen gap trips it
    7000,
    () => {},
    () => {},
  );

  // Episode 1 (interim): establish a stall baseline, then fire. A first sighting (no
  // baseline) is NOT live-writing, so interim engages from probe 1.
  poller.tick(); // probe 1: stale-frozen, no baseline → interim → terminal baseline (defer)
  await flush();
  clock += 7000;
  poller.tick(); // probe 2: frozen past stallMs → interim stall fires
  await flush();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // One live-writing probe: newest record advances → transcript path → resetInterim
  // clears lastInterimChangeAt/ticks/visible. A non-stalled snapshot also clears the
  // stall block (the clear emit).
  live = true;
  clock += 7000;
  poller.tick();
  await flush();
  const afterLive = blocks.length;
  expect(blocks[afterLive - 1]).toEqual({ id: store.list()[0]!.id, block: null });

  // Re-enter interim. The wall-clock gap from the OLD (episode-1) baseline far
  // exceeds stallMs, so WITHOUT resetInterim this FIRST re-entry sample would fire
  // immediately off the stale baseline. With the reset it has no baseline → defers.
  live = false;
  clock += 7000;
  poller.tick(); // first interim sample post-reset → MUST defer, not fire
  await flush();
  expect(blocks.length).toBe(afterLive); // no new stall fired off the stale baseline
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

  poller.tick(); // priming: first sighting → interim (no readAsync → no emit)
  expect(activities).toHaveLength(0);
  clock += 8000;
  poller.tick(); // newest record advanced → transcript path → emit; populates the maps
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
  // prune cleared lastTranscriptTs too, so the resurrected session is a fresh first
  // sighting → priming interim probe (no readAsync → no emit), then the advancing probe
  // re-emits via the transcript path (proving the activity sig map was cleared by prune).
  clock += 8000;
  poller.tick(); // priming: first sighting post-resurrection → interim, no emit
  expect(activities).toHaveLength(1);
  clock += 8000;
  poller.tick(); // newest record advanced → transcript path → must re-emit
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

  poller.tick(); // priming: first sighting → interim (no readAsync → no emit)
  expect(poller.activitySnapshot()).toEqual({});

  clock += 8000;
  poller.tick(); // newest record advanced → transcript path emits → caches the signal
  expect(poller.activitySnapshot()).toEqual({
    [s.id]: { lastActivityTs: 108_000, summary: "edited x.ts", recentTs: [], recentErrTs: [] },
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
