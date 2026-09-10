// Persisting the OBSERVED runtime identity onto the session row (#1823). The poller learns what an
// agent actually ran from its transcript/rollout, but that signal is process-local and pushed over
// SSE only while a session is live — a concluded session or a restarted server would lose it, which
// is what made a card fall back to the configured (usually null → "default") value. These tests pin
// the write cadence: only on change, per FIELD, and never clearing a counterpart it wasn't told about.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { StatusPoller } from "../src/poller";
import type { HerdrAgent } from "../src/herdr";
import type { Session } from "../src/types";
import type { SessionActivity } from "../src/activity-signal";
import type { TranscriptSignals } from "../src/session-liveness";

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

function activity(identity: Partial<SessionActivity>, ts: number): SessionActivity {
  return {
    lastActivityTs: ts,
    summary: "$ echo hi",
    recentTs: [ts],
    recentErrTs: [],
    ...identity,
  };
}

/**
 * The poller's first tick resolves liveness asynchronously, so the transcript-activity emit only
 * happens from the second probe onward. Advance past the probe cadence between ticks so each one
 * really probes.
 */
async function settle(poller: StatusPoller, bump: (ms: number) => void, ticks = 2) {
  for (let i = 0; i < ticks; i++) {
    await poller.tick();
    bump(10_000);
  }
}

function makePoller(
  store: SessionStore,
  now: () => number,
  probe: (s: Session) => TranscriptSignals,
) {
  return new StatusPoller(
    store,
    withListAsync({
      list: () => [liveAgent()],
      read: () => "",
      readAsync: async () => "",
    } as never),
    () => {},
    () => {},
    1000,
    3000,
    (() => null) as never,
    now,
    probe,
  );
}

test("a steady runtime identity is written once, not once per tick", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(codexSession);
  let clock = 1_000_000;
  let writes = 0;
  const realSet = store.setRuntimeIdentity.bind(store);
  store.setRuntimeIdentity = (id, identity) => {
    writes += 1;
    realSet(id, identity);
  };

  const poller = makePoller(
    store,
    () => clock,
    () => ({
      snapshot: null,
      activity: activity({ runtimeModel: "gpt-6-astra", runtimeEffort: "high" }, clock),
    }),
  );

  await settle(poller, (ms) => (clock += ms), 5);

  expect(writes).toBe(1);
  expect(store.get(row.id)?.runtimeModel).toBe("gpt-6-astra");
  expect(store.get(row.id)?.runtimeEffort).toBe("high");
});

test("a model-only signal leaves an already-observed effort standing", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(codexSession);
  store.setRuntimeIdentity(row.id, { runtimeEffort: "high" });

  let clock = 1_000_000;
  const poller = makePoller(
    store,
    () => clock,
    () => ({
      snapshot: null,
      activity: activity({ runtimeModel: "gpt-6-astra" }, clock),
    }),
  );

  await settle(poller, (ms) => (clock += ms));

  expect(store.get(row.id)?.runtimeModel).toBe("gpt-6-astra");
  expect(store.get(row.id)?.runtimeEffort).toBe("high");
});

test("a later signal fills in the missing field", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(codexSession);
  let clock = 1_000_000;
  let identity: Partial<SessionActivity> = { runtimeModel: "gpt-6-astra" };

  const poller = makePoller(
    store,
    () => clock,
    () => ({
      snapshot: null,
      activity: activity(identity, clock),
    }),
  );

  await settle(poller, (ms) => (clock += ms));
  expect(store.get(row.id)?.runtimeModel).toBe("gpt-6-astra");
  expect(store.get(row.id)?.runtimeEffort).toBeNull();

  // The first turn_context lands: same model, effort now known.
  identity = { runtimeModel: "gpt-6-astra", runtimeEffort: "high" };
  await settle(poller, (ms) => (clock += ms), 1);
  expect(store.get(row.id)?.runtimeModel).toBe("gpt-6-astra");
  expect(store.get(row.id)?.runtimeEffort).toBe("high");
});

test("a genuinely changed model replaces the stored one", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(codexSession);
  let clock = 1_000_000;
  let model = "gpt-5.6-sol";

  const poller = makePoller(
    store,
    () => clock,
    () => ({
      snapshot: null,
      activity: activity({ runtimeModel: model }, clock),
    }),
  );

  await settle(poller, (ms) => (clock += ms));
  expect(store.get(row.id)?.runtimeModel).toBe("gpt-5.6-sol");

  model = "gpt-6-astra";
  await settle(poller, (ms) => (clock += ms), 1);
  expect(store.get(row.id)?.runtimeModel).toBe("gpt-6-astra");
});

test("an activity signal carrying no identity writes nothing", async () => {
  const store = new SessionStore(":memory:");
  const row = store.create(codexSession);
  let clock = 1_000_000;
  let writes = 0;
  store.setRuntimeIdentity = () => void (writes += 1);

  const poller = makePoller(
    store,
    () => clock,
    () => ({
      snapshot: null,
      activity: activity({}, clock),
    }),
  );

  await settle(poller, (ms) => (clock += ms), 3);

  expect(writes).toBe(0);
  expect(store.get(row.id)?.runtimeModel).toBeNull();
});
