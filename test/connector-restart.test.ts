import { test, expect } from "bun:test";
import {
  ConnectorRestartService,
  CONNECTOR_RESTART_MAX_ATTEMPTS,
  CONNECTOR_RESTART_SETTLE_MS,
} from "../src/connector-restart";
import type { LivenessState, Session } from "../src/types";

const NOW = 1_000_000;
const SETTLED = NOW - CONNECTOR_RESTART_SETTLE_MS;

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    repoPath: "/repo",
    agentProvider: "claude",
    status: "idle",
    settledAt: SETTLED,
    claudeAiConnectors: null,
    terminal: false,
    operatorAssistant: false,
    ...over,
  } as Session;
}

function harness(opts: {
  sessions: Session[];
  enabled?: Record<string, boolean>;
  liveness?: LivenessState | undefined;
  resume?: (id: string) => Promise<unknown>;
}) {
  const resumed: string[] = [];
  let now = NOW;
  const svc = new ConnectorRestartService({
    store: {
      list: () => opts.sessions,
      getRepoConfig: (repo: string) => ({
        claudeAiConnectorsEnabled: opts.enabled?.[repo] ?? true,
      }),
    } as any,
    livenessOf: () => ("liveness" in opts ? opts.liveness : "alive"),
    resume: async (id) => {
      resumed.push(id);
      return opts.resume ? opts.resume(id) : { id };
    },
    now: () => now,
  });
  return { svc, resumed, advance: (ms: number) => (now += ms) };
}

test("a settled live session spawned with the old setting is force-resumed", async () => {
  const { svc, resumed } = harness({ sessions: [session()] });
  await svc.sweep();
  expect(resumed).toEqual(["s1"]);
});

test("done counts as settled too", async () => {
  const { svc, resumed } = harness({ sessions: [session({ status: "done" })] });
  await svc.sweep();
  expect(resumed).toEqual(["s1"]);
});

test("a matching stamp restarts nothing; null reads as spawned with connectors off", async () => {
  const on = harness({ sessions: [session({ claudeAiConnectors: true })] });
  await on.svc.sweep();
  expect(on.resumed).toEqual([]);
  const off = harness({
    sessions: [session({ claudeAiConnectors: null })],
    enabled: { "/repo": false },
  });
  await off.svc.sweep();
  expect(off.resumed).toEqual([]);
});

test("switching back off restarts a session spawned with connectors on", async () => {
  const { svc, resumed } = harness({
    sessions: [session({ claudeAiConnectors: true })],
    enabled: { "/repo": false },
  });
  await svc.sweep();
  expect(resumed).toEqual(["s1"]);
});

test("a working or blocked session waits until it settles", async () => {
  const s = session({ status: "running", settledAt: null });
  const { svc, resumed, advance } = harness({ sessions: [s] });
  await svc.sweep();
  s.status = "blocked";
  await svc.sweep();
  expect(resumed).toEqual([]);

  // turn ends: the first idle tick is not settled yet …
  s.status = "idle";
  s.settledAt = NOW;
  await svc.sweep();
  expect(resumed).toEqual([]);
  // … one settle window later it is.
  advance(CONNECTOR_RESTART_SETTLE_MS);
  await svc.sweep();
  expect(resumed).toEqual(["s1"]);
});

test("Codex, the Operator Assistant and terminal sessions are never restarted", async () => {
  const { svc, resumed } = harness({
    sessions: [
      session({ id: "codex", agentProvider: "codex" }),
      session({ id: "assistant", operatorAssistant: true }),
      session({ id: "terminal", terminal: true }),
    ],
  });
  await svc.sweep();
  expect(resumed).toEqual([]);
});

test("a session without a live agent is left for its next resume", async () => {
  for (const liveness of ["husk", "stranded", undefined] as const) {
    const { svc, resumed } = harness({ sessions: [session()], liveness });
    await svc.sweep();
    expect(resumed).toEqual([]);
  }
});

test("the setting is read per repo", async () => {
  const { svc, resumed } = harness({
    sessions: [session({ id: "a", repoPath: "/a" }), session({ id: "b", repoPath: "/b" })],
    enabled: { "/a": true, "/b": false },
  });
  await svc.sweep();
  expect(resumed).toEqual(["a"]);
});

test("gives up after the attempt cap, and tries again once the target changes", async () => {
  const sessions = [session()];
  const enabled = { "/repo": true };
  const { svc, resumed } = harness({ sessions, enabled, resume: async () => null });
  for (let i = 0; i < CONNECTOR_RESTART_MAX_ATTEMPTS + 2; i++) await svc.sweep();
  expect(resumed).toHaveLength(CONNECTOR_RESTART_MAX_ATTEMPTS);

  // flipped back and forth: a fresh target gets a fresh budget
  sessions[0]!.claudeAiConnectors = true;
  enabled["/repo"] = false;
  await svc.sweep();
  expect(resumed).toHaveLength(CONNECTOR_RESTART_MAX_ATTEMPTS + 1);
});

test("a throwing resume counts as a failed attempt and does not abort the pass", async () => {
  const { svc, resumed } = harness({
    sessions: [session({ id: "a" }), session({ id: "b" })],
    resume: async (id) => {
      if (id === "a") throw new Error("boom");
      return { id };
    },
  });
  await svc.sweep();
  expect(resumed).toEqual(["a", "b"]);
});

test("an overlapping sweep is dropped", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { svc, resumed } = harness({
    sessions: [session()],
    resume: async () => {
      await gate;
      return {};
    },
  });
  const first = svc.sweep();
  await svc.sweep();
  release();
  await first;
  expect(resumed).toEqual(["s1"]);
});
