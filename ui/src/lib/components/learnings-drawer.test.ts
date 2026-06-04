import { describe, it, expect, test } from "vitest";
import {
  basename,
  groupByRepo,
  mergeRepoGroups,
  injectionBadge,
  injectedCount,
  showIneffective,
  evidenceSources,
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
    createdAt: 0,
    updatedAt: 0,
    lastEvidenceAt: null,
    promotedPrUrl: null,
  };
}

function IR(
  repo: string,
  rules: { id: string; injected: boolean; status?: LearningStatus }[],
  over: Partial<RepoInjectable> = {},
): RepoInjectable {
  return {
    repoPath: repo,
    enabled: true,
    budgetChars: 4000,
    usedChars: 100,
    rules: rules.map((r) => ({ ...L(r.id, repo, r.status ?? "active"), injected: r.injected })),
    ...over,
  };
}

describe("basename", () => {
  it("takes the last path segment", () => expect(basename("/home/u/acme")).toBe("acme"));
  it("tolerates trailing slash", () => expect(basename("/home/u/acme/")).toBe("acme"));
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
  const rule = (injected: boolean) => ({ ...L("1", "/a", "active"), injected });
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
