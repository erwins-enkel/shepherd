import { test, expect, describe } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import type { GhRunner } from "../../src/forge/github";

function fakeRunner(responses: Record<string, string>) {
  const run = async (args: string[]): Promise<string> => {
    const path = args.find((a) => a.startsWith("repos/")) ?? args.slice(0, 2).join(" ");
    if (responses[path] === undefined) throw new Error("gh: 404");
    return responses[path];
  };
  return { run };
}

/** Build a recording GhRunner that returns responses in sequence. */
function sequenceRunner(responses: string[]): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  let idx = 0;
  const run: GhRunner = async (args) => {
    calls.push(args);
    const resp = responses[idx++];
    if (resp === undefined) throw new Error("no more responses");
    return resp;
  };
  return { run, calls };
}

/** Build a recording GhRunner that always returns the same JSON and never ends. */
function infiniteRunner(response: string): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    return response;
  };
  return { run, calls };
}

describe("GithubForge epic reads", () => {
  test("listSubIssues → children in order with native state/labels/body", async () => {
    const { run } = fakeRunner({
      "repos/o/r/issues/327/sub_issues": JSON.stringify([
        {
          number: 320,
          title: "EFI",
          html_url: "u320",
          body: "b320",
          state: "closed",
          labels: [{ name: "shepherd:active" }],
        },
        { number: 326, title: "Ont", html_url: "u326", body: "", state: "open", labels: [] },
      ]),
    });
    expect(await new GithubForge("o/r", {} as never, run).listSubIssues!(327)).toEqual([
      {
        number: 320,
        title: "EFI",
        url: "u320",
        body: "b320",
        closed: true,
        labels: ["shepherd:active"],
      },
      { number: 326, title: "Ont", url: "u326", body: "", closed: false, labels: [] },
    ]);
  });

  test("listBlockedBy → numbers", async () => {
    const { run } = fakeRunner({
      "repos/o/r/issues/323/dependencies/blocked_by": JSON.stringify([
        { number: 320 },
        { number: 322 },
      ]),
    });
    expect(await new GithubForge("o/r", {} as never, run).listBlockedBy!(323)).toEqual([320, 322]);
  });

  test("404 → [] (no native links)", async () => {
    expect(await new GithubForge("o/r", {} as never, fakeRunner({}).run).listSubIssues!(1)).toEqual(
      [],
    );
  });
});

describe("GithubForge listSubIssueSummaries", () => {
  test("single page: returns Map with entries filtered to total > 0, exactly 1 runner call", async () => {
    const page = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { number: 1, subIssuesSummary: { total: 3, completed: 1 } },
              { number: 2, subIssuesSummary: { total: 0, completed: 0 } },
              { number: 3, subIssuesSummary: { total: 5, completed: 5 } },
            ],
          },
        },
      },
    });
    const { run, calls } = sequenceRunner([page]);
    const result = await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    expect(calls.length).toBe(1);
    expect(result.summaries.size).toBe(2);
    expect(result.summaries.get(1)).toEqual({ total: 3, completed: 1 });
    expect(result.summaries.get(2)).toBeUndefined(); // total === 0 excluded
    expect(result.summaries.get(3)).toEqual({ total: 5, completed: 5 });
    expect(result.subIssueNumbers).toEqual([]); // no nodes have parent set
  });

  test("runner throws → returns empty summaries and subIssueNumbers (no rethrow)", async () => {
    const run: GhRunner = async () => {
      throw new Error("network error");
    };
    const result = await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    expect(result.summaries).toBeInstanceOf(Map);
    expect(result.summaries.size).toBe(0);
    expect(result.subIssueNumbers).toEqual([]);
  });

  test("two-page cursor: collects both pages, 2 runner calls, second call passes endCursor from first", async () => {
    const page1 = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
            nodes: [{ number: 10, subIssuesSummary: { total: 2, completed: 0 } }],
          },
        },
      },
    });
    const page2 = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ number: 20, subIssuesSummary: { total: 4, completed: 2 } }],
          },
        },
      },
    });
    const { run, calls } = sequenceRunner([page1, page2]);
    const result = await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    expect(calls.length).toBe(2);
    expect(result.summaries.size).toBe(2);
    expect(result.summaries.get(10)).toEqual({ total: 2, completed: 0 });
    expect(result.summaries.get(20)).toEqual({ total: 4, completed: 2 });
    expect(result.subIssueNumbers).toEqual([]); // no nodes have parent set
    // First call must NOT pass an endCursor field arg; second must pass cursor-abc.
    const firstCallArgs = calls[0]!.join(" ");
    const secondCallArgs = calls[1]!.join(" ");
    expect(firstCallArgs).not.toContain("cursor-abc");
    expect(secondCallArgs).toContain("cursor-abc");
    // Both calls use the graphql endpoint and refer to $endCursor + pageInfo.
    expect(firstCallArgs).toContain("graphql");
    expect(firstCallArgs).toContain("endCursor");
    expect(firstCallArgs).toContain("pageInfo");
    expect(firstCallArgs).not.toContain("title"); // counts-only query — no title/body fetched
  });

  test("cap: runner always returns hasNextPage:true → called at most MAX_SUMMARY_PAGES (2) times", async () => {
    const infinitePage = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-loop" },
            nodes: [{ number: 99, subIssuesSummary: { total: 1, completed: 0 } }],
          },
        },
      },
    });
    const { run, calls } = infiniteRunner(infinitePage);
    await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    expect(calls.length).toBe(2); // MAX_SUMMARY_PAGES = 2
  });

  // collectSubIssueSummaryPage: tested via listSubIssueSummaries with synthetic mixed nodes
  test("collectSubIssueSummaryPage: parent!=null adds to subIssueNumbers, parent:null does not", async () => {
    // node 7: parent set → sub-issue child; node 10: parent null → not a sub-issue;
    // node 15: total>0 → goes into summaries map
    const page = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { number: 7, subIssuesSummary: null, parent: { number: 3 } },
              { number: 10, subIssuesSummary: { total: 2, completed: 1 }, parent: null },
              { number: 15, subIssuesSummary: { total: 4, completed: 0 }, parent: null },
            ],
          },
        },
      },
    });
    const { run } = sequenceRunner([page]);
    const result = await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    // subIssueNumbers: only node 7 has a non-null parent
    expect(result.subIssueNumbers).toEqual([7]);
    // summaries map: only nodes with total>0; node 7 has null subIssuesSummary so excluded
    expect(result.summaries.get(7)).toBeUndefined();
    expect(result.summaries.get(10)).toEqual({ total: 2, completed: 1 });
    expect(result.summaries.get(15)).toEqual({ total: 4, completed: 0 });
  });

  test("collectSubIssueSummaryPage: node with parent AND total>0 appears in both summaries and subIssueNumbers", async () => {
    const page = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              // parent set AND total>0: appears in both
              { number: 42, subIssuesSummary: { total: 3, completed: 1 }, parent: { number: 1 } },
              // no parent, no summary: neither
              { number: 43, subIssuesSummary: null, parent: null },
            ],
          },
        },
      },
    });
    const { run } = sequenceRunner([page]);
    const result = await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    expect(result.subIssueNumbers).toEqual([42]);
    expect(result.summaries.get(42)).toEqual({ total: 3, completed: 1 });
    expect(result.summaries.size).toBe(1);
  });
});
