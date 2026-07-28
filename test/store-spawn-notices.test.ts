import { test, expect, describe } from "bun:test";
import { rmSync } from "node:fs";
import { SessionStore } from "../src/store";

const mk = () => new SessionStore(":memory:");

const clamped = (over: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  kind: "plan" as const,
  severity: "clamped" as const,
  detail: "plan (129000→40000 bytes)",
  updatedAt: 1000,
  ...over,
});

const failed = (over: Record<string, unknown> = {}) => ({
  sessionId: "s1",
  kind: "plan" as const,
  severity: "failed" as const,
  reason: "plan-unreviewable" as const,
  detail: "too little of the plan would survive",
  inputKey: "hash-a",
  updatedAt: 2000,
  ...over,
});

describe("spawn_notices", () => {
  test("round-trips a clamped notice", () => {
    const s = mk();
    expect(s.putSpawnNotice(clamped())).toBe(true);
    const got = s.getSpawnNotice("s1", "plan");
    expect(got).toMatchObject({
      sessionId: "s1",
      kind: "plan",
      severity: "clamped",
      detail: "plan (129000→40000 bytes)",
      steers: 0,
    });
    expect(got?.reason ?? null).toBeNull();
    expect(got?.inputKey ?? null).toBeNull();
  });

  test("DEDUP: re-reporting an identical notice reports NO change", () => {
    // The failure is deterministic, so without this every poll would re-broadcast onChange.
    const s = mk();
    expect(s.putSpawnNotice(failed())).toBe(true);
    expect(s.putSpawnNotice(failed())).toBe(false);
    expect(s.putSpawnNotice(failed({ updatedAt: 9999 }))).toBe(false); // timestamp alone is not a change
  });

  test("a changed severity / reason / detail / inputKey DOES report a change", () => {
    for (const delta of [
      { severity: "clamped" as const },
      { reason: "over-budget" as const },
      { detail: "different" },
      { inputKey: "hash-b" },
    ]) {
      const s = mk();
      s.putSpawnNotice(failed());
      expect(s.putSpawnNotice(failed(delta))).toBe(true);
    }
  });

  test("a failed notice OVERWRITES a clamped one for the same (session, kind)", () => {
    const s = mk();
    s.putSpawnNotice(clamped());
    s.putSpawnNotice(failed());
    expect(s.listSpawnNotices("s1")).toHaveLength(1);
    expect(s.getSpawnNotice("s1", "plan")?.severity).toBe("failed");
  });

  test("plan and review notices coexist independently", () => {
    const s = mk();
    s.putSpawnNotice(clamped());
    s.putSpawnNotice(failed({ kind: "review", inputKey: "sha-1" }));
    expect(s.listSpawnNotices("s1").map((n) => n.kind)).toEqual(["plan", "review"]);
    s.clearSpawnNotice("s1", "plan");
    expect(s.listSpawnNotices("s1").map((n) => n.kind)).toEqual(["review"]);
  });

  test("STEER BOUND: the counter survives a re-reported failure", () => {
    // The bound is what stops refusal→steer looping forever: each plan edit mints a new planHash,
    // clearing suppression, so without a counter that survives the upsert the gate would steer
    // every round.
    const s = mk();
    s.putSpawnNotice(failed());
    expect(s.bumpSpawnNoticeSteers("s1", "plan")).toBe(1);
    expect(s.bumpSpawnNoticeSteers("s1", "plan")).toBe(2);
    s.putSpawnNotice(failed({ inputKey: "hash-b", detail: "again" })); // a new plan, same failure
    expect(s.getSpawnNotice("s1", "plan")?.steers).toBe(2);
  });

  test("clearing resets the steer counter, so a later failure can steer again", () => {
    const s = mk();
    s.putSpawnNotice(failed());
    s.bumpSpawnNoticeSteers("s1", "plan");
    expect(s.clearSpawnNotice("s1", "plan")).toBe(true);
    expect(s.clearSpawnNotice("s1", "plan")).toBe(false); // idempotent, and reports no change
    s.putSpawnNotice(failed());
    expect(s.getSpawnNotice("s1", "plan")?.steers).toBe(0);
  });

  test("bumping a notice that does not exist is a harmless no-op", () => {
    expect(mk().bumpSpawnNoticeSteers("nope", "plan")).toBe(0);
  });

  test("SURVIVES A FRESH STORE over the same database file", () => {
    // Suppression is only useful if it outlives a restart.
    const path = `/tmp/shepherd-spawn-notices-${process.pid}.sqlite`;
    try {
      const a = new SessionStore(path);
      a.putSpawnNotice(failed());
      a.bumpSpawnNoticeSteers("s1", "plan");
      const b = new SessionStore(path);
      expect(b.getSpawnNotice("s1", "plan")).toMatchObject({
        severity: "failed",
        reason: "plan-unreviewable",
        inputKey: "hash-a",
        steers: 1,
      });
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(path + suffix);
        } catch {
          /* not present */
        }
      }
    }
  });

  test("snapshot groups by session", () => {
    const s = mk();
    s.putSpawnNotice(clamped());
    s.putSpawnNotice(failed({ sessionId: "s2", kind: "review" }));
    const snap = s.snapshotSpawnNotices();
    expect(Object.keys(snap).sort()).toEqual(["s1", "s2"]);
    expect(snap.s1).toHaveLength(1);
  });

  test("dropSpawnNotices removes every kind for the session and nothing else", () => {
    const s = mk();
    s.putSpawnNotice(clamped());
    s.putSpawnNotice(failed({ kind: "review" }));
    s.putSpawnNotice(clamped({ sessionId: "s2" }));
    s.dropSpawnNotices("s1");
    expect(s.listSpawnNotices("s1")).toEqual([]);
    expect(s.listSpawnNotices("s2")).toHaveLength(1);
  });
});
