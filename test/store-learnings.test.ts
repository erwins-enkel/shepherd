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

test("getSignalsByIds resolves cited evidence (newest first), ignoring unknown ids", () => {
  const s = new SessionStore(":memory:");
  const r1 = s.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: "a" });
  const c1 = s.addSignal({ repoPath: "/r", sessionId: null, kind: "critic", payload: "c" });
  const got = s.getSignalsByIds([r1.id, c1.id, "pruned-id"]);
  expect(got.map((g) => g.kind)).toEqual(["critic", "reply"]); // newest first
  expect(got.map((g) => g.id)).toEqual([c1.id, r1.id]);
  expect(s.getSignalsByIds([])).toEqual([]);
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

test("incrementLearningIneffective bumps active rules by new signal count, no-ops others", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "use bun", rationale: "", evidence: [] });
  // proposed → no-op
  expect(s.incrementLearningIneffective(l.id, ["s1"])).toBeNull();
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(0);
  // activate, then bump by the number of fresh signal ids
  s.setLearningStatus(l.id, "active");
  expect(s.incrementLearningIneffective(l.id, ["s1"])!.ineffectiveCount).toBe(1);
  expect(s.incrementLearningIneffective(l.id, ["s2", "s3"])!.ineffectiveCount).toBe(3);
  // missing id → null
  expect(s.incrementLearningIneffective("nope", ["x"])).toBeNull();
});

test("incrementLearningIneffective dedups already-counted signals across distill runs", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "rebase first", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  expect(s.incrementLearningIneffective(l.id, ["s1", "s2"])!.ineffectiveCount).toBe(2);
  // a later distill over the same window re-cites s1/s2 → no inflation
  expect(s.incrementLearningIneffective(l.id, ["s1", "s2"])).toBeNull();
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(2);
  // only the genuinely-new signal counts
  expect(s.incrementLearningIneffective(l.id, ["s2", "s4"])!.ineffectiveCount).toBe(3);
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

// ── reviseLearning ────────────────────────────────────────────────────────────

test("reviseLearning: active rule — text + rationale updated, ineffectiveCount → 0, updatedAt advanced, status unchanged", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({
    repoPath: "/r",
    rule: "old rule",
    rationale: "old rationale",
    evidence: [],
  });
  s.setLearningStatus(l.id, "active");
  s.incrementLearningIneffective(l.id, ["s1", "s2"]);
  const before = s.getLearning(l.id)!;
  expect(before.ineffectiveCount).toBe(2);

  const updated = s.reviseLearning(l.id, "new rule", "new rationale")!;
  expect(updated).not.toBeNull();
  expect(updated.rule).toBe("new rule");
  expect(updated.rationale).toBe("new rationale");
  expect(updated.ineffectiveCount).toBe(0);
  expect(updated.status).toBe("active");
  expect(updated.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
});

test("reviseLearning: promoted rule is allowed", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "old", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  s.setLearningStatus(l.id, "promoted");
  const updated = s.reviseLearning(l.id, "revised for promoted")!;
  expect(updated).not.toBeNull();
  expect(updated.rule).toBe("revised for promoted");
  expect(updated.status).toBe("promoted");
});

test("reviseLearning: proposed rule → returns null, row unchanged", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "proposed rule", rationale: "", evidence: [] });
  expect(s.reviseLearning(l.id, "attempt")).toBeNull();
  expect(s.getLearning(l.id)!.rule).toBe("proposed rule");
});

test("reviseLearning: dismissed rule → returns null, row unchanged", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "dis rule", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  s.setLearningStatus(l.id, "dismissed");
  expect(s.reviseLearning(l.id, "attempt")).toBeNull();
  expect(s.getLearning(l.id)!.rule).toBe("dis rule");
});

test("reviseLearning: missing id → returns null", () => {
  const s = new SessionStore(":memory:");
  expect(s.reviseLearning("no-such-id", "text")).toBeNull();
});

test("reviseLearning: empty/whitespace-only rule → returns null, row unchanged", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "keep this", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  expect(s.reviseLearning(l.id, "")).toBeNull();
  expect(s.reviseLearning(l.id, "   ")).toBeNull();
  expect(s.getLearning(l.id)!.rule).toBe("keep this");
});

test("reviseLearning: text > 240 chars is capped to 240", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "original", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  const longRule = "x".repeat(300);
  const updated = s.reviseLearning(l.id, longRule)!;
  expect(updated.rule.length).toBe(240);
});

test("reviseLearning: omitted rationale preserves existing rationale", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "rule", rationale: "keep me", evidence: [] });
  s.setLearningStatus(l.id, "active");
  const updated = s.reviseLearning(l.id, "revised rule")!;
  expect(updated.rationale).toBe("keep me");
});

test("reviseLearning: preserves ineffectiveSignalIds so old signals stay deduped after revision", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "rule", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  // seed count = 2
  s.incrementLearningIneffective(l.id, ["s1", "s2"]);
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(2);
  // revise clears visible count
  s.reviseLearning(l.id, "new text");
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(0);
  // re-presenting the same signals → still deduped → null / count stays 0
  expect(s.incrementLearningIneffective(l.id, ["s1", "s2"])).toBeNull();
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(0);
  // a genuinely new signal increments to 1
  expect(s.incrementLearningIneffective(l.id, ["s3"])!.ineffectiveCount).toBe(1);
});

// ── ineffectiveSignalsFor ─────────────────────────────────────────────────────

test("ineffectiveSignalsFor: returns matching Signal rows after flagging", () => {
  const s = new SessionStore(":memory:");
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: "a" });
  const sig2 = s.addSignal({ repoPath: "/r", sessionId: null, kind: "critic", payload: "b" });
  const l = s.addLearning({ repoPath: "/r", rule: "rule", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  s.incrementLearningIneffective(l.id, [sig1.id, sig2.id]);
  const signals = s.ineffectiveSignalsFor(l.id);
  expect(signals.map((sg) => sg.id).sort()).toEqual([sig1.id, sig2.id].sort());
});

test("ineffectiveSignalsFor: rule with no ineffective ids → []", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "clean", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  expect(s.ineffectiveSignalsFor(l.id)).toEqual([]);
});

test("ineffectiveSignalsFor: missing id → []", () => {
  const s = new SessionStore(":memory:");
  expect(s.ineffectiveSignalsFor("no-such-id")).toEqual([]);
});
