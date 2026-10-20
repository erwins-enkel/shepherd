import { expect, test } from "bun:test";
import { GithubForge } from "../../src/forge/github";

function page(nodes: unknown[], next: string | null = null) {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            nodes,
            pageInfo: { hasNextPage: next !== null, endCursor: next },
          },
        },
      },
    },
  });
}
const merged = {
  __typename: "PullRequest",
  number: 212,
  url: "https://github.com/o/r/pull/212",
  state: "MERGED",
};
test("claim references include bare mentions, UI links and cross-repository PRs across pages", async () => {
  const calls: string[][] = [];
  const responses = [
    page([{ source: merged }], "next"),
    page([
      { source: merged },
      {
        source: { __typename: "Issue" },
        subject: { ...merged, state: "OPEN", url: "https://github.com/other/r/pull/212" },
      },
    ]),
  ];
  const forge = new GithubForge("o/r", {} as never, async (args) => {
    calls.push(args);
    return responses.shift()!;
  });
  expect(await forge.issuePullRequestReferences(133)).toEqual([
    { number: 212, url: merged.url, state: "merged" },
    { number: 212, url: "https://github.com/other/r/pull/212", state: "open" },
  ]);
  expect(calls[1]).toContain("cursor=next");
  expect(calls[0]!.join(" ")).toContain("CONNECTED_EVENT");
});
test("incomplete, inaccessible and failing reads cannot establish no open PR", async () => {
  for (const response of [
    page([null]),
    page([{ source: null }]),
    JSON.stringify({ errors: [{}] }),
    page([], "stuck"),
  ]) {
    const forge = new GithubForge("o/r", {} as never, async () => response);
    expect(await forge.issuePullRequestReferences(133)).toBeNull();
  }
  expect(
    await new GithubForge("o/r", {} as never, async () => {
      throw Error("offline");
    }).issuePullRequestReferences(133),
  ).toBeNull();
});
test("a complete empty read establishes no references", async () => {
  expect(
    await new GithubForge("o/r", {} as never, async () => page([])).issuePullRequestReferences(133),
  ).toEqual([]);
});

test("claimed issue discovery paginates the active-label query, independent of the backlog cap", async () => {
  const calls: string[][] = [];
  const row = (number: number) => ({
    number,
    title: "claim",
    body: "",
    html_url: `https://github.com/o/r/issues/${number}`,
    labels: [{ name: "shepherd:active" }],
    assignees: [],
    created_at: "2026-10-19T00:00:00Z",
  });
  const forge = new GithubForge("o/r", {} as never, async (args) => {
    calls.push(args);
    return JSON.stringify(
      calls.length === 1 ? Array.from({ length: 100 }, (_, n) => row(n + 1)) : [row(133)],
    );
  });
  expect((await forge.listClaimedIssues()).at(-1)?.number).toBe(133);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("labels=shepherd:active");
  expect(calls[1]).toContain("page=2");
});
