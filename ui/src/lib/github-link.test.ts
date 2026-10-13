import { describe, it, expect } from "vitest";
import { parseGithubLinks, matchRepoForLinks } from "./github-link";
import type { RepoEntry } from "./types";

const repo = (name: string, extra: Partial<RepoEntry> = {}): RepoEntry => ({
  name,
  path: `/r/${name}`,
  display: name,
  realPath: `/r/${name}`,
  ...extra,
});

describe("parseGithubLinks", () => {
  it("reads PR, issue, root, .git and deep links", () => {
    expect(parseGithubLinks("https://github.com/acme/api/pull/1288")).toEqual([
      { slug: "acme/api", issue: null },
    ]);
    expect(parseGithubLinks("https://github.com/acme/api/issues/7")).toEqual([
      { slug: "acme/api", issue: 7 },
    ]);
    expect(parseGithubLinks("http://www.github.com/acme/api")).toEqual([
      { slug: "acme/api", issue: null },
    ]);
    expect(parseGithubLinks("https://github.com/acme/api.git")).toEqual([
      { slug: "acme/api", issue: null },
    ]);
    expect(parseGithubLinks("https://github.com/acme/api/blob/main/x.ts#L3")).toEqual([
      { slug: "acme/api", issue: null },
    ]);
  });

  it("finds every link inside prose", () => {
    expect(
      parseGithubLinks("see https://github.com/a/b/pull/1, and (https://github.com/c/d/issues/2)."),
    ).toEqual([
      { slug: "a/b", issue: null },
      { slug: "c/d", issue: 2 },
    ]);
  });

  it("ignores non-GitHub hosts and look-alikes", () => {
    expect(parseGithubLinks("https://gitlab.com/a/b/-/issues/1")).toEqual([]);
    expect(parseGithubLinks("https://notgithub.com/a/b")).toEqual([]);
    expect(parseGithubLinks("plain text")).toEqual([]);
  });
});

describe("matchRepoForLinks", () => {
  const repos = [
    repo("api", { remoteSlug: "acme/api" }),
    repo("fork", { remoteSlug: "me/fork", upstreamSlug: "Upstream/Proj", isFork: true }),
    repo("local"),
  ];

  it("matches remoteSlug case-insensitively", () => {
    expect(matchRepoForLinks(repos, "https://github.com/ACME/Api/pull/3")).toEqual({
      repo: repos[0],
      issue: null,
      viaUpstream: false,
    });
  });

  it("matches a fork by its upstream slug and flags it", () => {
    expect(matchRepoForLinks(repos, "https://github.com/upstream/proj/issues/9")).toEqual({
      repo: repos[1],
      issue: 9,
      viaUpstream: true,
    });
  });

  it("first MATCHING link wins", () => {
    const text = "https://github.com/nobody/x/pull/1 https://github.com/me/fork/issues/4";
    expect(matchRepoForLinks(repos, text)).toEqual({
      repo: repos[1],
      issue: 4,
      viaUpstream: false,
    });
  });

  it("an exact clone wins over a fork of it, whatever the list order", () => {
    const upstream = repo("flow", { remoteSlug: "murakamyadvisory/flowagent" });
    const fork = repo("myflow", {
      remoteSlug: "me/flowagent",
      upstreamSlug: "murakamyadvisory/flowagent",
      isFork: true,
    });
    const link = "https://github.com/murakamyadvisory/flowagent/pull/1288";
    for (const list of [
      [fork, upstream],
      [upstream, fork],
    ])
      expect(matchRepoForLinks(list, link)).toEqual({
        repo: upstream,
        issue: null,
        viaUpstream: false,
      });
  });

  it("null when nothing matches", () => {
    expect(matchRepoForLinks(repos, "https://github.com/nobody/x")).toBeNull();
    expect(matchRepoForLinks(repos, "no links")).toBeNull();
  });
});
