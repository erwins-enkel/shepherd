import { test, expect } from "bun:test";
import { EventHub } from "../src/events";
import { SessionStore } from "../src/store";
import { wirePrOpenedTelemetry } from "../src/pr-opened-telemetry";
import type { GitState } from "../src/forge/types";

function harness() {
  const events = new EventHub();
  const store = new SessionStore(":memory:");
  const emitted: { name: string; props: Record<string, unknown> }[] = [];
  wirePrOpenedTelemetry({
    events,
    store,
    telemetry: { event: (name, props = {}) => emitted.push({ name, props }) },
  });
  return { events, store, emitted };
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

function prOpenedEvents(emitted: { name: string; props: Record<string, unknown> }[]) {
  return emitted.filter((e) => e.name === "pr_opened");
}

test("none -> open fires once with agentProvider + isDraft props", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store, { agentProvider: "codex" });

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });

  const fired = prOpenedEvents(emitted);
  expect(fired).toHaveLength(1);
  expect(fired[0]?.props).toEqual({ agentProvider: "codex", isDraft: false });
});

test("cold-start skip: first-ever session:git already open does not fire", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store);

  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 7, isDraft: false }) });

  expect(prOpenedEvents(emitted)).toHaveLength(0);
});

test("open -> open does not re-fire", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store);

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });
  // checks changed but still open
  events.emit("session:git", {
    id: s.id,
    git: git({ state: "open", number: 42, isDraft: false, checks: "pending" }),
  });

  expect(prOpenedEvents(emitted)).toHaveLength(1);
});

test("double-fire dedup: two back-to-back open events after none only fire once", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store);

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });

  expect(prOpenedEvents(emitted)).toHaveLength(1);
});

test("isDraft passthrough: none -> open with isDraft true", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store);

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: true }) });

  const fired = prOpenedEvents(emitted);
  expect(fired).toHaveLength(1);
  expect(fired[0]?.props.isDraft).toBe(true);
});

test("open with no number does not fire", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store);

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", {
    id: s.id,
    git: git({ state: "open", number: undefined, isDraft: false }),
  });

  expect(prOpenedEvents(emitted)).toHaveLength(0);
});

test("session:archived clears per-session state so a later cold-start open does not false-fire", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store);

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });
  expect(prOpenedEvents(emitted)).toHaveLength(1);

  events.emit("session:archived", { id: s.id });

  // A fresh "cold" open observation post-archive (e.g. id reused/re-seen) should not
  // fire again since it is now an unseen id — cold-start skip applies.
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });
  expect(prOpenedEvents(emitted)).toHaveLength(1);
});

test("reopen does not re-fire: none -> open -> closed -> open only emits once", () => {
  const { events, store, emitted } = harness();
  const s = makeSession(store);

  events.emit("session:git", { id: s.id, git: git({ state: "none" }) });
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });
  expect(prOpenedEvents(emitted)).toHaveLength(1);

  events.emit("session:git", { id: s.id, git: git({ state: "closed", number: 42 }) });
  // Reopen: closed -> open satisfies the `prev !== "open"` transition guard, so ONLY the
  // once-per-session `emitted` guard prevents a second emit here.
  events.emit("session:git", { id: s.id, git: git({ state: "open", number: 42, isDraft: false }) });

  expect(prOpenedEvents(emitted)).toHaveLength(1);
});
