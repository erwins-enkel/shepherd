import { afterEach, describe, expect, test } from "bun:test";
import {
  buildHeadBatchArgs,
  HEAD_BATCH_CHUNK,
  headKey,
  parseHeadBatchResponse,
  type HeadTarget,
} from "../src/forge/github-head-batch";
import { GithubForge, type GhRunner } from "../src/forge/github";
import { graphRateLimit } from "../src/forge/rate-limit";

/** The flat `gh pr list --json` row for the PR below. */
const GH_ROW = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Topic",
  state: "OPEN",
  author: { login: "alice" },
  createdAt: "2026-10-20T10:00:00Z",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  isDraft: false,
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "test",
      workflowName: "CI",
      status: "IN_PROGRESS",
      conclusion: "",
      startedAt: "2026-10-20T10:01:00Z",
      completedAt: null,
      detailsUrl: "https://x/1",
    },
    {
      __typename: "StatusContext",
      context: "deploy",
      state: "SUCCESS",
      targetUrl: "https://x/2",
      createdAt: "2026-10-20T10:02:00Z",
    },
  ],
  headRefOid: "abc",
  baseRefName: "main",
  reviews: [
    {
      author: { login: "bob" },
      submittedAt: "2026-10-20T11:00:00Z",
      body: "ok",
      state: "APPROVED",
    },
  ],
  reviewRequests: [{ login: "carol" }],
  headRepositoryOwner: { login: "o" },
};

/** The same PR as the aliased GraphQL node. */
const GRAPHQL_NODE = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Topic",
  state: "OPEN",
  author: { login: "alice" },
  createdAt: "2026-10-20T10:00:00Z",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  isDraft: false,
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "test",
                  checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                  status: "IN_PROGRESS",
                  conclusion: "",
                  startedAt: "2026-10-20T10:01:00Z",
                  completedAt: null,
                  detailsUrl: "https://x/1",
                },
                {
                  __typename: "StatusContext",
                  context: "deploy",
                  state: "SUCCESS",
                  targetUrl: "https://x/2",
                  createdAt: "2026-10-20T10:02:00Z",
                },
              ],
            },
          },
        },
      },
    ],
  },
  headRefOid: "abc",
  baseRefName: "main",
  reviews: {
    nodes: [
      {
        author: { login: "bob" },
        submittedAt: "2026-10-20T11:00:00Z",
        body: "ok",
        state: "APPROVED",
      },
    ],
  },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: "User", login: "carol" } },
      { requestedReviewer: { __typename: "Team" } },
    ],
  },
  headRepositoryOwner: { login: "o" },
};

const RATE = { cost: 1, used: 10, remaining: 4990, resetAt: "2099-01-01T00:00:00Z" };

/** A fake runner answering head-batch queries from `prs` (slug → head → node). */
function batchRunner(prs: Record<string, Record<string, unknown>>, calls: string[][]): GhRunner {
  return async (args) => {
    calls.push(args);
    const vars = new Map<string, string>();
    for (let i = 0; i < args.length - 1; i++)
      if (args[i] === "-f") {
        const [k, ...v] = args[i + 1]!.split("=");
        vars.set(k!, v.join("="));
      }
    const data: Record<string, unknown> = { rateLimit: RATE };
    for (let r = 0; vars.has(`o${r}`); r++) {
      const slug = `${vars.get(`o${r}`)}/${vars.get(`n${r}`)}`;
      if (!(slug in prs)) {
        data[`r${r}`] = null;
        continue;
      }
      const repo: Record<string, unknown> = {};
      for (let h = 0; vars.has(`h${r}_${h}`); h++) {
        const node = prs[slug]![vars.get(`h${r}_${h}`)!];
        repo[`h${h}`] = { nodes: node ? [node] : [] };
      }
      data[`r${r}`] = repo;
    }
    return JSON.stringify({ data });
  };
}

afterEach(() => graphRateLimit.noteSuccess());

describe("buildHeadBatchArgs", () => {
  test("aliases repos and heads, values only as -f variables", () => {
    const args = buildHeadBatchArgs([
      { slug: "o/r", head: "a" },
      { slug: "x/y", head: "b" },
      { slug: "o/r", head: "c" },
    ]);
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    const fields = args.filter((_, i) => args[i - 1] === "-f");
    expect(fields).toContain("o0=o");
    expect(fields).toContain("n0=r");
    expect(fields).toContain("h0_0=a");
    expect(fields).toContain("h0_1=c");
    expect(fields).toContain("o1=x");
    expect(fields).toContain("h1_0=b");
    const query = fields.find((f) => f.startsWith("query="))!;
    expect(query).toContain("r0:repository(owner:$o0,name:$n0)");
    expect(query).toContain("h1:pullRequests(headRefName:$h0_1,");
    expect(query).toContain("rateLimit{");
    expect(query).not.toContain('"a"');
  });
});

describe("parseHeadBatchResponse", () => {
  const targets: HeadTarget[] = [
    { slug: "o/r", head: "topic" },
    { slug: "o/r", head: "none" },
    { slug: "gone/repo", head: "x" },
  ];

  test("flattens nodes to gh's JSON shape; empty → null; unresolved repo → absent", () => {
    const out = JSON.stringify({
      data: { r0: { h0: { nodes: [GRAPHQL_NODE] }, h1: { nodes: [] } }, r1: null },
    });
    const res = parseHeadBatchResponse(out, targets);
    expect(res.get(headKey("o/r", "topic"))).toEqual(GH_ROW);
    expect(res.get(headKey("o/r", "none"))).toBeNull();
    expect(res.has(headKey("gone/repo", "x"))).toBe(false);
  });

  test("throws without data", () => {
    expect(() => parseHeadBatchResponse("{}", targets)).toThrow();
  });
});

describe("GithubForge.prStatusMany", () => {
  test("maps exactly like prStatus for the same PR", async () => {
    const single = new GithubForge("o/r", {}, async () => JSON.stringify([GH_ROW]));
    const calls: string[][] = [];
    const batched = new GithubForge(
      "o/r",
      {},
      batchRunner({ "o/r": { topic: GRAPHQL_NODE } }, calls),
    );
    const many = await batched.prStatusMany(["topic", "other"]);
    expect(many.get("topic")).toEqual(await single.prStatus("topic"));
    expect(many.get("other")).toMatchObject({ state: "none", checks: "none" });
    expect(calls).toHaveLength(1);
  });

  test("coalesces forges in one macrotask; chunks at 20 heads", async () => {
    const calls: string[][] = [];
    const run = batchRunner({ "o/a": {}, "o/b": {} }, calls);
    const a = new GithubForge("o/a", {}, run);
    const b = new GithubForge("o/b", {}, run);
    const heads = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const [ra, rb] = await Promise.all([
      a.prStatusMany(heads(15, "a")),
      b.prStatusMany(heads(10, "b")),
    ]);
    expect(calls).toHaveLength(Math.ceil(25 / HEAD_BATCH_CHUNK));
    expect(ra.size).toBe(15);
    expect(rb.size).toBe(10);
  });

  test("a failed chunk leaves its heads out; never rejects", async () => {
    const forge = new GithubForge("o/r", {}, async () => {
      throw new Error("boom");
    });
    expect((await forge.prStatusMany(["a"])).size).toBe(0);
  });

  test("empty in fork mode and under the GraphQL backoff", async () => {
    const calls: string[][] = [];
    const run = batchRunner({ "o/r": { a: GRAPHQL_NODE } }, calls);
    const fork = new GithubForge("o/r", {}, run, "me/r");
    expect((await fork.prStatusMany(["a"])).size).toBe(0);
    graphRateLimit.noteLimitError(60);
    const plain = new GithubForge("o/r", {}, run);
    expect((await plain.prStatusMany(["a"])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
