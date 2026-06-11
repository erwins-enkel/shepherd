import { describe, it, expect } from "vitest";
import {
  activeMergeTrain,
  chipHasTelemetry,
  chipRailVisible,
  enabledDrains,
  mergeTrainIsAttention,
  mergeTrainLabel,
  pausedText,
  queueOpenable,
  repoChipRows,
  shouldClearRepoFilter,
} from "./queue-strip";
import type { RepoChip } from "./queue-strip";
import type { AutoMergeStatus, DrainStatus, Learning, RepoInjectable, Session } from "../types";

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

// ─── repoChipRows ─────────────────────────────────────────────────────────────

function session(over: Partial<Session>): Session {
  return {
    id: "s1",
    desig: "TASK-01",
    name: "test session",
    prompt: "",
    repoPath: "/repos/a",
    baseBranch: "main",
    branch: null,
    worktreePath: "",
    isolated: false,
    herdrSession: "",
    herdrAgentId: "",
    claudeSessionId: "",
    model: null,
    status: "running",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...over,
  };
}

describe("repoChipRows", () => {
  it("returns empty array when sessions list is empty", () => {
    expect(repoChipRows([], {}, [], [])).toEqual([]);
  });

  it("excludes archived sessions; repo with only archived sessions gets no chip", () => {
    const chips = repoChipRows(
      [
        session({ repoPath: "/repos/a", status: "archived" }),
        session({ id: "s2", repoPath: "/repos/b", status: "running" }),
      ],
      {},
      [],
      [],
    );
    expect(chips.map((c) => c.repoPath)).toEqual(["/repos/b"]);
  });

  it("count reflects non-archived sessions per repo across all live statuses", () => {
    const chips = repoChipRows(
      [
        session({ id: "s1", repoPath: "/repos/a", status: "running" }),
        session({ id: "s2", repoPath: "/repos/a", status: "idle" }),
        session({ id: "s3", repoPath: "/repos/a", status: "blocked" }),
        session({ id: "s4", repoPath: "/repos/a", status: "done" }),
        session({ id: "s5", repoPath: "/repos/a", status: "archived" }), // excluded
      ],
      {},
      [],
      [],
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].count).toBe(4);
  });

  it("attaches enabled drain, does NOT attach disabled drain", () => {
    const chips = repoChipRows(
      [session({ repoPath: "/repos/a" }), session({ id: "s2", repoPath: "/repos/b" })],
      {
        a: drain({ repoPath: "/repos/a", enabled: true, inFlight: 2 }),
        b: drain({ repoPath: "/repos/b", enabled: false, inFlight: 5 }),
      },
      [],
      [],
    );
    const a = chips.find((c) => c.repoPath === "/repos/a")!;
    const b = chips.find((c) => c.repoPath === "/repos/b")!;
    expect(a.drain?.inFlight).toBe(2);
    expect(b.drain).toBeNull();
  });

  it("insights counts Learning items per repo", () => {
    const chips = repoChipRows(
      [session({ repoPath: "/repos/a" })],
      {},
      [learning({ id: "l1", repoPath: "/repos/a" }), learning({ id: "l2", repoPath: "/repos/a" })],
      [],
    );
    expect(chips[0]).toMatchObject({ insights: 2, curate: 0 });
  });

  it("curate shows over-budget count only when insights === 0", () => {
    const chips = repoChipRows(
      [session({ repoPath: "/repos/a" })],
      {},
      [],
      [injectable({ repoPath: "/repos/a", rules: [rule(true), rule(false), rule(false)] })],
    );
    expect(chips[0]).toMatchObject({ insights: 0, curate: 2 });
  });

  it("curate is 0 when insights > 0 (proposals suppress the curate fallback)", () => {
    const chips = repoChipRows(
      [session({ repoPath: "/repos/a" })],
      {},
      [learning({ repoPath: "/repos/a" })],
      [injectable({ repoPath: "/repos/a", rules: [rule(false)] })],
    );
    expect(chips[0]).toMatchObject({ insights: 1, curate: 0 });
  });

  it("a disabled injectable repo never contributes curate", () => {
    const chips = repoChipRows(
      [session({ repoPath: "/repos/a" })],
      {},
      [],
      [injectable({ repoPath: "/repos/a", enabled: false, rules: [rule(false)] })],
    );
    expect(chips[0]).toMatchObject({ insights: 0, curate: 0 });
  });

  it("learnings for repo B do not inflate repo A's insights", () => {
    const chips = repoChipRows(
      [session({ id: "s1", repoPath: "/repos/a" }), session({ id: "s2", repoPath: "/repos/b" })],
      {},
      [learning({ id: "l1", repoPath: "/repos/b" })],
      [],
    );
    const a = chips.find((c) => c.repoPath === "/repos/a")!;
    const b = chips.find((c) => c.repoPath === "/repos/b")!;
    expect(a.insights).toBe(0);
    expect(b.insights).toBe(1);
  });

  it("sorted ascending by repoPath", () => {
    const chips = repoChipRows(
      [session({ id: "s1", repoPath: "/repos/z" }), session({ id: "s2", repoPath: "/repos/a" })],
      {},
      [],
      [],
    );
    expect(chips.map((c) => c.repoPath)).toEqual(["/repos/a", "/repos/z"]);
  });
});

// ─── chipRailVisible ──────────────────────────────────────────────────────────

describe("chipRailVisible", () => {
  function chip(repoPath: string): RepoChip {
    return { repoPath, count: 1, drain: null, insights: 0, curate: 0 };
  }

  it("false for empty array", () => {
    expect(chipRailVisible([])).toBe(false);
  });

  it("false for 1 chip", () => {
    expect(chipRailVisible([chip("/repos/a")])).toBe(false);
  });

  it("true for 2 chips", () => {
    expect(chipRailVisible([chip("/repos/a"), chip("/repos/b")])).toBe(true);
  });

  it("true for 3+ chips", () => {
    expect(chipRailVisible([chip("/repos/a"), chip("/repos/b"), chip("/repos/c")])).toBe(true);
  });
});

// ─── chipHasTelemetry ─────────────────────────────────────────────────────────

describe("chipHasTelemetry", () => {
  function chip(over: Partial<RepoChip>): RepoChip {
    return { repoPath: "/repos/a", count: 1, drain: null, insights: 0, curate: 0, ...over };
  }

  it("false when no drain, no insights, no curate", () => {
    expect(chipHasTelemetry(chip({}))).toBe(false);
  });

  it("true when drain is present", () => {
    expect(chipHasTelemetry(chip({ drain: drain({}) }))).toBe(true);
  });

  it("true when insights > 0", () => {
    expect(chipHasTelemetry(chip({ insights: 1 }))).toBe(true);
  });

  it("true when curate > 0", () => {
    expect(chipHasTelemetry(chip({ curate: 2 }))).toBe(true);
  });
});

// ─── shouldClearRepoFilter ────────────────────────────────────────────────────

describe("shouldClearRepoFilter", () => {
  function chip(repoPath: string): RepoChip {
    return { repoPath, count: 1, drain: null, insights: 0, curate: 0 };
  }

  it("false when no filter is active (null)", () => {
    expect(shouldClearRepoFilter(null, [chip("/repos/a"), chip("/repos/b")])).toBe(false);
  });

  it("false when the filtered repo is among a ≥2-chip rail", () => {
    expect(shouldClearRepoFilter("/repos/a", [chip("/repos/a"), chip("/repos/b")])).toBe(false);
  });

  it("TRUE when the filtered repo is absent from a ≥2-chip rail", () => {
    expect(shouldClearRepoFilter("/repos/x", [chip("/repos/a"), chip("/repos/b")])).toBe(true);
  });

  it("TRUE when only 1 chip (rail hidden) even if it is that repo — the strand case", () => {
    expect(shouldClearRepoFilter("/repos/a", [chip("/repos/a")])).toBe(true);
  });
});
