import { describe, it, expect } from "vitest";
import {
  activeMergeTrain,
  chipHasTelemetry,
  chipRailVisible,
  enabledDrains,
  firstCurateRepo,
  globalLearningsCounts,
  mergeTrainIsAttention,
  mergeTrainLabel,
  pausedText,
  pickRepoSwitchTarget,
  queueOpenable,
  repoChipRows,
  nextRepoFilter,
  staleFilterRepos,
  shouldFollowFilterToRepo,
  followRepoFilter,
} from "./queue-strip";
import type { RepoChip } from "./queue-strip";
import type { BlockState } from "../triage";
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
    epicParent: null,
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
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: null,
    retiredAt: null,
    retiredReason: null,
    scopeGlobs: [],
    createdAt: 0,
    updatedAt: 0,
    lastEvidenceAt: null,
    promotedPrUrl: null,
    ...over,
  };
}

function rule(
  injected: boolean,
  scoped = false,
): Learning & { injected: boolean; scoped: boolean } {
  return { ...learning({}), injected, scoped };
}

function injectable(over: Partial<RepoInjectable>): RepoInjectable {
  return {
    repoPath: "/repos/a",
    enabled: true,
    budgetChars: 100,
    usedChars: 0,
    rules: [],
    retired: [],
    unseenRetired: 0,
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
  // #1757: this switch IS reached (the code is `paused`), so without a case the generic
  // "paused" copy would hide a nameable, actionable cause.
  it("maps epic_base_unavailable with its branch", () => {
    expect(
      pausedText(drain({ paused: true, reason: "epic_base_unavailable", detail: "epic/9-x" })),
    ).toContain("epic/9-x");
  });

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
  it("maps credits to drain_paused_credits", () => {
    const text = pausedText(drain({ paused: true, reason: "credits", detail: "0.29" }));
    expect(text.length).toBeGreaterThan(0);
    // must differ from the generic fallback so it's actually the correct branch
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
    mergeTrainPrs: null,
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
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
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
  const none: ReadonlySet<string> = new Set();

  it("false for empty array", () => {
    expect(chipRailVisible([], none)).toBe(false);
  });

  it("false for 1 chip", () => {
    expect(chipRailVisible([chip("/repos/a")], none)).toBe(false);
  });

  it("true for 2 chips", () => {
    expect(chipRailVisible([chip("/repos/a"), chip("/repos/b")], none)).toBe(true);
  });

  it("true for 3+ chips", () => {
    expect(chipRailVisible([chip("/repos/a"), chip("/repos/b"), chip("/repos/c")], none)).toBe(
      true,
    );
  });

  it("true for 1 chip when filter matches that chip (lone-repo filter stays visible)", () => {
    expect(chipRailVisible([chip("/repos/a")], new Set(["/repos/a"]))).toBe(true);
  });

  it("false for 1 chip when filter is a different repo (filter on repo with no chip)", () => {
    expect(chipRailVisible([chip("/repos/a")], new Set(["/repos/b"]))).toBe(false);
  });

  it("false for empty array with an active filter", () => {
    expect(chipRailVisible([], new Set(["/repos/a"]))).toBe(false);
  });

  it("true when a multi-selection includes a live chip", () => {
    expect(
      chipRailVisible([chip("/repos/a"), chip("/repos/b")], new Set(["/repos/a", "/repos/b"])),
    ).toBe(true);
  });
});

// ─── chipHasTelemetry ─────────────────────────────────────────────────────────

describe("chipHasTelemetry", () => {
  function chip(over: Partial<RepoChip>): RepoChip {
    return { repoPath: "/repos/a", count: 1, drain: null, insights: 0, curate: 0, ...over };
  }

  it("false when no drain", () => {
    expect(chipHasTelemetry(chip({}))).toBe(false);
  });

  it("true when drain is present", () => {
    expect(chipHasTelemetry(chip({ drain: drain({}) }))).toBe(true);
  });

  // learnings no longer surface on the detail line (they live on the chip ✦ mark + the
  // gear menu), so insights/curate alone do not warrant a telemetry band.
  it("false when only insights > 0 (no drain)", () => {
    expect(chipHasTelemetry(chip({ insights: 1 }))).toBe(false);
  });

  it("false when only curate > 0 (no drain)", () => {
    expect(chipHasTelemetry(chip({ curate: 2 }))).toBe(false);
  });
});

// ─── nextRepoFilter ───────────────────────────────────────────────────────────

describe("nextRepoFilter", () => {
  it("plain click on empty selects that one repo", () => {
    expect([...nextRepoFilter(new Set(), "/repos/a", false)]).toEqual(["/repos/a"]);
  });

  it("plain click collapses a multi-selection to just the clicked repo", () => {
    expect([...nextRepoFilter(new Set(["/repos/a", "/repos/b"]), "/repos/c", false)]).toEqual([
      "/repos/c",
    ]);
  });

  it("plain click on the sole selected repo clears the filter (toggle-off)", () => {
    expect([...nextRepoFilter(new Set(["/repos/a"]), "/repos/a", false)]).toEqual([]);
  });

  it("plain click on one of several selected resets to that one (not a toggle-off)", () => {
    expect([...nextRepoFilter(new Set(["/repos/a", "/repos/b"]), "/repos/a", false)]).toEqual([
      "/repos/a",
    ]);
  });

  it("Shift+click adds a repo to the selection", () => {
    expect([...nextRepoFilter(new Set(["/repos/a"]), "/repos/b", true)].sort()).toEqual([
      "/repos/a",
      "/repos/b",
    ]);
  });

  it("Shift+click removes an already-selected repo", () => {
    expect([...nextRepoFilter(new Set(["/repos/a", "/repos/b"]), "/repos/a", true)]).toEqual([
      "/repos/b",
    ]);
  });

  it("Shift+click removing the last repo yields the empty (all-repos) set", () => {
    expect([...nextRepoFilter(new Set(["/repos/a"]), "/repos/a", true)]).toEqual([]);
  });

  it("does not mutate the input set", () => {
    const current = new Set(["/repos/a"]);
    nextRepoFilter(current, "/repos/b", true);
    expect([...current]).toEqual(["/repos/a"]);
  });
});

// ─── staleFilterRepos ─────────────────────────────────────────────────────────

describe("staleFilterRepos", () => {
  function chip(repoPath: string): RepoChip {
    return { repoPath, count: 1, drain: null, insights: 0, curate: 0 };
  }

  it("empty when no filter is active", () => {
    expect(staleFilterRepos(new Set(), [chip("/repos/a"), chip("/repos/b")])).toEqual([]);
  });

  it("empty when every selected repo still has a chip", () => {
    expect(
      staleFilterRepos(new Set(["/repos/a", "/repos/b"]), [chip("/repos/a"), chip("/repos/b")]),
    ).toEqual([]);
  });

  it("returns ONLY the vanished repos, not the whole set", () => {
    expect(
      staleFilterRepos(new Set(["/repos/a", "/repos/x"]), [chip("/repos/a"), chip("/repos/b")]),
    ).toEqual(["/repos/x"]);
  });

  it("returns all selected when no chips remain", () => {
    expect(staleFilterRepos(new Set(["/repos/a", "/repos/b"]), []).sort()).toEqual([
      "/repos/a",
      "/repos/b",
    ]);
  });
});

// ─── shouldFollowFilterToRepo ─────────────────────────────────────────────────

describe("shouldFollowFilterToRepo", () => {
  it("false when no filter is active (empty) — 'all repos' already shows the task", () => {
    expect(shouldFollowFilterToRepo(new Set(), "/repos/a")).toBe(false);
  });

  it("false when the filter already covers the new task's repo", () => {
    expect(shouldFollowFilterToRepo(new Set(["/repos/a"]), "/repos/a")).toBe(false);
  });

  it("false when a multi-selection already includes the new task's repo", () => {
    expect(shouldFollowFilterToRepo(new Set(["/repos/a", "/repos/b"]), "/repos/b")).toBe(false);
  });

  it("TRUE when the active filter does not include the new task's repo — would hide it", () => {
    expect(shouldFollowFilterToRepo(new Set(["/repos/a"]), "/repos/b")).toBe(true);
  });
});

// ─── followRepoFilter ─────────────────────────────────────────────────────────

describe("followRepoFilter", () => {
  it("no-op (false) on an empty filter — must not narrow the 'all repos' view", () => {
    const f = new Set<string>();
    expect(followRepoFilter(f, "/repos/a")).toBe(false);
    expect([...f]).toEqual([]);
  });

  it("collapses a single mismatched repo onto the session's repo", () => {
    const f = new Set(["/repos/a"]);
    expect(followRepoFilter(f, "/repos/b")).toBe(true);
    expect([...f]).toEqual(["/repos/b"]);
  });

  it("collapses a multi-selection onto the session's repo (not additive)", () => {
    const f = new Set(["/repos/a", "/repos/b"]);
    expect(followRepoFilter(f, "/repos/c")).toBe(true);
    expect([...f]).toEqual(["/repos/c"]);
  });

  it("no-op (false) when a multi-selection already covers the session's repo", () => {
    const f = new Set(["/repos/a", "/repos/b"]);
    expect(followRepoFilter(f, "/repos/a")).toBe(false);
    expect([...f].sort()).toEqual(["/repos/a", "/repos/b"]);
  });

  it("no-op (false) when the sole selected repo already covers the session's repo", () => {
    const f = new Set(["/repos/a"]);
    expect(followRepoFilter(f, "/repos/a")).toBe(false);
    expect([...f]).toEqual(["/repos/a"]);
  });
});

// ─── globalLearningsCounts ────────────────────────────────────────────────────

describe("globalLearningsCounts", () => {
  it("returns zeros for empty inputs", () => {
    expect(globalLearningsCounts([], [])).toEqual({ proposed: 0, curate: 0 });
  });

  it("proposed equals items.length regardless of repoPath", () => {
    const items = [
      learning({ id: "l1", repoPath: "/repos/a" }),
      learning({ id: "l2", repoPath: "/repos/b" }),
      learning({ id: "l3", repoPath: "/repos/c" }),
    ];
    expect(globalLearningsCounts(items, [])).toEqual({ proposed: 3, curate: 0 });
  });

  it("curate sums non-injected rules across enabled injectables", () => {
    const injectables = [
      injectable({ repoPath: "/repos/a", rules: [rule(true), rule(false), rule(false)] }), // 2 over-budget
      injectable({ repoPath: "/repos/b", rules: [rule(false)] }), // 1 over-budget
    ];
    expect(globalLearningsCounts([], injectables)).toEqual({ proposed: 0, curate: 3 });
  });

  it("disabled injectable contributes 0 to curate even with non-injected rules", () => {
    const injectables = [
      injectable({ repoPath: "/repos/a", enabled: false, rules: [rule(false), rule(false)] }),
    ];
    expect(globalLearningsCounts([], injectables)).toEqual({ proposed: 0, curate: 0 });
  });

  it("injected rules (injected=true) do not count toward curate", () => {
    const injectables = [
      injectable({ repoPath: "/repos/a", rules: [rule(true), rule(true)] }), // all injected → 0 over-budget
    ];
    expect(globalLearningsCounts([], injectables)).toEqual({ proposed: 0, curate: 0 });
  });

  it("combines proposed and curate independently", () => {
    const items = [learning({ id: "l1" }), learning({ id: "l2" })];
    const injectables = [injectable({ rules: [rule(false)] })];
    expect(globalLearningsCounts(items, injectables)).toEqual({ proposed: 2, curate: 1 });
  });
});

// ─── firstCurateRepo ──────────────────────────────────────────────────────────

describe("firstCurateRepo", () => {
  it("returns null for empty list", () => {
    expect(firstCurateRepo([])).toBeNull();
  });

  it("returns null when no repo has over-budget rules", () => {
    const injectables = [
      injectable({ repoPath: "/repos/a", rules: [rule(true), rule(true)] }),
      injectable({ repoPath: "/repos/b", rules: [rule(true)] }),
    ];
    expect(firstCurateRepo(injectables)).toBeNull();
  });

  it("returns the repoPath of the first repo with ≥1 over-budget rule", () => {
    const injectables = [
      injectable({ repoPath: "/repos/a", rules: [rule(true)] }), // all injected
      injectable({ repoPath: "/repos/b", rules: [rule(true), rule(false)] }), // 1 over-budget
      injectable({ repoPath: "/repos/c", rules: [rule(false), rule(false)] }), // 2 over-budget
    ];
    expect(firstCurateRepo(injectables)).toBe("/repos/b");
  });

  it("returns null when the only over-budget repo is disabled", () => {
    const injectables = [
      injectable({ repoPath: "/repos/a", enabled: false, rules: [rule(false)] }),
    ];
    expect(firstCurateRepo(injectables)).toBeNull();
  });

  it("skips disabled repos and returns the first enabled over-budget repo", () => {
    const injectables = [
      injectable({ repoPath: "/repos/a", enabled: false, rules: [rule(false)] }), // disabled → skip
      injectable({ repoPath: "/repos/b", enabled: true, rules: [rule(false)] }), // enabled → match
    ];
    expect(firstCurateRepo(injectables)).toBe("/repos/b");
  });
});

// ─── pickRepoSwitchTarget ─────────────────────────────────────────────────────

function block(since: number): BlockState {
  return { reason: { shape: "awaiting-input", options: [], tail: [] }, since };
}

describe("pickRepoSwitchTarget", () => {
  it("re-targets onto a session waiting on the user, oldest-blocked first", () => {
    const sessions = [
      session({ id: "a1", repoPath: "/repos/a", status: "running" }),
      session({ id: "b-run", repoPath: "/repos/b", status: "running" }),
      session({ id: "b-new", repoPath: "/repos/b", status: "blocked" }),
      session({ id: "b-old", repoPath: "/repos/b", status: "blocked" }),
    ];
    const blocks = { "b-new": block(200), "b-old": block(100) };
    const sel = sessions[0]; // currently on a session in repo a
    expect(pickRepoSwitchTarget("/repos/b", sessions, blocks, {}, sel)).toBe("b-old");
  });

  it("falls back to the first active (running) session when none are waiting", () => {
    const sessions = [
      session({ id: "a1", repoPath: "/repos/a", status: "running" }),
      session({ id: "b-idle", repoPath: "/repos/b", status: "idle" }),
      session({ id: "b-run", repoPath: "/repos/b", status: "running" }),
    ];
    expect(pickRepoSwitchTarget("/repos/b", sessions, {}, {}, sessions[0])).toBe("b-run");
  });

  it("falls back to the first session in the repo when none are waiting or active", () => {
    const sessions = [
      session({ id: "a1", repoPath: "/repos/a", status: "running" }),
      session({ id: "b-idle", repoPath: "/repos/b", status: "idle" }),
      session({ id: "b-done", repoPath: "/repos/b", status: "done" }),
    ];
    expect(pickRepoSwitchTarget("/repos/b", sessions, {}, {}, sessions[0])).toBe("b-idle");
  });

  it("excludes a working-while-blocked session from the 'waiting' pick", () => {
    const sessions = [
      session({ id: "a1", repoPath: "/repos/a", status: "running" }),
      session({ id: "b-wb", repoPath: "/repos/b", status: "blocked" }),
      session({ id: "b-wait", repoPath: "/repos/b", status: "blocked" }),
    ];
    // b-wb blocked earlier (10) but actively working; b-wait blocked later (50) and truly waiting.
    const blocks = { "b-wb": block(10), "b-wait": block(50) };
    // Without the exclusion oldest-blocked b-wb would win; it's working, so b-wait is the real wait.
    expect(pickRepoSwitchTarget("/repos/b", sessions, blocks, { "b-wb": true }, sessions[0])).toBe(
      "b-wait",
    );
  });

  it("returns null when already on a session in the chosen repo", () => {
    const sessions = [
      session({ id: "b1", repoPath: "/repos/b", status: "running" }),
      session({ id: "b2", repoPath: "/repos/b", status: "blocked" }),
    ];
    expect(
      pickRepoSwitchTarget("/repos/b", sessions, { b2: block(1) }, {}, sessions[0]),
    ).toBeNull();
  });

  it("returns null when the chosen repo has no session", () => {
    const sessions = [session({ id: "a1", repoPath: "/repos/a" })];
    expect(pickRepoSwitchTarget("/repos/empty", sessions, {}, {}, sessions[0])).toBeNull();
  });

  it("re-targets even with no session previously selected", () => {
    const sessions = [session({ id: "b1", repoPath: "/repos/b", status: "running" })];
    expect(pickRepoSwitchTarget("/repos/b", sessions, {}, {}, null)).toBe("b1");
  });
});
