import { expect, test } from "bun:test";
import { CodexCapacityGate } from "../src/codex-capacity";

test("Codex capacity: waits durably, deduplicates, preserves identity and resumes once", async () => {
  const saved = new Map<string, string>();
  let free = false;
  const run: string[] = [];
  const deps = {
    store: {
      getSetting: (k: string) => saved.get(k) ?? null,
      setSetting: (k: string, v: string) => {
        saved.set(k, v);
      },
    },
    reset: {
      ensureCapacity: async () => {},
      canRun: () => free,
      currentAccountId: () => "account-a",
      setWaitingCount: () => {},
    },
  };
  const intent = {
    owner: "autopilot" as const,
    key: "autopilot:one",
    target: "one",
    provider: "codex" as const,
    model: "chosen-model",
    fingerprint: "head-a",
  };
  const gate = new CodexCapacityGate(deps);
  expect(await gate.admit(intent)).toBe(false);
  expect(await gate.admit(intent)).toBe(false);
  expect(gate.pending()).toHaveLength(1);
  expect(await gate.admit({ ...intent, key: "claude:two", provider: "claude" })).toBe(true);
  const restarted = new CodexCapacityGate(deps);
  expect(restarted.pending()[0]).toMatchObject({ model: "chosen-model", fingerprint: "head-a" });
  free = true;
  await restarted.reconcile(async (i) => {
    run.push(i.target);
    return true;
  });
  await restarted.reconcile(async (i) => {
    run.push(i.target);
    return true;
  });
  expect(run).toEqual(["one"]);
  expect(restarted.pending()).toHaveLength(0);
});

test("Codex capacity: never transfers pending work to a new account and removes cancelled targets", async () => {
  let account = "a";
  let free = false;
  const settings = new Map<string, string>();
  const gate = new CodexCapacityGate({
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => {
        settings.set(k, v);
      },
    },
    reset: {
      ensureCapacity: async () => {},
      canRun: () => free,
      currentAccountId: () => account,
      setWaitingCount: () => {},
    },
  });
  await gate.admit({
    owner: "review",
    key: "review:one",
    target: "one",
    provider: "codex",
    model: null,
  });
  account = "b";
  free = true;
  let runs = 0;
  await gate.reconcile(async () => {
    runs++;
    return true;
  });
  expect(runs).toBe(0);
  gate.forget("one");
  expect(gate.pending()).toHaveLength(0);
});

test("Codex capacity: a renewed wait during replay is not discarded", async () => {
  const settings = new Map<string, string>();
  let free = false;
  const gate = new CodexCapacityGate({
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => {
        settings.set(k, v);
      },
    },
    reset: {
      ensureCapacity: async () => {},
      canRun: () => free,
      currentAccountId: () => "a",
      setWaitingCount: () => {},
    },
  });
  const intent = {
    owner: "plan" as const,
    key: "plan:one",
    target: "one",
    provider: "codex" as const,
    model: null,
  };
  await gate.admit(intent);
  free = true;
  await gate.reconcile(async (i) => {
    free = false;
    await gate.admit(i);
    return true;
  });
  expect(gate.pending()).toHaveLength(1);
});

test("Codex capacity: only the latest structured usage error is a capacity interruption", async () => {
  const { codexCapacityInterrupted } = await import("../src/codex-capacity");
  const error = JSON.stringify({
    type: "event_msg",
    payload: { type: "error", codex_error_info: "usage_limit_exceeded" },
  });
  expect(codexCapacityInterrupted(error)).toBe(true);
  expect(
    codexCapacityInterrupted(
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "usage_limit_exceeded" },
      }),
    ),
  ).toBe(false);
  expect(
    codexCapacityInterrupted(
      error + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ),
  ).toBe(false);
  expect(
    codexCapacityInterrupted(
      error +
        "\n" +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "error", codex_error_info: "internal_server_error" },
        }),
    ),
  ).toBe(false);
});

test("Codex capacity: concurrent admission of one blocked intention remains one row", async () => {
  const settings = new Map<string, string>();
  const gate = new CodexCapacityGate({
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => {
        settings.set(k, v);
      },
    },
    reset: {
      ensureCapacity: async () => {},
      canRun: () => false,
      currentAccountId: () => "a",
      setWaitingCount: () => {},
    },
  });
  const intent = {
    owner: "review" as const,
    key: "review:one",
    target: "one",
    provider: "codex" as const,
    model: null,
  };
  await Promise.all(Array.from({ length: 10 }, () => gate.admit(intent)));
  expect(gate.pending()).toHaveLength(1);
});

test("Codex capacity review: changed helper environments are pruned before demand or replay", async () => {
  const settings = new Map<string, string>();
  let calls = 0;
  const gate = new CodexCapacityGate({
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => {
        settings.set(k, v);
      },
    },
    reset: {
      ensureCapacity: async () => {
        calls++;
      },
      canRun: () => true,
      currentAccountId: () => "a",
      setWaitingCount: () => {},
    },
  });
  gate.defer({ owner: "plan", key: "plan:x", target: "x", provider: "codex", model: "old" });
  gate.prune((i) => i.provider === "codex" && i.model === "new");
  await gate.reconcile(async () => {
    throw new Error("must not replay changed model");
  });
  expect(gate.pending()).toHaveLength(0);
  expect(calls).toBe(0);
});

test("Codex capacity review: a missing PR snapshot preserves a findings continuation until replay", async () => {
  const settings = new Map<string, string>();
  let git: { headSha: string } | null = null;
  let runs = 0;
  const gate = new CodexCapacityGate({
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => {
        settings.set(k, v);
      },
    },
    reset: {
      ensureCapacity: async () => {},
      canRun: () => true,
      currentAccountId: () => "a",
      setWaitingCount: () => {},
    },
  });
  gate.defer({
    owner: "reviewFindings",
    key: "reviewFindings:x",
    target: "x",
    provider: "codex",
    model: null,
    fingerprint: "head",
  });
  const replay = async () => {
    if (!git) return false;
    runs++;
    return true;
  };
  await gate.reconcile(replay);
  expect(gate.pending()).toHaveLength(1);
  git = { headSha: "head" };
  await gate.reconcile(replay);
  await gate.reconcile(replay);
  expect(runs).toBe(1);
  expect(gate.pending()).toHaveLength(0);
});
