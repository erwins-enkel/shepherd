import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { LearningsService } from "../src/learnings-service";

/** A store + an emit-spy + the service under test, wired the way production wires it. */
function harness() {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: unknown }[] = [];
  const events = { emit: (event: string, data: unknown) => emitted.push({ event, data }) };
  const svc = new LearningsService(store, events);
  return { store, svc, emitted };
}

/** Counts of learnings:update emits (the only event the service emits). */
const updates = (emitted: { event: string }[]) =>
  emitted.filter((e) => e.event === "learnings:update").length;

/** Add a rule already in `active` state (addLearning starts proposed). */
function activeRule(store: SessionStore, repoPath: string, rule: string) {
  const l = store.addLearning({ repoPath, rule, rationale: "", evidence: [] });
  return store.setLearningStatus(l.id, "active")!;
}

function intraSuggestion(store: SessionStore, targetId: string, sourceIds: string[]) {
  return store.addMergeSuggestion({
    kind: "intra",
    repoPath: "/r",
    targetId,
    sourceIds,
    mergedRule: "consolidated rule",
    mergedRationale: "merged",
    repoPaths: null,
    signature: `sig-${targetId}-${sourceIds.join(",")}`,
  });
}

// ── applyMergeSuggestion ──────────────────────────────────────────────────────

test("applyMergeSuggestion: success consolidates survivor, retires sources, emits once", () => {
  const { store, svc, emitted } = harness();
  const target = activeRule(store, "/r", "keep me");
  const source = activeRule(store, "/r", "fold me");
  const sug = intraSuggestion(store, target.id, [source.id]);

  const r = svc.applyMergeSuggestion(sug.id);

  expect(r).toEqual({ ok: true });
  expect(store.getLearning(target.id)!.rule).toBe("consolidated rule");
  const folded = store.getLearning(source.id)!;
  expect(folded.status).toBe("retired");
  expect(folded.mergedIntoId).toBe(target.id);
  expect(store.getMergeSuggestion(sug.id)!.status).toBe("applied");
  expect(updates(emitted)).toBe(1);
});

test("applyMergeSuggestion: unknown id → not-found, no emit", () => {
  const { svc, emitted } = harness();
  expect(svc.applyMergeSuggestion("nope")).toEqual({ ok: false, reason: "not-found" });
  expect(updates(emitted)).toBe(0);
});

test("applyMergeSuggestion: already-resolved (re-apply) → no second emit", () => {
  const { store, svc, emitted } = harness();
  const target = activeRule(store, "/r", "keep me");
  const source = activeRule(store, "/r", "fold me");
  const sug = intraSuggestion(store, target.id, [source.id]);

  expect(svc.applyMergeSuggestion(sug.id).ok).toBe(true);
  const second = svc.applyMergeSuggestion(sug.id);

  expect(second).toEqual({ ok: false, reason: "already-resolved" });
  expect(updates(emitted)).toBe(1); // only the first apply emitted
});

test("applyMergeSuggestion: a non-active member → stale, suggestion dismissed, emits once", () => {
  const { store, svc, emitted } = harness();
  const target = activeRule(store, "/r", "keep me");
  // source stays `proposed` (never activated) → the merge no longer applies.
  const source = store.addLearning({
    repoPath: "/r",
    rule: "fold me",
    rationale: "",
    evidence: [],
  });
  const sug = intraSuggestion(store, target.id, [source.id]);

  const r = svc.applyMergeSuggestion(sug.id);

  expect(r).toEqual({ ok: false, reason: "stale" });
  expect(store.getMergeSuggestion(sug.id)!.status).toBe("dismissed");
  expect(updates(emitted)).toBe(1); // the stale-dismiss IS a store change → emits
});

// ── dismissMergeSuggestion ────────────────────────────────────────────────────

test("dismissMergeSuggestion: found → true + emit; unknown → false + no emit", () => {
  const { store, svc, emitted } = harness();
  const t = activeRule(store, "/r", "a");
  const sug = intraSuggestion(store, t.id, []);

  expect(svc.dismissMergeSuggestion(sug.id)).toBe(true);
  expect(store.getMergeSuggestion(sug.id)!.status).toBe("dismissed");
  expect(updates(emitted)).toBe(1);

  expect(svc.dismissMergeSuggestion("nope")).toBe(false);
  expect(updates(emitted)).toBe(1); // unchanged
});

// ── setStatus ─────────────────────────────────────────────────────────────────

test("setStatus: approve with edit normalizes (trim + 240) and activates; emits once", () => {
  const { store, svc, emitted } = harness();
  const l = store.addLearning({ repoPath: "/r", rule: "orig", rationale: "", evidence: [] });

  const edited = svc.setStatus(l.id, "approve", "  cleaned up rule  ");

  expect(edited!.status).toBe("active");
  expect(edited!.rule).toBe("cleaned up rule");
  expect(updates(emitted)).toBe(1);
});

test("setStatus: approve with blank edit falls back to the stored rule", () => {
  const { store, svc } = harness();
  const l = store.addLearning({ repoPath: "/r", rule: "orig", rationale: "", evidence: [] });
  expect(svc.setStatus(l.id, "approve", "   ")!.rule).toBe("orig");
});

test("setStatus: long edit clipped to 240 chars", () => {
  const { store, svc } = harness();
  const l = store.addLearning({ repoPath: "/r", rule: "orig", rationale: "", evidence: [] });
  expect(svc.setStatus(l.id, "approve", "x".repeat(300))!.rule.length).toBe(240);
});

test("setStatus: dismiss sets dismissed; unknown id → null + no emit", () => {
  const { store, svc, emitted } = harness();
  const l = store.addLearning({ repoPath: "/r", rule: "orig", rationale: "", evidence: [] });
  expect(svc.setStatus(l.id, "dismiss")!.status).toBe("dismissed");
  expect(updates(emitted)).toBe(1);
  expect(svc.setStatus("nope", "approve")).toBeNull();
  expect(updates(emitted)).toBe(1); // unchanged
});

// ── setScope / revertTrial / restore ──────────────────────────────────────────

test("setScope: sets globs + emit; unknown → null + no emit", () => {
  const { store, svc, emitted } = harness();
  const l = activeRule(store, "/r", "scoped");
  expect(svc.setScope(l.id, ["src/**"])!.scopeGlobs).toEqual(["src/**"]);
  expect(updates(emitted)).toBe(1);
  expect(svc.setScope("nope", ["x"])).toBeNull();
  expect(updates(emitted)).toBe(1);
});

test("revertTrial: reverts an active trial + emit; non-trial → null + no emit", () => {
  const { store, svc, emitted } = harness();
  const l = store.addLearning({ repoPath: "/r", rule: "trial me", rationale: "", evidence: [] });
  store.trialLearning(l.id); // proposed → active trial, so revert applies
  const reverted = svc.revertTrial(l.id, "proposed");
  expect(reverted!.status).toBe("proposed");
  expect(updates(emitted)).toBe(1);

  const plain = activeRule(store, "/r", "not a trial");
  expect(svc.revertTrial(plain.id, "proposed")).toBeNull();
  expect(updates(emitted)).toBe(1); // unchanged
});

test("restore: brings a merged-retired source back + emit; unknown → null + no emit", () => {
  const { store, svc, emitted } = harness();
  const target = activeRule(store, "/r", "keep");
  const source = activeRule(store, "/r", "folded");
  const sug = intraSuggestion(store, target.id, [source.id]);
  svc.applyMergeSuggestion(sug.id); // retires source (emit #1)

  const restored = svc.restore(source.id);
  expect(restored!.status).not.toBe("retired");
  expect(updates(emitted)).toBe(2);

  expect(svc.restore("nope")).toBeNull();
  expect(updates(emitted)).toBe(2); // unchanged
});

// ── emitPending ───────────────────────────────────────────────────────────────

test("emitPending: emits learnings:update with the live pending count", () => {
  const { store, svc, emitted } = harness();
  store.addLearning({ repoPath: "/r", rule: "p1", rationale: "", evidence: [] });
  store.addLearning({ repoPath: "/r", rule: "p2", rationale: "", evidence: [] });
  svc.emitPending();
  expect(emitted.at(-1)).toEqual({ event: "learnings:update", data: { pending: 2 } });
});

// ── read projections ──────────────────────────────────────────────────────────

test("pendingWithEvidence: resolves evidence kinds + source designation + excerpt", () => {
  const { store, svc } = harness();
  const session = store.create({
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/n",
    worktreePath: "/r-wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_1",
  });
  const sig = store.addSignal({
    repoPath: "/r",
    sessionId: session.id,
    kind: "critic",
    payload: "  use   bun  not npm  ",
  });
  store.addLearning({ repoPath: "/r", rule: "prefer bun", rationale: "", evidence: [sig.id] });

  const [row] = svc.pendingWithEvidence();
  expect(row!.evidenceKinds).toEqual({ critic: 1 });
  expect(row!.evidenceDetail).toHaveLength(1);
  expect(row!.evidenceDetail![0]!.desig).toBe(session.desig);
  expect(row!.evidenceDetail![0]!.excerpt).toBe("use bun not npm"); // flattened whitespace
});

test("injectableOverview: one entry per repo with active rules, budget threaded through", () => {
  const { store, svc } = harness();
  activeRule(store, "/r", "always rebase");
  const out = svc.injectableOverview(5000);
  const entry = out.find((e) => e.repoPath === "/r");
  expect(entry).toBeTruthy();
  expect(entry!.budgetChars).toBe(5000);
  expect(entry!.rules.length).toBeGreaterThanOrEqual(1);
});

test("mergeSuggestionsWithMembers: hydrates member rules, drops vanished ones", () => {
  const { store, svc } = harness();
  const target = activeRule(store, "/r", "survivor");
  intraSuggestion(store, target.id, ["ghost-id"]); // ghost member no longer exists
  const [row] = svc.mergeSuggestionsWithMembers();
  expect(row!.members).toHaveLength(1);
  expect(row!.members![0]!.rule).toBe("survivor");
});
