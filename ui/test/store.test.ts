import { test, expect } from "vitest";
import { HerdStore } from "../src/lib/store.svelte";
import type { Session } from "../src/lib/types";

const s = (id: string, status: any = "running"): Session => ({
  id,
  desig: "UNIT-01",
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_" + id,
  claudeSessionId: "cs-" + id,
  model: null,
  status,
  lastState: "working",
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
});

test("applies snapshot, new, status, archived", () => {
  const store = new HerdStore();
  store.setAll([s("a"), s("b")]);
  expect(store.sessions.length).toBe(2);
  store.apply({ event: "session:new", data: s("c") });
  expect(store.sessions.length).toBe(3);
  store.apply({ event: "session:status", data: { id: "a", status: "blocked" } });
  expect(store.byId("a")?.status).toBe("blocked");
  store.apply({ event: "session:archived", data: { id: "b" } });
  expect(store.sessions.find((x) => x.id === "b")).toBeUndefined();
});

test("applies usage:limits", () => {
  const store = new HerdStore();
  expect(store.usageLimits).toBeNull();
  store.apply({
    event: "usage:limits",
    data: {
      session5h: { pct: 12, resetAt: 1000 },
      week: { pct: 40, resetAt: 2000 },
      stale: false,
      calibratedAt: 5,
    },
  });
  expect(store.usageLimits?.session5h?.pct).toBe(12);
  expect(store.usageLimits?.week?.pct).toBe(40);
});

test("tracks session:block reasons and preserves since across re-classification", () => {
  const store = new HerdStore();
  const reason = { shape: "menu", options: [{ label: "Yes", send: "1" }], tail: ["?"] };
  store.apply({ event: "session:block", data: { id: "s1", block: reason as any } });
  const since1 = store.blocks["s1"]!.since;
  expect(store.blocks["s1"]!.reason).toEqual(reason);
  store.apply({
    event: "session:block",
    data: { id: "s1", block: { ...reason, tail: ["??"] } as any },
  });
  expect(store.blocks["s1"]!.since).toBe(since1); // preserved
  store.apply({ event: "session:block", data: { id: "s1", block: null } });
  expect(store.blocks["s1"]).toBeUndefined();
});

test("clears block state when the session is archived", () => {
  const store = new HerdStore();
  store.apply({
    event: "session:block",
    data: { id: "s1", block: { shape: "yes-no", options: [], tail: [] } as any },
  });
  store.apply({ event: "session:archived", data: { id: "s1" } });
  expect(store.blocks["s1"]).toBeUndefined();
});
