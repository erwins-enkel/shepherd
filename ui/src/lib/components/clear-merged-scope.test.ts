import { describe, it, expect } from "vitest";
import { scopeClearMerged, sumLeftovers } from "./clear-merged-scope";
import type { Session } from "../types";

const s = (id: string, repoPath: string) => ({ id, repoPath }) as Session;

const hunde1 = s("h1", "/p/hunde-frontend");
const hunde2 = s("h2", "/p/hunde-frontend");
const shep1 = s("s1", "/p/shepherd");
const shep2 = s("s2", "/p/shepherd");
const bar1 = s("b1", "/p/BarTab");
const all = [hunde1, shep1, bar1, hunde2, shep2];

describe("scopeClearMerged", () => {
  it("targets every merged session when the herd is unfiltered", () => {
    expect(scopeClearMerged(all, new Set())).toEqual({
      inside: all,
      outside: [],
      outsideRepos: [],
    });
  });

  it("splits the merged sessions along the repo filter, keeping order", () => {
    const scope = scopeClearMerged(all, new Set(["/p/hunde-frontend"]));
    expect(scope.inside).toEqual([hunde1, hunde2]);
    expect(scope.outside).toEqual([shep1, bar1, shep2]);
  });

  it("counts the hidden sessions per repo, largest first", () => {
    const scope = scopeClearMerged(all, new Set(["/p/hunde-frontend"]));
    expect(scope.outsideRepos).toEqual([
      { name: "shepherd", count: 2 },
      { name: "BarTab", count: 1 },
    ]);
  });

  it("treats every repo of a multi-repo filter as inside", () => {
    const scope = scopeClearMerged(all, new Set(["/p/hunde-frontend", "/p/BarTab"]));
    expect(scope.inside).toEqual([hunde1, bar1, hunde2]);
    expect(scope.outsideRepos).toEqual([{ name: "shepherd", count: 2 }]);
  });
});

describe("sumLeftovers", () => {
  it("totals the leftovers of just the given sessions, missing ids as zero", () => {
    expect(sumLeftovers([hunde1, shep1, bar1], { h1: 2, s1: 3, h2: 7 })).toBe(5);
  });
});
