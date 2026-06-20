import { describe, it, expect, test } from "vitest";
import {
  basename,
  repoAnchorId,
  groupByRepo,
  mergeRepoGroups,
  injectionBadge,
  injectedCount,
  showIneffective,
  flaggedRules,
  flaggedCount,
  totalFlagged,
  evidenceSources,
  droppedCount,
  isOverBudget,
  sortGroupsForTriage,
  splitDropped,
  reposNeedingAttention,
  visibleInjectableRules,
  retiredRules,
  retiredCount,
  unseenRetiredCount,
  helpRate,
} from "./learnings-drawer";
import type { Learning, LearningStatus, RepoInjectable } from "../types";

function L(id: string, repo: string, status: LearningStatus = "proposed"): Learning {
  return {
    id,
    repoPath: repo,
    rule: "r",
    rationale: "",
    evidence: [],
    status,
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
  };
}

function IR(
  repo: string,
  rules: {
    id: string;
    injected: boolean;
    status?: LearningStatus;
    ineffectiveCount?: number;
    scoped?: boolean;
    scopeGlobs?: string[];
  }[],
  over: Partial<RepoInjectable> = {},
): RepoInjectable {
  return {
    repoPath: repo,
    enabled: true,
    budgetChars: 4000,
    usedChars: 100,
    rules: rules.map((r) => ({
      ...L(r.id, repo, r.status ?? "active"),
      injected: r.injected,
      scoped: r.scoped ?? false,
      scopeGlobs: r.scopeGlobs ?? [],
      ineffectiveCount: r.ineffectiveCount ?? 0,
    })),
    retired: [],
    unseenRetired: 0,
    ...over,
  };
}

describe("basename", () => {
  it("takes the last path segment", () => expect(basename("/home/u/acme")).toBe("acme"));
  it("tolerates trailing slash", () => expect(basename("/home/u/acme/")).toBe("acme"));
});

describe("repoAnchorId", () => {
  it("is a DOM-id-safe slug of the full path with a disambiguating suffix", () => {
    const id = repoAnchorId("/home/u/acme");
    expect(id).toMatch(/^learnings-repo-home-u-acme-[a-z0-9]+$/);
  });
  it("distinguishes repos that share a basename (no collision)", () => {
    expect(repoAnchorId("/work/a/api")).not.toBe(repoAnchorId("/work/b/api"));
  });
  it("distinguishes paths that differ only in punctuation (injective slug)", () => {
    // both slugify to "r-a-b"; the raw-path hash keeps the ids distinct
    expect(repoAnchorId("/r/a-b")).not.toBe(repoAnchorId("/r/a/b"));
  });
  it("is deterministic for the same path", () => {
    expect(repoAnchorId("/x/Y/Z")).toBe(repoAnchorId("/x/Y/Z"));
  });
});

describe("groupByRepo", () => {
  it("groups by repoPath preserving first-seen order", () => {
    const g = groupByRepo([L("1", "/a"), L("2", "/b"), L("3", "/a")]);
    expect(g.map(([repo]) => repo)).toEqual(["/a", "/b"]);
    expect(g[0]![1].map((l) => l.id)).toEqual(["1", "3"]);
  });
  it("returns [] for no items", () => expect(groupByRepo([])).toEqual([]));
});

describe("mergeRepoGroups", () => {
  it("attaches the injectable payload to a proposed repo group", () => {
    const inj = IR("/a", [{ id: "x", injected: true }]);
    const g = mergeRepoGroups([L("1", "/a")], [inj]);
    expect(g).toHaveLength(1);
    expect(g[0]!.repoPath).toBe("/a");
    expect(g[0]!.proposed.map((l) => l.id)).toEqual(["1"]);
    expect(g[0]!.injectable).toBe(inj);
  });

  it("appends injectable-only repos (zero proposals) after proposed ones", () => {
    const injA = IR("/a", [{ id: "x", injected: true }]);
    const injB = IR("/b", [{ id: "y", injected: true }]);
    // proposals only for /a; /b is injectable-only — the #253 case
    const g = mergeRepoGroups([L("1", "/a")], [injA, injB]);
    expect(g.map((x) => x.repoPath)).toEqual(["/a", "/b"]);
    expect(g[1]!.proposed).toEqual([]);
    expect(g[1]!.injectable).toBe(injB);
  });

  it("leaves injectable null for a proposed repo with no injectable entry", () => {
    const g = mergeRepoGroups([L("1", "/a")], []);
    expect(g[0]!.injectable).toBeNull();
  });

  it("returns [] when both inputs are empty", () => {
    expect(mergeRepoGroups([], [])).toEqual([]);
  });
});

describe("injectionBadge", () => {
  const rule = (injected: boolean, scoped = false) => ({
    ...L("1", "/a", "active"),
    injected,
    scoped,
  });
  it("disabled when repo injection is off, regardless of injected flag", () => {
    expect(injectionBadge(rule(true), false)).toBe("disabled");
    expect(injectionBadge(rule(false), false)).toBe("disabled");
  });
  it("injected when enabled and the rule made the cut", () =>
    expect(injectionBadge(rule(true), true)).toBe("injected"));
  it("over-budget when enabled but the rule did not fit", () =>
    expect(injectionBadge(rule(false), true)).toBe("over-budget"));
});

describe("injectedCount", () => {
  it("counts only rules with injected:true", () => {
    const inj = IR("/a", [
      { id: "1", injected: true },
      { id: "2", injected: false },
      { id: "3", injected: true },
    ]);
    expect(injectedCount(inj)).toBe(2);
  });
  it("is 0 when none injected (e.g. injection disabled)", () => {
    const inj = IR("/a", [{ id: "1", injected: false }], { enabled: false, usedChars: 0 });
    expect(injectedCount(inj)).toBe(0);
  });
});

test("showIneffective true only when ineffectiveCount > 0", () => {
  expect(showIneffective({ ineffectiveCount: 0 } as never)).toBe(false);
  expect(showIneffective({ ineffectiveCount: 3 } as never)).toBe(true);
});

describe("flaggedRules / flaggedCount", () => {
  it("null repo → [] / 0", () => {
    expect(flaggedRules(null)).toEqual([]);
    expect(flaggedCount(null)).toBe(0);
  });
  it("returns only rules with ineffectiveCount > 0", () => {
    const inj = IR("/a", [
      { id: "1", injected: true, ineffectiveCount: 2 },
      { id: "2", injected: true, ineffectiveCount: 0 },
      { id: "3", injected: false, ineffectiveCount: 1 },
    ]);
    expect(flaggedRules(inj).map((r) => r.id)).toEqual(["1", "3"]);
    expect(flaggedCount(inj)).toBe(2);
  });
  it("0 when none flagged", () => {
    const inj = IR("/a", [{ id: "1", injected: true }]);
    expect(flaggedRules(inj)).toEqual([]);
    expect(flaggedCount(inj)).toBe(0);
  });
});

describe("totalFlagged", () => {
  it("sums flagged across repos", () => {
    const a = IR("/a", [
      { id: "1", injected: true, ineffectiveCount: 1 },
      { id: "2", injected: true, ineffectiveCount: 0 },
    ]);
    const b = IR("/b", [
      { id: "3", injected: true, ineffectiveCount: 3 },
      { id: "4", injected: true, ineffectiveCount: 1 },
    ]);
    expect(totalFlagged([a, b])).toBe(3);
  });
  it("is 0 for an empty list", () => expect(totalFlagged([])).toBe(0));
  it("is 0 when no repo has a flagged rule", () => {
    expect(totalFlagged([IR("/a", [{ id: "1", injected: true }])])).toBe(0);
  });
});

describe("evidenceSources", () => {
  it("orders kinds reply→critic→block→stall and drops empties", () => {
    const l = { ...L("1", "/a"), evidenceKinds: { stall: 1, reply: 2, critic: 1 } };
    expect(evidenceSources(l)).toEqual([
      { kind: "reply", count: 2 },
      { kind: "critic", count: 1 },
      { kind: "stall", count: 1 },
    ]);
  });
  it("returns [] when the server sent no breakdown (older payload)", () => {
    expect(evidenceSources(L("1", "/a"))).toEqual([]);
  });
});

// ─── droppedCount / isOverBudget ─────────────────────────────────────────────

describe("droppedCount / isOverBudget", () => {
  it("enabled repo with dropped rules returns dropped count / true", () => {
    const repo = IR("/a", [
      { id: "1", injected: true },
      { id: "2", injected: false },
      { id: "3", injected: false },
    ]);
    expect(droppedCount(repo)).toBe(2);
    expect(isOverBudget(repo)).toBe(true);
  });

  it("enabled all-injected → 0 / false", () => {
    const repo = IR("/a", [
      { id: "1", injected: true },
      { id: "2", injected: true },
    ]);
    expect(droppedCount(repo)).toBe(0);
    expect(isOverBudget(repo)).toBe(false);
  });

  it("disabled repo with all-uninjected rules → 0 / false (anti-mislabel case)", () => {
    const repo = IR(
      "/a",
      [
        { id: "1", injected: false },
        { id: "2", injected: false },
      ],
      { enabled: false },
    );
    expect(droppedCount(repo)).toBe(0);
    expect(isOverBudget(repo)).toBe(false);
  });

  it("null → 0 / false", () => {
    expect(droppedCount(null)).toBe(0);
    expect(isOverBudget(null)).toBe(false);
  });
});

// ─── sortGroupsForTriage ──────────────────────────────────────────────────────

describe("sortGroupsForTriage", () => {
  it("reorders [plain, flagged, overBudget] → [overBudget, flagged, plain]", () => {
    const plain = mergeRepoGroups(
      [L("1", "/plain")],
      [IR("/plain", [{ id: "1", injected: true }])],
    )[0]!;
    const flagged = mergeRepoGroups(
      [L("2", "/flagged")],
      [IR("/flagged", [{ id: "2", injected: true, ineffectiveCount: 1 }])],
    )[0]!;
    const overBudget = mergeRepoGroups(
      [L("3", "/over")],
      [IR("/over", [{ id: "3", injected: false }])],
    )[0]!;

    // input order: plain, flagged, overBudget (first-seen ≠ triage order)
    const result = sortGroupsForTriage([plain, flagged, overBudget]);
    expect(result.map((g) => g.repoPath)).toEqual(["/over", "/flagged", "/plain"]);
  });

  it("does not mutate the input array", () => {
    const groups = [
      mergeRepoGroups([L("1", "/plain")], [IR("/plain", [{ id: "1", injected: true }])])[0]!,
      mergeRepoGroups([L("2", "/over")], [IR("/over", [{ id: "2", injected: false }])])[0]!,
    ];
    const original = [...groups];
    sortGroupsForTriage(groups);
    expect(groups.map((g) => g.repoPath)).toEqual(original.map((g) => g.repoPath));
  });

  it("two over-budget repos preserve their relative input order (stability)", () => {
    const over1 = mergeRepoGroups(
      [L("1", "/over1")],
      [IR("/over1", [{ id: "1", injected: false }])],
    )[0]!;
    const over2 = mergeRepoGroups(
      [L("2", "/over2")],
      [IR("/over2", [{ id: "2", injected: false }])],
    )[0]!;
    const result = sortGroupsForTriage([over1, over2]);
    expect(result.map((g) => g.repoPath)).toEqual(["/over1", "/over2"]);
  });

  it("repo that is BOTH over-budget and flagged → tier 0 (over-budget wins)", () => {
    const bothFlags = mergeRepoGroups(
      [L("1", "/both")],
      [IR("/both", [{ id: "1", injected: false, ineffectiveCount: 2 }])],
    )[0]!;
    const flaggedOnly = mergeRepoGroups(
      [L("2", "/flagged")],
      [IR("/flagged", [{ id: "2", injected: true, ineffectiveCount: 1 }])],
    )[0]!;
    const result = sortGroupsForTriage([flaggedOnly, bothFlags]);
    expect(result[0]!.repoPath).toBe("/both");
  });
});

// ─── splitDropped ─────────────────────────────────────────────────────────────

describe("splitDropped", () => {
  it("over-budget repo: dropped rules split from injected, each preserving order", () => {
    const repo = IR("/a", [
      { id: "1", injected: true },
      { id: "2", injected: false },
      { id: "3", injected: true },
      { id: "4", injected: false },
    ]);
    const { dropped, injected } = splitDropped(repo);
    expect(dropped.map((r) => r.id)).toEqual(["2", "4"]);
    expect(injected.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("disabled repo → {dropped: [], injected: all rules} (no split, anti-mislabel)", () => {
    const repo = IR(
      "/a",
      [
        { id: "1", injected: false },
        { id: "2", injected: false },
      ],
      { enabled: false },
    );
    const { dropped, injected } = splitDropped(repo);
    expect(dropped).toEqual([]);
    expect(injected.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("enabled all-injected → no split (dropped: [], injected: all)", () => {
    const repo = IR("/a", [
      { id: "1", injected: true },
      { id: "2", injected: true },
    ]);
    const { dropped, injected } = splitDropped(repo);
    expect(dropped).toEqual([]);
    expect(injected.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("null → {dropped: [], injected: []}", () => {
    const { dropped, injected } = splitDropped(null);
    expect(dropped).toEqual([]);
    expect(injected).toEqual([]);
  });
});

// ─── reposNeedingAttention ────────────────────────────────────────────────────

describe("reposNeedingAttention", () => {
  it("returns only repos that are over-budget or flagged, in triage order", () => {
    const plain = mergeRepoGroups(
      [L("1", "/plain")],
      [IR("/plain", [{ id: "1", injected: true }])],
    )[0]!;
    const flaggedG = mergeRepoGroups(
      [L("2", "/flagged")],
      [IR("/flagged", [{ id: "2", injected: true, ineffectiveCount: 1 }])],
    )[0]!;
    const overBudgetG = mergeRepoGroups(
      [L("3", "/over")],
      [IR("/over", [{ id: "3", injected: false }])],
    )[0]!;

    // input order: plain, flagged, overBudget
    const result = reposNeedingAttention([plain, flaggedG, overBudgetG]);
    // plain excluded; over-budget comes first; correct counts
    expect(result).toEqual([
      { repoPath: "/over", droppedCount: 1, flaggedCount: 0 },
      { repoPath: "/flagged", droppedCount: 0, flaggedCount: 1 },
    ]);
  });

  it("returns [] when no repo needs attention", () => {
    const plain = mergeRepoGroups(
      [L("1", "/plain")],
      [IR("/plain", [{ id: "1", injected: true }])],
    )[0]!;
    expect(reposNeedingAttention([plain])).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(reposNeedingAttention([])).toEqual([]);
  });
});

// ─── visibleInjectableRules ───────────────────────────────────────────────────

describe("visibleInjectableRules", () => {
  it("null repo → []", () => {
    expect(visibleInjectableRules(null, { flaggedOnly: false, overBudgetOnly: false })).toEqual([]);
    expect(visibleInjectableRules(null, { flaggedOnly: true, overBudgetOnly: true })).toEqual([]);
  });

  it("no lens active → all rules in original order", () => {
    const repo = IR("/a", [
      { id: "1", injected: true },
      { id: "2", injected: false },
      { id: "3", injected: true, ineffectiveCount: 1 },
    ]);
    const rules = visibleInjectableRules(repo, { flaggedOnly: false, overBudgetOnly: false });
    expect(rules.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("flaggedOnly → only flagged rules", () => {
    const repo = IR("/a", [
      { id: "1", injected: true, ineffectiveCount: 2 },
      { id: "2", injected: true, ineffectiveCount: 0 },
      { id: "3", injected: false, ineffectiveCount: 0 },
    ]);
    const rules = visibleInjectableRules(repo, { flaggedOnly: true, overBudgetOnly: false });
    expect(rules.map((r) => r.id)).toEqual(["1"]);
  });

  it("overBudgetOnly → only dropped rules (and empty when repo is not over-budget)", () => {
    const repo = IR("/a", [
      { id: "1", injected: true },
      { id: "2", injected: false },
      { id: "3", injected: false },
    ]);
    const rules = visibleInjectableRules(repo, { flaggedOnly: false, overBudgetOnly: true });
    expect(rules.map((r) => r.id)).toEqual(["2", "3"]);

    // disabled repo: not over-budget → empty
    const disabledRepo = IR("/b", [{ id: "4", injected: false }], { enabled: false });
    const disabledRules = visibleInjectableRules(disabledRepo, {
      flaggedOnly: false,
      overBudgetOnly: true,
    });
    expect(disabledRules).toEqual([]);
  });

  it("both lenses: union deduped — a rule that is both flagged AND dropped appears once", () => {
    const repo = IR("/a", [
      { id: "1", injected: false, ineffectiveCount: 2 }, // both flagged + dropped
      { id: "2", injected: true, ineffectiveCount: 1 }, // flagged only
      { id: "3", injected: false, ineffectiveCount: 0 }, // dropped only
      { id: "4", injected: true, ineffectiveCount: 0 }, // neither
    ]);
    const rules = visibleInjectableRules(repo, { flaggedOnly: true, overBudgetOnly: true });
    // union: ids 1 (flagged+dropped), 2 (flagged), 3 (dropped); in repo order
    expect(rules.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });
});

// ─── retiredRules / retiredCount / unseenRetiredCount ─────────────────────────

describe("retiredRules / retiredCount / unseenRetiredCount", () => {
  it("null repo → [] / 0 / 0", () => {
    expect(retiredRules(null)).toEqual([]);
    expect(retiredCount(null)).toBe(0);
    expect(unseenRetiredCount(null)).toBe(0);
  });

  it("repo with no retired rules → [] / 0 / 0", () => {
    const repo = IR("/a", [{ id: "1", injected: true }]);
    expect(retiredRules(repo)).toEqual([]);
    expect(retiredCount(repo)).toBe(0);
    expect(unseenRetiredCount(repo)).toBe(0);
  });

  it("repo with retired rules returns them / correct count", () => {
    const r1 = { ...L("r1", "/a", "retired"), retiredAt: 1 };
    const r2 = { ...L("r2", "/a", "retired"), retiredAt: 2 };
    const repo = IR("/a", [{ id: "1", injected: true }], { retired: [r1, r2], unseenRetired: 2 });
    expect(retiredRules(repo).map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(retiredCount(repo)).toBe(2);
    expect(unseenRetiredCount(repo)).toBe(2);
  });

  it("unseenRetired tracks independently of retired length", () => {
    const r1 = { ...L("r1", "/a", "retired") };
    const r2 = { ...L("r2", "/a", "retired") };
    // 2 retired, but operator already saw 1
    const repo = IR("/a", [], { retired: [r1, r2], unseenRetired: 1 });
    expect(retiredCount(repo)).toBe(2);
    expect(unseenRetiredCount(repo)).toBe(1);
  });
});

// ─── helpRate ─────────────────────────────────────────────────────────────────

describe("helpRate", () => {
  it("returns null when injectedCount is 0 (never injected)", () => {
    expect(helpRate({ helpfulCount: 0, injectedCount: 0 })).toBeNull();
  });

  it("returns { helped, pulls } when injectedCount > 0", () => {
    expect(helpRate({ helpfulCount: 3, injectedCount: 10 })).toEqual({ helped: 3, pulls: 10 });
  });

  it("helped can be 0 of non-zero pulls", () => {
    expect(helpRate({ helpfulCount: 0, injectedCount: 5 })).toEqual({ helped: 0, pulls: 5 });
  });

  it("helped can equal pulls (100% rate)", () => {
    expect(helpRate({ helpfulCount: 7, injectedCount: 7 })).toEqual({ helped: 7, pulls: 7 });
  });
});
