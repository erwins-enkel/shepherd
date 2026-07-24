import { describe, test, expect } from "bun:test";
import { selectCodexRollout, CodexRolloutResolver, type RolloutMeta } from "../src/codex-activity";

const WT1 = "/wt/review-TASK-1";
const WT2 = "/wt/review-TASK-2";

function meta(path: string, cwd: string, rolloutId: string, mtimeMs = 1000): RolloutMeta {
  return { path, cwd, rolloutId, source: "exec", mtimeMs };
}

describe("selectCodexRollout — ownership", () => {
  test("exactly one exec rollout with cwd === worktreePath → resolve", () => {
    const metas = [meta("/r/a.jsonl", WT1, "id-a"), meta("/r/b.jsonl", WT2, "id-b")];
    expect(selectCodexRollout(metas, { worktreePath: WT1, source: "exec" })).toEqual({
      path: "/r/a.jsonl",
      rolloutId: "id-a",
    });
  });

  test("0 candidates → null", () => {
    const metas = [meta("/r/b.jsonl", WT2, "id-b")];
    expect(selectCodexRollout(metas, { worktreePath: WT1, source: "exec" })).toBeNull();
  });

  test("≥2 candidates (legacy SHA-named cwd) → null (invariant violation)", () => {
    const metas = [meta("/r/a.jsonl", WT1, "id-a"), meta("/r/a2.jsonl", WT1, "id-a2")];
    expect(selectCodexRollout(metas, { worktreePath: WT1, source: "exec" })).toBeNull();
  });

  test("providerSessionId known → exact match on rollout id, cwd ignored", () => {
    const metas = [meta("/r/a.jsonl", "/wrong/cwd", "id-a")];
    expect(
      selectCodexRollout(metas, {
        worktreePath: WT1,
        source: "exec",
        providerSessionId: "id-a",
      }),
    ).toEqual({ path: "/r/a.jsonl", rolloutId: "id-a" });
  });

  test("source must match (a cli rollout is not an exec candidate)", () => {
    const metas: RolloutMeta[] = [{ ...meta("/r/a.jsonl", WT1, "id-a"), source: "cli" }];
    expect(selectCodexRollout(metas, { worktreePath: WT1, source: "exec" })).toBeNull();
  });
});

describe("CodexRolloutResolver — backoff, cache, race", () => {
  // A controllable clock + a spy-able rollout lister.
  function harness(initial: RolloutMeta[]) {
    let now = 0;
    let metas = initial;
    let scanCount = 0;
    const warnings: string[] = [];
    const resolver = new CodexRolloutResolver({
      listMetas: () => {
        scanCount += 1;
        return metas;
      },
      now: () => now,
      warn: (m) => warnings.push(m),
    });
    return {
      resolver,
      warnings,
      setNow: (t: number) => (now = t),
      setMetas: (m: RolloutMeta[]) => (metas = m),
      scans: () => scanCount,
    };
  }

  // The race test the plan mandates: at spawn 1's FIRST attempt only spawn 2's
  // rollout exists (write order != launch order). Spawn 1 must return null and
  // NOT grab spawn 2's rollout; once its own appears it converges.
  test("only sibling's rollout visible → null, never grabs it; converges later", () => {
    const h = harness([meta("/r/2.jsonl", WT2, "id-2")]);
    expect(h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" })).toBeNull();
    // spawn 1's own rollout finally appears
    h.setMetas([meta("/r/2.jsonl", WT2, "id-2"), meta("/r/1.jsonl", WT1, "id-1")]);
    h.setNow(999_999); // past any backoff
    expect(h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" })).toEqual({
      path: "/r/1.jsonl",
      rolloutId: "id-1",
    });
  });

  test("backoff bounds the tree walk: repeated misses don't rescan until nextAt", () => {
    const h = harness([]); // no rollout ever
    for (let i = 0; i < 5; i++) {
      h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    }
    expect(h.scans()).toBe(1); // one walk on the first miss, none until nextAt
  });

  test("distinct trackingId keys have independent backoff", () => {
    const h = harness([]);
    h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    h.resolver.resolve({ trackingId: "t2", worktreePath: WT2, source: "exec" });
    expect(h.scans()).toBe(2); // each key's first miss walks once
  });

  test("proven resolution is cached (no rescan) and reset() clears it", () => {
    const h = harness([meta("/r/1.jsonl", WT1, "id-1")]);
    const first = h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    expect(first).toEqual({ path: "/r/1.jsonl", rolloutId: "id-1" });
    const scansAfterHit = h.scans();
    h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    expect(h.scans()).toBe(scansAfterHit); // served from cache, no new walk
    h.resolver.reset("t1");
    h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    expect(h.scans()).toBe(scansAfterHit + 1); // cache cleared → walks again
  });

  test("≥2 candidates emit a warning and resolve to null", () => {
    const h = harness([meta("/r/a.jsonl", WT1, "id-a"), meta("/r/b.jsonl", WT1, "id-b")]);
    expect(h.resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" })).toBeNull();
    expect(h.warnings.length).toBeGreaterThan(0);
  });

  test("onResolved fires ONCE, only on a proven resolution (persist-on-proof hook)", () => {
    let now = 0;
    let metas: RolloutMeta[] = [];
    const resolved: Array<[string, string]> = [];
    const resolver = new CodexRolloutResolver({
      listMetas: () => metas,
      now: () => now,
      onResolved: (id, rid) => resolved.push([id, rid]),
    });
    // miss → no persist
    resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    expect(resolved).toEqual([]);
    // rollout appears → proof → persist once
    metas = [meta("/r/1.jsonl", WT1, "id-1")];
    now = 999_999;
    resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    // repeat resolve served from cache → no second persist
    resolver.resolve({ trackingId: "t1", worktreePath: WT1, source: "exec" });
    expect(resolved).toEqual([["t1", "id-1"]]);
  });
});
