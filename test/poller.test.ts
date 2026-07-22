import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import { makeApp } from "../src/server";
import type { HerdrAgent } from "../src/herdr";
import { classifyBlocked, hasActiveSpinner } from "../src/blocked";
import { DEFAULT_STALL } from "../src/stall";
import { maintenance } from "../src/maintenance";
import { config } from "../src/config";
import type { ReviewVerdict, PlanGate } from "../src/types";

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

/**
 * tick() (issue #1529) now reads agents over the socket via `listAsync()`, not the
 * sync `list()` these pre-existing herdr fakes were written against. Rather than
 * duplicate each fake's (sometimes stateful) `list()` logic, mirror it: `listAsync`
 * resolves to whatever `list()` returns at call time.
 */
function withListAsync<T extends { list: () => HerdrAgent[] }>(
  herdr: T,
): T & { listAsync: () => Promise<HerdrAgent[]>; reportAgentState: () => Promise<void> } {
  // Default `reportAgentState` (#1891) so poller fakes don't each need it; a caller-provided one wins
  // (spread after the default). The push is version-gated off here anyway (no 0.7.5 detected).
  return {
    reportAgentState: () => Promise.resolve(),
    ...herdr,
    listAsync: () => Promise.resolve(herdr.list()),
  };
}

test("tick maps herdr state to status and emits only on change", async () => {
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
    withListAsync({ list: () => agents, read: () => "" } as any),
    (id, status) => emitted.push({ id, status }),
    () => {},
  );

  await poller.tick();
  expect(store.get(s.id)?.status).toBe("running");
  expect(emitted).toEqual([{ id: s.id, status: "running" }]);

  await poller.tick(); // unchanged → no new emit
  expect(emitted.length).toBe(1);

  agents = [{ ...agents[0]!, agentStatus: "blocked" }];
  await poller.tick();
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
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );

  await poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("menu");

  // within the reclassify window + same content → no new emit
  clock += 1000;
  await poller.tick();
  expect(blocks).toHaveLength(1);

  // agent resumes → exactly one clear emit (block === null)
  agentStatus = "working";
  clock += 5000;
  await poller.tick();
  await flush();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });
});

test("re-emits onBlock when the blocked reason changes after the cadence", async () => {
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
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );
  await poller.tick();
  expect(blocks).toHaveLength(1);
  text = "Continue? (y/n)";
  clock += 5000;
  await poller.tick();
  expect(blocks).toHaveLength(2);
  expect((blocks[1]!.block as any).shape).toBe("yes-no");
});

/** A live spinner ticks its elapsed counter, so the buffer advances between
 *  classify reads — parameterize the seconds to simulate that in tests. */
const spinnerTail = (secs: number) => `✶ Bunning… (1m ${secs}s · ↑ 1.3k tokens)\n❯`;
const SPINNER_TAIL = spinnerTail(13);

/** Blocked-status herdr fake whose visible buffer (`setText`) and agent status
 *  (`setStatus`) are swappable. Captures block, working-blocked, and status
 *  emissions plus a combined `events` log for relative-order assertions. */
function spinnerHarness(initialText: string) {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];
  const working: { id: string; working: boolean }[] = [];
  const statuses: string[] = [];
  /** Interleaved block + working-blocked emissions, most recent last. */
  const events: string[] = [];
  let text = initialText;
  let agentStatus = "blocked";
  let gone = false;
  const herdr = {
    list: (): HerdrAgent[] =>
      gone
        ? []
        : [
            {
              agent: "claude",
              agentStatus,
              cwd: "/wt",
              paneId: "p",
              tabId: "t",
              name: "",
              terminalId: "term_a",
              workspaceId: "w",
            } as HerdrAgent,
          ],
    read: () => text,
    readAsync: () => Promise.resolve(text),
  };
  let clock = 100_000;
  const poller = new StatusPoller(
    store,
    withListAsync(herdr as any),
    (_id, status) => statuses.push(status),
    (id, block) => {
      blocks.push({ id, block });
      events.push(`block:${block === null ? "null" : (block as any).shape}`);
    },
    1000,
    3000,
    classifyBlocked,
    () => clock,
    undefined, // probe
    undefined, // stallCfg
    undefined, // probeCheckMs
    undefined, // onReady
    undefined, // onActivity
    undefined, // preview
    undefined, // liveness
    (id, w) => {
      working.push({ id, working: w });
      events.push(`working:${w}`);
    },
  );
  return {
    poller,
    store,
    blocks,
    working,
    statuses,
    events,
    id: s.id,
    setText: (t: string) => (text = t),
    setStatus: (st: string) => (agentStatus = st),
    setGone: () => (gone = true),
    advance: (ms: number) => (clock += ms),
  };
}

test("suppresses the awaiting-input fallback when the TUI shows a working spinner", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(0);
  // exactly one working-blocked(true) for the episode …
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  // … and further cadences over an ADVANCING buffer (live spinner ticks) stay silent
  h.setText(spinnerTail(18));
  h.advance(5000);
  await h.poller.tick();
  h.setText(spinnerTail(23));
  h.advance(5000);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(0);
  expect(h.working).toHaveLength(1);
  expect(h.poller.workingBlockedSnapshot()).toEqual({ [h.id]: true });
});

test("clears an announced block exactly once when the buffer flips to a working spinner", async () => {
  const h = spinnerHarness("❯ 1. Yes\n  2. No");
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("menu");
  expect(h.working).toHaveLength(0);

  // dialog answered, herdr latches blocked, TUI now shows a live turn spinner
  h.setText(SPINNER_TAIL);
  h.advance(5000);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(2);
  expect(h.blocks[1]!.block).toBeNull();
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  // further suppressed cycles (spinner still ticking) emit nothing
  h.setText(spinnerTail(18));
  h.advance(5000);
  await h.poller.tick();
  h.setText(spinnerTail(23));
  h.advance(5000);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(2);
  expect(h.working).toHaveLength(1);
});

test("re-arms after suppression: a later spinner-free awaiting-input tail emits a block", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(0);

  h.setText("I need your input on the API design.\n❯");
  h.advance(5000);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("awaiting-input");
  // flag-off lands in the same tick, BEFORE the block (badge + red row together)
  expect(h.events).toEqual(["working:true", "working:false", "block:awaiting-input"]);
  expect(h.poller.workingBlockedSnapshot()).toEqual({});
});

test("still emits a menu block when a spinner line is also visible", async () => {
  const h = spinnerHarness(`✶ Bunning… (1m 13s · ↑ 1.3k tokens)\n❯ 1. Yes\n  2. No`);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("menu");
  // a genuine dialog never enters the working-blocked display state
  expect(h.working).toHaveLength(0);
});

test("herdr leaving blocked drops the working-blocked flag in the same tick", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick();
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  // herdr flips to working → flag-off synchronously on that tick (no probe wait,
  // no async flush — reconcileAgent clears it before any throttled path runs)
  h.setStatus("working");
  h.advance(1000);
  await h.poller.tick();
  expect(h.working).toEqual([
    { id: h.id, working: true },
    { id: h.id, working: false },
  ]);
  expect(h.poller.workingBlockedSnapshot()).toEqual({});
  expect(h.blocks).toHaveLength(0); // suppression never announced a block to clear
});

test("suppress/re-arm cycle synthesizes no status transitions of its own", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick(); // blocked + suppressed
  h.setText(spinnerTail(18)); // spinner ticks → stays suppressed
  h.advance(5000);
  await h.poller.tick(); // still suppressed
  h.setText("I need your input on the API design.\n❯");
  h.advance(5000);
  await h.poller.tick(); // re-arm → block emitted
  expect(h.statuses).toEqual(["blocked"]); // only herdr's raw transition

  h.setStatus("working");
  h.advance(1000);
  await h.poller.tick();
  expect(h.statuses).toEqual(["blocked", "running"]);
});

test("agent gone during suppression: reap emits exactly one working:false and marks done", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick(); // herdr blocked + spinner tail → suppression episode
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  // claude exited / ctrl-c'd — herdr no longer lists the agent → reapGone
  h.setGone();
  h.advance(1000);
  await h.poller.tick();
  expect(h.working).toEqual([
    { id: h.id, working: true },
    { id: h.id, working: false },
  ]);
  expect(h.store.get(h.id)?.status).toBe("done");
  expect(h.poller.workingBlockedSnapshot()).toEqual({});

  // further ticks emit nothing more
  h.advance(1000);
  await h.poller.tick();
  expect(h.working).toHaveLength(2);
});

test("archive during suppression: prune drops the flag silently (no working:false)", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick(); // enter the suppression episode
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  // session archived → leaves the activeOnly list → pruneInactive clears tracking
  h.store.update(h.id, { status: "archived" });
  h.advance(1000);
  await h.poller.tick();
  expect(h.working).toEqual([{ id: h.id, working: true }]); // NO additional emission
  expect(h.poller.workingBlockedSnapshot()).toEqual({});
});

test("frozen spinner re-arms: an identical buffer across cadences surfaces the block", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick(); // first sighting → one-cadence grace, suppressed
  expect(h.blocks).toHaveLength(0);
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  // buffer did NOT advance → wedged/static, not a live spinner → re-arm:
  // exactly one working:false then one awaiting-input block, in that order
  h.advance(3001);
  await h.poller.tick();
  expect(h.events).toEqual(["working:true", "working:false", "block:awaiting-input"]);
  expect(h.poller.workingBlockedSnapshot()).toEqual({});

  // a further identical-buffer cadence: sig-dedupe → no new emissions
  h.advance(3001);
  await h.poller.tick();
  expect(h.events).toEqual(["working:true", "working:false", "block:awaiting-input"]);
});

test("advancing spinner stays suppressed across cadences", async () => {
  const h = spinnerHarness(spinnerTail(13));
  await h.poller.tick();
  for (const secs of [14, 15, 16]) {
    h.setText(spinnerTail(secs)); // elapsed counter ticks → buffer advances
    h.advance(3001);
    await h.poller.tick();
  }
  expect(h.blocks).toHaveLength(0);
  expect(h.working).toEqual([{ id: h.id, working: true }]); // only the initial flag-on
  expect(h.poller.workingBlockedSnapshot()).toEqual({ [h.id]: true });
});

test("unwedged spinner re-enters suppression: flag back on, re-armed block cleared once", async () => {
  const h = spinnerHarness(SPINNER_TAIL);
  await h.poller.tick(); // grace
  h.advance(3001);
  await h.poller.tick(); // frozen → re-arm
  expect(h.events).toEqual(["working:true", "working:false", "block:awaiting-input"]);

  // turn unwedges: the buffer advances again with a live spinner
  h.setText(spinnerTail(14));
  h.advance(3001);
  await h.poller.tick();
  expect(h.events).toEqual([
    "working:true",
    "working:false",
    "block:awaiting-input",
    "block:null", // the re-armed block clears exactly once
    "working:true", // flag back on for the fresh episode
  ]);

  // and the re-entered episode keeps suppressing while the spinner ticks
  h.setText(spinnerTail(15));
  h.advance(3001);
  await h.poller.tick();
  expect(h.events).toHaveLength(5);
  expect(h.poller.workingBlockedSnapshot()).toEqual({ [h.id]: true });
});

test("static buffer quoting a spinner-like markdown bullet ultimately surfaces the block", async () => {
  // genuine awaiting-input tail that merely CONTAINS a spinner-shaped bullet line
  const h = spinnerHarness("Summary:\n* Done… (3s)\nWhich option do you prefer?\n❯");
  await h.poller.tick(); // first cadence: grace → may suppress
  expect(h.blocks).toHaveLength(0);

  // static across reads → second cadence re-arms with the block
  h.advance(3001);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("awaiting-input");
  expect(h.poller.workingBlockedSnapshot()).toEqual({});
});

// route mirror of GET /api/claude-alive (see poller-liveness.test.ts)
test("GET /api/working-blocked returns the snapshot; {} when unwired", async () => {
  const baseDeps = {
    store: new SessionStore(":memory:"),
    service: {} as any,
    events: { subscribe: () => () => {}, emit: () => {} } as any,
    usageLimits: {
      limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
    },
  };
  const wired = makeApp({
    ...baseDeps,
    workingBlocked: { snapshot: () => ({ "session-1": true }) },
  } as any);
  let res = await wired.fetch(new Request("http://localhost/api/working-blocked"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ "session-1": true });

  const unwired = makeApp(baseDeps as any);
  res = await unwired.fetch(new Request("http://localhost/api/working-blocked"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("GET /api/blocks returns the block snapshot (incl. authUrl); {} when unwired", async () => {
  const baseDeps = {
    store: new SessionStore(":memory:"),
    service: {} as any,
    events: { subscribe: () => () => {}, emit: () => {} } as any,
    usageLimits: {
      limits: () => ({ session5h: null, week: null, stale: true, calibratedAt: null }),
    },
  };
  const reason = {
    shape: "awaiting-input",
    options: [],
    tail: ["paste callback"],
    authUrl: AUTH_URL,
  };
  const wired = makeApp({
    ...baseDeps,
    blocks: { snapshot: () => ({ "session-1": reason }) },
  } as any);
  let res = await wired.fetch(new Request("http://localhost/api/blocks"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ "session-1": reason });

  const unwired = makeApp(baseDeps as any);
  res = await unwired.fetch(new Request("http://localhost/api/blocks"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

test("marks a session done and emits once when its herdr agent is gone", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: { id: string; status: string }[] = [];

  // herdr no longer lists the agent (claude exited / ctrl-c reaped the terminal)
  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [] as HerdrAgent[], read: () => "" } as any),
    (id, status) => emitted.push({ id, status }),
    () => {},
  );

  await poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
  expect(store.get(s.id)?.lastState).toBe("done");
  expect(emitted).toEqual([{ id: s.id, status: "done" }]);

  await poller.tick(); // already done → no duplicate emit
  expect(emitted.length).toBe(1);
});

test("clears an active block when the agent disappears", async () => {
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
    withListAsync({ list: () => agents, read: () => "❯ 1. Yes\n  2. No" } as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );

  await poller.tick();
  expect(blocks).toHaveLength(1); // classified the block

  agents = []; // agent gone
  clock += 5000;
  await poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
  expect(blocks[blocks.length - 1]).toEqual({ id: s.id, block: null }); // block cleared
});

test("flags a silent working agent with a FROZEN terminal as a stall, fires once, re-arms on resume", async () => {
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
    withListAsync(herdr as any),
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
  await poller.tick();
  expect(blocks).toHaveLength(0);

  // first transcript-path probe (newest record advanced) only captures a terminal
  // baseline — no emit yet
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(0);

  // next probe: terminal unchanged + transcript silent → stall fires
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");
  expect((blocks[0]!.block as any).tail).toEqual(["still chewing on it"]);

  // throttled within probeCheckMs → no re-probe
  clock += 1000;
  await poller.tick();
  expect(blocks).toHaveLength(1);

  // past the throttle, still stalled → fires only once per episode
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(1);

  // terminal resumes moving (live generation) → the liveness gate clears the stall
  // and resets the baseline, re-arming the episode.
  visible = "Computing… (1s)";
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });

  // frozen again: baseline was reset on recovery, so the first probe defers again…
  visible = "still chewing on it";
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(2);
  // …and the next confirms the frozen terminal → fires
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(3);
  expect((blocks[2]!.block as any).shape).toBe("stall");
});

test("does NOT flag a transcript-silent agent whose terminal is still moving (live generation)", async () => {
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
    withListAsync(herdr as any),
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
    await poller.tick();
    clock += 7000;
  }
  expect(blocks).toHaveLength(0);
});

test("fires a stall for a hung command (pending past the ceiling) even when the terminal keeps ticking", async () => {
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
    withListAsync(herdr as any),
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
  await poller.tick();
  expect(blocks).toHaveLength(0);

  // pending candidate fires immediately (no baseline defer) despite the moving terminal
  frame += 5;
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // still hung + still ticking → once per episode, no re-fire / no false clear
  frame += 5;
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(1);
});

test("clears an emitted stall when the terminal resumes moving even before the transcript catches up", async () => {
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
    withListAsync(herdr as any),
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

  await poller.tick(); // priming: first sighting → interim, just records transcript baseline
  clock += 7000;
  await poller.tick(); // first transcript probe → terminal baseline
  clock += 7000;
  await poller.tick(); // frozen → stall fires
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // terminal resumes ticking while the transcript is still silent → clear the stall
  visible = "Computing… (601s)";
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });
});

test("acknowledgeStall clears the flag without re-firing while still stalled", async () => {
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
    withListAsync(herdr as any),
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

  await poller.tick(); // priming: first sighting → interim, just records transcript baseline
  expect(blocks).toHaveLength(0);
  clock += 7000;
  await poller.tick(); // first transcript probe → terminal baseline, no emit yet
  expect(blocks).toHaveLength(0);
  clock += 7000;
  await poller.tick(); // frozen terminal → stall fires
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // manual dismiss: clears the flag now, but keeps the once-per-episode guard
  expect(poller.acknowledgeStall(s.id)).toBe(true);
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });

  // still stalled on the next probe → does NOT re-announce (episode acknowledged)
  clock += 7000;
  await poller.tick();
  expect(blocks).toHaveLength(2);

  // terminal moves → episode re-arms; acknowledgeStall now no-ops (no live stall)
  visible = "Computing… (1s)";
  clock += 7000;
  await poller.tick();
  expect(poller.acknowledgeStall(s.id)).toBe(false);

  // a later stall fires again (baseline reset on recovery → defer one probe, then fire)
  visible = "still chewing on it";
  clock += 7000;
  await poller.tick();
  clock += 7000;
  await poller.tick();
  expect((blocks[blocks.length - 1]!.block as any).shape).toBe("stall");
});

test.each(["working", "blocked"] as const)(
  "auto-clears readyToMerge when a ready session transitions to %s",
  async (agentStatus) => {
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
      withListAsync({ list: () => agents, read: () => "" } as any),
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

    await poller.tick();
    expect(store.get(s.id)?.readyToMerge).toBe(false);
    expect(ready).toEqual([{ id: s.id, ready: false }]);

    await poller.tick(); // already cleared → no duplicate emit
    expect(ready).toHaveLength(1);
  },
);

test("leaves readyToMerge untouched while a ready session stays idle", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  store.update(s.id, { readyToMerge: true });
  const ready: unknown[] = [];

  // herdr "done" maps to idle status — not running/blocked, so the flag is sticky
  const poller = new StatusPoller(
    store,
    withListAsync({
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
    } as any),
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

  await poller.tick();
  expect(store.get(s.id)?.readyToMerge).toBe(true);
  expect(ready).toHaveLength(0);
});

test("does not emit onBlock when reading the terminal throws", async () => {
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
    withListAsync(herdr as any),
    () => {},
    (_id, block) => blocks.push(block),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );
  await poller.tick();
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

test("maybeActivity emits via onActivity when the probe returns a signal", async () => {
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
    withListAsync(runningHerdr as any),
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

  await poller.tick(); // priming: first sighting → interim (constant terminal → no emit)
  expect(activities).toHaveLength(0);

  clock += 8000; // past throttle
  signal.lastActivityTs = 1000; // newest record advanced → transcript path → emit
  await poller.tick();
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
    withListAsync(runningHerdr as any),
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

  await poller.tick(); // priming: first sighting → interim (constant terminal → no emit)
  await flush();
  expect(activities).toHaveLength(0);

  // newest record advances → transcript path → first emit (signalA)
  clock += 8000;
  currentSignal = signalA;
  await poller.tick();
  await flush();
  expect(activities).toHaveLength(1);

  // advance past throttle, SAME signal (ts unchanged) → not advancing → interim
  // path, constant terminal → no new emit.
  clock += 8000;
  await poller.tick();
  await flush();
  expect(activities).toHaveLength(1);

  // swap signal in place (newer ts) → live-writing again → transcript path re-emits
  clock += 8000;
  currentSignal = signalB;
  await poller.tick();
  await flush();
  expect(activities).toHaveLength(2);
  expect(activities[1]).toEqual(signalB);
});

test("maybeActivity respects activityCheckMs throttle", async () => {
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
    withListAsync(runningHerdr as any),
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

  await poller.tick(); // probe called; first sighting → interim (constant terminal → no emit)
  expect(callCount).toBe(1);
  expect(activities).toHaveLength(0);

  clock += 3000; // within probeCheckMs (7000) → throttled
  await poller.tick();
  expect(callCount).toBe(1); // probe NOT called again yet

  clock += 5000; // now past the 7000ms throttle; newest record advanced → transcript emit
  await poller.tick();
  expect(callCount).toBe(2); // probe called again
  expect(activities).toHaveLength(1);
});

test("maybeActivity skips emit when probe returns null", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const activities: unknown[] = [];

  const poller = new StatusPoller(
    store,
    withListAsync(runningHerdr as any),
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

  await poller.tick();
  expect(activities).toHaveLength(0);
});

test("maybeActivity does not run for non-running (idle/blocked) sessions", async () => {
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
    withListAsync(idleHerdr as any),
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

  await poller.tick();
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
    withListAsync(herdr as any),
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
  await poller.tick();
  await flush();
  expect(activities).toHaveLength(0);

  // subsequent probes: terminal changes each cadence → a tick accrues each time
  for (let i = 0; i < 3; i++) {
    frame += 7;
    clock += 7000;
    await poller.tick();
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

  await poller.tick(); // baseline
  await flush();
  // accrue ticks well past the window so the oldest must be dropped
  const totalSpan = STRIP_WINDOW_MS * 2;
  let elapsed = 0;
  while (elapsed < totalSpan) {
    frame += 1;
    clock += 7000;
    elapsed += 7000;
    await poller.tick();
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
  await poller.tick();
  await flush();
  expect(blocks).toHaveLength(0);

  // still static, but not yet past stallMs → no fire
  clock += 7000;
  await poller.tick();
  await flush();
  expect(blocks).toHaveLength(0);

  // past stallMs of no change → stall fires once
  clock += 7000;
  await poller.tick();
  await flush();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");
  expect((blocks[0]!.block as any).tail).toEqual(["frozen output"]);

  // still static past throttle → once per episode, no re-fire
  clock += 7000;
  await poller.tick();
  await flush();
  expect(blocks).toHaveLength(1);

  // terminal moves again → stall clears
  visible = "moving now";
  clock += 7000;
  await poller.tick();
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
  await poller.tick();
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
    withListAsync(herdr as any),
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

  await expect(poller.tick()).resolves.toBeUndefined();
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
    withListAsync(herdr as any),
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
  await poller.tick();
  await flush();
  expect(reads).toBe(1);

  // advance past the throttle so the throttle alone wouldn't block a second probe,
  // tick again → the in-flight guard must suppress a second read
  clock += 7000;
  await poller.tick();
  await flush();
  expect(reads).toBe(1);

  // let the first read finish → the next probe is free to read again
  resolveFirst("done");
  await flush();
  clock += 7000;
  await poller.tick();
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
    withListAsync(herdr as any),
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

  await poller.tick(); // priming: first sighting → interim (records the transcript baseline)
  await flush();
  // discount any terminal read from the priming interim probe; from here every probe
  // sees the newest record advance → transcript path, which must never touch the terminal.
  visibleReads = 0;
  const activitiesBefore = activities.length;

  for (let i = 0; i < 2; i++) {
    clock += 7000;
    await poller.tick();
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
    withListAsync(herdr as any),
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
  await poller.tick();
  await flush();
  expect(visibleReads).toBe(1);

  // subsequent probes: newest record still does NOT advance → interim stays engaged,
  // reading the (changing) live terminal and accruing heartbeat ticks.
  for (let i = 0; i < 3; i++) {
    frame += 7;
    clock += 7000;
    await poller.tick();
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
    withListAsync(herdr as any),
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
  await poller.tick();
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
    withListAsync(herdr as any),
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

  await poller.tick(); // probe 1: no baseline → interim engages, captures terminal baseline → defer
  await flush();
  expect(blocks).toHaveLength(0);
  clock += 7000;
  await poller.tick(); // probe 2: terminal still frozen past stallMs → interim stall fires
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
    withListAsync(herdr as any),
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
  await poller.tick(); // probe 1: stale-frozen, no baseline → interim → terminal baseline (defer)
  await flush();
  clock += 7000;
  await poller.tick(); // probe 2: frozen past stallMs → interim stall fires
  await flush();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("stall");

  // One live-writing probe: newest record advances → transcript path → resetInterim
  // clears lastInterimChangeAt/ticks/visible. A non-stalled snapshot also clears the
  // stall block (the clear emit).
  live = true;
  clock += 7000;
  await poller.tick();
  await flush();
  const afterLive = blocks.length;
  expect(blocks[afterLive - 1]).toEqual({ id: store.list()[0]!.id, block: null });

  // Re-enter interim. The wall-clock gap from the OLD (episode-1) baseline far
  // exceeds stallMs, so WITHOUT resetInterim this FIRST re-entry sample would fire
  // immediately off the stale baseline. With the reset it has no baseline → defers.
  live = false;
  clock += 7000;
  await poller.tick(); // first interim sample post-reset → MUST defer, not fire
  await flush();
  expect(blocks.length).toBe(afterLive); // no new stall fired off the stale baseline
});

test("pruneInactive clears activity tracking for a running-only session that goes away", async () => {
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
    withListAsync({ list: () => agents, read: () => "" } as any),
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

  await poller.tick(); // priming: first sighting → interim (no readAsync → no emit)
  expect(activities).toHaveLength(0);
  clock += 8000;
  await poller.tick(); // newest record advanced → transcript path → emit; populates the maps
  expect(activities).toHaveLength(1);

  // session is archived — poller sees empty store list → pruneInactive fires
  store.update(s.id, { status: "archived" });
  agents = [];
  clock += 8000;
  await poller.tick(); // pruneInactive must clear lastProbeAt + lastActivitySig

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
  await poller.tick(); // priming: first sighting post-resurrection → interim, no emit
  expect(activities).toHaveLength(1);
  clock += 8000;
  await poller.tick(); // newest record advanced → transcript path → must re-emit
  expect(activities).toHaveLength(2);
});

test("tick adopts a resurrected agent by cwd, re-points the id, emits, and does NOT reap", async () => {
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
    withListAsync({ list: () => agents, read: () => "" } as any),
    (id, status) => emitted.push({ id, status }),
    () => {},
  );

  await poller.tick();
  const out = store.get(s.id);
  expect(out?.herdrAgentId).toBe("term_fresh"); // adopted, not reaped
  expect(out?.status).toBe("running");
  expect(emitted).toContainEqual({ id: s.id, status: "running" });
});

test("tick reaps when neither terminalId nor cwd matches a live agent", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, worktreePath: "/wt", herdrAgentId: "term_stale" });

  const poller = new StatusPoller(
    store,
    withListAsync({ list: () => [], read: () => "" } as any),
    () => {},
    () => {},
  );

  await poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
});

test("activitySnapshot returns last emitted signal, pruned when the session goes away", async () => {
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
    withListAsync({ list: () => agents, read: () => "" } as any),
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

  await poller.tick(); // priming: first sighting → interim (no readAsync → no emit)
  expect(poller.activitySnapshot()).toEqual({});

  clock += 8000;
  await poller.tick(); // newest record advanced → transcript path emits → caches the signal
  expect(poller.activitySnapshot()).toEqual({
    [s.id]: { lastActivityTs: 108_000, summary: "edited x.ts", recentTs: [], recentErrTs: [] },
  });

  // session archived → next tick prunes it out of the snapshot too
  store.update(s.id, { status: "archived" });
  agents = [];
  clock += 8000;
  await poller.tick();
  expect(poller.activitySnapshot()).toEqual({});
});

test("tick() is a no-op while maintenance is active (no herdr call, no reap)", async () => {
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
    withListAsync(herdr),
    () => {},
    () => {},
  );
  maintenance.begin();
  try {
    await poller.tick();
    expect(listCalls).toBe(0);
  } finally {
    maintenance.end();
  }
});

test("tick() swallows a herdr.list() throw (no crash, no reap)", async () => {
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
    withListAsync(herdr),
    () => {},
    () => {},
  );
  // must NOT throw (an unhandled throw on the 1s interval would crash shepherd)
  await expect(poller.tick()).resolves.toBeUndefined();
  expect(reaped).toBe(false); // tick bailed before touching the store
});

// ── Phase-1 push-hook ingestion (issue #704) ──────────────────────────────────
//
// `config.hooksSignals` gates the whole feature; save/restore it per-test so the
// flag never leaks across the suite (default off ⇒ ingest* are inert).

/** A running-agent harness for the push-hook tests: a `working` herdr agent whose
 *  status + visible buffer are swappable, capturing block + activity emissions. The
 *  transcript probe returns null by default (interim path) so the freshness guard's
 *  interaction with the interim heartbeat is exercisable. */
function hookHarness(opts?: {
  visible?: () => string;
  probe?: () => { snapshot: any; activity: any };
  stallCfg?: { stallMs: number; pendingStallMs: number };
  onLivenessChange?: (id: string, alive: boolean) => void;
}) {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const activities: { id: string; activity: any }[] = [];
  const blocks: { id: string; block: any }[] = [];
  let agentStatus = "working";
  let clock = 1_700_000_000_000;
  const visible = opts?.visible ?? (() => "Computing… (1s)");
  const pruned: Array<Set<string>> = [];
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
      } as HerdrAgent,
    ],
    read: () => visible(),
    readAsync: () => Promise.resolve(visible()),
  };
  const livenessWiring = opts?.onLivenessChange ? { onChange: opts.onLivenessChange } : undefined;
  const poller = new StatusPoller(
    store,
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    opts?.probe ?? (() => ({ snapshot: null, activity: null })),
    opts?.stallCfg ?? { stallMs: 1, pendingStallMs: 1 },
    7000, // probeCheckMs
    () => {},
    (id, activity) => activities.push({ id, activity }),
    undefined, // preview
    livenessWiring, // liveness
    () => {}, // onWorkingBlocked
    (ids) => pruned.push(new Set(ids)), // pruneHooks
  );
  return {
    poller,
    store,
    activities,
    blocks,
    pruned,
    id: s.id,
    setStatus: (st: string) => (agentStatus = st),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

test("hooks: ingestActivity emits a deduped session:activity with a non-null summary + tick", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = hookHarness();
    h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
    expect(h.activities).toHaveLength(1);
    const a = h.activities[0]!.activity;
    expect(a.summary).toBe("Edit");
    expect(a.recentTs).toEqual([h.now()]);
    expect(a.lastActivityTs).toBe(h.now());
    expect(a.recentErrTs).toEqual([]);

    // identical call → dedup (no re-emit)
    h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
    expect(h.activities).toHaveLength(1);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: PostToolUseFailure (status:error) populates recentErrTs", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = hookHarness();
    h.poller.ingestActivity(h.id, { toolName: "Bash", status: "error", ts: h.now() });
    expect(h.activities).toHaveLength(1);
    const a = h.activities[0]!.activity;
    expect(a.summary).toBe("Bash");
    expect(a.recentErrTs).toEqual([h.now()]);
    expect(a.recentTs).toEqual([h.now()]);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: a permission_prompt notification triggers maybeClassify on the next (non-blocked) tick, consumed once", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    // agent stays herdr-"working" (not blocked) yet the TUI shows a menu → the push
    // notification, not herdr's latch, surfaces the block.
    const h = hookHarness({ visible: () => "❯ 1. Yes\n  2. No" });
    h.poller.ingestNotification(h.id, "permission_prompt");

    await h.poller.tick();
    expect(h.blocks).toHaveLength(1);
    expect((h.blocks[0]!.block as any).shape).toBe("menu");

    // marker consumed → a later tick does NOT re-classify/re-fire (sig-deduped anyway,
    // but the marker is gone so the awaiting branch never even runs again)
    h.advance(5000);
    await h.poller.tick();
    expect(h.blocks).toHaveLength(1);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: a throttled awaiting tick KEEPS the marker and retries once the cadence passes", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    // status stays herdr-"working" so only the push marker (never herdr's latch / the
    // maybeProbe path) can surface the block. The buffer is swappable so a later
    // classify yields a fresh sig (proves the retried classify actually re-emitted vs.
    // dedup short-circuited).
    let buf = "❯ 1. Yes\n  2. No";
    const h = hookHarness({ visible: () => buf });

    // Prime `lastReadAt` fresh: a blocked tick runs maybeClassify (records the read
    // time + emits the first menu block), then drop back to working.
    h.setStatus("blocked");
    await h.poller.tick();
    expect(h.blocks).toHaveLength(1);
    h.setStatus("working");

    // Marker arrives but a classify just ran (<reclassifyMs ago) → this tick is
    // throttled. maybeClassify returns false, so the marker is NOT consumed and no
    // new block fires.
    h.poller.ingestNotification(h.id, "permission_prompt");
    h.advance(1000); // < reclassifyMs (3000)
    await h.poller.tick();
    expect(h.blocks).toHaveLength(1); // still throttled, nothing new

    // Cadence passes → the RETAINED marker drives a real classify this tick. Vary the
    // buffer so the sig differs from the primed menu and the emit isn't dedup-skipped.
    buf = "❯ 1. Approve\n  2. Deny\n  3. Cancel";
    h.advance(3000); // now > reclassifyMs since the priming read
    await h.poller.tick();
    expect(h.blocks).toHaveLength(2); // classify ran → block re-emitted
    expect((h.blocks[1]!.block as any).shape).toBe("menu");

    // Marker now consumed: a further (post-cadence) tick does not re-fire.
    h.advance(3000);
    await h.poller.tick();
    expect(h.blocks).toHaveLength(2);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: idle_prompt does NOT trigger a block", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = hookHarness({ visible: () => "❯ 1. Yes\n  2. No" });
    h.poller.ingestNotification(h.id, "idle_prompt");
    await h.poller.tick();
    expect(h.blocks).toHaveLength(0);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: freshness guard suppresses the interim activity emit while push is fresh", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    // interim path (probe null); terminal changes each cadence → normally a heartbeat
    // tick emits. A fresh push must suppress that redundant null-summary emit.
    let frame = 0;
    const h = hookHarness({ visible: () => `Computing… (${frame}s)` });

    // prime the interim baseline
    await h.poller.tick();
    await flush();
    expect(h.activities).toHaveLength(0);

    // a fresh push lands (carries the real summary)
    h.poller.ingestActivity(h.id, { toolName: "Read", status: "ok", ts: h.now() });
    expect(h.activities).toHaveLength(1); // the push emit
    expect(h.activities[0]!.activity.summary).toBe("Read");

    // next probe: terminal changed (would emit a null-summary heartbeat) but push is
    // fresh → suppressed. The only activity remains the push emit.
    frame += 7;
    h.advance(7000);
    await h.poller.tick();
    await flush();
    const interimEmits = h.activities.filter((a) => a.activity.summary === null);
    expect(interimEmits).toHaveLength(0);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: freshness guard keeps the transcript stall firing for a frozen pure-generation turn", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    // live-writing transcript that's a 10m-old silence candidate (frozen terminal) →
    // stall must still fire even while a push keeps the activity path fresh.
    const visible = "still chewing on it";
    const h = hookHarness({
      visible: () => visible,
      probe: () => ({ snapshot: { lastTs: h.now() - 600_000, pending: false }, activity: null }),
      stallCfg: { stallMs: 1, pendingStallMs: 1 },
    });

    // keep the push fresh throughout
    const refresh = () =>
      h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });

    refresh();
    await h.poller.tick(); // priming: first sighting → interim, records transcript baseline
    h.advance(7000);
    refresh();
    await h.poller.tick(); // transcript path → terminal baseline, no stall yet
    expect(h.blocks).toHaveLength(0);
    h.advance(7000);
    refresh();
    await h.poller.tick(); // frozen terminal + silent transcript → stall STILL fires
    expect(h.blocks).toHaveLength(1);
    expect((h.blocks[0]!.block as any).shape).toBe("stall");
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: freshness guard still emits the probe's activity when it carries error heat the push didn't", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    // transcript probe carries a recentErrTs while a non-error push is fresh — the
    // belt-and-suspenders guard must still emit it (never drop error heat, Finding 3).
    const h = hookHarness({
      probe: () => ({
        snapshot: null,
        activity: {
          lastActivityTs: h.now(),
          summary: "$ bun test",
          recentTs: [h.now()],
          recentErrTs: [h.now()],
        },
      }),
    });

    // fresh non-error push
    h.poller.ingestActivity(h.id, { toolName: "Read", status: "ok", ts: h.now() });
    const pushEmits = h.activities.length;

    // prime then advance so the transcript path engages (newest record advances)
    await h.poller.tick();
    h.advance(8000);
    h.poller.ingestActivity(h.id, { toolName: "Read", status: "ok", ts: h.now() }); // keep fresh
    await h.poller.tick();

    // the probe's error-bearing signal was emitted despite the fresh push
    const errEmits = h.activities.filter((a) => a.activity.recentErrTs.length > 0);
    expect(errEmits.length).toBeGreaterThan(0);
    expect(h.activities.length).toBeGreaterThan(pushEmits);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: pruneInactive clears the new maps and calls pruneHooks", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const h = hookHarness();
    h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
    h.poller.ingestNotification(h.id, "permission_prompt");

    // archive the session → it leaves the activeOnly list → pruneInactive
    h.store.update(h.id, { status: "archived" });
    h.advance(1000);
    await h.poller.tick();

    // pruneHooks called with the (now empty) active set
    expect(h.pruned.length).toBeGreaterThan(0);
    expect(h.pruned[h.pruned.length - 1]!.has(h.id)).toBe(false);

    // re-ingesting after prune starts a fresh strip (no stale ticks): a single tick
    config.hooksSignals = true;
    h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
    const a = h.activities[h.activities.length - 1]!.activity;
    expect(a.recentTs).toEqual([h.now()]); // exactly one tick → strip was pruned
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: ingest* are inert when config.hooksSignals is off", async () => {
  const orig = config.hooksSignals;
  config.hooksSignals = false;
  try {
    const h = hookHarness({ visible: () => "❯ 1. Yes\n  2. No" });
    h.poller.ingestActivity(h.id, { toolName: "Edit", status: "ok", ts: h.now() });
    expect(h.activities).toHaveLength(0); // no emit

    h.poller.ingestNotification(h.id, "permission_prompt");
    await h.poller.tick();
    expect(h.blocks).toHaveLength(0); // no block trigger
  } finally {
    config.hooksSignals = orig;
  }
});

// ── Phase-2 push lifecycle: ingestSessionStart (issue #709) ──────────────────

test("hooks: ingestSessionStart flips claude-liveness to true on first call", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const livenessChanges: Array<{ id: string; alive: boolean }> = [];
    const h = hookHarness({
      onLivenessChange: (id, alive) => livenessChanges.push({ id, alive }),
    });
    h.poller.ingestSessionStart(h.id);
    expect(livenessChanges).toEqual([{ id: h.id, alive: true }]);
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: ingestSessionStart is a no-op on repeated calls (flip-dedup)", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = true;
  try {
    const livenessChanges: Array<{ id: string; alive: boolean }> = [];
    const h = hookHarness({
      onLivenessChange: (id, alive) => livenessChanges.push({ id, alive }),
    });
    h.poller.ingestSessionStart(h.id);
    h.poller.ingestSessionStart(h.id); // second call → already true, no re-emit
    expect(livenessChanges).toHaveLength(1); // only one flip
  } finally {
    config.hooksSignals = orig;
  }
});

test("hooks: ingestSessionStart is inert when config.hooksSignals is off", () => {
  const orig = config.hooksSignals;
  config.hooksSignals = false;
  try {
    const livenessChanges: Array<{ id: string; alive: boolean }> = [];
    const h = hookHarness({
      onLivenessChange: (id, alive) => livenessChanges.push({ id, alive }),
    });
    h.poller.ingestSessionStart(h.id);
    expect(livenessChanges).toHaveLength(0); // flag off → no emit
  } finally {
    config.hooksSignals = orig;
  }
});

// ── quota block lifecycle (task 3) ────────────────────────────────────────────

/** Minimal ReviewVerdict that puts the review in rework-stall state.
 *  addressRound === addressCap, finalRoundPending=false → addressStallStatus="stalled". */
function makeReworkStallReview(sessionId: string): ReviewVerdict {
  return {
    sessionId,
    headSha: "abc",
    patchId: "p1",
    decision: "changes_requested",
    summary: "issues",
    body: "## issues",
    findings: ["fix A", "fix B"],
    addressRound: 3,
    addressCap: 3,
    streakReviews: 2,
    reviewedPatchIds: ["p1"],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 60_000,
    seenNoteIds: [],
    updatedAt: 1000,
  };
}

/** Minimal PlanGate at cap (decision=changes_requested, round>=cap). */
function makeExhaustedGate(sessionId: string): PlanGate {
  return {
    sessionId,
    planHash: "h1",
    decision: "changes_requested",
    summary: "plan issues",
    body: "## plan",
    findings: ["address X"],
    round: 5,
    cap: 5,
    approved: false,
    plan: "do stuff",
    updatedAt: 1000,
  };
}

/** Build a poller whose single session is idle (herdr agentStatus="done") and
 *  whose block callbacks are captured. The store is returned so tests can seed
 *  review/gate rows and mutate session status. */
function idleQuotaHarness() {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  const herdr = {
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
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => Date.now(),
  );

  return { store, s, blocks, poller };
}

// Property 1: emit once per episode
test("quota: idle session in rework-stall emits block once; second tick with same state does not re-emit", async () => {
  const { store, s, blocks, poller } = idleQuotaHarness();
  store.putReview(makeReworkStallReview(s.id));

  await poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("quota");
  expect((blocks[0]!.block as any).quotaKind).toBe("rework");

  // second tick with same state → deduped, no new emit
  await poller.tick();
  expect(blocks).toHaveLength(1);
});

// Property 2: clear on resolve
test("quota: clears block when review is reset so quotaBlockReason returns null", async () => {
  const { store, s, blocks, poller } = idleQuotaHarness();
  store.putReview(makeReworkStallReview(s.id));

  await poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("quota");

  // reset the review row so the detector returns null
  store.dropReview(s.id);

  await poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });
});

// Property 3: clear on resume (running-path guard clears stale quota block)
test("quota: block is cleared when a quota-carrying session transitions to running", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  let agentStatus: "done" | "working" = "done";
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
    read: () => "",
    readAsync: () => Promise.resolve(""),
  };

  const poller = new StatusPoller(
    store,
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => Date.now(),
  );

  store.putReview(makeReworkStallReview(s.id));

  // idle tick → quota block emitted
  await poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("quota");

  // session resumes
  agentStatus = "working";
  await poller.tick();
  // the running-path guard (probeTerminalInterim ~line 833) clears any non-stall
  // lastSig asynchronously via the interim path; flush the microtask queue.
  await flush();
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  expect(blocks[blocks.length - 1]).toEqual({ id: s.id, block: null });
});

// Property 4: blocked-status priority — quota branch not invoked for blocked sessions
test("quota: blocked session goes through maybeClassify, not the quota branch", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  // herdr says blocked, terminal shows a menu prompt
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus: "blocked" as const,
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

  const clock = 100_000;
  const poller = new StatusPoller(
    store,
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );

  // seed a quota condition too — but it must not matter for a blocked session
  store.putReview(makeReworkStallReview(s.id));

  await poller.tick();
  expect(blocks).toHaveLength(1);
  // must be a menu block (from maybeClassify), not a quota block
  expect((blocks[0]!.block as any).shape).toBe("menu");
});

// Property 5: plan kind emits quotaKind "plan"
test("quota: idle session with exhausted plan gate (no review) emits quotaKind 'plan'", async () => {
  const { store, s, blocks, poller } = idleQuotaHarness();
  store.setPlanPhase(s.id, "planning");
  store.putPlanGate(makeExhaustedGate(s.id));

  await poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("quota");
  expect((blocks[0]!.block as any).quotaKind).toBe("plan");
});

// ── Fullscreen renderer stall-detection regression coverage ───────────────────

const fullscreenFixturesDir = join(import.meta.dir, "fixtures", "fullscreen");
const fullscreenSpinner = readFileSync(
  join(fullscreenFixturesDir, "fullscreen-spinner.txt"),
  "utf8",
);
const fullscreenIdle = readFileSync(join(fullscreenFixturesDir, "fullscreen-idle.txt"), "utf8");

test("fullscreen idle frame is not mistaken for a live turn (hasActiveSpinner = false)", () => {
  expect(hasActiveSpinner(fullscreenIdle)).toBe(false);
});

test("fullscreen: a wedged (frozen) spinner frame is detected as frozen — chrome does not fake advancement", async () => {
  // The fullscreen buffer contains incidental status-bar chrome (path, progress bar).
  // Holding it CONSTANT across cadences must read as FROZEN and re-arm the block,
  // exactly like the classic "frozen spinner re-arms" test.
  const h = spinnerHarness(fullscreenSpinner);
  // first tick: spinner detected → one-cadence grace, suppressed
  await h.poller.tick();
  expect(h.blocks).toHaveLength(0);
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  // buffer did NOT advance → wedged; re-arm must fire working:false then block
  h.advance(3001);
  await h.poller.tick();
  expect(h.events).toEqual(["working:true", "working:false", "block:awaiting-input"]);
  expect(h.poller.workingBlockedSnapshot()).toEqual({});

  // further identical-buffer cadence: sig-dedupe → no new emissions
  h.advance(3001);
  await h.poller.tick();
  expect(h.events).toEqual(["working:true", "working:false", "block:awaiting-input"]);
});

test("fullscreen: an advancing spinner frame stays suppressed (live turn, not a stall)", async () => {
  // Simulate the elapsed-time counter ticking by appending a distinct suffix each
  // cadence. The spinner line remains valid across all iterations; the buffer
  // advances → suppression holds throughout.
  const h = spinnerHarness(fullscreenSpinner);
  await h.poller.tick(); // first tick: spinner detected → grace, suppressed
  expect(h.blocks).toHaveLength(0);
  expect(h.working).toEqual([{ id: h.id, working: true }]);

  for (let secs = 13; secs <= 16; secs++) {
    // buffer changes each cadence (different suffix) while the spinner line persists
    h.setText(fullscreenSpinner + `\n<!-- tick:${secs} -->`);
    h.advance(3001);
    await h.poller.tick();
  }
  expect(h.blocks).toHaveLength(0);
  expect(h.working).toEqual([{ id: h.id, working: true }]); // only the initial flag-on
  expect(h.poller.workingBlockedSnapshot()).toEqual({ [h.id]: true });
});

// ── auth-URL detection on awaiting-input blocks (MCP OAuth banner source) ──────────
const AUTH_URL =
  "https://mcp.notion.com/authorize?response_type=code&client_id=abc&code_challenge=x&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback";

test("awaiting-input block carries the detected auth URL + blockSnapshot exposes it", async () => {
  const h = spinnerHarness("Open the URL in your browser, then paste the callback here:");
  (h.poller as any).detectAuth = () => AUTH_URL;
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("awaiting-input");
  expect((h.blocks[0]!.block as any).authUrl).toBe(AUTH_URL);
  // snapshot (client bootstrap) exposes the same reason incl. the URL
  expect(h.poller.blockSnapshot()[h.id]?.authUrl).toBe(AUTH_URL);
});

test("awaiting-input block has no authUrl when none is detected", async () => {
  const h = spinnerHarness("Type your answer:");
  (h.poller as any).detectAuth = () => null;
  await h.poller.tick();
  expect((h.blocks[0]!.block as any).shape).toBe("awaiting-input");
  expect((h.blocks[0]!.block as any).authUrl).toBeUndefined();
});

test("detectAuth is not consulted for a non-awaiting (menu) block", async () => {
  const h = spinnerHarness("❯ 1. Yes\n  2. No");
  let calls = 0;
  (h.poller as any).detectAuth = () => {
    calls++;
    return AUTH_URL;
  };
  await h.poller.tick();
  expect((h.blocks[0]!.block as any).shape).toBe("menu");
  expect(calls).toBe(0);
  expect((h.blocks[0]!.block as any).authUrl).toBeUndefined();
});

test("blockSnapshot drops the auth URL when the session resumes", async () => {
  const h = spinnerHarness("Paste the callback URL:");
  (h.poller as any).detectAuth = () => AUTH_URL;
  await h.poller.tick();
  expect(h.poller.blockSnapshot()[h.id]?.authUrl).toBe(AUTH_URL);
  // agent resumes → block clears → snapshot no longer carries it
  h.setStatus("working");
  h.advance(5000);
  await h.poller.tick();
  await flush();
  expect(h.poller.blockSnapshot()[h.id]).toBeUndefined();
});

// ── Resting-session (done/idle) MCP-auth detection (feat #1436 gap fix) ──────────────────
// An MCP OAuth prompt ends the agent's turn → herdr reports `done`, never `blocked`, so the
// normal maybeClassify path never runs. maybeAuthAtRest surfaces it via the injectable
// authMtime/detectRestingAuth seams (driven here without touching disk).
function doneAuthHarness() {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];
  const herdr = {
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
    readAsync: () => Promise.resolve(""),
  };
  let clock = 100_000;
  const poller = new StatusPoller(
    store,
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );
  return { store, id: s.id, blocks, poller, advance: (ms: number) => (clock += ms) };
}

test("emits an awaiting-input auth block for a done session with a fresh pending URL", async () => {
  const h = doneAuthHarness();
  let authCalls = 0;
  h.poller.authMtime = () => 100; // stable mtime
  h.poller.detectRestingAuth = () => {
    authCalls++;
    return { url: AUTH_URL, tail: ["Open this URL in your browser"] };
  };
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).shape).toBe("awaiting-input");
  expect((h.blocks[0]!.block as any).authUrl).toBe(AUTH_URL);
  expect(h.poller.blockSnapshot()[h.id]?.authUrl).toBe(AUTH_URL);
  expect(authCalls).toBe(1);
  // unchanged mtime → no re-read, no re-emit (the standing block is preserved)
  h.advance(5000);
  await h.poller.tick();
  expect(authCalls).toBe(1);
  expect(h.blocks).toHaveLength(1);
});

test("does not latch on a first-tick miss — re-probes when the transcript grows (flush race)", async () => {
  const h = doneAuthHarness();
  let mtime = 100;
  let url: string | null = null; // URL not flushed to the transcript yet
  h.poller.authMtime = () => mtime;
  h.poller.detectRestingAuth = () => ({ url, tail: [] });
  await h.poller.tick();
  expect(h.blocks).toHaveLength(0); // nothing emitted, no suppression latched
  mtime = 200; // transcript appended → mtime bumps
  url = AUTH_URL; // the authorize URL is now present
  h.advance(5000);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  expect((h.blocks[0]!.block as any).authUrl).toBe(AUTH_URL);
});

test("clears the auth block at rest when the URL is answered (mtime bump, no running edge)", async () => {
  const h = doneAuthHarness();
  let mtime = 100;
  let url: string | null = AUTH_URL;
  h.poller.authMtime = () => mtime;
  h.poller.detectRestingAuth = () => ({ url, tail: [] });
  await h.poller.tick();
  expect(h.blocks).toHaveLength(1);
  // operator pastes the callback → transcript changes and detectPendingAuthUrl clears
  mtime = 200;
  url = null;
  h.advance(5000);
  await h.poller.tick();
  expect(h.blocks).toHaveLength(2);
  expect(h.blocks[1]!.block).toBeNull();
  expect(h.poller.blockSnapshot()[h.id]).toBeUndefined();
});

// ── Resting-session (done/idle) `/login` account-URL detection (PTY-only source) ──────────
// The Claude Code `/login` flow prints its authorize URL ONLY to the PTY (never the transcript),
// so the transcript `detectRestingAuth` yields null and detection falls to a throttled async
// visible-buffer read gated by a two-read stability check (a half-painted URL must never latch).
const LOGIN_FULL =
  "https://claude.com/cai/oauth/authorize?response_type=code&code_challenge=abc123&state=xyz789";
// A still-painting prefix — truncated but still an isAuthUrl-valid `/…/authorize` URL.
const LOGIN_PARTIAL = "https://claude.com/cai/oauth/authorize?response_type=cod";
const loginPanel = (url: string) => `─────\n  Login\n\n${url}\n\n  Paste code here if prompted >`;

function doneLoginHarness() {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];
  let visible = "";
  let readCalls = 0;
  let agentStatus = "done";
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
      } as HerdrAgent,
    ],
    read: () => visible, // sync read drives the blocked path (maybeClassify)
    readAsync: () => {
      readCalls++;
      return Promise.resolve(visible);
    },
  };
  let clock = 100_000;
  let alive = true; // a /login modal implies a live claude; the pre-guard skips husk sessions
  const poller = new StatusPoller(
    store,
    withListAsync(herdr as any),
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
    undefined, // probe
    undefined, // stallCfg
    undefined, // probeCheckMs
    undefined, // onReady
    undefined, // onActivity
    undefined, // preview
    // liveness: reflect the mutable `alive` flag every tick (sweepMs 0) instead of scanning /proc
    { scan: (wts) => new Map(wts.map((w) => [w, alive])), sweepMs: 0, onChange: () => {} },
  );
  poller.authMtime = () => 100; // stable transcript mtime
  poller.detectRestingAuth = () => ({ url: null, tail: [] }); // no transcript URL → force PTY source
  return {
    store,
    id: s.id,
    blocks,
    poller,
    advance: (ms: number) => (clock += ms),
    setVisible: (v: string) => (visible = v),
    setStatus: (st: string) => (agentStatus = st),
    setAlive: (a: boolean) => (alive = a),
    readCalls: () => readCalls,
  };
}

/** Drive N throttled probe cadences (advance past reclassifyMs each), resolving each async read. */
async function settleLogin(h: ReturnType<typeof doneLoginHarness>, times = 4) {
  for (let i = 0; i < times; i++) {
    h.advance(3000);
    await h.poller.tick();
    await flush();
  }
}

test("surfaces a /login authorize URL from the PTY after two equal reads (stability gate)", async () => {
  const h = doneLoginHarness();
  h.setVisible(loginPanel(LOGIN_FULL));
  await settleLogin(h);
  const emitted = h.blocks.filter((b) => b.block !== null);
  expect(emitted).toHaveLength(1);
  expect((emitted[0]!.block as any).shape).toBe("awaiting-input");
  expect((emitted[0]!.block as any).authUrl).toBe(LOGIN_FULL);
  expect(h.poller.blockSnapshot()[h.id]?.authUrl).toBe(LOGIN_FULL);
});

test("never emits a still-painting partial URL (emits the full URL once it stabilizes)", async () => {
  const h = doneLoginHarness();
  h.setVisible(loginPanel(LOGIN_PARTIAL));
  h.advance(3000);
  await h.poller.tick();
  await flush(); // read #1 = PARTIAL (observed, unconfirmed)
  h.setVisible(loginPanel(LOGIN_FULL)); // paint completed before the next read
  await settleLogin(h);
  const emitted = h.blocks.filter((b) => b.block !== null);
  expect(emitted.length).toBeGreaterThanOrEqual(1);
  expect(emitted.every((b) => (b.block as any).authUrl === LOGIN_FULL)).toBe(true);
  // the truncated prefix must never have surfaced
  expect(h.blocks.some((b) => (b.block as any)?.authUrl === LOGIN_PARTIAL)).toBe(false);
});

test("clears the /login banner on a no-URL read, with NO running/blocked transition", async () => {
  const h = doneLoginHarness();
  h.setVisible(loginPanel(LOGIN_FULL));
  await settleLogin(h);
  expect(h.blocks.filter((b) => b.block !== null)).toHaveLength(1); // banner up
  // login completes → panel gone, but the session STAYS done (no running edge fires)
  h.setVisible("  Some other screen\n  no url here");
  await settleLogin(h);
  expect(h.blocks[h.blocks.length - 1]!.block).toBeNull();
  expect(h.poller.blockSnapshot()[h.id]).toBeUndefined();
});

test("does not read the PTY while a transcript (MCP) URL stands", async () => {
  const h = doneLoginHarness();
  h.poller.detectRestingAuth = () => ({ url: AUTH_URL, tail: [] }); // transcript owns the banner
  await h.poller.tick();
  expect(h.readCalls()).toBe(0); // PTY source never consulted
  expect((h.blocks[0]!.block as any).authUrl).toBe(AUTH_URL);
});

test("throttles the PTY probe to one read per reclassify cadence", async () => {
  const h = doneLoginHarness();
  h.setVisible(loginPanel(LOGIN_FULL));
  await h.poller.tick();
  await flush(); // read #1
  await h.poller.tick();
  await flush(); // same clock → throttled, no read
  await h.poller.tick();
  await flush();
  expect(h.readCalls()).toBe(1);
  h.advance(3000);
  await h.poller.tick();
  await flush(); // cadence elapsed → read #2
  expect(h.readCalls()).toBe(2);
});

test("drops the confirmed /login cache on the leave-resting edge (no phantom re-emit)", async () => {
  const h = doneLoginHarness();
  h.setVisible(loginPanel(LOGIN_FULL));
  await settleLogin(h);
  expect(h.blocks.filter((b) => b.block !== null)).toHaveLength(1); // banner up
  // agent resumes → the leave-resting edge drops the detection caches
  h.setStatus("working");
  h.advance(3000);
  await h.poller.tick();
  await flush();
  // immediately re-rested: a single tick can only RE-OBSERVE (one read), never RE-CONFIRM, so the
  // stale FULL URL must not instantly re-emit.
  h.setStatus("done");
  const mark = h.blocks.length;
  h.advance(3000);
  await h.poller.tick();
  await flush();
  expect(h.blocks.slice(mark).some((b) => (b.block as any)?.authUrl === LOGIN_FULL)).toBe(false);
});

test("blocked path: reconstructs a /login URL from the visible buffer (after two reads, no partial)", async () => {
  const h = spinnerHarness(loginPanel(LOGIN_FULL));
  (h.poller as any).detectAuth = () => null; // no transcript URL
  await h.poller.tick(); // read #1 → awaiting-input block, URL observed but NOT yet confirmed
  expect((h.blocks[0]!.block as any).shape).toBe("awaiting-input");
  expect((h.blocks[0]!.block as any).authUrl).toBeUndefined();
  h.advance(3000);
  await h.poller.tick(); // read #2 → confirmed → authUrl attached (re-emits, sig now includes authUrl)
  const last = h.blocks[h.blocks.length - 1]!.block as any;
  expect(last.authUrl).toBe(LOGIN_FULL);
  // never a truncated partial
  expect(
    h.blocks.every((b) => {
      const u = (b.block as any)?.authUrl;
      return u === undefined || u === LOGIN_FULL;
    }),
  ).toBe(true);
});

test("blocked→idle inheritance surfaces the AUTH banner with a real (non-empty) tail", async () => {
  const h = doneLoginHarness();
  h.setVisible(loginPanel(LOGIN_FULL));
  (h.poller as any).detectAuth = () => null; // no transcript URL → PTY reconstruction
  // Blocked: two reads confirm the /login URL (blocked path caches into the shared confirmed map).
  h.setStatus("blocked");
  await h.poller.tick();
  h.advance(3000);
  await h.poller.tick();
  await flush();
  // blocked → idle: NOT a leave-resting edge, so the confirmed cache persists and the resting
  // path inherits it. The inherited banner must carry the real login-panel tail, not a placeholder.
  h.setStatus("idle");
  h.advance(3000);
  await h.poller.tick();
  await flush();
  const authBlocks = h.blocks.filter((b) => (b.block as any)?.authUrl === LOGIN_FULL);
  expect(authBlocks.length).toBeGreaterThan(0);
  expect((authBlocks[authBlocks.length - 1]!.block as any).tail.length).toBeGreaterThan(0);
});

test("stops probing the PTY once a resting session's claude is known dead (husk)", async () => {
  const h = doneLoginHarness();
  h.setVisible(loginPanel(LOGIN_FULL));
  h.setAlive(false); // no live claude → no /login modal possible
  await h.poller.tick(); // cold tick: the post-loop liveness sweep records claude-dead
  const afterPrime = h.readCalls(); // the cold tick probes once before the sweep runs (undefined=maybe)
  h.advance(3000);
  await h.poller.tick();
  h.advance(3000);
  await h.poller.tick();
  expect(h.readCalls()).toBe(afterPrime); // no further PTY reads once known dead
  expect(h.blocks.filter((b) => b.block !== null)).toHaveLength(0); // never surfaced a banner
});
