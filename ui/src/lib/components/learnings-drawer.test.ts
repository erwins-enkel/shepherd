import { describe, it, expect } from "vitest";
import { basename, groupByRepo } from "./learnings-drawer";
import type { Learning } from "../types";

function L(id: string, repo: string): Learning {
  return {
    id,
    repoPath: repo,
    rule: "r",
    rationale: "",
    evidence: [],
    status: "proposed",
    evidenceCount: 0,
    ineffectiveCount: 0,
    createdAt: 0,
    updatedAt: 0,
    lastEvidenceAt: null,
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
