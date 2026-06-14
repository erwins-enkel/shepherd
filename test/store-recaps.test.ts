import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";
import type { Recap } from "../src/types";

const r = (over: Partial<Recap> = {}): Recap => ({
  sessionId: "s1",
  state: "generating",
  headSha: "sha-abc",
  verdict: null,
  headline: "",
  body: "",
  openItems: [],
  changedFiles: [],
  spawnSessionId: "spawn-1",
  cwd: "/tmp/recap-1",
  model: "claude-sonnet-4-5",
  spawnedAt: 1000,
  generatedAt: null,
  updatedAt: 1000,
  ...over,
});

test("recaps: put→get round-trip (incl. openItems JSON)", () => {
  const s = new SessionStore(":memory:");
  expect(s.getRecap("s1")).toBeNull();
  s.putRecap(r({ openItems: ["fix tests", "update docs"] }));
  const got = s.getRecap("s1");
  expect(got).not.toBeNull();
  expect(got?.sessionId).toBe("s1");
  expect(got?.state).toBe("generating");
  expect(got?.headSha).toBe("sha-abc");
  expect(got?.openItems).toEqual(["fix tests", "update docs"]);
  expect(got?.verdict).toBeNull();
  expect(got?.model).toBe("claude-sonnet-4-5");
  expect(got?.generatedAt).toBeNull();
});

test("recaps: upsert overwrites existing row", () => {
  const s = new SessionStore(":memory:");
  s.putRecap(r());
  s.putRecap(
    r({
      state: "ready",
      verdict: "ready",
      headline: "all done",
      body: "## Summary",
      openItems: ["cleanup"],
      generatedAt: 2000,
      updatedAt: 2000,
    }),
  );
  const got = s.getRecap("s1");
  expect(got?.state).toBe("ready");
  expect(got?.verdict).toBe("ready");
  expect(got?.headline).toBe("all done");
  expect(got?.openItems).toEqual(["cleanup"]);
  expect(got?.generatedAt).toBe(2000);
});

test("recaps: snapshotRecaps excludes empty-state rows", () => {
  const s = new SessionStore(":memory:");
  s.putRecap(r({ sessionId: "s1", state: "ready", verdict: "ready", headline: "done" }));
  s.putRecap(r({ sessionId: "s2", state: "empty", generatedAt: 1000 }));
  s.putRecap(r({ sessionId: "s3", state: "generating" }));
  s.putRecap(r({ sessionId: "s4", state: "failed", generatedAt: 1000 }));
  const snap = s.snapshotRecaps();
  expect(Object.keys(snap).sort()).toEqual(["s1", "s3", "s4"]);
  expect(snap["s2"]).toBeUndefined();
});

test("recaps: getRecap returns an empty-state row (excluded only from snapshot)", () => {
  const s = new SessionStore(":memory:");
  s.putRecap(r({ state: "empty", generatedAt: 1000 }));
  const got = s.getRecap("s1");
  expect(got?.state).toBe("empty");
});

test("recaps: generatingRecaps returns only generating rows", () => {
  const s = new SessionStore(":memory:");
  s.putRecap(r({ sessionId: "s1", state: "generating" }));
  s.putRecap(r({ sessionId: "s2", state: "ready", verdict: "ready" }));
  s.putRecap(r({ sessionId: "s3", state: "generating" }));
  const rows = s.generatingRecaps();
  const ids = rows.map((x) => x.sessionId).sort();
  expect(ids).toEqual(["s1", "s3"]);
  expect(rows.every((x) => x.state === "generating")).toBe(true);
});

test("recaps: dropRecap deletes the row", () => {
  const s = new SessionStore(":memory:");
  s.putRecap(r());
  expect(s.getRecap("s1")).not.toBeNull();
  s.dropRecap("s1");
  expect(s.getRecap("s1")).toBeNull();
});

test("recaps: dropRecap is a no-op for unknown sessionId", () => {
  const s = new SessionStore(":memory:");
  expect(() => s.dropRecap("nonexistent")).not.toThrow();
});

test("recaps: openItems with bad JSON in DB defaults to []", () => {
  const s = new SessionStore(":memory:");
  // Insert directly with bad JSON to simulate corruption
  s["db"].run(
    `INSERT INTO recaps (sessionId, state, headSha, verdict, headline, body, openItems,
       spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt)
     VALUES ('s-bad', 'ready', 'sha', 'ready', 'h', 'b', 'NOT_JSON', '', '/tmp', null, 1, null, 1)`,
  );
  const got = s.getRecap("s-bad");
  expect(got?.openItems).toEqual([]);
});

test("recaps: changedFiles round-trips through put→get / snapshot / generating", () => {
  const s = new SessionStore(":memory:");
  const files = ["src/store.ts", "src/types.ts", "test/store-recaps.test.ts"];
  // generating row carries changedFiles — guards the finalize() {...r} spread that
  // sources from generatingRecaps(); a dropped column there silently loses them.
  s.putRecap(r({ sessionId: "s1", state: "generating", changedFiles: files }));
  expect(s.getRecap("s1")?.changedFiles).toEqual(files);
  expect(s.generatingRecaps()[0]?.changedFiles).toEqual(files);

  s.putRecap(
    r({ sessionId: "s2", state: "ready", verdict: "ready", headline: "done", changedFiles: files }),
  );
  expect(s.snapshotRecaps()["s2"]?.changedFiles).toEqual(files);
});

test("recaps: changedFiles with bad JSON in DB defaults to []", () => {
  const s = new SessionStore(":memory:");
  s["db"].run(
    `INSERT INTO recaps (sessionId, state, headSha, verdict, headline, body, openItems, changedFiles,
       spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt)
     VALUES ('s-bad', 'ready', 'sha', 'ready', 'h', 'b', '[]', 'NOT_JSON', '', '/tmp', null, 1, null, 1)`,
  );
  expect(s.getRecap("s-bad")?.changedFiles).toEqual([]);
});

test("recaps: model field stores null correctly", () => {
  const s = new SessionStore(":memory:");
  s.putRecap(r({ model: null }));
  expect(s.getRecap("s1")?.model).toBeNull();
});

test("recaps: snapshotRecaps returns hydrated Recap objects", () => {
  const s = new SessionStore(":memory:");
  s.putRecap(
    r({
      sessionId: "s1",
      state: "ready",
      verdict: "needs_attention",
      headline: "has issues",
      openItems: ["fix CI"],
    }),
  );
  const snap = s.snapshotRecaps();
  expect(snap["s1"]?.openItems).toEqual(["fix CI"]);
  expect(snap["s1"]?.verdict).toBe("needs_attention");
});
