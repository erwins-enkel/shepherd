import { describe, it, expect } from "vitest";
import {
  activeMergeTrain,
  bandHasValue,
  enabledDrains,
  mergeTrainIsAttention,
  mergeTrainLabel,
  pausedText,
  queueOpenable,
  repoStatusRows,
} from "./queue-strip";
import type { RepoStatusRow } from "./queue-strip";
import type { AutoMergeStatus, DrainStatus, Learning, RepoInjectable } from "../types";

function drain(over: Partial<DrainStatus>): DrainStatus {
  return {
    repoPath: "/repos/a",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 1,
    ...over,
  };
}

function learning(over: Partial<Learning>): Learning {
  return {
    id: "l1",
    repoPath: "/repos/a",
    rule: "r",
    rationale: "",
    evidence: [],
    status: "proposed",
    evidenceCount: 0,
    ineffectiveCount: 0,
    createdAt: 0,
    updatedAt: 0,
    lastEvidenceAt: null,
    promotedPrUrl: null,
    ...over,
  };
}

function rule(injected: boolean): Learning & { injected: boolean } {
  return { ...learning({}), injected };
}

function injectable(over: Partial<RepoInjectable>): RepoInjectable {
  return {
    repoPath: "/repos/a",
    enabled: true,
    budgetChars: 100,
    usedChars: 0,
    rules: [],
    ...over,
  };
}

describe("enabledDrains", () => {
  it("drops disabled repos and sorts by path", () => {
    const rows = enabledDrains({
      z: drain({ repoPath: "/repos/z" }),
      a: drain({ repoPath: "/repos/a" }),
      off: drain({ repoPath: "/repos/b", enabled: false }),
    });
    expect(rows.map((d) => d.repoPath)).toEqual(["/repos/a", "/repos/z"]);
  });

  it("returns an empty list when nothing is enabled", () => {
    expect(enabledDrains({ a: drain({ enabled: false }) })).toEqual([]);
  });
});

describe("queueOpenable", () => {
  it("is true when items are queued", () => {
    expect(queueOpenable(drain({ queued: 3 }))).toBe(true);
  });
  it("is false when the queue is empty", () => {
    expect(queueOpenable(drain({ queued: 0 }))).toBe(false);
  });
});

describe("pausedText", () => {
  it("maps blocked with its designation", () => {
    expect(pausedText(drain({ paused: true, reason: "blocked", detail: "TASK-07" }))).toContain(
      "TASK-07",
    );
  });
  it("maps usage with its percentage", () => {
    expect(pausedText(drain({ paused: true, reason: "usage", detail: "80" }))).toContain("80");
  });
  it("falls back to the generic line for an unknown reason", () => {
    const generic = pausedText(drain({ paused: true, reason: null }));
    expect(generic).toBe(pausedText(drain({ paused: true, reason: "something-else" })));
    expect(generic.length).toBeGreaterThan(0);
  });
  it("maps changes_requested to drain_paused_changes", () => {
    const text = pausedText(drain({ paused: true, reason: "changes_requested", detail: null }));
    expect(text.length).toBeGreaterThan(0);
    // must differ from the generic fallback so it's actually the correct branch
    expect(text).not.toBe(pausedText(drain({ paused: true, reason: null })));
  });
  it("maps error to drain_paused_error", () => {
    const text = pausedText(drain({ paused: true, reason: "error", detail: null }));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe(pausedText(drain({ paused: true, reason: null })));
  });
  it("does not throw when detail is null", () => {
    expect(() =>
      pausedText(drain({ paused: true, reason: "blocked", detail: null })),
    ).not.toThrow();
    expect(
      pausedText(drain({ paused: true, reason: "blocked", detail: null })).length,
    ).toBeGreaterThan(0);
  });
});

// ─── merge-train helpers ───────────────────────────────────────────────────

function am(over: Partial<AutoMergeStatus>): AutoMergeStatus {
  return {
    repoPath: "/repos/a",
    enabled: true,
    state: null,
    detail: null,
    sessionId: null,
    ...over,
  };
}

describe("activeMergeTrain", () => {
  it("drops idle (null-state) entries", () => {
    expect(activeMergeTrain({ a: am({ state: null }) })).toEqual([]);
  });

  it("keeps non-null states and sorts by path", () => {
    const rows = activeMergeTrain({
      z: am({ repoPath: "/repos/z", state: "merging" }),
      a: am({ repoPath: "/repos/a", state: "rebasing" }),
      idle: am({ repoPath: "/repos/idle", state: null }),
    });
    expect(rows.map((r) => r.repoPath)).toEqual(["/repos/a", "/repos/z"]);
  });

  it("returns empty list for empty record", () => {
    expect(activeMergeTrain({})).toEqual([]);
  });
});

describe("mergeTrainIsAttention", () => {
  it("flags merge_error as attention", () => {
    expect(mergeTrainIsAttention("merge_error")).toBe(true);
  });
  it("flags rebase_cap as attention", () => {
    expect(mergeTrainIsAttention("rebase_cap")).toBe(true);
  });
  it("does not flag merging as attention", () => {
    expect(mergeTrainIsAttention("merging")).toBe(false);
  });
  it("does not flag rebasing as attention", () => {
    expect(mergeTrainIsAttention("rebasing")).toBe(false);
  });
});

describe("mergeTrainLabel", () => {
  it("returns non-empty string for merging", () => {
    expect(mergeTrainLabel("merging").length).toBeGreaterThan(0);
  });
  it("returns non-empty string for rebasing", () => {
    expect(mergeTrainLabel("rebasing").length).toBeGreaterThan(0);
  });
  it("returns non-empty string for merge_error", () => {
    expect(mergeTrainLabel("merge_error").length).toBeGreaterThan(0);
  });
  it("returns non-empty string for rebase_cap", () => {
    expect(mergeTrainLabel("rebase_cap").length).toBeGreaterThan(0);
  });
  it("returns empty string for null (idle)", () => {
    expect(mergeTrainLabel(null)).toBe("");
  });
  it("returns empty string for unknown state", () => {
    expect(mergeTrainLabel("something-else")).toBe("");
  });
  it("merge_error label differs from merging label", () => {
    expect(mergeTrainLabel("merge_error")).not.toBe(mergeTrainLabel("merging"));
  });
});

// ─── repoStatusRows (generalized per-repo band) ──────────────────────────────

describe("repoStatusRows", () => {
  // shorthand for the running-agent set the band gates on
  const running = (...paths: string[]) => new Set(paths);

  it("lists running-agent repos, enriched with drain/learnings, sorted by path", () => {
    const rows = repoStatusRows(
      { z: drain({ repoPath: "/repos/z" }) },
      [learning({ repoPath: "/repos/a" })],
      [],
      running("/repos/a", "/repos/z"),
    );
    expect(rows.map((r) => r.repoPath)).toEqual(["/repos/a", "/repos/z"]);
  });

  it("excludes a repo with an enabled drain but no running agent", () => {
    const rows = repoStatusRows(
      { a: drain({ repoPath: "/repos/a", inFlight: 0 }) },
      [],
      [],
      running(),
    );
    expect(rows).toEqual([]);
  });

  it("excludes a repo with pending learnings but no running agent", () => {
    const rows = repoStatusRows({}, [learning({ repoPath: "/repos/a" })], [], running());
    expect(rows).toEqual([]);
  });

  it("a running repo with learnings gets the proposal count, drain:null when not drained", () => {
    const rows = repoStatusRows(
      {},
      [learning({ id: "1", repoPath: "/repos/a" }), learning({ id: "2", repoPath: "/repos/a" })],
      [],
      running("/repos/a"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repoPath: "/repos/a", drain: null, insights: 2, curate: 0 });
  });

  it("a running repo with a drain but no learnings carries its drain, insights:0", () => {
    const rows = repoStatusRows(
      { a: drain({ repoPath: "/repos/a", inFlight: 1 }) },
      [],
      [],
      running("/repos/a"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].drain?.inFlight).toBe(1);
    expect(rows[0]).toMatchObject({ insights: 0, curate: 0 });
  });

  it("a running repo with neither drain nor learnings still gets a name-only row", () => {
    const rows = repoStatusRows({}, [], [], running("/repos/a"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repoPath: "/repos/a", drain: null, insights: 0, curate: 0 });
  });

  it("a disabled drain never leaks into a running repo's row", () => {
    const rows = repoStatusRows(
      { a: drain({ repoPath: "/repos/a", enabled: false, inFlight: 5 }) },
      [learning({ repoPath: "/repos/a" })],
      [],
      running("/repos/a"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].drain).toBeNull(); // disabled drain stays out of the row
  });

  it("curate counts over-budget rules of an enabled repo with no proposals", () => {
    const rows = repoStatusRows(
      {},
      [],
      [injectable({ repoPath: "/repos/a", rules: [rule(true), rule(false), rule(false)] })],
      running("/repos/a"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ insights: 0, curate: 2 });
  });

  it("a disabled injectable repo never curates (pruning can't help)", () => {
    const rows = repoStatusRows(
      {},
      [],
      [injectable({ repoPath: "/repos/a", enabled: false, rules: [rule(false)] })],
      running("/repos/a"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ insights: 0, curate: 0 });
  });

  it("proposals suppress the curate fallback (badge showed the count, not curate)", () => {
    const rows = repoStatusRows(
      {},
      [learning({ repoPath: "/repos/a" })],
      [injectable({ repoPath: "/repos/a", rules: [rule(false)] })],
      running("/repos/a"),
    );
    expect(rows[0]).toMatchObject({ insights: 1, curate: 0 });
  });

  it("returns an empty list when no repo has a running agent", () => {
    expect(repoStatusRows({ a: drain({}) }, [learning({})], [], running())).toEqual([]);
  });
});

describe("bandHasValue", () => {
  function row(over: Partial<RepoStatusRow>): RepoStatusRow {
    return { repoPath: "/repos/a", drain: null, insights: 0, curate: 0, ...over };
  }

  it("single bare name-only row → false", () => {
    expect(bandHasValue([row({ drain: null, insights: 0, curate: 0 })])).toBe(false);
  });

  it("single row with an enabled drain → true", () => {
    expect(bandHasValue([row({ drain: drain({}), insights: 0, curate: 0 })])).toBe(true);
  });

  it("single row with insights → true", () => {
    expect(bandHasValue([row({ drain: null, insights: 1, curate: 0 })])).toBe(true);
  });

  it("single row with curate (no insights) → true", () => {
    expect(bandHasValue([row({ drain: null, insights: 0, curate: 2 })])).toBe(true);
  });

  it("two bare name-only rows → true", () => {
    expect(
      bandHasValue([
        row({ repoPath: "/repos/a", drain: null, insights: 0, curate: 0 }),
        row({ repoPath: "/repos/b", drain: null, insights: 0, curate: 0 }),
      ]),
    ).toBe(true);
  });

  it("empty array → false", () => {
    expect(bandHasValue([])).toBe(false);
  });
});
