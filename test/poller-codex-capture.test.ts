// Poller-side back-off for the Codex provider-session-id seed (issue #1175). tick() invokes the
// injectable `poller.captureCodexSessionId` for a live isolated Codex session, but that call scans the
// whole `$CODEX_HOME/sessions` tree. A session that never matches (rollout GC'd / no `source=cli`
// header) must not rescan every 1s tick — an applicable miss (the hook returns `true`) backs off
// exponentially; a hit / non-applicable session (returns `false`) clears the back-off. The actual
// discovery is exercised in test/codex-session-id.test.ts + service.test.ts; here we prove the cadence.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";

/**
 * tick() (issue #1529) now reads agents over the socket via `listAsync()`, not the
 * sync `list()` these pre-existing herdr fakes were written against. Rather than
 * duplicate each fake's (sometimes stateful) `list()` logic, mirror it: `listAsync`
 * resolves to whatever `list()` returns at call time.
 */
function withListAsync<T extends { list: () => HerdrAgent[] }>(
  herdr: T,
): T & { listAsync: () => Promise<HerdrAgent[]> } {
  return { ...herdr, listAsync: () => Promise.resolve(herdr.list()) };
}

const codexSession = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "T1",
  agentProvider: "codex" as const,
};

function liveAgent(): HerdrAgent {
  return {
    agent: "codex",
    agentStatus: "working",
    cwd: "/wt",
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId: "T1",
    workspaceId: "w",
  };
}

function makePoller(store: SessionStore, agents: HerdrAgent[], now: () => number) {
  return new StatusPoller(
    store,
    withListAsync({ list: () => agents, read: () => "", readAsync: async () => "" } as never),
    () => {},
    () => {},
    1000,
    3000,
    (() => null) as never,
    now,
  );
}

test("a never-matching capture backs off exponentially instead of scanning every tick", async () => {
  const store = new SessionStore(":memory:");
  store.create(codexSession);
  let clock = 1_000_000;
  const poller = makePoller(store, [liveAgent()], () => clock);

  let calls = 0;
  poller.captureCodexSessionId = () => {
    calls++;
    return true; // always an applicable miss
  };

  await poller.tick(); // attempt #1 → miss, next allowed at +2000ms
  expect(calls).toBe(1);

  await poller.tick(); // no clock advance → still cooling down
  expect(calls).toBe(1);

  clock += 1999; // just before the 2000ms window
  await poller.tick();
  expect(calls).toBe(1);

  clock += 1; // window elapsed
  await poller.tick(); // attempt #2 → miss, next allowed at +4000ms
  expect(calls).toBe(2);

  clock += 2000; // 2000ms < the widened 4000ms window
  await poller.tick();
  expect(calls).toBe(2);

  clock += 2000; // 4000ms total → window elapsed
  await poller.tick(); // attempt #3
  expect(calls).toBe(3);
});

test("a hit / non-applicable capture clears the back-off (next tick attempts immediately)", async () => {
  const store = new SessionStore(":memory:");
  store.create(codexSession);
  let clock = 1_000_000;
  const poller = makePoller(store, [liveAgent()], () => clock);

  let calls = 0;
  let miss = true;
  poller.captureCodexSessionId = () => {
    calls++;
    return miss;
  };

  await poller.tick(); // miss → back-off set
  expect(calls).toBe(1);

  miss = false; // now reports non-applicable / seeded
  clock += 2000;
  await poller.tick(); // window elapsed → attempts, returns false → clears entry
  expect(calls).toBe(2);

  await poller.tick(); // no back-off entry → attempts again immediately (no clock advance)
  expect(calls).toBe(3);
});

test("tick() never throws when the capture hook throws (fire-and-forget)", async () => {
  const store = new SessionStore(":memory:");
  store.create(codexSession);
  const poller = makePoller(store, [liveAgent()], () => 1_000_000);

  poller.captureCodexSessionId = () => {
    throw new Error("boom");
  };

  await expect(poller.tick()).resolves.toBeUndefined();
});
