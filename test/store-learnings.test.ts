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

// ── effectiveness loop + auto-retire (issue #838) ────────────────────────────

test("new learnings columns exist after migration; old-shape DB migrates cleanly", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  // All five new public fields must exist with correct defaults
  expect(l.helpfulCount).toBe(0);
  expect(l.injectedCount).toBe(0);
  expect(l.lastUsedAt).toBeNull();
  expect(l.retiredAt).toBeNull();
  expect(l.retiredReason).toBeNull();
  // Round-trip via getLearning must preserve them
  const fetched = s.getLearning(l.id)!;
  expect(fetched.helpfulCount).toBe(0);
  expect(fetched.injectedCount).toBe(0);
  expect(fetched.lastUsedAt).toBeNull();
  expect(fetched.retiredAt).toBeNull();
  expect(fetched.retiredReason).toBeNull();
  // Idempotent: a second store (same :memory: is a fresh one) also migrates OK
  const s2 = new SessionStore(":memory:");
  const l2 = s2.addLearning({ repoPath: "/r", rule: "r2", rationale: "", evidence: [] });
  expect(l2.helpfulCount).toBe(0);
});

test("FSM: active→retired and promoted→retired succeed", () => {
  const s = new SessionStore(":memory:");

  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  s.setLearningStatus(a.id, "active");
  const ret = s.retireLearning(a.id, "not useful");
  expect(ret).not.toBeNull();
  expect(ret!.status).toBe("retired");
  expect(ret!.retiredAt).not.toBeNull();
  expect(ret!.retiredReason).toBe("not useful");

  const b = s.addLearning({ repoPath: "/r", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  s.setLearningStatus(b.id, "promoted");
  const ret2 = s.retireLearning(b.id, "outdated");
  expect(ret2).not.toBeNull();
  expect(ret2!.status).toBe("retired");
});

test("FSM: retired→active and retired→promoted succeed", () => {
  const s = new SessionStore(":memory:");

  // active→retired→active
  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  s.setLearningStatus(a.id, "active");
  s.retireLearning(a.id, "x");
  const restored = s.restoreLearning(a.id);
  expect(restored).not.toBeNull();
  expect(restored!.status).toBe("active");

  // promoted→retired→promoted
  const b = s.addLearning({ repoPath: "/r", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  s.setLearningStatus(b.id, "promoted");
  s.retireLearning(b.id, "y");
  const restored2 = s.restoreLearning(b.id);
  expect(restored2).not.toBeNull();
  expect(restored2!.status).toBe("promoted");
});

test("FSM: illegal proposed→retired, dismissed→retired, retired→dismissed return null", () => {
  const s = new SessionStore(":memory:");

  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  expect(s.retireLearning(a.id, "x")).toBeNull(); // proposed→retired illegal
  expect(s.getLearning(a.id)!.status).toBe("proposed");

  const b = s.addLearning({ repoPath: "/r", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  s.setLearningStatus(b.id, "dismissed");
  expect(s.retireLearning(b.id, "x")).toBeNull(); // dismissed→retired illegal

  // retired→dismissed via setLearningStatus illegal
  const c = s.addLearning({ repoPath: "/r", rule: "c", rationale: "", evidence: [] });
  s.setLearningStatus(c.id, "active");
  s.retireLearning(c.id, "z");
  expect(s.setLearningStatus(c.id, "dismissed")).toBeNull();
});

test("recordInjectedLearnings inserts join rows; injectedCount stays 0; duplicate is idempotent", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");

  s.recordInjectedLearnings("sess1", [l.id]);
  // No counter bump — injectedCount must still be 0
  expect(s.getLearning(l.id)!.injectedCount).toBe(0);

  // Duplicate record is idempotent (no error)
  s.recordInjectedLearnings("sess1", [l.id]);
  expect(s.getLearning(l.id)!.injectedCount).toBe(0);

  // Empty ids → no-op
  s.recordInjectedLearnings("sess2", []);
});

test("attributeInjected({good:true}) bumps injectedCount+lastUsedAt+helpfulCount", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");

  const before = Date.now();
  s.attributeInjected([l.id], { good: true });
  const after = s.getLearning(l.id)!;
  expect(after.injectedCount).toBe(1);
  expect(after.helpfulCount).toBe(1);
  expect(after.lastUsedAt).toBeGreaterThanOrEqual(before);
});

test("attributeInjected({good:false}) bumps injectedCount+lastUsedAt only; helpfulCount unchanged", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");

  s.attributeInjected([l.id], { good: false });
  const after = s.getLearning(l.id)!;
  expect(after.injectedCount).toBe(1);
  expect(after.helpfulCount).toBe(0); // unchanged
  expect(after.lastUsedAt).not.toBeNull();
});

test("takeSessionInjectedLearnings returns recorded ids then empties on second call", () => {
  const s = new SessionStore(":memory:");
  const l1 = s.addLearning({ repoPath: "/r", rule: "r1", rationale: "", evidence: [] });
  const l2 = s.addLearning({ repoPath: "/r", rule: "r2", rationale: "", evidence: [] });

  s.recordInjectedLearnings("sess1", [l1.id, l2.id]);
  const ids = s.takeSessionInjectedLearnings("sess1");
  expect(ids.sort()).toEqual([l1.id, l2.id].sort());

  // Second call returns empty
  const ids2 = s.takeSessionInjectedLearnings("sess1");
  expect(ids2).toEqual([]);
});

test("retireLearning then restoreLearning round-trips: retired fields cleared after restore", () => {
  const s = new SessionStore(":memory:");

  // active round-trip
  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  s.setLearningStatus(a.id, "active");
  const retired = s.retireLearning(a.id, "stale");
  expect(retired!.retiredAt).not.toBeNull();
  expect(retired!.retiredReason).toBe("stale");

  const restored = s.restoreLearning(a.id)!;
  expect(restored.status).toBe("active");
  expect(restored.retiredAt).toBeNull();
  expect(restored.retiredReason).toBeNull();

  // promoted round-trip
  const b = s.addLearning({ repoPath: "/r", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  s.setLearningStatus(b.id, "promoted");
  s.retireLearning(b.id, "outdated");
  const restored2 = s.restoreLearning(b.id)!;
  expect(restored2.status).toBe("promoted");
  expect(restored2.retiredAt).toBeNull();
  expect(restored2.retiredReason).toBeNull();
});

test("countSessionBlockingSignals counts block/stall/critic only; ignores reply/egress_drop and other sessions", () => {
  const s = new SessionStore(":memory:");
  s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "block", payload: "p" });
  s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "stall", payload: "p" });
  s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "critic", payload: "p" });
  s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "p" }); // excluded
  s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "egress_drop", payload: "p" }); // excluded
  s.addSignal({ repoPath: "/r", sessionId: "s2", kind: "block", payload: "p" }); // other session

  expect(s.countSessionBlockingSignals("s1")).toBe(3);
  expect(s.countSessionBlockingSignals("s2")).toBe(1);
  expect(s.countSessionBlockingSignals("s99")).toBe(0);
});

test("reviseLearning stamps autoOptimizedAt (getter returns non-null after revise)", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "old", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  s.incrementLearningIneffective(l.id, ["s1"]);

  // Before revise: autoOptimizedAt should be null
  expect(s.autoOptimizedAt(l.id)).toBeNull();

  const before = Date.now();
  s.reviseLearning(l.id, "new rule");

  // After revise: ineffectiveCount cleared
  expect(s.getLearning(l.id)!.ineffectiveCount).toBe(0);
  // autoOptimizedAt stamped
  const stamp = s.autoOptimizedAt(l.id);
  expect(stamp).not.toBeNull();
  expect(stamp!).toBeGreaterThanOrEqual(before);
});

test("listRetiredLearnings returns retired rules for a repo, newest-updated first", () => {
  const s = new SessionStore(":memory:");

  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  s.setLearningStatus(a.id, "active");
  s.retireLearning(a.id, "reason a");

  const b = s.addLearning({ repoPath: "/r", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  s.retireLearning(b.id, "reason b");

  // Active rule not included
  const c = s.addLearning({ repoPath: "/r", rule: "c", rationale: "", evidence: [] });
  s.setLearningStatus(c.id, "active");

  // Other repo not included
  const d = s.addLearning({ repoPath: "/other", rule: "d", rationale: "", evidence: [] });
  s.setLearningStatus(d.id, "active");
  s.retireLearning(d.id, "reason d");

  const retired = s.listRetiredLearnings("/r");
  expect(retired.length).toBe(2);
  expect(retired.every((r) => r.status === "retired")).toBe(true);
  expect(retired.map((r) => r.rule).sort()).toEqual(["a", "b"]);
});

test("pruneOrphanInjectedLearnings deletes rows for absent sessions, keeps rows for present sessions", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });

  // Insert a live session into the sessions table
  const now = Date.now();
  s["db"].run(
    `INSERT INTO sessions (id, desig, name, prompt, repoPath, baseBranch, worktreePath, isolated, herdrSession, herdrAgentId, claudeSessionId, status, lastState, createdAt, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      "live-sess",
      "TASK-99",
      "n",
      "p",
      "/r",
      "main",
      "/wt",
      1,
      "hs",
      "ha",
      "",
      "running",
      "idle",
      now,
      now,
    ],
  );

  s.recordInjectedLearnings("live-sess", [l.id]);
  s.recordInjectedLearnings("dead-sess", [l.id]);

  s.pruneOrphanInjectedLearnings();

  // live-sess row must survive
  const liveIds = s.takeSessionInjectedLearnings("live-sess");
  expect(liveIds).toEqual([l.id]);

  // dead-sess row must be gone
  const deadIds = s.takeSessionInjectedLearnings("dead-sess");
  expect(deadIds).toEqual([]);
});

test("repo_config.autoOptimizeFlagged defaults false and round-trips through get/set", () => {
  const s = new SessionStore(":memory:");

  // Default: not set → false
  const cfg = s.getRepoConfig("/r");
  expect(cfg.autoOptimizeFlagged).toBe(false);

  // Round-trip: set true, read back
  s.setRepoConfig("/r", { ...cfg, autoOptimizeFlagged: true });
  expect(s.getRepoConfig("/r").autoOptimizeFlagged).toBe(true);

  // Round-trip: set false
  s.setRepoConfig("/r", { ...s.getRepoConfig("/r"), autoOptimizeFlagged: false });
  expect(s.getRepoConfig("/r").autoOptimizeFlagged).toBe(false);
});

// ── unseen-retired marker (issue #838, Task 5) ────────────────────────────────

test("getRetiredSeenAt defaults to 0 when unset", () => {
  const s = new SessionStore(":memory:");
  expect(s.getRetiredSeenAt("/r")).toBe(0);
});

test("markRetiredSeen round-trips through getRetiredSeenAt", () => {
  const s = new SessionStore(":memory:");
  const ts = Date.now();
  s.markRetiredSeen("/r", ts);
  expect(s.getRetiredSeenAt("/r")).toBe(ts);
  // Overwrite with a newer timestamp
  const ts2 = ts + 1000;
  s.markRetiredSeen("/r", ts2);
  expect(s.getRetiredSeenAt("/r")).toBe(ts2);
});

test("markRetiredSeen is per-repo (different repos don't bleed)", () => {
  const s = new SessionStore(":memory:");
  const ts = Date.now();
  s.markRetiredSeen("/r", ts);
  expect(s.getRetiredSeenAt("/other")).toBe(0);
});

test("listRepoPathsWithRetiredLearnings returns repos with retired rules only", () => {
  const s = new SessionStore(":memory:");

  // Add retired rule for /r
  const a = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  s.setLearningStatus(a.id, "active");
  s.retireLearning(a.id, "reason");

  // Add active rule for /other (should NOT appear)
  const b = s.addLearning({ repoPath: "/other", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");

  // Add proposed rule for /third (should NOT appear)
  s.addLearning({ repoPath: "/third", rule: "c", rationale: "", evidence: [] });

  const repos = s.listRepoPathsWithRetiredLearnings();
  expect(repos).toEqual(["/r"]);
});

test("listRepoPathsWithRetiredLearnings returns multiple repos with retired rules", () => {
  const s = new SessionStore(":memory:");

  const a = s.addLearning({ repoPath: "/r1", rule: "a", rationale: "", evidence: [] });
  s.setLearningStatus(a.id, "active");
  s.retireLearning(a.id, "r1 reason");

  const b = s.addLearning({ repoPath: "/r2", rule: "b", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  s.retireLearning(b.id, "r2 reason");

  const repos = s.listRepoPathsWithRetiredLearnings().sort();
  expect(repos).toEqual(["/r1", "/r2"]);
});
