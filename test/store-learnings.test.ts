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

test("addLearning defaults to proposed; listLearnings filters by status", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({
    repoPath: "/r",
    rule: "run cd ui && bun run check:i18n before pushing",
    rationale: "agents forget the DE catalog",
    evidence: ["sig1", "sig2"],
  });
  expect(l.status).toBe("proposed");
  expect(l.evidence).toEqual(["sig1", "sig2"]);
  expect(l.evidenceCount).toBe(2);
  expect(s.listLearnings("/r", { status: "proposed" }).length).toBe(1);
  expect(s.listLearnings("/r", { status: "active" }).length).toBe(0);
});

test("setLearningStatus transitions and can edit rule text; getLearning round-trips", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "old", rationale: "", evidence: [] });
  const up = s.setLearningStatus(l.id, "active", "new wording")!;
  expect(up.status).toBe("active");
  expect(up.rule).toBe("new wording");
  expect(s.getLearning(l.id)?.status).toBe("active");
  expect(s.setLearningStatus("missing", "dismissed")).toBeNull();
});

test("pendingLearningCount counts proposed across all repos", () => {
  const s = new SessionStore(":memory:");
  s.addLearning({ repoPath: "/a", rule: "x", rationale: "", evidence: [] });
  const b = s.addLearning({ repoPath: "/b", rule: "y", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  expect(s.pendingLearningCount()).toBe(1);
});

test("listPendingLearnings returns proposed across all repos, newest first", () => {
  const s = new SessionStore(":memory:");
  s.addLearning({ repoPath: "/a", rule: "a1", rationale: "", evidence: [] });
  const b = s.addLearning({ repoPath: "/b", rule: "b1", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active"); // no longer proposed
  s.addLearning({ repoPath: "/b", rule: "b2", rationale: "", evidence: [] });
  const pending = s.listPendingLearnings();
  expect(pending.map((l) => l.rule).sort()).toEqual(["a1", "b2"]);
  expect(pending.every((l) => l.status === "proposed")).toBe(true);
});
