import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

const base = {
  name: "amend-me",
  prompt: "do the thing",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/amend-me",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

function mk() {
  const s = new SessionStore(":memory:");
  const a = s.create(base);
  const b = s.create({ ...base, herdrAgentId: "term_2" });
  return { s, a, b };
}

test("addTaskAmendment records the text verbatim and stands by default", () => {
  const { s, a } = mk();
  const rec = s.addTaskAmendment(a.id, "also build the gate", 5000);
  expect(rec.id).toBeTruthy();
  expect(rec.sessionId).toBe(a.id);
  expect(rec.text).toBe("also build the gate");
  expect(rec.createdAt).toBe(5000);
  expect(rec.retractedAt).toBeNull();
  expect(s.listActiveTaskAmendments(a.id)).toEqual([rec]);
});

test("amendments come back oldest-first", () => {
  const { s, a } = mk();
  s.addTaskAmendment(a.id, "second", 2000);
  s.addTaskAmendment(a.id, "first", 1000);
  expect(s.listTaskAmendments(a.id).map((x) => x.text)).toEqual(["first", "second"]);
});

test("same-millisecond amendments keep INSERTION order, not uuid order", () => {
  // Order is semantic here: the block renders "newest last" and a later amendment supersedes an
  // earlier one, so a random-uuid tiebreak would invert what the operator authorized.
  const { s, a } = mk();
  for (let i = 0; i < 12; i++) s.addTaskAmendment(a.id, `amend-${i}`, 1000);
  expect(s.listActiveTaskAmendments(a.id).map((x) => x.text)).toEqual(
    Array.from({ length: 12 }, (_, i) => `amend-${i}`),
  );
  expect(s.snapshotTaskAmendments()[a.id]?.map((x) => x.text)).toEqual(
    Array.from({ length: 12 }, (_, i) => `amend-${i}`),
  );
});

test("amendments are scoped to their session", () => {
  const { s, a, b } = mk();
  s.addTaskAmendment(a.id, "for A", 1000);
  expect(s.listActiveTaskAmendments(b.id)).toEqual([]);
});

test("retract soft-deletes: gone from the prompt read, still in the record", () => {
  const { s, a } = mk();
  const rec = s.addTaskAmendment(a.id, "mistyped", 1000);
  const out = s.retractTaskAmendment(a.id, rec.id, 7000);
  expect(out?.retractedAt).toBe(7000);
  expect(s.listActiveTaskAmendments(a.id)).toEqual([]);
  expect(s.listTaskAmendments(a.id).map((x) => x.text)).toEqual(["mistyped"]);
});

test("retract is idempotent — a second call keeps the FIRST retraction timestamp", () => {
  const { s, a } = mk();
  const rec = s.addTaskAmendment(a.id, "oops", 1000);
  s.retractTaskAmendment(a.id, rec.id, 7000);
  expect(s.retractTaskAmendment(a.id, rec.id, 9000)?.retractedAt).toBe(7000);
});

test("retract refuses another session's amendment id (no cross-session reach)", () => {
  const { s, a, b } = mk();
  const rec = s.addTaskAmendment(a.id, "belongs to A", 1000);
  expect(s.retractTaskAmendment(b.id, rec.id, 7000)).toBeNull();
  // ...and A's amendment is untouched.
  expect(s.listActiveTaskAmendments(a.id).map((x) => x.text)).toEqual(["belongs to A"]);
});

test("retract of an unknown id returns null", () => {
  const { s, a } = mk();
  expect(s.retractTaskAmendment(a.id, "no-such-id", 7000)).toBeNull();
});

test("there is no path that rewrites an amendment's text", () => {
  // The append-only property is the reason this channel is not a laundering vector, so it is
  // asserted structurally rather than trusted to code review.
  const { s } = mk();
  const writers = Object.getOwnPropertyNames(SessionStore.prototype).filter((n) =>
    /amendment/i.test(n),
  );
  expect(writers.sort()).toEqual([
    "addTaskAmendment",
    "copyTaskAmendments",
    "listActiveTaskAmendments",
    "listTaskAmendments",
    "retractTaskAmendment",
    "snapshotTaskAmendments",
  ]);
  void s;
});

test("snapshot keys by session and omits archived sessions", () => {
  const { s, a, b } = mk();
  s.addTaskAmendment(a.id, "for A", 1000);
  s.addTaskAmendment(b.id, "for B", 1000);
  expect(Object.keys(s.snapshotTaskAmendments()).sort()).toEqual([a.id, b.id].sort());
  s.archive(b.id);
  const snap = s.snapshotTaskAmendments();
  expect(snap[a.id]?.map((x) => x.text)).toEqual(["for A"]);
  expect(snap[b.id]).toBeUndefined();
});

test("snapshot carries retracted rows too — the UI shows them struck through", () => {
  const { s, a } = mk();
  const rec = s.addTaskAmendment(a.id, "retracted one", 1000);
  s.retractTaskAmendment(a.id, rec.id, 2000);
  expect(s.snapshotTaskAmendments()[a.id]?.[0]?.retractedAt).toBe(2000);
});

test("copy carries the standing amendments, keeping their original timestamps + order", () => {
  const { s, a, b } = mk();
  s.addTaskAmendment(a.id, "first", 1000);
  s.addTaskAmendment(a.id, "second", 2000);
  expect(s.copyTaskAmendments(a.id, b.id)).toBe(2);
  const copied = s.listActiveTaskAmendments(b.id);
  expect(copied.map((x) => x.text)).toEqual(["first", "second"]);
  expect(copied.map((x) => x.createdAt)).toEqual([1000, 2000]);
  // Fresh rows on the new session, not shared ones.
  expect(copied.map((x) => x.sessionId)).toEqual([b.id, b.id]);
});

test("copy does NOT resurrect retracted amendments", () => {
  const { s, a, b } = mk();
  const rec = s.addTaskAmendment(a.id, "retracted", 1000);
  s.addTaskAmendment(a.id, "standing", 2000);
  s.retractTaskAmendment(a.id, rec.id, 3000);
  expect(s.copyTaskAmendments(a.id, b.id)).toBe(1);
  expect(s.listTaskAmendments(b.id).map((x) => x.text)).toEqual(["standing"]);
});

test("copy from a session with nothing to carry is a no-op", () => {
  const { s, a, b } = mk();
  expect(s.copyTaskAmendments(a.id, b.id)).toBe(0);
  expect(s.listTaskAmendments(b.id)).toEqual([]);
});

test("pruning a session takes its amendments with it", () => {
  const { s, a } = mk();
  s.addTaskAmendment(a.id, "gone with the session", 1000);
  s.archive(a.id);
  expect(s.pruneArchivedSessions({ maxAgeMs: 0, keepNewest: 0 })).toBeGreaterThan(0);
  expect(s.listTaskAmendments(a.id)).toEqual([]);
});
