import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import { collectProviderHandoff } from "../src/provider-handoff";
import type { Session } from "../src/types";

function row(id = "h1") {
  const packet = collectProviderHandoff({
    session: {
      id: "s",
      repoPath: "/repo",
      prompt: "task",
      agentProvider: "claude",
      herdrAgentId: "old",
      branch: "b",
    } as Session,
    id,
    targetProvider: "codex",
    now: 1,
    messages: {
      messages: [],
      awaitingInput: false,
      pendingQuestion: null,
      unavailable: "no-transcript",
    },
    queue: { sessionId: "s", approved: false, steps: [] },
  });
  return {
    id,
    sessionId: "s",
    requestId: "req",
    choice: "codex",
    phase: "preparing" as const,
    targetRun: null,
    packet,
    updatedAt: 1,
  };
}

test("handoff request identity is durable and conflicting reuse is rejected", () => {
  const store = new SessionStore(":memory:");
  store.putProviderHandoff(row());
  expect(store.getProviderHandoff("s", "h1")).toEqual(row());
  expect(store.findProviderHandoffRequest("s", "req")?.id).toBe("h1");
  expect(() => store.putProviderHandoff({ ...row("h2"), choice: "claude" })).toThrow();
  expect(store.getProviderHandoff("other", "h1")).toBeNull();
  expect(store.providerHandoffHeld("s")).toBe(true);
  store.putProviderHandoff({ ...row(), phase: "observed" });
  expect(store.providerHandoffHeld("s")).toBe(false);
});

test("identity commit rolls back packet changes if session persistence fails", () => {
  const store = new SessionStore(":memory:");
  store.putProviderHandoff(row());
  expect(() =>
    store.commitProviderHandoff({ ...row(), phase: "pending" }, () => {
      throw new Error("db failure");
    }),
  ).toThrow("db failure");
  expect(store.getProviderHandoff("s", "h1")?.phase).toBe("preparing");
});
