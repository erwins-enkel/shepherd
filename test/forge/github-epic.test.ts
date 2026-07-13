import { test, expect, describe } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import type { GhRunner } from "../../src/forge/github";
import { graphRateLimit } from "../../src/forge/rate-limit";

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
    // childrenByParent: node 7 grouped under its parent #3; parent-less nodes absent
    expect(result.childrenByParent?.get(3)).toEqual([7]);
    expect(result.childrenByParent?.size).toBe(1);
    // summaries map: only nodes with total>0; node 7 has null subIssuesSummary so excluded
    expect(result.summaries.get(7)).toBeUndefined();
    expect(result.summaries.get(10)).toEqual({ total: 2, completed: 1 });
    expect(result.summaries.get(15)).toEqual({ total: 4, completed: 0 });
  });

  test("childrenByParent: multiple children of one parent are grouped together", async () => {
    const page = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { number: 24, subIssuesSummary: null, parent: { number: 16 } },
              { number: 25, subIssuesSummary: null, parent: { number: 16 } },
              { number: 26, subIssuesSummary: null, parent: { number: 99 } },
            ],
          },
        },
      },
    });
    const { run } = sequenceRunner([page]);
    const result = await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    expect(result.childrenByParent?.get(16)).toEqual([24, 25]);
    expect(result.childrenByParent?.get(99)).toEqual([26]);
    expect(result.subIssueNumbers).toEqual([24, 25, 26]);
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

describe("GithubForge listOpenPrLinkedIssues", () => {
  test("maps each closed issue to the open PR's number + author", async () => {
    const page = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 200,
                author: { login: "scoop" },
                closingIssuesReferences: { nodes: [{ number: 10 }, { number: 11 }] },
              },
              {
                number: 201,
                author: { login: "kai" },
                closingIssuesReferences: { nodes: [{ number: 10 }] },
              },
              { number: 202, author: { login: "ada" }, closingIssuesReferences: { nodes: [] } },
            ],
          },
        },
      },
    });
    const { run, calls } = sequenceRunner([page]);
    const linked = await new GithubForge("o/r", {} as never, run).listOpenPrLinkedIssues!();
    expect(linked.get(10)).toEqual([
      { prNumber: 200, author: "scoop" },
      { prNumber: 201, author: "kai" },
    ]);
    expect(linked.get(11)).toEqual([{ prNumber: 200, author: "scoop" }]);
    expect(linked.has(202)).toBe(false); // PR 202 closes nothing
    // The extended query selects the PR number + author.
    const q = calls[0]!.join(" ");
    expect(q).toContain("author{login}");
    expect(q).toContain("closingIssuesReferences");
  });

  test("missing author login degrades to empty string, not a throw", async () => {
    const page = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { number: 5, author: null, closingIssuesReferences: { nodes: [{ number: 3 }] } },
            ],
          },
        },
      },
    });
    const { run } = sequenceRunner([page]);
    const linked = await new GithubForge("o/r", {} as never, run).listOpenPrLinkedIssues!();
    expect(linked.get(3)).toEqual([{ prNumber: 5, author: "" }]);
  });

  test("listOpenPrClosingIssues delegates: still returns just the closed-issue numbers", async () => {
    const page = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 200,
                author: { login: "scoop" },
                closingIssuesReferences: { nodes: [{ number: 10 }, { number: 11 }] },
              },
            ],
          },
        },
      },
    });
    const { run } = sequenceRunner([page]);
    const closed = await new GithubForge("o/r", {} as never, run).listOpenPrClosingIssues!();
    expect(closed.sort((a, b) => a - b)).toEqual([10, 11]);
  });
});

describe("GithubForge listBlockedByOpen", () => {
  test("real payload: maps blocked issues to open-blocker numbers; unblocked/closed-blocker issues omitted", async () => {
    // Verified-live fixture shape (see task brief): #1600 has no blockers, #1601's only
    // blocker is CLOSED — neither should appear in the result Map.
    const page = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: "y" },
            nodes: [
              { number: 1622, blockedBy: { nodes: [{ number: 1642, state: "OPEN" }] } },
              { number: 1506, blockedBy: { nodes: [{ number: 1505, state: "OPEN" }] } },
              { number: 1507, blockedBy: { nodes: [{ number: 1505, state: "OPEN" }] } },
              { number: 1627, blockedBy: { nodes: [{ number: 1626, state: "OPEN" }] } },
              { number: 1600, blockedBy: { nodes: [] } },
              { number: 1601, blockedBy: { nodes: [{ number: 1500, state: "CLOSED" }] } },
            ],
          },
        },
      },
    });
    const { run, calls } = sequenceRunner([page]);
    const result = await new GithubForge("o/r", {} as never, run).listBlockedByOpen!();
    expect(result).toEqual(
      new Map([
        [1622, [1642]],
        [1506, [1505]],
        [1507, [1505]],
        [1627, [1626]],
      ]),
    );
    expect(result.has(1600)).toBe(false);
    expect(result.has(1601)).toBe(false);
    expect(calls.length).toBe(1);
  });

  test("runner throws rate-limit error → returns empty Map (no rethrow)", async () => {
    const run: GhRunner = async () => {
      throw { stderr: "API rate limit exceeded for graphql resource" };
    };
    const result = await new GithubForge("o/r", {} as never, run).listBlockedByOpen!();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test("malformed JSON response → returns empty Map (no throw)", async () => {
    const run: GhRunner = async () => "not json";
    const result = await new GithubForge("o/r", {} as never, run).listBlockedByOpen!();
    expect(result.size).toBe(0);
  });

  test("graphRateLimit.blocked(): short-circuits to empty Map without calling the runner", async () => {
    graphRateLimit.noteLimitError(60);
    try {
      const calls: string[][] = [];
      const run: GhRunner = async (args) => {
        calls.push(args);
        return "{}";
      };
      const result = await new GithubForge("o/r", {} as never, run).listBlockedByOpen!();
      expect(result.size).toBe(0);
      expect(calls.length).toBe(0);
    } finally {
      graphRateLimit.note({ remaining: 1000, resetAt: Date.now() + 60_000 });
    }
  });

  test("two-page cursor: collects both pages into one Map, 2 runner calls, second passes after= from first", async () => {
    const page1 = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
            nodes: [{ number: 10, blockedBy: { nodes: [{ number: 9, state: "OPEN" }] } }],
          },
        },
      },
    });
    const page2 = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ number: 20, blockedBy: { nodes: [{ number: 19, state: "OPEN" }] } }],
          },
        },
      },
    });
    const { run, calls } = sequenceRunner([page1, page2]);
    const result = await new GithubForge("o/r", {} as never, run).listBlockedByOpen!();
    expect(calls.length).toBe(2);
    expect(result).toEqual(
      new Map([
        [10, [9]],
        [20, [19]],
      ]),
    );
    const firstCallArgs = calls[0]!.join(" ");
    const secondCallArgs = calls[1]!.join(" ");
    expect(firstCallArgs).not.toContain("cursor-abc");
    expect(secondCallArgs).toContain("cursor-abc");
  });

  test("cap: runner always returns hasNextPage:true → called at most MAX_SUMMARY_PAGES (2) times", async () => {
    const infinitePage = JSON.stringify({
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-loop" },
            nodes: [{ number: 99, blockedBy: { nodes: [{ number: 98, state: "OPEN" }] } }],
          },
        },
      },
    });
    const { run, calls } = infiniteRunner(infinitePage);
    await new GithubForge("o/r", {} as never, run).listBlockedByOpen!();
    expect(calls.length).toBe(2);
  });
});
