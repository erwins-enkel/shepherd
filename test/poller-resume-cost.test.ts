// Cold-resume reading across the running↔parked boundary (#2042).
//
// The marker warns the operator what the FIRST turn back into a parked session will cost, so the
// reading is measured once when the session parks (its transcript can no longer change) and
// cleared when it resumes (that turn pays the cost, and every turn after it is warm). These tests
// pin both edges — especially the clear, without which a resumed session keeps a `coldResumeAt`
// that is already in the past, satisfies "now > coldResumeAt" forever, and pins the warning across
// active, rewarmed work.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";
import type { HerdrState, Session } from "../src/types";
import type { ResumeSignal } from "../src/usage";

function withListAsync<T extends { list: () => HerdrAgent[] }>(
  herdr: T,
): T & { listAsync: () => Promise<HerdrAgent[]> } {
  return { ...herdr, listAsync: () => Promise.resolve(herdr.list()) };
}

const claudeSession = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "T1",
  claudeSessionId: "c0ffee00-0000-4000-8000-000000000001",
};

function agentIn(state: HerdrState): HerdrAgent {
  return {
    agent: "claude",
    agentStatus: state,
    cwd: "/wt",
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId: "T1",
    workspaceId: "w",
  };
}

const PARKED: ResumeSignal = {
  contextTokens: 180_000,
  coldResumeAt: 1_800_000_000_000,
  resumeCostUnits: 1.572,
};

function makePoller(
  store: SessionStore,
  now: () => number,
  state: () => HerdrState,
  readResumeSignal: (s: Session) => ResumeSignal | null,
) {
  const poller = new StatusPoller(
    store,
    withListAsync({
      list: () => [agentIn(state())],
      read: () => "",
      readAsync: async () => "",
    } as never),
    () => {},
    () => {},
    1000,
    3000,
    undefined, // classify: keep the real one — the blocked path dereferences its result
    now,
    (() => ({ snapshot: null, activity: null })) as never,
  );
  // The reader is the constructor's 24th parameter; assigning it here is the same seam the
  // detectAuth tests use, rather than threading fifteen positional `undefined`s.
  (
    poller as unknown as { readResumeSignal: (s: Session) => ResumeSignal | null }
  ).readResumeSignal = readResumeSignal;
  return poller;
}

/** Drive the poller far enough that one status transition is reconciled. */
async function settle(poller: StatusPoller, bump: (ms: number) => void, ticks = 2) {
  for (let i = 0; i < ticks; i++) {
    await poller.tick();
    bump(10_000);
  }
}

test("running → idle captures the reading", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(claudeSession);
  let clock = 1_000_000;
  let state: HerdrState = "working";

  const poller = makePoller(
    store,
    () => clock,
    () => state,
    () => PARKED,
  );
  await settle(poller, (ms) => (clock += ms));
  expect(store.get(row.id)?.status).toBe("running");
  expect(store.get(row.id)?.coldResumeAt).toBeNull();

  state = "idle";
  await settle(poller, (ms) => (clock += ms), 1);

  const parked = store.get(row.id)!;
  expect(parked.contextTokens).toBe(180_000);
  expect(parked.coldResumeAt).toBe(1_800_000_000_000);
  expect(parked.resumeCostUnits).toBeCloseTo(1.572, 6);
});

// Awaiting the operator is parked too: the cache expires while it waits, exactly as when idle.
test("running → blocked captures the reading", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(claudeSession);
  let clock = 1_000_000;
  let state: HerdrState = "working";

  const poller = makePoller(
    store,
    () => clock,
    () => state,
    () => PARKED,
  );
  await settle(poller, (ms) => (clock += ms));

  state = "blocked";
  await settle(poller, (ms) => (clock += ms), 1);

  expect(store.get(row.id)?.status).toBe("blocked");
  expect(store.get(row.id)?.coldResumeAt).toBe(1_800_000_000_000);
});

test("idle → running CLEARS the reading, so a stale warning cannot survive the resume", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(claudeSession);
  store.setResumeSignal(row.id, PARKED);
  let clock = 1_000_000;
  let state: HerdrState = "idle";

  const poller = makePoller(
    store,
    () => clock,
    () => state,
    () => PARKED,
  );
  await settle(poller, (ms) => (clock += ms));

  state = "working";
  await settle(poller, (ms) => (clock += ms), 1);

  const resumed = store.get(row.id)!;
  expect(resumed.status).toBe("running");
  expect(resumed.contextTokens).toBeNull();
  expect(resumed.coldResumeAt).toBeNull();
  expect(resumed.resumeCostUnits).toBeNull();
});

test("park → resume → park ends on the SECOND park's reading, never the first's", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(claudeSession);
  let clock = 1_000_000;
  let state: HerdrState = "working";
  let reading: ResumeSignal = PARKED;

  const poller = makePoller(
    store,
    () => clock,
    () => state,
    () => reading,
  );
  await settle(poller, (ms) => (clock += ms));

  state = "idle";
  await settle(poller, (ms) => (clock += ms), 1);
  expect(store.get(row.id)?.contextTokens).toBe(180_000);

  state = "working";
  await settle(poller, (ms) => (clock += ms), 1);
  expect(store.get(row.id)?.contextTokens).toBeNull();

  // The session worked some more, so the next park measures a bigger context.
  reading = { contextTokens: 260_000, coldResumeAt: 1_900_000_000_000, resumeCostUnits: 2.372 };
  state = "idle";
  await settle(poller, (ms) => (clock += ms), 1);

  const reparked = store.get(row.id)!;
  expect(reparked.contextTokens).toBe(260_000);
  expect(reparked.coldResumeAt).toBe(1_900_000_000_000);
});

test("steady state writes nothing — no churn while running, none while parked", async () => {
  const store = new SessionStore(":memory:");
  store.create(claudeSession);
  let clock = 1_000_000;
  let state: HerdrState = "working";
  let writes = 0;
  const realSet = store.setResumeSignal.bind(store);
  store.setResumeSignal = (id, signal) => {
    writes += 1;
    realSet(id, signal);
  };

  const poller = makePoller(
    store,
    () => clock,
    () => state,
    () => PARKED,
  );
  // Many ticks while running: the resume edge must not re-clear an already-null row.
  await settle(poller, (ms) => (clock += ms), 5);
  expect(writes).toBe(0);

  // One park writes once; further parked ticks write nothing more.
  state = "idle";
  await settle(poller, (ms) => (clock += ms), 5);
  expect(writes).toBe(1);
});

test("a session with no priceable reading is never written", async () => {
  // Codex sessions and transcript-less Claude sessions both land here via the real reader's null.
  const store = new SessionStore(":memory:");
  const row = store.create(claudeSession);
  let clock = 1_000_000;
  let state: HerdrState = "working";
  let writes = 0;
  const realSet = store.setResumeSignal.bind(store);
  store.setResumeSignal = (id, signal) => {
    writes += 1;
    realSet(id, signal);
  };

  const poller = makePoller(
    store,
    () => clock,
    () => state,
    () => null,
  );
  await settle(poller, (ms) => (clock += ms));

  state = "idle";
  await settle(poller, (ms) => (clock += ms), 1);

  expect(writes).toBe(0);
  expect(store.get(row.id)?.coldResumeAt).toBeNull();
});

test("a throwing reader leaves the row untouched and does not break the tick", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(claudeSession);
  let clock = 1_000_000;
  let state: HerdrState = "working";
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" "));

  try {
    const poller = makePoller(
      store,
      () => clock,
      () => state,
      () => {
        throw new Error("transcript exploded");
      },
    );
    await settle(poller, (ms) => (clock += ms));

    state = "idle";
    await settle(poller, (ms) => (clock += ms), 1);

    expect(store.get(row.id)?.status).toBe("idle"); // the tick still reconciled
    expect(store.get(row.id)?.coldResumeAt).toBeNull();
    expect(warns.some((w) => w.includes("cold-resume read failed"))).toBe(true);
  } finally {
    console.warn = origWarn;
  }
});
