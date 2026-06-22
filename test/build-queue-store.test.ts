import { test, expect } from "bun:test";
import { SessionStore, resolveStepId, STEP_ID_PREFIX_MIN } from "../src/store";

function mk() {
  return new SessionStore(":memory:");
}

const base = {
  name: "repo-flatten",
  prompt: "flatten repo",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/repo-flatten",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

test("replaceBuildQueue inserts steps in array order, getBuildQueue returns ordered, approved defaults false", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [
    { title: "Step A", detail: "do A" },
    { title: "Step B" },
    { title: "Step C", detail: "do C" },
  ]);
  expect(q.sessionId).toBe(sess.id);
  expect(q.approved).toBe(false);
  expect(q.steps).toHaveLength(3);
  expect(q.steps[0]!.title).toBe("Step A");
  expect(q.steps[0]!.position).toBe(0);
  expect(q.steps[0]!.status).toBe("pending");
  expect(q.steps[1]!.title).toBe("Step B");
  expect(q.steps[1]!.position).toBe(1);
  expect(q.steps[2]!.title).toBe("Step C");
  expect(q.steps[2]!.position).toBe(2);
  // re-read via getBuildQueue
  const q2 = s.getBuildQueue(sess.id);
  expect(q2.steps.map((x) => x.title)).toEqual(["Step A", "Step B", "Step C"]);
});

test("replaceBuildQueue preserves status for matching id, new entry defaults pending", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [{ title: "Step A" }, { title: "Step B" }]);
  const idA = q.steps[0]!.id;
  const idB = q.steps[1]!.id;

  // mark Step A done
  s.setBuildStepStatus(sess.id, idA, "done");

  // replace with same id for A (no explicit status), a new step C, and B by id
  const q2 = s.replaceBuildQueue(sess.id, [
    { id: idA, title: "Step A updated" },
    { id: idB, title: "Step B" },
    { title: "Step C (new)" },
  ]);
  expect(q2.steps[0]!.id).toBe(idA);
  expect(q2.steps[0]!.status).toBe("done"); // preserved
  expect(q2.steps[1]!.id).toBe(idB);
  expect(q2.steps[1]!.status).toBe("pending"); // was pending, stays pending
  expect(q2.steps[2]!.status).toBe("pending"); // brand new → pending
});

test("replaceBuildQueue: explicit input.status overrides the preserved status", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [{ title: "Step A" }]);
  const idA = q.steps[0]!.id;
  s.setBuildStepStatus(sess.id, idA, "done");
  // re-replace with the same id but an explicit status — the explicit value wins
  const q2 = s.replaceBuildQueue(sess.id, [{ id: idA, title: "Step A", status: "active" }]);
  expect(q2.steps[0]!.status).toBe("active");
});

test("setBuildStepStatus: true on hit, false for unknown id, false for wrong sessionId", () => {
  const s = mk();
  const sess1 = s.create(base);
  const sess2 = s.create({ ...base, herdrAgentId: "term_2" });
  const q = s.replaceBuildQueue(sess1.id, [{ title: "Step A" }]);
  const stepId = q.steps[0]!.id;

  expect(s.setBuildStepStatus(sess1.id, stepId, "active")).toBe(true);
  expect(s.getBuildQueue(sess1.id).steps[0]!.status).toBe("active");

  // unknown id
  expect(s.setBuildStepStatus(sess1.id, "no-such-id", "done")).toBe(false);

  // step exists but belongs to sess1, not sess2
  expect(s.setBuildStepStatus(sess2.id, stepId, "done")).toBe(false);
  // sess1 step should remain "active" (not changed by the wrong-session call)
  expect(s.getBuildQueue(sess1.id).steps[0]!.status).toBe("active");
});

test("forward-fill: marking a later step done auto-completes earlier pending steps", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [
    { title: "Step A" },
    { title: "Step B" },
    { title: "Step C" },
    { title: "Step D" },
  ]);
  const [a, b, c, d] = q.steps.map((x) => x.id);

  // Agent jumps straight to marking step C done (the screenshot's under-reporting shape).
  expect(s.setBuildStepStatus(sess.id, c!, "done")).toBe(true);

  const after = s.getBuildQueue(sess.id).steps;
  expect(after[0]!.status).toBe("done"); // A back-filled
  expect(after[1]!.status).toBe("done"); // B back-filled
  expect(after[2]!.status).toBe("done"); // C as posted
  expect(after[3]!.status).toBe("pending"); // D (later) untouched
  void a;
  void b;
  void d;
});

test("forward-fill: marking a later step active also back-fills earlier pending", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [
    { title: "Step A" },
    { title: "Step B" },
    { title: "Step C" },
  ]);
  const c = q.steps[2]!.id;
  s.setBuildStepStatus(sess.id, c, "active");
  const after = s.getBuildQueue(sess.id).steps;
  expect(after.map((x) => x.status)).toEqual(["done", "done", "active"]);
});

test("forward-fill: an explicitly skipped earlier step is preserved, not flipped to done", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [
    { title: "Step A" },
    { title: "Step B" },
    { title: "Step C" },
  ]);
  const [a, b, c] = q.steps.map((x) => x.id);

  // Agent explicitly skips B, then advances to C.
  s.setBuildStepStatus(sess.id, b!, "skipped");
  s.setBuildStepStatus(sess.id, c!, "done");

  const after = s.getBuildQueue(sess.id).steps;
  expect(after[0]!.status).toBe("done"); // A back-filled
  expect(after[1]!.status).toBe("skipped"); // B preserved (terminal state)
  expect(after[2]!.status).toBe("done"); // C as posted
  void a;
});

test("forward-fill: posting skipped or pending does NOT cascade", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [
    { title: "Step A" },
    { title: "Step B" },
    { title: "Step C" },
  ]);
  const c = q.steps[2]!.id;

  s.setBuildStepStatus(sess.id, c, "skipped");
  expect(s.getBuildQueue(sess.id).steps.map((x) => x.status)).toEqual([
    "pending",
    "pending",
    "skipped",
  ]);

  // Re-asserting pending on the last step must not complete earlier ones either.
  s.setBuildStepStatus(sess.id, c, "pending");
  expect(s.getBuildQueue(sess.id).steps.map((x) => x.status)).toEqual([
    "pending",
    "pending",
    "pending",
  ]);
});

test("forward-fill: idempotent and never un-completes; already-done steps unchanged", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [
    { title: "Step A" },
    { title: "Step B" },
    { title: "Step C" },
  ]);
  const [a, , c] = q.steps.map((x) => x.id);

  s.setBuildStepStatus(sess.id, a!, "done"); // A done, nothing earlier
  s.setBuildStepStatus(sess.id, c!, "done"); // back-fills B; A already done
  const first = s.getBuildQueue(sess.id).steps.map((x) => x.status);
  expect(first).toEqual(["done", "done", "done"]);

  // Re-posting C done changes nothing further.
  s.setBuildStepStatus(sess.id, c!, "done");
  expect(s.getBuildQueue(sess.id).steps.map((x) => x.status)).toEqual(["done", "done", "done"]);
});

test("forward-fill: a missing target id does not cascade", () => {
  const s = mk();
  const sess = s.create(base);
  s.replaceBuildQueue(sess.id, [{ title: "Step A" }, { title: "Step B" }]);
  expect(s.setBuildStepStatus(sess.id, "no-such-id", "done")).toBe(false);
  expect(s.getBuildQueue(sess.id).steps.map((x) => x.status)).toEqual(["pending", "pending"]);
});

// ── resolveStepId (pure helper) ──────────────────────────────────────────────

test("resolveStepId: exact match resolves to itself", () => {
  expect(resolveStepId(["abcd1234ef", "99887766aa"], "abcd1234ef")).toEqual({
    ok: true,
    id: "abcd1234ef",
  });
});

test("resolveStepId: exact match WINS over being a prefix of another id (defensive ordering)", () => {
  // Synthetic ids: "abcd1234" is both an exact id AND a prefix of "abcd1234ef". Exact wins.
  // Real fixed-length 36-char UUIDs can't construct this collision, so this guards implementation
  // robustness, not a production-reachable case.
  expect(resolveStepId(["abcd1234", "abcd1234ef"], "abcd1234")).toEqual({
    ok: true,
    id: "abcd1234",
  });
});

test("resolveStepId: unambiguous ≥8-char prefix resolves to the full id", () => {
  const ids = ["1444d473-ffc4-4e41-88b0-c4f255337d81", "9c14f3da-0000-4e41-88b0-c4f255337d81"];
  expect(resolveStepId(ids, "1444d473")).toEqual({ ok: true, id: ids[0]! });
});

test("resolveStepId: ambiguous prefix returns all matches", () => {
  const ids = ["abcd1234aaaa", "abcd1234bbbb", "ffffffff0000"];
  const r = resolveStepId(ids, "abcd1234");
  expect(r).toEqual({ ok: false, reason: "ambiguous", matches: ["abcd1234aaaa", "abcd1234bbbb"] });
});

test("resolveStepId: a too-short (<8) non-exact prefix is refused as not-found, never resolved", () => {
  // "abcd123" uniquely prefixes the lone id, but is below the floor — refuse rather than guess.
  expect("abcd123".length).toBeLessThan(STEP_ID_PREFIX_MIN);
  expect(resolveStepId(["abcd1234ef"], "abcd123")).toEqual({ ok: false, reason: "not-found" });
});

test("resolveStepId: unknown id is not-found", () => {
  expect(resolveStepId(["abcd1234ef"], "no-such-step-id")).toEqual({
    ok: false,
    reason: "not-found",
  });
});

// ── store.resolveStepId + setBuildStepStatus interaction ─────────────────────

test("store.resolveStepId maps an unambiguous 8-char prefix to the full step id, scoped to session", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [{ title: "Step A" }, { title: "Step B" }]);
  const fullId = q.steps[1]!.id;
  const prefix = fullId.slice(0, 8);
  expect(s.resolveStepId(sess.id, prefix)).toEqual({ ok: true, id: fullId });
  // a prefix that matches nothing in THIS session is not-found
  expect(s.resolveStepId(sess.id, "00000000")).toEqual({ ok: false, reason: "not-found" });
});

test("forward-fill fires when a later step is marked done via a RESOLVED ≥8-char prefix", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [
    { title: "Step A" },
    { title: "Step B" },
    { title: "Step C" },
  ]);
  const cFull = q.steps[2]!.id;
  const cPrefix = cFull.slice(0, 8);

  // Resolve the short prefix, then drive setBuildStepStatus with the full id (the handler's path).
  const resolved = s.resolveStepId(sess.id, cPrefix);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("expected prefix to resolve");
  expect(s.setBuildStepStatus(sess.id, resolved.id, "done")).toBe(true);

  // earlier pending steps back-filled to done exactly as with a full UUID
  expect(s.getBuildQueue(sess.id).steps.map((x) => x.status)).toEqual(["done", "done", "done"]);
});

test("mode-2 regression: a lone pending step goes pending → done directly (no active first)", () => {
  const s = mk();
  const sess = s.create(base);
  const q = s.replaceBuildQueue(sess.id, [{ title: "Only step" }]);
  const id = q.steps[0]!.id;
  expect(q.steps[0]!.status).toBe("pending");
  expect(s.setBuildStepStatus(sess.id, id, "done")).toBe(true);
  expect(s.getBuildQueue(sess.id).steps[0]!.status).toBe("done");
});

test("replaceBuildQueue leaves approval untouched (self-revision must not re-gate)", () => {
  const s = mk();
  const sess = s.create(base);
  s.replaceBuildQueue(sess.id, [{ title: "Step A" }]);
  s.setBuildQueueApproved(sess.id, true);
  // agent self-revises the queue mid-run — approval must survive
  const q = s.replaceBuildQueue(sess.id, [{ title: "Step A" }, { title: "Step B (added)" }]);
  expect(q.approved).toBe(true);
  expect(s.getBuildQueue(sess.id).approved).toBe(true);
});

test("setBuildQueueApproved flips approved in getBuildQueue", () => {
  const s = mk();
  const sess = s.create(base);
  s.replaceBuildQueue(sess.id, [{ title: "Step A" }]);
  expect(s.getBuildQueue(sess.id).approved).toBe(false);

  s.setBuildQueueApproved(sess.id, true);
  expect(s.getBuildQueue(sess.id).approved).toBe(true);

  s.setBuildQueueApproved(sess.id, false);
  expect(s.getBuildQueue(sess.id).approved).toBe(false);
});

test("create with pre-generated id uses that id", () => {
  const s = mk();
  const sess = s.create({ ...base, id: "fixed-id" });
  expect(sess.id).toBe("fixed-id");
  expect(s.get("fixed-id")?.id).toBe("fixed-id");
});

test("create without id still assigns a random id", () => {
  const s = mk();
  const sess = s.create(base);
  expect(sess.id).toBeTruthy();
  expect(sess.id).not.toBe("fixed-id");
});

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pruneArchivedSessions removes build_queue_steps and build_queue_state for pruned session", async () => {
  const s = mk();
  const victim = s.create({ ...base, herdrAgentId: "tv" });
  s.replaceBuildQueue(victim.id, [{ title: "victim step" }]);
  s.setBuildQueueApproved(victim.id, true);
  s.archive(victim.id);

  await sleep(2);
  const keep = s.create({ ...base, herdrAgentId: "tk" });
  s.replaceBuildQueue(keep.id, [{ title: "keep step" }]);
  s.archive(keep.id);

  const removed = s.pruneArchivedSessions({ maxAgeMs: YEAR_MS, keepNewest: 1 });
  expect(removed).toBe(1);
  expect(s.get(victim.id)).toBeNull();

  // victim's queue rows gone
  expect(s.getBuildQueue(victim.id).steps).toHaveLength(0);
  expect(s.getBuildQueue(victim.id).approved).toBe(false);

  // survivor's queue intact
  expect(s.getBuildQueue(keep.id).steps).toHaveLength(1);
});
