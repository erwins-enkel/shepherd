import { describe, it, expect } from "vitest";
import { steerAppliesToRepo, steerRepoNames } from "./steer-scope";
import type { RemoteRepo, Steer } from "./types";

function makeSteer(repos?: string[], agentProviders?: Steer["agentProviders"]): Steer {
  return {
    id: "s1",
    label: "test",
    text: "do it",
    inSteerBar: true,
    onIssues: false,
    ...(repos !== undefined ? { repos } : {}),
    ...(agentProviders !== undefined ? { agentProviders } : {}),
  };
}

describe("steerAppliesToRepo", () => {
  it("universal when repos is absent", () => {
    expect(steerAppliesToRepo(makeSteer(undefined), "alpha")).toBe(true);
    expect(steerAppliesToRepo(makeSteer(undefined), null)).toBe(true);
  });

  it("universal when repos is empty", () => {
    expect(steerAppliesToRepo(makeSteer([]), "alpha")).toBe(true);
    expect(steerAppliesToRepo(makeSteer([]), null)).toBe(true);
  });

  it("matches when repoName is in the allowlist", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha", "beta"]), "alpha")).toBe(true);
  });

  it("misses when repoName is not in the allowlist", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha", "beta"]), "gamma")).toBe(false);
  });

  it("hidden (not universal) when repoName is null and allowlist is non-empty", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha"]), null)).toBe(false);
  });

  it("matches provider-specific steers only for that provider", () => {
    expect(steerAppliesToRepo(makeSteer(undefined, ["codex"]), "alpha", "codex")).toBe(true);
    expect(steerAppliesToRepo(makeSteer(undefined, ["codex"]), "alpha", "claude")).toBe(false);
  });

  it("combines repo and provider constraints", () => {
    const steer = makeSteer(["alpha"], ["claude"]);
    expect(steerAppliesToRepo(steer, "alpha", "claude")).toBe(true);
    expect(steerAppliesToRepo(steer, "alpha", "codex")).toBe(false);
    expect(steerAppliesToRepo(steer, "beta", "claude")).toBe(false);
  });
});

describe("steerAppliesToRepo with several names", () => {
  it("matches when any of the names is in the allowlist", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha"]), ["beta", "alpha"])).toBe(true);
    expect(steerAppliesToRepo(makeSteer(["alpha"]), ["beta"])).toBe(false);
  });

  it("hides a repo-bound steer for an empty name list but keeps universal ones", () => {
    expect(steerAppliesToRepo(makeSteer(["alpha"]), [])).toBe(false);
    expect(steerAppliesToRepo(makeSteer(undefined), [])).toBe(true);
  });
});

describe("steerRepoNames (#3967)", () => {
  // The source machine A: its checkouts, as its probe reports them.
  const source: RemoteRepo[] = [
    {
      name: "shepherd",
      path: "/home/a/Work/shepherd",
      realPath: "/srv/a/shepherd",
      remoteSlug: "Erwins-Enkel/Shepherd",
    },
    {
      name: "shepherd-2",
      path: "/home/a/Work/shepherd-2",
      realPath: "/home/a/Work/shepherd-2",
      remoteSlug: "erwins-enkel/shepherd",
    },
    { name: "notes", path: "/home/a/notes", realPath: "/home/a/notes", remoteSlug: null },
  ];

  it("keeps the local name when no source is set", () => {
    expect(steerRepoNames({ path: "/b/shep", localName: "shep", slug: "x/y" }, null)).toEqual([
      "shep",
    ]);
    expect(steerRepoNames({ path: "/b/unknown", localName: null, slug: null }, null)).toEqual([]);
  });

  it("maps the source's own checkout (a mirrored session) to its name, in either path form", () => {
    expect(
      steerRepoNames({ path: "/home/a/Work/shepherd", localName: null, slug: null }, source),
    ).toEqual(["shepherd"]);
    expect(
      steerRepoNames({ path: "/srv/a/shepherd", localName: null, slug: null }, source),
    ).toEqual(["shepherd"]);
    // a slugless source checkout still matches by its own path
    expect(steerRepoNames({ path: "/home/a/notes", localName: null, slug: null }, source)).toEqual([
      "notes",
    ]);
  });

  it("maps a local checkout with another path and name to the source names by slug", () => {
    expect(
      steerRepoNames(
        { path: "/Users/b/code/shep", localName: "shep", slug: "erwins-enkel/SHEPHERD" },
        source,
      ),
    ).toEqual(["shepherd", "shepherd-2"]);
  });

  it("never matches by directory name: no slug or an unknown slug resolves to nothing", () => {
    expect(
      steerRepoNames({ path: "/Users/b/shepherd", localName: "shepherd", slug: null }, source),
    ).toEqual([]);
    expect(
      steerRepoNames(
        { path: "/Users/b/shepherd", localName: "shepherd", slug: "other/repo" },
        source,
      ),
    ).toEqual([]);
  });

  it("feeds steerAppliesToRepo: a source steer bound to its repo shows on the local checkout", () => {
    const names = steerRepoNames(
      { path: "/Users/b/code/shep", localName: "shep", slug: "erwins-enkel/shepherd" },
      source,
    );
    expect(steerAppliesToRepo(makeSteer(["shepherd-2"]), names)).toBe(true);
    expect(steerAppliesToRepo(makeSteer(["shep"]), names)).toBe(false);
  });
});
