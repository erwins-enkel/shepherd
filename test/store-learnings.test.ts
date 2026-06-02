import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

test("addSignal stores and lists newest-first within a repo", () => {
  const s = new SessionStore(":memory:");
  const a = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "use bun" });
  expect(a.id).toBeTruthy();
  expect(a.kind).toBe("reply");
  s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "block", payload: "menu" });
  s.addSignal({ repoPath: "/other", sessionId: null, kind: "stall", payload: "quiet" });
  const got = s.listSignals("/r");
  expect(got.length).toBe(2);
  expect(got.map((g) => g.kind)).toEqual(["block", "reply"]); // newest first
});

test("listSignals honors sinceTs and limit", () => {
  const s = new SessionStore(":memory:");
  for (let i = 0; i < 5; i++) {
    s.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: `p${i}` });
  }
  expect(s.listSignals("/r", { limit: 2 }).length).toBe(2);
  const all = s.listSignals("/r");
  const cutoff = all[2]!.ts;
  expect(s.listSignals("/r", { sinceTs: cutoff }).every((g) => g.ts >= cutoff)).toBe(true);
});

test("pruneSignals drops rows older than cutoff and returns count", () => {
  const s = new SessionStore(":memory:");
  const old = s.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: "old" });
  const removed = s.pruneSignals(old.ts + 1);
  expect(removed).toBe(1);
  expect(s.listSignals("/r").length).toBe(0);
});
