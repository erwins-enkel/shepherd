import { describe, it, expect } from "vitest";
import { searchRepos, type RepoSearchKey } from "./repo-search";

type Repo = RepoSearchKey & { id: string };

function repo(name: string, usage: Partial<RepoSearchKey> = {}): Repo {
  return { id: name, name, aliases: [`~/Work/${name}`], ...usage };
}

const ids = (query: string, repos: Repo[]) => searchRepos(query, repos, (r) => r).map((r) => r.id);

describe("searchRepos", () => {
  it("ranks the exact name above an alphabetically earlier substring match", () => {
    const repos = [
      repo("omarchy-plugin-shepherd"),
      repo("shepherd", { recentAgentCount: 0, lastUsedAt: 1 }),
    ];
    expect(ids("shepherd", repos)).toEqual(["shepherd", "omarchy-plugin-shepherd"]);
  });

  it("orders same-tier matches by recent agent count", () => {
    const repos = [
      repo("shepherd-buzz-bridge", { recentAgentCount: 1 }),
      repo("shepherd", { recentAgentCount: 9 }),
    ];
    expect(ids("shep", repos)).toEqual(["shepherd", "shepherd-buzz-bridge"]);
  });

  it("never lets usage lift a substring match above a prefix match", () => {
    const repos = [
      repo("omarchy-plugin-shepherd", { recentAgentCount: 99 }),
      repo("shepherd-claude-swap"),
    ];
    expect(ids("shep", repos)).toEqual(["shepherd-claude-swap", "omarchy-plugin-shepherd"]);
  });

  it("prefers a name match over an alias-only match at the same tier", () => {
    const repos = [
      { id: "alias", name: "zeta", aliases: ["owner/shepherd"], recentAgentCount: 5 },
      { id: "name", name: "my-shepherd", aliases: [] },
    ];
    expect(ids("shepherd", repos)).toEqual(["name", "alias"]);
  });

  it("breaks usage ties by last used, then name", () => {
    const repos = [
      repo("shep-b", { lastUsedAt: 1 }),
      repo("shep-c", { lastUsedAt: 5 }),
      repo("shep-a", { lastUsedAt: 1 }),
    ];
    expect(ids("shep", repos)).toEqual(["shep-c", "shep-a", "shep-b"]);
  });

  it("returns the input order for a blank query", () => {
    const repos = [repo("b"), repo("a")];
    expect(ids("  ", repos)).toEqual(["b", "a"]);
  });

  it("drops non-matches and keeps fuzzy subsequence matches", () => {
    const repos = [repo("shepherd"), repo("other")];
    expect(ids("shpd", repos)).toEqual(["shepherd"]);
  });
});
