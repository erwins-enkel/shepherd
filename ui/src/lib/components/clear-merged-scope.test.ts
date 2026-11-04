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
    expect(scopeClearMerged(all, new Set(), [])).toEqual({
      inside: all,
      outside: [],
      outsideRepos: [],
    });
  });

  it("splits the merged sessions along the repo filter, keeping order", () => {
    const scope = scopeClearMerged(all, new Set(["/p/hunde-frontend"]), []);
    expect(scope.inside).toEqual([hunde1, hunde2]);
    expect(scope.outside).toEqual([shep1, bar1, shep2]);
  });

  it("counts the hidden sessions per repo, largest first", () => {
    const scope = scopeClearMerged(all, new Set(["/p/hunde-frontend"]), []);
    expect(scope.outsideRepos).toEqual([
      { name: "shepherd", count: 2 },
      { name: "BarTab", count: 1 },
    ]);
  });

  it("treats every repo of a multi-repo filter as inside", () => {
    const scope = scopeClearMerged(all, new Set(["/p/hunde-frontend", "/p/BarTab"]), []);
    expect(scope.inside).toEqual([hunde1, bar1, hunde2]);
    expect(scope.outsideRepos).toEqual([{ name: "shepherd", count: 2 }]);
  });
});

// Sessions mirrored from a connected machine (#2765): their checkout lives under another path, so
// the herd keeps them under a repo filter by project slug (`inRepoFilter`) — the dialog must too.
const HOST = { instanceId: "m1", name: "macbook", platform: "macos" };
const mirrored = (id: string, repoPath: string, remoteSlug?: string) =>
  ({ id, repoPath, host: HOST, ...(remoteSlug ? { remoteSlug } : {}) }) as Session;
const mac1 = mirrored("m1", "/Users/x/shepherd-main", "Erwins-Enkel/Shepherd");
const mac2 = mirrored("m2", "/Users/x/shepherd-main", "erwins-enkel/shepherd");
const macOther = mirrored("m3", "/Users/x/manufare-portal", "erwins-enkel/manufare-portal");
const macNoSlug = mirrored("m4", "/Users/x/scratch");
const repos = [
  { path: "/p/shepherd", realPath: "/p/shepherd", remoteSlug: "erwins-enkel/shepherd" },
  { path: "/p/BarTab", realPath: "/p/BarTab" },
];

describe("scopeClearMerged with sessions on connected machines", () => {
  it("keeps a mirrored session of the filtered project inside, as the herd shows it", () => {
    const scope = scopeClearMerged(
      [hunde1, mac1, macOther, mac2, macNoSlug],
      new Set(["/p/shepherd"]),
      repos,
    );
    expect(scope.inside).toEqual([mac1, mac2]);
    expect(scope.outside).toEqual([hunde1, macOther, macNoSlug]);
  });

  it("keeps a local session matched by its path, never by a slug", () => {
    const scope = scopeClearMerged([shep1, mac1, bar1], new Set(["/p/shepherd"]), repos);
    expect(scope.inside).toEqual([shep1, mac1]);
    expect(scope.outside).toEqual([bar1]);
  });

  it("keeps no mirrored session when the filtered repo has no known slug", () => {
    const scope = scopeClearMerged([bar1, mac1], new Set(["/p/BarTab"]), repos);
    expect(scope.inside).toEqual([bar1]);
    expect(scope.outside).toEqual([mac1]);
  });

  it("targets every machine's merged sessions when the herd is unfiltered", () => {
    const sessions = [shep1, mac1, macNoSlug];
    expect(scopeClearMerged(sessions, new Set(), repos).inside).toEqual(sessions);
  });

  it("counts the hidden sessions per project, naming it after this host's checkout", () => {
    const scope = scopeClearMerged(
      [bar1, shep1, mac1, macOther, shep2, mac2, macNoSlug, hunde1],
      new Set(["/p/BarTab"]),
      repos,
    );
    expect(scope.outsideRepos).toEqual([
      { name: "shepherd", count: 4 },
      { name: "manufare-portal", count: 1 },
      { name: "scratch", count: 1 },
      { name: "hunde-frontend", count: 1 },
    ]);
  });
});

describe("sumLeftovers", () => {
  it("totals the leftovers of just the given sessions, missing ids as zero", () => {
    expect(sumLeftovers([hunde1, shep1, bar1], { h1: 2, s1: 3, h2: 7 })).toBe(5);
  });
});
