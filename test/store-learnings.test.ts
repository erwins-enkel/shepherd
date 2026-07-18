import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionStore } from "../src/store";
import { runAutoTrial } from "../src/learnings-lifecycle";

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

test("reviseLearning: resets the effectiveness baseline (helpfulCount/injectedCount/lastUsedAt) so a rewrite re-earns its record", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "old rule", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  // Accumulate a poor history on the OLD text: many injections, few helps, plus a flag.
  s.attributeInjected([l.id], { good: false });
  s.attributeInjected([l.id], { good: false });
  s.attributeInjected([l.id], { good: true });
  s.incrementLearningIneffective(l.id, ["s1"]);
  const before = s.getLearning(l.id)!;
  expect(before.injectedCount).toBe(3);
  expect(before.helpfulCount).toBe(1);
  expect(before.lastUsedAt).not.toBeNull();

  const updated = s.reviseLearning(l.id, "new rule")!;
  // Fresh artifact → fresh baseline (otherwise the rewrite inherits the old poor
  // help-rate and shouldRetire re-trips at the first new ineffective signal).
  expect(updated.helpfulCount).toBe(0);
  expect(updated.injectedCount).toBe(0);
  expect(updated.lastUsedAt).toBeNull();
  expect(updated.ineffectiveCount).toBe(0);
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

// ── #842 glob scope ─────────────────────────────────────────────────────────

test("#842: addLearning defaults scopeGlobs to [] and round-trips supplied globs", () => {
  const s = new SessionStore(":memory:");
  const always = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  expect(always.scopeGlobs).toEqual([]);
  const scoped = s.addLearning({
    repoPath: "/r",
    rule: "scoped",
    rationale: "",
    evidence: [],
    scopeGlobs: ["src/**", "ui/**/*.svelte"],
  });
  expect(scoped.scopeGlobs).toEqual(["src/**", "ui/**/*.svelte"]);
  expect(s.getLearning(scoped.id)!.scopeGlobs).toEqual(["src/**", "ui/**/*.svelte"]);
});

test("#842: setLearningScope normalizes, dedupes, and can clear back to []", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  // " src/** " and "./src/**" both normalize to "src/**" → one entry (display parity
  // with the distiller's sanitizeScopeGlobs); empty strings drop.
  const set = s.setLearningScope(l.id, [" src/** ", "./src/**", "/ui/**", ""]);
  expect(set!.scopeGlobs).toEqual(["src/**", "ui/**"]);
  const cleared = s.setLearningScope(l.id, []);
  expect(cleared!.scopeGlobs).toEqual([]);
  expect(s.setLearningScope("missing", ["a"])).toBeNull();
});

test("#842: setLearningScope enforces the same count/length caps as the distiller", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  // 8 distinct globs → capped at 5; an over-long pattern is dropped.
  const many = Array.from({ length: 8 }, (_, i) => `src/d${i}/**`);
  const set = s.setLearningScope(l.id, [...many, "x".repeat(200)]);
  expect(set!.scopeGlobs.length).toBe(5);
  expect(set!.scopeGlobs).toEqual(many.slice(0, 5));
});

test("#842: a pre-existing DB without the scopeGlobs column migrates to []", () => {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-store-scopeglobs-"));
  const dbPath = join(dir, "test.db");
  try {
    // Hand-build a learnings table at the ORIGINAL schema (no scopeGlobs / Phase-1 cols).
    const raw = new Database(dbPath);
    raw.run(`CREATE TABLE learnings (
      id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, rule TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL, evidenceCount INTEGER NOT NULL DEFAULT 0,
      ineffectiveCount INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastEvidenceAt INTEGER, promotedPrUrl TEXT,
      ineffectiveSignalIds TEXT NOT NULL DEFAULT '[]')`);
    raw.run(
      `INSERT INTO learnings (id, repoPath, rule, status, createdAt, updatedAt) VALUES ('old','/r','legacy','active',1,1)`,
    );
    raw.close();
    // Opening a store runs migrateLearningsColumns → scopeGlobs column added, defaults to [].
    const s = new SessionStore(dbPath);
    expect(s.getLearning("old")!.scopeGlobs).toEqual([]);
    // And a newly-set scope persists on the migrated table.
    expect(s.setLearningScope("old", ["src/**"])!.scopeGlobs).toEqual(["src/**"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ── mergeLearning ─────────────────────────────────────────────────────────────

test("mergeLearning: preserves counters + updates text and rationale", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({
    repoPath: "/r",
    rule: "original rule",
    rationale: "original rationale",
    evidence: [],
  });
  s.setLearningStatus(l.id, "active");

  // Seed counters: 2 good + 1 bad attribution → injected=3, helpful=2
  s.attributeInjected([l.id], { good: true });
  s.attributeInjected([l.id], { good: true });
  s.attributeInjected([l.id], { good: false });
  // One ineffective signal → ineffective=1
  s.incrementLearningIneffective(l.id, ["s1"]);

  const before = s.getLearning(l.id)!;
  expect(before.injectedCount).toBe(3);
  expect(before.helpfulCount).toBe(2);
  expect(before.ineffectiveCount).toBe(1);
  const lastUsedAtBefore = before.lastUsedAt;
  const evidenceCountBefore = before.evidenceCount;

  const updated = s.mergeLearning(l.id, "new longer enriched text", "new rationale")!;
  expect(updated).not.toBeNull();
  expect(updated.rule).toBe("new longer enriched text");
  expect(updated.rationale).toBe("new rationale");
  // Counters preserved
  expect(updated.helpfulCount).toBe(2);
  expect(updated.injectedCount).toBe(3);
  expect(updated.ineffectiveCount).toBe(1);
  expect(updated.lastUsedAt).toBe(lastUsedAtBefore);
  expect(updated.evidenceCount).toBe(evidenceCountBefore);
  // Timestamps advanced (or at least as recent)
  expect(updated.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  expect(updated.lastEvidenceAt).toBeGreaterThanOrEqual(before.lastEvidenceAt ?? 0);
  expect(updated.status).toBe("active");
  // autoOptimizedAt not stamped (use the dedicated getter — field absent from Learning type)
  expect(s.autoOptimizedAt(l.id)).toBeNull();
});

test("mergeLearning: omitted rationale keeps existing rationale", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({
    repoPath: "/r",
    rule: "rule",
    rationale: "keep me",
    evidence: [],
  });
  s.setLearningStatus(l.id, "active");
  const updated = s.mergeLearning(l.id, "newtext")!;
  expect(updated).not.toBeNull();
  expect(updated.rationale).toBe("keep me");
  expect(updated.rule).toBe("newtext");
});

test("mergeLearning: text > 240 chars is clamped to 240", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "original", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  const longRule = "y".repeat(300);
  const updated = s.mergeLearning(l.id, longRule)!;
  expect(updated.rule.length).toBe(240);
});

test("mergeLearning: blank/whitespace-only rule → returns null, row unchanged", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "keep this", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  expect(s.mergeLearning(l.id, "")).toBeNull();
  expect(s.mergeLearning(l.id, "   ")).toBeNull();
  expect(s.getLearning(l.id)!.rule).toBe("keep this");
});

test("mergeLearning: rejects non-active states (proposed, dismissed, promoted, retired, missing)", () => {
  const s = new SessionStore(":memory:");

  // proposed
  const proposed = s.addLearning({
    repoPath: "/r",
    rule: "proposed rule",
    rationale: "",
    evidence: [],
  });
  expect(s.mergeLearning(proposed.id, "attempt")).toBeNull();
  expect(s.getLearning(proposed.id)!.rule).toBe("proposed rule");

  // dismissed
  const dis = s.addLearning({
    repoPath: "/r",
    rule: "dismissed rule",
    rationale: "",
    evidence: [],
  });
  s.setLearningStatus(dis.id, "active");
  s.setLearningStatus(dis.id, "dismissed");
  expect(s.mergeLearning(dis.id, "attempt")).toBeNull();
  expect(s.getLearning(dis.id)!.rule).toBe("dismissed rule");

  // promoted
  const prom = s.addLearning({
    repoPath: "/r",
    rule: "promoted rule",
    rationale: "",
    evidence: [],
  });
  s.setLearningStatus(prom.id, "active");
  s.promoteLearning(prom.id, "https://github.com/owner/repo/pull/1");
  expect(s.mergeLearning(prom.id, "attempt")).toBeNull();
  expect(s.getLearning(prom.id)!.rule).toBe("promoted rule");

  // retired
  const ret = s.addLearning({ repoPath: "/r", rule: "retired rule", rationale: "", evidence: [] });
  s.setLearningStatus(ret.id, "active");
  s.retireLearning(ret.id, "reason");
  expect(s.mergeLearning(ret.id, "attempt")).toBeNull();
  expect(s.getLearning(ret.id)!.rule).toBe("retired rule");

  // missing id
  expect(s.mergeLearning("nope", "attempt")).toBeNull();
});

// ── mergeSuggestionSignatures: cross dedup carve-out (issue #872) ──────────────

test("mergeSuggestionSignatures: cross includes 'applied' so a promoted group is not re-suggested", () => {
  const s = new SessionStore(":memory:");
  const sug = s.addMergeSuggestion({
    kind: "cross",
    repoPath: null,
    targetId: null,
    sourceIds: ["x", "y"],
    mergedRule: "always rebase",
    mergedRationale: "",
    repoPaths: ["/r1", "/r2"],
    signature: "cross-sig-1",
  });
  // Before promote it is pending → already in the dedup set.
  expect(s.mergeSuggestionSignatures({ kind: "cross" }).has("cross-sig-1")).toBe(true);
  // promote-global marks it applied; cross members stay active, so 'applied' MUST still dedup.
  s.setMergeSuggestionStatus(sug.id, "applied");
  expect(s.mergeSuggestionSignatures({ kind: "cross" }).has("cross-sig-1")).toBe(true);
});

test("mergeSuggestionSignatures: intra still EXCLUDES 'applied' (members get retired on merge)", () => {
  const s = new SessionStore(":memory:");
  const sug = s.addMergeSuggestion({
    kind: "intra",
    repoPath: "/r",
    targetId: "t",
    sourceIds: ["a"],
    mergedRule: "merged",
    mergedRationale: "",
    repoPaths: null,
    signature: "intra-sig-1",
  });
  s.setMergeSuggestionStatus(sug.id, "applied");
  expect(s.mergeSuggestionSignatures({ kind: "intra", repoPath: "/r" }).has("intra-sig-1")).toBe(
    false,
  );
});

// ── auto-trial primitives (#925) ─────────────────────────────────────────────

test("#925: addLearning populates distinctKinds/distinctSessions from multi-kind/session evidence", () => {
  const s = new SessionStore(":memory:");
  // Seed signals: 2 kinds (reply, block), 2 sessions
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" });
  const sig2 = s.addSignal({ repoPath: "/r", sessionId: "s2", kind: "block", payload: "b" });
  const sig3 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "c" }); // same kind+session as sig1
  const l = s.addLearning({
    repoPath: "/r",
    rule: "r",
    rationale: "",
    evidence: [sig1.id, sig2.id, sig3.id],
  });
  expect(l.distinctKinds).toBe(2); // reply + block
  expect(l.distinctSessions).toBe(2); // s1 + s2
});

test("#925: addLearning — null sessionId signal adds a kind but NOT a session", () => {
  const s = new SessionStore(":memory:");
  const nullSess = s.addSignal({ repoPath: "/r", sessionId: null, kind: "critic", payload: "x" });
  const realSess = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "y" });
  const l = s.addLearning({
    repoPath: "/r",
    rule: "r",
    rationale: "",
    evidence: [nullSess.id, realSess.id],
  });
  expect(l.distinctKinds).toBe(2); // critic + reply
  expect(l.distinctSessions).toBe(1); // only s1; null excluded
});

test("#925: addLearning with no evidence produces distinctKinds=0, distinctSessions=0", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  expect(l.distinctKinds).toBe(0);
  expect(l.distinctSessions).toBe(0);
  expect(l.trialedAt).toBeNull();
});

test("#925: trialLearning proposed→active, sets trialedAt; rejects non-proposed", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  const before = Date.now();
  const trialed = s.trialLearning(l.id)!;
  expect(trialed).not.toBeNull();
  expect(trialed.status).toBe("active");
  expect(trialed.trialedAt).not.toBeNull();
  expect(trialed.trialedAt!).toBeGreaterThanOrEqual(before);
  // already active → null
  expect(s.trialLearning(l.id)).toBeNull();
  // dismissed → null
  const d = s.addLearning({ repoPath: "/r", rule: "d", rationale: "", evidence: [] });
  s.setLearningStatus(d.id, "dismissed");
  expect(s.trialLearning(d.id)).toBeNull();
  // missing → null
  expect(s.trialLearning("no-such-id")).toBeNull();
});

test("#925: revertTrial active→proposed clears trialedAt (bypasses FSM allowed)", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.trialLearning(l.id);
  const reverted = s.revertTrial(l.id, "proposed")!;
  expect(reverted).not.toBeNull();
  expect(reverted.status).toBe("proposed");
  expect(reverted.trialedAt).toBeNull();
});

test("#925: revertTrial active→dismissed clears trialedAt", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.trialLearning(l.id);
  const reverted = s.revertTrial(l.id, "dismissed")!;
  expect(reverted).not.toBeNull();
  expect(reverted.status).toBe("dismissed");
  expect(reverted.trialedAt).toBeNull();
});

test("#925: revertTrial returns null when not a trial (trialedAt is null) even if active", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active"); // manual activation, not a trial
  expect(s.revertTrial(l.id, "proposed")).toBeNull();
  expect(s.getLearning(l.id)!.status).toBe("active");
});

test("#925: revertTrial returns null for proposed/dismissed/missing rows", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  expect(s.revertTrial(l.id, "proposed")).toBeNull(); // still proposed
  expect(s.revertTrial("no-id", "proposed")).toBeNull(); // missing
});

test("#945: revertTrial('proposed') sets reTrialBlockedAt; 'dismissed' leaves it null", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.trialLearning(l.id);
  const before = Date.now();
  const reverted = s.revertTrial(l.id, "proposed")!;
  expect(reverted.reTrialBlockedAt).not.toBeNull();
  expect(reverted.reTrialBlockedAt!).toBeGreaterThanOrEqual(before);

  const l2 = s.addLearning({ repoPath: "/r", rule: "r2", rationale: "", evidence: [] });
  s.trialLearning(l2.id);
  const dismissed = s.revertTrial(l2.id, "dismissed")!;
  expect(dismissed.reTrialBlockedAt).toBeNull();
});

test("#945: accrueProposedEvidence clears reTrialBlockedAt on genuinely fresh evidence", () => {
  const s = new SessionStore(":memory:");
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" });
  const sig2 = s.addSignal({ repoPath: "/r", sessionId: "s2", kind: "block", payload: "b" });
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [sig1.id] });
  s.trialLearning(l.id);
  const reverted = s.revertTrial(l.id, "proposed")!;
  expect(reverted.reTrialBlockedAt).not.toBeNull();
  const updated = s.accrueProposedEvidence(l.id, [sig2.id])!;
  expect(updated.reTrialBlockedAt).toBeNull();
});

test("#945: accrueProposedEvidence no-op (no fresh ids) leaves the block in place", () => {
  const s = new SessionStore(":memory:");
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" });
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [sig1.id] });
  s.trialLearning(l.id);
  s.revertTrial(l.id, "proposed");
  expect(s.accrueProposedEvidence(l.id, [sig1.id])).toBeNull(); // dup → no-op
  expect(s.getLearning(l.id)!.reTrialBlockedAt).not.toBeNull(); // block survives
});

test("#945: setLearningStatus(active→dismissed) clears stale trialedAt", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.trialLearning(l.id); // active + trialedAt set
  expect(s.getLearning(l.id)!.trialedAt).not.toBeNull();
  const dismissed = s.setLearningStatus(l.id, "dismissed")!;
  expect(dismissed.status).toBe("dismissed");
  expect(dismissed.trialedAt).toBeNull();
});

test("#945: end-to-end — revert blocks the next sweep; recurrence re-trials", () => {
  const s = new SessionStore(":memory:");
  const gate = { nMin: 4, sessionFloor: 2, minKinds: 2, minSessions: 3 };
  // A strong proposal: 4 signals across 4 kinds + 4 sessions → trial-worthy.
  const sigs = [
    s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" }),
    s.addSignal({ repoPath: "/r", sessionId: "s2", kind: "block", payload: "b" }),
    s.addSignal({ repoPath: "/r", sessionId: "s3", kind: "critic", payload: "c" }),
    s.addSignal({ repoPath: "/r", sessionId: "s4", kind: "stall", payload: "d" }),
  ];
  const l = s.addLearning({
    repoPath: "/r",
    rule: "r",
    rationale: "",
    evidence: sigs.map((x) => x.id),
  });
  s.trialLearning(l.id); // it was auto-trialed
  s.revertTrial(l.id, "proposed"); // operator sends it back to the queue

  // Next sweep must NOT re-trial it off the frozen counters.
  const first = runAutoTrial({ store: s, enabled: true, maxPerSweep: 5, gate });
  expect(first).toHaveLength(0);
  expect(s.getLearning(l.id)!.status).toBe("proposed");

  // Genuine recurrence: a fresh signal lifts the block.
  const fresh = s.addSignal({ repoPath: "/r", sessionId: "s5", kind: "reply", payload: "e" });
  s.accrueProposedEvidence(l.id, [fresh.id]);

  // Now the sweep re-trials it.
  const second = runAutoTrial({ store: s, enabled: true, maxPerSweep: 5, gate });
  expect(second.map((r) => r.id)).toContain(l.id);
  expect(s.getLearning(l.id)!.status).toBe("active");
});

test("#925: reapStaleTrial retires a trial with reason trial-expired, clears trialedAt", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.trialLearning(l.id);
  const before = Date.now();
  const reaped = s.reapStaleTrial(l.id)!;
  expect(reaped).not.toBeNull();
  expect(reaped.status).toBe("retired");
  expect(reaped.retiredReason).toBe("trial-expired");
  expect(reaped.retiredAt).not.toBeNull();
  expect(reaped.retiredAt!).toBeGreaterThanOrEqual(before);
  expect(reaped.trialedAt).toBeNull();
});

test("#925: reapStaleTrial returns null for non-trialed active (no trialedAt)", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  s.setLearningStatus(l.id, "active");
  expect(s.reapStaleTrial(l.id)).toBeNull();
  expect(s.getLearning(l.id)!.status).toBe("active");
});

test("#925: reapStaleTrial returns null for proposed/retired/missing", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  expect(s.reapStaleTrial(l.id)).toBeNull(); // proposed
  expect(s.reapStaleTrial("nope")).toBeNull(); // missing
});

test("#925: accrueProposedEvidence dedups, bumps evidenceCount, merges kinds/sessions, refreshes lastEvidenceAt", () => {
  const s = new SessionStore(":memory:");
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" });
  const sig2 = s.addSignal({ repoPath: "/r", sessionId: "s2", kind: "block", payload: "b" });
  const sig3 = s.addSignal({ repoPath: "/r", sessionId: "s3", kind: "critic", payload: "c" });
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [sig1.id] });
  // initial state: 1 kind (reply), 1 session (s1)
  expect(l.distinctKinds).toBe(1);
  expect(l.distinctSessions).toBe(1);
  expect(l.evidenceCount).toBe(1);

  const before = Date.now();
  const updated = s.accrueProposedEvidence(l.id, [sig2.id, sig3.id])!;
  expect(updated).not.toBeNull();
  expect(updated.evidenceCount).toBe(3);
  expect(updated.distinctKinds).toBe(3); // reply + block + critic
  expect(updated.distinctSessions).toBe(3); // s1 + s2 + s3
  expect(updated.lastEvidenceAt).toBeGreaterThanOrEqual(before);
  expect(updated.evidence).toContain(sig1.id);
  expect(updated.evidence).toContain(sig2.id);
  expect(updated.evidence).toContain(sig3.id);
});

test("#925: accrueProposedEvidence returns null when no fresh ids (all already counted)", () => {
  const s = new SessionStore(":memory:");
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" });
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [sig1.id] });
  // same id → no-op
  expect(s.accrueProposedEvidence(l.id, [sig1.id])).toBeNull();
  expect(s.getLearning(l.id)!.evidenceCount).toBe(1);
});

test("#925: accrueProposedEvidence returns null for non-proposed rules", () => {
  const s = new SessionStore(":memory:");
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" });
  const sig2 = s.addSignal({ repoPath: "/r", sessionId: "s2", kind: "block", payload: "b" });
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [sig1.id] });
  s.setLearningStatus(l.id, "active");
  expect(s.accrueProposedEvidence(l.id, [sig2.id])).toBeNull();
  // missing id
  expect(s.accrueProposedEvidence("no-id", [sig2.id])).toBeNull();
});

test("#925: accrueProposedEvidence null-sessionId signal merges kind but not session", () => {
  const s = new SessionStore(":memory:");
  const sig1 = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "a" });
  const sigNull = s.addSignal({ repoPath: "/r", sessionId: null, kind: "stall", payload: "b" });
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [sig1.id] });
  const updated = s.accrueProposedEvidence(l.id, [sigNull.id])!;
  expect(updated.distinctKinds).toBe(2); // reply + stall
  expect(updated.distinctSessions).toBe(1); // only s1
});

// ── #1794: pruneStaleProposedLearnings (permanent 3-day retention) ─────────────

/** Force createdAt/lastEvidenceAt on a row so age is deterministic (no public setter). */
function ageRow(s: SessionStore, id: string, createdAt: number, lastEvidenceAt: number | null) {
  (s as unknown as { db: { run(sql: string, params: unknown[]): void } }).db.run(
    `UPDATE learnings SET createdAt = ?, lastEvidenceAt = ? WHERE id = ?`,
    [createdAt, lastEvidenceAt, id],
  );
}

test("#1794: prune permanently deletes every stale proposed row (no per-sweep cap)", () => {
  const s = new SessionStore(":memory:");
  const cutoff = Date.now();
  const ids = Array.from({ length: 7 }, (_, i) => {
    const l = s.addLearning({ repoPath: "/r", rule: `r${i}`, rationale: "", evidence: [] });
    ageRow(s, l.id, cutoff - 1, null);
    return l.id;
  });
  expect(s.pruneStaleProposedLearnings(cutoff)).toBe(7); // uncapped: all 7, past the old 5-cap
  for (const id of ids) expect(s.getLearning(id)).toBeNull(); // permanent, not soft-dismissed
});

test("#1794: prune boundary is strict (< cutoff): exactly-at and newer survive", () => {
  const s = new SessionStore(":memory:");
  const cutoff = Date.now();
  const older = s.addLearning({ repoPath: "/r", rule: "older", rationale: "", evidence: [] });
  const atCut = s.addLearning({ repoPath: "/r", rule: "at", rationale: "", evidence: [] });
  const newer = s.addLearning({ repoPath: "/r", rule: "newer", rationale: "", evidence: [] });
  ageRow(s, older.id, cutoff - 1, null);
  ageRow(s, atCut.id, cutoff, null);
  ageRow(s, newer.id, cutoff + 1, null);
  expect(s.pruneStaleProposedLearnings(cutoff)).toBe(1);
  expect(s.getLearning(older.id)).toBeNull();
  expect(s.getLearning(atCut.id)).not.toBeNull(); // exactly at cutoff survives until a later sweep
  expect(s.getLearning(newer.id)).not.toBeNull();
});

test("#1794: prune ages by COALESCE(lastEvidenceAt, createdAt) — fresh evidence refreshes retention", () => {
  const s = new SessionStore(":memory:");
  const cutoff = Date.now();
  // stale createdAt but recent lastEvidenceAt → survives
  const refreshed = s.addLearning({ repoPath: "/r", rule: "fresh", rationale: "", evidence: [] });
  ageRow(s, refreshed.id, cutoff - 10_000, cutoff + 1);
  // stale latest evidence → removed
  const stale = s.addLearning({ repoPath: "/r", rule: "stale", rationale: "", evidence: [] });
  ageRow(s, stale.id, cutoff - 10_000, cutoff - 1);
  expect(s.pruneStaleProposedLearnings(cutoff)).toBe(1);
  expect(s.getLearning(refreshed.id)).not.toBeNull();
  expect(s.getLearning(stale.id)).toBeNull();
});

test("#1794: prune only touches proposed rows — active/promoted/dismissed/retired preserved", () => {
  const s = new SessionStore(":memory:");
  const cutoff = Date.now();
  const active = s.addLearning({ repoPath: "/r", rule: "a", rationale: "", evidence: [] });
  s.setLearningStatus(active.id, "active");
  const promoted = s.addLearning({ repoPath: "/r", rule: "p", rationale: "", evidence: [] });
  s.setLearningStatus(promoted.id, "active");
  s.setLearningStatus(promoted.id, "promoted");
  const dismissed = s.addLearning({ repoPath: "/r", rule: "d", rationale: "", evidence: [] });
  s.setLearningStatus(dismissed.id, "dismissed");
  const retired = s.addLearning({ repoPath: "/r", rule: "x", rationale: "", evidence: [] });
  s.setLearningStatus(retired.id, "active");
  s.retireLearning(retired.id, "auto-retire");
  for (const id of [active.id, promoted.id, dismissed.id, retired.id])
    ageRow(s, id, cutoff - 1, cutoff - 1);
  expect(s.pruneStaleProposedLearnings(cutoff)).toBe(0);
  expect(s.getLearning(active.id)!.status).toBe("active");
  expect(s.getLearning(promoted.id)!.status).toBe("promoted");
  expect(s.getLearning(dismissed.id)!.status).toBe("dismissed");
  expect(s.getLearning(retired.id)!.status).toBe("retired");
});

test("#1794: prune returns 0 when no proposed row is eligible", () => {
  const s = new SessionStore(":memory:");
  const cutoff = Date.now();
  const fresh = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  ageRow(s, fresh.id, cutoff + 1, null);
  expect(s.pruneStaleProposedLearnings(cutoff)).toBe(0);
  expect(s.getLearning(fresh.id)).not.toBeNull();
});

test("#925: listTrialLearnings returns only active+trialedAt rows, oldest-trial first", () => {
  const s = new SessionStore(":memory:");
  const l1 = s.addLearning({ repoPath: "/r", rule: "r1", rationale: "", evidence: [] });
  const l2 = s.addLearning({ repoPath: "/r2", rule: "r2", rationale: "", evidence: [] });
  const l3 = s.addLearning({ repoPath: "/r", rule: "r3", rationale: "", evidence: [] });
  // Trial l1 first (oldest), then l2
  s.trialLearning(l1.id);
  s.trialLearning(l2.id);
  // l3 is manually activated (no trialedAt)
  s.setLearningStatus(l3.id, "active");
  const trials = s.listTrialLearnings();
  expect(trials.length).toBe(2);
  expect(trials.map((t) => t.id)).toEqual([l1.id, l2.id]); // oldest first
  expect(trials.every((t) => t.trialedAt !== null)).toBe(true);
  expect(trials.every((t) => t.status === "active")).toBe(true);
  // non-trialed active l3 must not appear
  expect(trials.some((t) => t.id === l3.id)).toBe(false);
});

test("#925: listTrialLearnings returns [] when no trials exist", () => {
  const s = new SessionStore(":memory:");
  s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  expect(s.listTrialLearnings()).toEqual([]);
});

test("#925: listPendingLearnings orders by evidenceCount DESC then lastEvidenceAt DESC", () => {
  const s = new SessionStore(":memory:");
  // l_low: 0 evidence (low count), l_mid: 2 evidence (mid), l_high: 5 evidence (high)
  const l_low = s.addLearning({ repoPath: "/r", rule: "low", rationale: "", evidence: [] });
  // Add signals for mid and high
  const sigs = Array.from({ length: 5 }, (_, i) =>
    s.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: `p${i}` }),
  );
  const l_mid = s.addLearning({
    repoPath: "/r",
    rule: "mid",
    rationale: "",
    evidence: sigs.slice(0, 2).map((s) => s.id),
  });
  const l_high = s.addLearning({
    repoPath: "/r",
    rule: "high",
    rationale: "",
    evidence: sigs.slice(0, 5).map((s) => s.id),
  });

  const pending = s.listPendingLearnings();
  expect(pending.length).toBe(3);
  expect(pending[0]!.id).toBe(l_high.id); // 5 evidence
  expect(pending[1]!.id).toBe(l_mid.id); // 2 evidence
  expect(pending[2]!.id).toBe(l_low.id); // 0 evidence
});

test("#925: new DB columns exist with correct defaults after migration", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "r", rationale: "", evidence: [] });
  expect(l.trialedAt).toBeNull();
  expect(l.distinctKinds).toBe(0);
  expect(l.distinctSessions).toBe(0);
  const fetched = s.getLearning(l.id)!;
  expect(fetched.trialedAt).toBeNull();
  expect(fetched.distinctKinds).toBe(0);
  expect(fetched.distinctSessions).toBe(0);
});
