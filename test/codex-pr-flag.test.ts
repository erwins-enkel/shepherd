import { test, expect } from "bun:test";
import { EventHub } from "../src/events";
import { SessionStore } from "../src/store";
import { wireCodexPrFlag } from "../src/codex-pr-flag";
import type { GitForge, GitState } from "../src/forge/types";

/** Flush pending microtasks so wireCodexPrFlag's async addPrLabel .then/.catch runs. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function harness(
  opts: {
    /** undefined → default recording forge; null → resolveForge returns null;
     *  otherwise the given (possibly addPrLabel-less) forge. */
    forge?: GitForge | null;
    reject?: boolean;
  } = {},
) {
  const events = new EventHub();
  const store = new SessionStore(":memory:");
  const calls: { prNumber: number; label: string }[] = [];
  const recording = {
    addPrLabel: async (prNumber: number, label: string) => {
      calls.push({ prNumber, label });
      if (opts.reject) throw new Error("HTTP 403: no write access");
    },
  } as unknown as GitForge;
  const forge = opts.forge === undefined ? recording : opts.forge;
  wireCodexPrFlag({ events, store, resolveForge: () => forge });
  return { events, store, calls };
}

function makeSession(
  store: SessionStore,
  overrides: Partial<{ agentProvider: "claude" | "codex" }> = {},
) {
  return store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_a",
    ...overrides,
  });
}

function git(overrides: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "none",
    checks: "none",
    deployConfigured: false,
    ...overrides,
  } as GitState;
}

/** Suppress console.warn for the duration of `fn` (the failure-path tests warn on purpose). */
async function quiet(fn: () => Promise<void>) {
  const orig = console.warn;
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
}

test("cold-start: first-ever session:git already open labels a codex PR once", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();

  expect(calls).toEqual([{ prNumber: 42, label: "codex-authored" }]);
});

test("idempotent: repeated open events after success do not re-label", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();
  // checks churn — still open
  events.emit("session:git", {
    id: s.id,
    git: git({ state: "open", number: 42, checks: "pending" }),
  });
  await tick();

  expect(calls).toHaveLength(1);
});

test("busy guard: two back-to-back open events (no flush) only fire one attempt", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();

  expect(calls).toHaveLength(1);
});

test("claude session is never labeled", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store, { agentProvider: "claude" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();

  expect(calls).toHaveLength(0);
});

test("default provider (unset → claude) is never labeled", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store); // no agentProvider

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();

  expect(calls).toHaveLength(0);
});

test("non-open states are never labeled", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", { id: s.id, git: git({ state: "merged", number: 42 }) });
  events.emit("session:git", { id: s.id, git: git({ state: "closed", number: 42 }) });
  await tick();

  expect(calls).toHaveLength(0);
});

test("open with no PR number is never labeled", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: undefined }) });
  await tick();

  expect(calls).toHaveLength(0);
});

test("null forge (resolveForge → null) is skipped without throwing", async () => {
  const { events, store, calls } = harness({ forge: null });
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();

  expect(calls).toHaveLength(0);
});

test("forge without addPrLabel (e.g. Gitea) is skipped without throwing", async () => {
  const { events, store, calls } = harness({ forge: {} as GitForge });
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();

  expect(calls).toHaveLength(0);
});

test("failing add retries but stops at MAX_ATTEMPTS (no unbounded calls)", async () => {
  await quiet(async () => {
    const { events, store, calls } = harness({ reject: true });
    const s = makeSession(store, { agentProvider: "codex" });

    // Emit far more open events than the cap; each needs a flush so the prior catch
    // clears `busy` before the next attempt is allowed.
    for (let i = 0; i < 6; i++) {
      events.emit("session:git", {
        id: s.id,
        git: git({ state: "open", number: 42, checks: "pending" }),
      });
      await tick();
    }

    expect(calls).toHaveLength(3); // MAX_ATTEMPTS
  });
});

test("session:archived clears guards so a later open re-labels", async () => {
  const { events, store, calls } = harness();
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();
  expect(calls).toHaveLength(1);

  events.emit("session:archived", { id: s.id });

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42 }) });
  await tick();
  expect(calls).toHaveLength(2);
});
