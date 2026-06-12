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
    expect(result.size).toBe(2);
    expect(result.get(1)).toEqual({ total: 3, completed: 1 });
    expect(result.get(2)).toBeUndefined(); // total === 0 excluded
    expect(result.get(3)).toEqual({ total: 5, completed: 5 });
  });

  test("runner throws → returns empty Map (no rethrow)", async () => {
    const run: GhRunner = async () => {
      throw new Error("network error");
    };
    const result = await new GithubForge("o/r", {} as never, run).listSubIssueSummaries!();
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
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
    expect(result.size).toBe(2);
    expect(result.get(10)).toEqual({ total: 2, completed: 0 });
    expect(result.get(20)).toEqual({ total: 4, completed: 2 });
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
});
