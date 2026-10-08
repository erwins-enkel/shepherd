/**
 * Background-shell busy flag on StatusPoller: a resting (idle/done) claude session whose
 * process still runs a non-server background Bash shell is flagged, so it stays out of Ready.
 */
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller, BACKGROUND_BUSY_CAP_MS } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";

const baseAgent: HerdrAgent = {
  agent: "claude",
  agentStatus: "working",
  cwd: "/wt-a",
  paneId: "p",
  tabId: "t",
  name: "",
  terminalId: "term_a",
  workspaceId: "w",
};

const baseSessionInput = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt-a",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
};

type Scan = (worktrees: string[]) => Map<string, string[]> | null;

function setup(initialScan: Scan) {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSessionInput);
  const agent: HerdrAgent = { ...baseAgent };
  const log: string[] = [];
  const box = { scan: initialScan, clock: 100_000 };
  const poller = new StatusPoller(
    store,
    { listAsync: () => Promise.resolve([agent]), read: () => "", readAsync: async () => "" } as any,
    (id, status) => log.push(`status:${status}`),
    () => {},
    1000,
    3000,
    undefined,
    () => box.clock,
    () => ({ snapshot: null, activity: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    {
      service: { ensure: () => null, release: () => {}, converge: () => {}, snapshot: () => ({}) },
      sweepMs: 4000,
      scan: () => new Map(),
      pick: async () => null,
    },
    { scan: () => new Map(), sweepMs: 4000, onChange: () => {} },
    undefined, // onWorkingBlocked
    undefined, // pruneHooks
    () => {}, // onStopWindow: silence the logger
    undefined, // onHalt
    undefined, // usageLimits
    () => null, // detectAuth
    undefined, // archiveTerminal
    undefined, // codexTranscripts
    () => null, // readResumeSignal
    {
      scan: (w) => box.scan(w),
      sweepMs: 4000,
      onChange: (id, busy) => log.push(`bg:${busy}`),
    },
  );
  return { store, s, agent, log, box, poller };
}

const busy: Scan = (w) => new Map(w.map((p) => [p, ["git push"]]));
const quiet: Scan = (w) => new Map(w.map((p) => [p, []]));

test("edge probe flags the session BEFORE the resting status onChange", async () => {
  const { s, agent, log, poller } = setup(busy);
  await poller.tick(); // running
  expect(poller.isBackgroundBusy(s.id)).toBe(false);
  log.length = 0;
  agent.agentStatus = "idle";
  await poller.tick();
  expect(log.slice(0, 2)).toEqual(["bg:true", "status:idle"]);
  expect(poller.isBackgroundBusy(s.id)).toBe(true);
  expect(poller.backgroundBusySnapshot()).toEqual({ [s.id]: true });
});

test("going running clears the flag", async () => {
  const { s, agent, log, box, poller } = setup(busy);
  await poller.tick();
  agent.agentStatus = "done";
  await poller.tick();
  expect(poller.isBackgroundBusy(s.id)).toBe(true);
  log.length = 0;
  agent.agentStatus = "working";
  box.clock += 1000;
  await poller.tick();
  expect(log).toContain("bg:false");
  expect(log.indexOf("bg:false")).toBeLessThan(log.indexOf("status:running"));
  expect(poller.isBackgroundBusy(s.id)).toBe(false);
  expect(poller.backgroundBusySnapshot()).toEqual({});
});

test("30-min cap clears and stays cleared until the session runs again", async () => {
  const { s, agent, log, box, poller } = setup(busy);
  await poller.tick();
  agent.agentStatus = "idle";
  await poller.tick();
  expect(poller.isBackgroundBusy(s.id)).toBe(true);

  box.clock += BACKGROUND_BUSY_CAP_MS - 1;
  await poller.tick(); // sweep, still within the cap
  expect(poller.isBackgroundBusy(s.id)).toBe(true);

  box.clock += 1;
  // the sweep throttle needs sweepMs since its last pass
  box.clock += 4000;
  await poller.tick();
  expect(poller.isBackgroundBusy(s.id)).toBe(false);
  expect(log.filter((l) => l.startsWith("bg:"))).toEqual(["bg:true", "bg:false"]);

  box.clock += 10_000;
  await poller.tick(); // shell still running, but capped → no re-flag
  expect(poller.isBackgroundBusy(s.id)).toBe(false);

  agent.agentStatus = "working";
  box.clock += 1000;
  await poller.tick();
  agent.agentStatus = "idle";
  box.clock += 1000;
  await poller.tick(); // new rest episode → edge probe flags again
  expect(poller.isBackgroundBusy(s.id)).toBe(true);
});

test("a null scan leaves the flag state untouched", async () => {
  const { s, agent, box, poller } = setup(() => null);
  await poller.tick();
  agent.agentStatus = "idle";
  await poller.tick(); // edge probe: unknown → no flag
  expect(poller.isBackgroundBusy(s.id)).toBe(false);

  box.scan = busy;
  box.clock += 5000;
  await poller.tick(); // sweep flags
  expect(poller.isBackgroundBusy(s.id)).toBe(true);

  box.scan = () => null;
  box.clock += 5000;
  await poller.tick(); // unknown → stays flagged
  expect(poller.isBackgroundBusy(s.id)).toBe(true);
});

test("an empty scan clears the flag", async () => {
  const { s, agent, log, box, poller } = setup(busy);
  await poller.tick();
  agent.agentStatus = "idle";
  await poller.tick();
  expect(poller.isBackgroundBusy(s.id)).toBe(true);
  box.scan = quiet;
  box.clock += 5000;
  await poller.tick();
  expect(poller.isBackgroundBusy(s.id)).toBe(false);
  expect(log.filter((l) => l.startsWith("bg:"))).toEqual(["bg:true", "bg:false"]);
});

test("archiving a flagged session clears it", async () => {
  const { store, s, agent, log, poller } = setup(busy);
  await poller.tick();
  agent.agentStatus = "idle";
  await poller.tick();
  expect(poller.isBackgroundBusy(s.id)).toBe(true);
  store.archive(s.id);
  await poller.tick();
  expect(poller.isBackgroundBusy(s.id)).toBe(false);
  expect(log.filter((l) => l.startsWith("bg:"))).toEqual(["bg:true", "bg:false"]);
});
