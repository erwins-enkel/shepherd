import { describe, it, expect } from "vitest";
import { recentRepos, RECENT_LIMIT } from "./recentRepos";
import type { RepoEntry } from "$lib/types";

function repo(name: string, recentAgentCount?: number, lastUsedAt?: number): RepoEntry {
  return {
    name,
    path: `/repos/${name}`,
    display: name,
    realPath: `/repos/${name}`,
    recentAgentCount,
    lastUsedAt,
  };
}

describe("recentRepos", () => {
  it("ranks by recentAgentCount descending", () => {
    const repos = [repo("a", 1), repo("b", 5), repo("c", 3)];
    const result = recentRepos(repos);
    expect(result.map((r) => r.name)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties by lastUsedAt descending", () => {
    const repos = [repo("a", 3, 100), repo("b", 3, 200), repo("c", 3, 50)];
    const result = recentRepos(repos);
    expect(result.map((r) => r.name)).toEqual(["b", "a", "c"]);
  });

  it("breaks further ties by name (localeCompare)", () => {
    const repos = [repo("charlie", 3, 100), repo("alpha", 3, 100), repo("beta", 3, 100)];
    const result = recentRepos(repos);
    expect(result.map((r) => r.name)).toEqual(["alpha", "beta", "charlie"]);
  });

  it("excludes repos with zero recentAgentCount", () => {
    const repos = [repo("a", 0), repo("b", 2), repo("c")];
    const result = recentRepos(repos);
    expect(result.map((r) => r.name)).toEqual(["b"]);
  });

  it("excludes repos with undefined recentAgentCount", () => {
    const repos = [repo("a", undefined), repo("b", 1)];
    const result = recentRepos(repos);
    expect(result.map((r) => r.name)).toEqual(["b"]);
  });

  it("caps result at RECENT_LIMIT (3) by default", () => {
    const repos = [repo("a", 5), repo("b", 4), repo("c", 3), repo("d", 2), repo("e", 1)];
    const result = recentRepos(repos);
    expect(result).toHaveLength(RECENT_LIMIT);
    expect(result.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("respects an explicit smaller limit", () => {
    const repos = [repo("a", 5), repo("b", 4), repo("c", 3)];
    const result = recentRepos(repos, 2);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("returns empty array when all repos have no recentAgentCount", () => {
    const repos = [repo("a"), repo("b", 0)];
    expect(recentRepos(repos)).toEqual([]);
  });
});
