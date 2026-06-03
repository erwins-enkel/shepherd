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

test("setLearningStatus enforces the state machine", () => {
  const s = new SessionStore(":memory:");

  // proposed → promoted is illegal (must go via active); returns null, row unchanged
  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  expect(s.setLearningStatus(a.id, "promoted")).toBeNull();
  expect(s.getLearning(a.id)?.status).toBe("proposed");

  // active → proposed is illegal
  const b = s.addLearning({ repoPath: "/r", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  expect(s.setLearningStatus(b.id, "proposed")).toBeNull();
  expect(s.getLearning(b.id)?.status).toBe("active");

  // active → promoted and active → dismissed are legal
  const c = s.addLearning({ repoPath: "/r", rule: "c", rationale: "", evidence: [] });
  s.setLearningStatus(c.id, "active");
  expect(s.setLearningStatus(c.id, "promoted")?.status).toBe("promoted");

  const d = s.addLearning({ repoPath: "/r", rule: "d", rationale: "", evidence: [] });
  s.setLearningStatus(d.id, "active");
  expect(s.setLearningStatus(d.id, "dismissed")?.status).toBe("dismissed");

  // terminal states are sticky: dismissed → active is illegal
  expect(s.setLearningStatus(d.id, "active")).toBeNull();
  expect(s.getLearning(d.id)?.status).toBe("dismissed");
});

test("incrementLearningIneffective bumps active rules, no-ops others", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "use bun", rationale: "", evidence: [] });
  // proposed → no-op
  expect(s.incrementLearningIneffective(l.id)).toBeNull();
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(0);
  // activate, then bump twice
  s.setLearningStatus(l.id, "active");
  expect(s.incrementLearningIneffective(l.id)!.ineffectiveCount).toBe(1);
  expect(s.incrementLearningIneffective(l.id)!.ineffectiveCount).toBe(2);
  // missing id → null
  expect(s.incrementLearningIneffective("nope")).toBeNull();
});

test("promoteLearning records PR url and enforces active→promoted", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({
    repoPath: "/r",
    rule: "rebase onto main",
    rationale: "",
    evidence: [],
  });
  // proposed cannot promote
  expect(s.promoteLearning(l.id, "https://pr/1")).toBeNull();
  s.setLearningStatus(l.id, "active");
  const promoted = s.promoteLearning(l.id, "https://pr/1");
  expect(promoted!.status).toBe("promoted");
  expect(promoted!.promotedPrUrl).toBe("https://pr/1");
  // already promoted → no further transition
  expect(s.promoteLearning(l.id, "https://pr/2")).toBeNull();
});

test("listActiveLearnings returns active + promoted only, oldest-updated first", () => {
  const s = new SessionStore(":memory:");
  const act = s.addLearning({ repoPath: "/r", rule: "active rule", rationale: "", evidence: [] });
  s.setLearningStatus(act.id, "active");
  const prom = s.addLearning({
    repoPath: "/r",
    rule: "promoted rule",
    rationale: "",
    evidence: [],
  });
  s.setLearningStatus(prom.id, "active");
  s.setLearningStatus(prom.id, "promoted");
  s.addLearning({ repoPath: "/r", rule: "still proposed", rationale: "", evidence: [] });
  const dis = s.addLearning({
    repoPath: "/r",
    rule: "dismissed rule",
    rationale: "",
    evidence: [],
  });
  s.setLearningStatus(dis.id, "dismissed");
  // other repo's active rule must not leak in
  const other = s.addLearning({ repoPath: "/other", rule: "other", rationale: "", evidence: [] });
  s.setLearningStatus(other.id, "active");

  const rules = s.listActiveLearnings("/r").map((l) => l.rule);
  expect(rules.sort()).toEqual(["active rule", "promoted rule"]);
});
