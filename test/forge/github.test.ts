import { test, expect } from "bun:test";
import { GithubForge, reviewerStatesFromReviews } from "../../src/forge/github";
import { graphRateLimit } from "../../src/forge/rate-limit";
import { CRITIC_REVIEW_MARKER, EmptyDiffError } from "../../src/forge/types";
import type { PullRequest, PrReviewerState, PrStatus } from "../../src/forge/types";
import type { GhReview } from "../../src/forge/github";

// A recording fake `gh` runner. Returns canned stdout keyed by the subcommand.
function fakeRunner(responses: Record<string, string>) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const key = `${args[0]} ${args[1] ?? ""}`.trim();
    if (key in responses) return responses[key]!;
    return "";
  };
  return { run, calls };
}

function blockGraphql(): void {
  graphRateLimit.noteLimitError(60);
}

function unblockGraphql(): void {
  graphRateLimit.note({ remaining: 1000, resetAt: Date.now() + 60_000 });
}

const ISSUE_CREATED_AT = "2024-01-01T00:00:00Z";
const ISSUES_JSON = JSON.stringify([
  {
    number: 1,
    title: "Fix crash",
    body: "boom",
    url: "u1",
    labels: [{ name: "bug" }],
    createdAt: ISSUE_CREATED_AT,
    assignees: [{ login: "octocat" }, { login: "hubot" }],
  },
  {
    number: 2,
    title: "Unassigned",
    body: "",
    url: "u2",
    labels: [],
    createdAt: ISSUE_CREATED_AT,
    // no assignees key → maps to []
  },
]);

function review(author: string, state: string, submittedAt: string, body = ""): GhReview {
  return { author: { login: author }, state, submittedAt, body };
}

test("reviewerStatesFromReviews: changes requested creates a per-reviewer state", () => {
  expect(
    reviewerStatesFromReviews([review("scoop", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z")]),
  ).toEqual({
    scoop: { state: "changes_requested", latestAt: Date.parse("2026-01-01T00:00:00Z") },
  });
});

test("reviewerStatesFromReviews: approval clears prior requested changes", () => {
  expect(
    reviewerStatesFromReviews([
      review("scoop", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"),
      review("scoop", "APPROVED", "2026-01-01T01:00:00Z"),
    ]),
  ).toEqual({ scoop: { state: "approved", latestAt: Date.parse("2026-01-01T01:00:00Z") } });
});

test("reviewerStatesFromReviews: later comment does not clear requested changes", () => {
  expect(
    reviewerStatesFromReviews([
      review("scoop", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"),
      review("scoop", "COMMENTED", "2026-01-01T01:00:00Z"),
    ]),
  ).toEqual({
    scoop: { state: "changes_requested", latestAt: Date.parse("2026-01-01T00:00:00Z") },
  });
});

test("reviewerStatesFromReviews: dismissed clears requested changes", () => {
  expect(
    reviewerStatesFromReviews([
      review("scoop", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"),
      review("scoop", "DISMISSED", "2026-01-01T01:00:00Z"),
    ]),
  ).toEqual({});
});

test("reviewerStatesFromReviews: replay is chronological, not payload-order dependent", () => {
  expect(
    reviewerStatesFromReviews([
      review("scoop", "APPROVED", "2026-01-01T01:00:00Z"),
      review("scoop", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z"),
    ]),
  ).toEqual({ scoop: { state: "approved", latestAt: Date.parse("2026-01-01T01:00:00Z") } });
});

test("reviewerStatesFromReviews: critic reviews are ignored", () => {
  expect(
    reviewerStatesFromReviews([
      review("scoop", "CHANGES_REQUESTED", "2026-01-01T00:00:00Z", CRITIC_REVIEW_MARKER),
    ]),
  ).toEqual({});
});

test("GithubForge.listBacklogCounts: parses counts, CI rollup and PR-kind split", async () => {
  const graphql = JSON.stringify({
    data: {
      repository: {
        issues: { totalCount: 7 },
        pullRequests: {
          totalCount: 4,
          nodes: [
            { author: { login: "dependabot[bot]" }, title: "bump foo", labels: { nodes: [] } },
            { author: { login: "me" }, title: "chore(main): release 1.0.0", labels: { nodes: [] } },
            { author: { login: "me" }, title: "fix: a bug", labels: { nodes: [] } },
            { author: { login: "me" }, title: "feat: a thing", labels: { nodes: [] } },
          ],
        },
        defaultBranchRef: { target: { statusCheckRollup: { state: "FAILURE" } } },
      },
    },
  });
  const { run, calls } = fakeRunner({ "api graphql": graphql });
  const forge = new GithubForge("o/r", {}, run);
  const counts = await forge.listBacklogCounts();
  expect(counts).toEqual({
    openIssues: 7,
    openPRs: 4,
    ciStatus: "failure",
    prKinds: { release: 1, dependabot: 1, regular: 2 },
  });
  expect(calls[0]).toContain("owner=o");
  expect(calls[0]).toContain("name=r");
});

test("GithubForge.listBacklogCounts: REST fallback derives counts when PR pagination is uncapped", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 1,
          title: "Bump dep",
          user: { login: "dependabot[bot]" },
          head: { ref: "dependabot/npm/foo" },
        },
        {
          number: 2,
          title: "feat: work",
          user: { login: "alice" },
          head: { ref: "feature" },
        },
      ]);
    }
    if (args.includes("repos/o/r")) return JSON.stringify({ open_issues_count: 5 });
    return "";
  };
  blockGraphql();
  try {
    const counts = await new GithubForge("o/r", {}, run).listBacklogCounts();
    expect(counts).toEqual({
      openIssues: 3,
      openPRs: 2,
      ciStatus: null,
      prKinds: { release: 0, dependabot: 1, regular: 1 },
    });
  } finally {
    unblockGraphql();
  }
});

test("GithubForge.listBacklogCounts: REST fallback returns unknown when PR pagination is capped", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify(
        Array.from({ length: 100 }, (_, i) => ({
          number: i + (args.includes("page=2") ? 101 : 1),
          title: "feat",
          user: { login: "alice" },
        })),
      );
    }
    if (args.includes("repos/o/r")) return JSON.stringify({ open_issues_count: 250 });
    return "";
  };
  blockGraphql();
  try {
    const counts = await new GithubForge("o/r", {}, run).listBacklogCounts();
    expect(counts).toEqual({ openIssues: null, openPRs: null, ciStatus: null, prKinds: null });
  } finally {
    unblockGraphql();
  }
});

test("GithubForge.listIssues: parses gh issue list output (incl. assignee logins, #824)", async () => {
  const { run } = fakeRunner({ "issue list": ISSUES_JSON });
  const forge = new GithubForge("o/r", { deployWorkflow: "deploy.yml" }, run);
  const issues = await forge.listIssues();
  expect(issues).toEqual([
    {
      number: 1,
      title: "Fix crash",
      body: "boom",
      url: "u1",
      labels: ["bug"],
      createdAt: Date.parse(ISSUE_CREATED_AT),
      assignees: ["octocat", "hubot"],
    },
    {
      number: 2,
      title: "Unassigned",
      body: "",
      url: "u2",
      labels: [],
      createdAt: Date.parse(ISSUE_CREATED_AT),
      assignees: [],
    },
  ]);
});

test("GithubForge.listIssues: maps label color into labelColors (name→#rrggbb); colorless labels contribute nothing", async () => {
  const issuesJson = JSON.stringify([
    {
      number: 1,
      title: "Fix crash",
      body: "boom",
      url: "u1",
      labels: [{ name: "bug", color: "d73a4a" }, { name: "no-color" }],
      createdAt: ISSUE_CREATED_AT,
    },
  ]);
  const { run } = fakeRunner({ "issue list": issuesJson });
  const forge = new GithubForge("o/r", {}, run);
  const issues = await forge.listIssues();
  expect(issues[0]!.labels).toEqual(["bug", "no-color"]);
  expect(issues[0]!.labelColors).toEqual({ bug: "#d73a4a" });
});

test("GithubForge.listIssues: no label carries a color → labelColors omitted", async () => {
  const issuesJson = JSON.stringify([
    {
      number: 1,
      title: "T",
      body: "",
      url: "u1",
      labels: [{ name: "bug" }],
      createdAt: ISSUE_CREATED_AT,
    },
  ]);
  const { run } = fakeRunner({ "issue list": issuesJson });
  const forge = new GithubForge("o/r", {}, run);
  const issues = await forge.listIssues();
  expect(issues[0]!.labelColors).toBeUndefined();
});

test("GithubForge.listIssues: REST fallback maps label color into labelColors (name→#rrggbb)", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/issues")) {
      return JSON.stringify([
        {
          number: 1,
          title: "Issue 1",
          body: "body",
          html_url: "https://github.com/o/r/issues/1",
          labels: [{ name: "bug", color: "D73A4A" }, { name: "no-color" }],
          created_at: ISSUE_CREATED_AT,
        },
      ]);
    }
    return "[]";
  };
  blockGraphql();
  try {
    const issues = await new GithubForge("o/r", {}, run).listIssues();
    expect(issues[0]!.labels).toEqual(["bug", "no-color"]);
    expect(issues[0]!.labelColors).toEqual({ bug: "#d73a4a" });
  } finally {
    unblockGraphql();
  }
});

test("GithubForge.listIssues: requests the assignees field from gh (#824)", async () => {
  const { run, calls } = fakeRunner({ "issue list": ISSUES_JSON });
  const forge = new GithubForge("o/r", { deployWorkflow: "deploy.yml" }, run);
  await forge.listIssues();
  const listCall = calls.find((c) => c[0] === "issue" && c[1] === "list");
  const jsonArg = listCall?.[listCall.indexOf("--json") + 1] ?? "";
  expect(jsonArg.split(",")).toContain("assignees");
});

test("GithubForge.listIssues: REST fallback during GraphQL backoff filters PRs before 200 cap", async () => {
  const calls: string[][] = [];
  const page1 = [
    ...Array.from({ length: 99 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      body: "body",
      html_url: `https://github.com/o/r/issues/${i + 1}`,
      labels: [{ name: "bug" }],
      assignees: [{ login: "octocat" }],
      user: { login: "alice" },
      created_at: ISSUE_CREATED_AT,
    })),
    { number: 1000, title: "PR", pull_request: {}, html_url: "https://github.com/o/r/pull/1" },
  ];
  const page2 = Array.from({ length: 100 }, (_, i) => ({
    number: 100 + i,
    title: `Issue ${100 + i}`,
    body: "",
    html_url: `https://github.com/o/r/issues/${100 + i}`,
    labels: [],
    assignees: [],
    user: { login: "bob" },
    created_at: ISSUE_CREATED_AT,
  }));
  const page3 = [
    {
      number: 200,
      title: "Issue 200",
      body: "",
      html_url: "https://github.com/o/r/issues/200",
      labels: [],
      assignees: [],
      user: { login: "carol" },
      created_at: ISSUE_CREATED_AT,
    },
  ];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    const page = args.includes("page=1") ? page1 : args.includes("page=2") ? page2 : page3;
    return JSON.stringify(page);
  };
  blockGraphql();
  try {
    const issues = await new GithubForge("o/r", {}, run).listIssues();
    expect(issues).toHaveLength(200);
    expect(issues.some((i) => i.number === 1000)).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("state=open");
    expect(calls[0]).toContain("per_page=100");
  } finally {
    unblockGraphql();
  }
});

test("GithubForge.listIssues: REST fallback stops at the hard page cap", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    return JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({
        number: i + 1,
        title: `PR ${i + 1}`,
        pull_request: {},
        html_url: `https://github.com/o/r/pull/${i + 1}`,
      })),
    );
  };
  blockGraphql();
  try {
    const issues = await new GithubForge("o/r", {}, run).listIssues();
    expect(issues).toEqual([]);
    expect(calls).toHaveLength(10);
    expect(calls.at(-1)).toContain("page=10");
  } finally {
    unblockGraphql();
  }
});

test("GithubForge.listIssues: retries REST after GraphQL rate-limit error", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      throw { stderr: "API rate limit exceeded for graphql resource" };
    }
    return JSON.stringify([
      {
        number: 1,
        title: "REST issue",
        html_url: "https://github.com/o/r/issues/1",
        created_at: ISSUE_CREATED_AT,
      },
    ]);
  };
  const issues = await new GithubForge("o/r", {}, run).listIssues();
  expect(issues.map((i) => i.title)).toEqual(["REST issue"]);
  expect(calls.some((c) => c[0] === "issue" && c[1] === "list")).toBe(true);
  expect(calls.some((c) => c.slice(0, 3).join(" ") === "api --method GET")).toBe(true);
});

test("GithubForge.getIssue: fetches via GraphQL and maps author + authorAssociation", async () => {
  const graphql = JSON.stringify({
    data: {
      repository: {
        issue: {
          number: 5,
          title: "t",
          body: "b",
          url: "https://x/5",
          createdAt: "2020-01-01T00:00:00Z",
          author: { login: "alice" },
          authorAssociation: "MEMBER",
          labels: { nodes: [{ name: "bug" }] },
          assignees: { nodes: [{ login: "bob" }] },
        },
      },
    },
  });
  const { run, calls } = fakeRunner({ "api graphql": graphql });
  const forge = new GithubForge("o/r", {}, run);
  const issue = await forge.getIssue!(5);
  expect(issue).toEqual({
    number: 5,
    title: "t",
    body: "b",
    url: "https://x/5",
    createdAt: Date.parse("2020-01-01T00:00:00Z"),
    labels: ["bug"],
    assignees: ["bob"],
    author: "alice",
    authorAssociation: "MEMBER",
  });
  expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
  expect(calls[0]).toContain("owner=o");
  expect(calls[0]).toContain("repo=r");
  expect(calls[0]).toContain("num=5");
  const queryArg = calls[0]![calls[0]!.indexOf("-f") + 1] ?? "";
  expect(queryArg).toContain("authorAssociation");
  expect(queryArg).toContain("author{login}");
});

test("GithubForge.getIssue: REST fallback during GraphQL backoff maps authorAssociation", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("repos/o/r/issues/5")) {
      return JSON.stringify({
        number: 5,
        title: "rest",
        body: "body",
        html_url: "https://github.com/o/r/issues/5",
        created_at: ISSUE_CREATED_AT,
        author_association: "COLLABORATOR",
        user: { login: "alice" },
        labels: [{ name: "bug" }],
        assignees: [{ login: "bob" }],
      });
    }
    return "";
  };
  blockGraphql();
  try {
    const issue = await new GithubForge("o/r", {}, run).getIssue!(5);
    expect(issue).toMatchObject({
      number: 5,
      author: "alice",
      authorAssociation: "COLLABORATOR",
      labels: ["bug"],
      assignees: ["bob"],
    });
    expect(calls[0]!.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    expect(calls[0]).toContain("repos/o/r/issues/5");
  } finally {
    unblockGraphql();
  }
});

test("GithubForge.getIssue: retries REST after GraphQL rate-limit error", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      throw { stderr: "API rate limit exceeded for graphql resource" };
    }
    return JSON.stringify({
      number: 6,
      title: "rest",
      html_url: "https://github.com/o/r/issues/6",
      created_at: ISSUE_CREATED_AT,
      author_association: "MEMBER",
    });
  };
  const issue = await new GithubForge("o/r", {}, run).getIssue!(6);
  expect(issue?.authorAssociation).toBe("MEMBER");
  expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
  expect(calls[1]!.slice(0, 3)).toEqual(["api", "--method", "GET"]);
});

test('GithubForge.getIssue: body defaults to "" and createdAt falls back on absent/bad fields', async () => {
  const graphql = JSON.stringify({
    data: {
      repository: {
        issue: {
          number: 9,
          title: "t2",
          url: "https://x/9",
          // no body, no author, no authorAssociation, no labels/assignees, bad createdAt
          createdAt: "not-a-date",
        },
      },
    },
  });
  const { run } = fakeRunner({ "api graphql": graphql });
  const forge = new GithubForge("o/r", {}, run);
  const before = Date.now();
  const issue = await forge.getIssue!(9);
  expect(issue?.body).toBe("");
  expect(issue?.labels).toEqual([]);
  expect(issue?.assignees).toEqual([]);
  expect(issue?.author).toBeUndefined();
  expect(issue?.authorAssociation).toBeUndefined();
  expect(issue?.createdAt).toBeGreaterThanOrEqual(before);
});

test("GithubForge.getIssue: null on a missing repository.issue (deleted/inaccessible)", async () => {
  const { run } = fakeRunner({
    "api graphql": JSON.stringify({ data: { repository: { issue: null } } }),
  });
  const forge = new GithubForge("o/r", {}, run);
  expect(await forge.getIssue!(5)).toBeNull();
});

test("GithubForge.getIssue: null on empty/malformed output", async () => {
  const { run } = fakeRunner({ "api graphql": "" });
  const forge = new GithubForge("o/r", {}, run);
  expect(await forge.getIssue!(5)).toBeNull();
});

test("GithubForge.getIssue: null when run throws", async () => {
  const forge = new GithubForge("o/r", {}, async () => {
    throw new Error("gh: not found");
  });
  expect(await forge.getIssue!(5)).toBeNull();
});

test("GithubForge.listPullRequests: maps author, draft, mergeable, checks, jobs, review", async () => {
  const prsJson = JSON.stringify([
    {
      number: 7,
      title: "feat: thing",
      url: "https://github.com/o/r/pull/7",
      author: { login: "alice" },
      createdAt: "2024-02-02T00:00:00Z",
      isDraft: true,
      mergeable: "CONFLICTING",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "lint",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://gh/job/a",
        },
        {
          __typename: "CheckRun",
          name: "test",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://gh/job/b",
        },
        {
          __typename: "StatusContext",
          context: "netlify/deploy",
          state: "PENDING",
          targetUrl: "https://netlify/x",
        },
      ],
      reviews: [
        {
          author: { login: "bob" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2024-02-03T00:00:00Z",
        },
      ],
    },
  ]);
  const { run, calls } = fakeRunner({ "pr list": prsJson });
  const forge = new GithubForge("o/r", {}, run);
  const prs = await forge.listPullRequests();
  expect(prs).toEqual([
    {
      number: 7,
      title: "feat: thing",
      url: "https://github.com/o/r/pull/7",
      author: "alice",
      kind: "regular",
      createdAt: Date.parse("2024-02-02T00:00:00Z"),
      isDraft: true,
      mergeable: false,
      checks: "failure", // worst-of over the three checks
      jobs: [
        { name: "CI / lint", state: "success", url: "https://gh/job/a" },
        { name: "CI / test", state: "failure", url: "https://gh/job/b" },
        { name: "netlify/deploy", state: "pending", url: "https://netlify/x" },
      ],
      latestReview: {
        state: "changes_requested",
        author: "bob",
        submittedAt: Date.parse("2024-02-03T00:00:00Z"),
      },
    },
  ]);
  // open-only, capped query
  const prListCall = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  expect(prListCall).toContain("open");
});

test("GithubForge.listPullRequests: classifies dependabot + release PRs by kind", async () => {
  const prsJson = JSON.stringify([
    {
      number: 1,
      title: "Bump lodash from 1 to 2",
      url: "u1",
      author: { login: "app/dependabot" },
      createdAt: "2024-02-02T00:00:00Z",
    },
    {
      number: 2,
      title: "chore(main): release 1.0.0",
      url: "u2",
      author: { login: "release-please[bot]" },
      headRefName: "release-please--branches--main",
    },
    {
      number: 3,
      title: "feat: real work",
      url: "u3",
      author: { login: "carol" },
    },
  ]);
  const { run } = fakeRunner({ "pr list": prsJson });
  const forge = new GithubForge("o/r", {}, run);
  const prs = await forge.listPullRequests();
  expect(prs.map((p) => p.kind)).toEqual(["dependabot", "release", "regular"]);
});

test("GithubForge.listPullRequests: nonDefaultBase set only for non-default-targeting PRs", async () => {
  const prsJson = JSON.stringify([
    {
      number: 1,
      title: "feat: targets default",
      url: "u1",
      author: { login: "alice" },
      createdAt: "2024-02-02T00:00:00Z",
      baseRefName: "main",
    },
    {
      number: 2,
      title: "feat: stacked on epic",
      url: "u2",
      author: { login: "bob" },
      createdAt: "2024-02-02T00:00:00Z",
      baseRefName: "epic/foo",
    },
  ]);
  const { run } = fakeRunner({
    "pr list": prsJson,
    "repo view": JSON.stringify({ defaultBranchRef: { name: "main" } }),
  });
  const forge = new GithubForge("o/r", {}, run);
  const prs = await forge.listPullRequests();
  expect(prs.map((p) => p.nonDefaultBase)).toEqual([undefined, "epic/foo"]);
});

test("GithubForge.listPullRequests: nonDefaultBase undefined when default branch is unresolvable", async () => {
  // No "repo view" mock → defaultBranch() rejects → def === null → no chip even
  // for a non-default-targeting PR (fail-quiet, never a bogus chip).
  const prsJson = JSON.stringify([
    {
      number: 2,
      title: "feat: stacked on epic",
      url: "u2",
      author: { login: "bob" },
      createdAt: "2024-02-02T00:00:00Z",
      baseRefName: "epic/foo",
    },
  ]);
  const { run } = fakeRunner({ "pr list": prsJson, "repo view": "{}" });
  const forge = new GithubForge("o/r", {}, run);
  const prs = await forge.listPullRequests();
  expect(prs[0]!.nonDefaultBase).toBeUndefined();
});

test("GithubForge.listPullRequests: empty output → []", async () => {
  const { run } = fakeRunner({ "pr list": "" });
  const forge = new GithubForge("o/r", {}, run);
  expect(await forge.listPullRequests()).toEqual([]);
});

test("GithubForge.prStatus: open PR with rollup → mapped PrStatus", async () => {
  const prJson = JSON.stringify([
    {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      title: "feat",
      state: "OPEN",
      mergeable: "MERGEABLE",
      baseRefName: "main",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  ]);
  const { run, calls } = fakeRunner({ "pr list": prJson });
  const forge = new GithubForge("o/r", {}, run);
  const st = await forge.prStatus("feature");
  expect(st.state).toBe("open");
  expect(st.number).toBe(7);
  expect(st.url).toBe("https://github.com/o/r/pull/7");
  expect(st.mergeable).toBe(true);
  expect(st.checks).toBe("success");
  expect(st.deployConfigured).toBe(false);
  // queried by head branch + repo
  expect(calls[0]).toContain("--head");
  expect(calls[0]).toContain("feature");
  expect(calls[0]).toContain("o/r");
});

test("GithubForge.prStatus: runningChecks names only the in-flight (pending) checks", async () => {
  const prJson = JSON.stringify([
    {
      number: 8,
      url: "u",
      title: "feat",
      state: "OPEN",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          workflowName: "verify",
          status: "IN_PROGRESS",
          conclusion: null,
        },
        {
          __typename: "CheckRun",
          name: "lint",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
        },
      ],
    },
  ]);
  const { run } = fakeRunner({ "pr list": prJson });
  const st = await new GithubForge("o/r", {}, run).prStatus("feature");
  expect(st.checks).toBe("pending");
  expect(st.runningChecks).toEqual(["verify / test"]);
});

test("GithubForge.prStatus: runningChecks is undefined when nothing is pending", async () => {
  const prJson = JSON.stringify([
    {
      number: 8,
      url: "u",
      title: "feat",
      state: "OPEN",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  ]);
  const { run } = fakeRunner({ "pr list": prJson });
  const st = await new GithubForge("o/r", {}, run).prStatus("feature");
  expect(st.runningChecks).toBeUndefined();
});

test("GithubForge.prStatus: surfaces baseRefName (the PR's real target branch)", async () => {
  // A hotfix PR targeting a non-default branch — the case the diff/recap base resolution needs.
  const prJson = JSON.stringify([
    { number: 9, url: "u", title: "hotfix", state: "OPEN", baseRefName: "main" },
  ]);
  const { run, calls } = fakeRunner({ "pr list": prJson });
  const forge = new GithubForge("o/r", {}, run);
  const st = await forge.prStatus("hotfix/backport");
  expect(st.baseRefName).toBe("main");
  // baseRefName must be among the requested --json fields
  expect(calls[0]?.join(" ")).toContain("baseRefName");
});

test("GithubForge.prStatus: maps isDraft from the json", async () => {
  const draftJson = JSON.stringify([
    { number: 7, url: "u", title: "feat", state: "OPEN", mergeable: "MERGEABLE", isDraft: true },
  ]);
  const draftForge = new GithubForge("o/r", {}, fakeRunner({ "pr list": draftJson }).run);
  expect((await draftForge.prStatus("feature")).isDraft).toBe(true);

  // isDraft absent in the json → defaults to false
  const readyJson = JSON.stringify([
    { number: 7, url: "u", title: "feat", state: "OPEN", mergeable: "MERGEABLE" },
  ]);
  const readyForge = new GithubForge("o/r", {}, fakeRunner({ "pr list": readyJson }).run);
  expect((await readyForge.prStatus("feature")).isDraft).toBe(false);
});

test("GithubForge.prStatus: no PR → state none", async () => {
  const { run } = fakeRunner({ "pr list": "[]" });
  const forge = new GithubForge("o/r", { deployWorkflow: "x.yml" }, run);
  const st = await forge.prStatus("feature");
  expect(st.state).toBe("none");
  expect(st.checks).toBe("none");
  expect(st.deployConfigured).toBe(true);
});

test("GithubForge.prStatus: GraphQL rate limit falls back to REST PR status", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      throw { stderr: "API rate limit exceeded for graphql resource" };
    }
    if (args[0] === "api" && args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 7,
          html_url: "https://github.com/o/r/pull/7",
          title: "feat",
          state: "open",
          draft: false,
          created_at: "2024-01-01T00:00:00Z",
          mergeable: true,
          mergeable_state: "clean",
          head: { ref: "feature", sha: "abc123", repo: { owner: { login: "o" } } },
          base: { ref: "main" },
          requested_reviewers: [{ login: "reviewer" }],
        },
      ]);
    }
    if (args[0] === "api" && args.includes("repos/o/r/commits/abc123/status")) {
      return JSON.stringify({ state: "success" });
    }
    if (args[0] === "api" && args.includes("repos/o/r/commits/abc123/check-runs")) {
      return JSON.stringify({ check_runs: [] });
    }
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  const st = await forge.prStatus("feature");
  expect(st).toMatchObject({
    state: "open",
    number: 7,
    checks: "success",
    mergeable: true,
    mergeStateStatus: "clean",
    baseRefName: "main",
    requestedReviewers: ["reviewer"],
  });
  expect(calls.some((c) => c[0] === "pr" && c[1] === "list")).toBe(true);
  const restList = calls.find((c) => c[0] === "api" && c.includes("repos/o/r/pulls"))!;
  expect(restList).toBeDefined();
  expect(restList.slice(1, 3)).toEqual(["--method", "GET"]);
});

test("GithubForge.merge: invokes gh pr merge with squash + delete-branch", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.merge(7, { method: "squash", deleteBranch: true });
  const args = calls[0]!;
  expect(args.slice(0, 3)).toEqual(["pr", "merge", "7"]);
  expect(args).toContain("--squash");
  expect(args).toContain("--delete-branch");
  expect(args).toContain("o/r");
});

test("GithubForge.redeploy: invokes gh workflow run with ref", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", { deployWorkflow: "deploy.yml" }, run);
  await forge.redeploy({ workflow: "deploy.yml", ref: "main" });
  const args = calls[0]!;
  expect(args.slice(0, 2)).toEqual(["workflow", "run"]);
  expect(args).toContain("deploy.yml");
  expect(args).toContain("--ref");
  expect(args).toContain("main");
});

test("GithubForge.addIssueLabel: ensures the label exists, then adds it", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.addIssueLabel(7, "shepherd:active");
  expect(calls[0]!.slice(0, 3)).toEqual(["label", "create", "shepherd:active"]);
  expect(calls[1]).toEqual([
    "issue",
    "edit",
    "7",
    "--repo",
    "o/r",
    "--add-label",
    "shepherd:active",
  ]);
});

test("GithubForge.addIssueLabel: a pre-existing label (label create throws) still adds", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "label" && args[1] === "create") throw new Error("label already exists");
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  await forge.addIssueLabel(7, "shepherd:active"); // must not throw
  expect(calls.some((c) => c[0] === "issue" && c.includes("--add-label"))).toBe(true);
});

test("GithubForge.removeIssueLabel: gh issue edit --remove-label", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.removeIssueLabel(7, "shepherd:active");
  expect(calls[0]).toEqual([
    "issue",
    "edit",
    "7",
    "--repo",
    "o/r",
    "--remove-label",
    "shepherd:active",
  ]);
});

test("GithubForge.kind + slug", () => {
  const forge = new GithubForge("o/r", {}, async () => "");
  expect(forge.kind).toBe("github");
  expect(forge.slug).toBe("o/r");
});

test("GithubForge.webUrl: returns https://github.com/<slug>", () => {
  const forge = new GithubForge("o/r", {}, async () => "");
  expect(forge.webUrl).toBe("https://github.com/o/r");
});

test("GithubForge.postReview: request-changes invokes gh pr review", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.postReview(7, { event: "REQUEST_CHANGES", body: "nope" });
  expect(calls[0]).toEqual([
    "pr",
    "review",
    "7",
    "--repo",
    "o/r",
    "--request-changes",
    "--body",
    "nope",
  ]);
});

test("GithubForge.postReview: comment maps to --comment", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.postReview(7, { event: "COMMENT", body: "fyi" });
  expect(calls[0]).toEqual(["pr", "review", "7", "--repo", "o/r", "--comment", "--body", "fyi"]);
});

test("GithubForge.prStatus: surfaces head SHA from headRefOid", async () => {
  const prJson = JSON.stringify([
    {
      number: 7,
      url: "u",
      title: "feat",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      headRefOid: "abc123",
    },
  ]);
  const { run, calls } = fakeRunner({ "pr list": prJson });
  const forge = new GithubForge("o/r", {}, run);
  const st = await forge.prStatus("feature");
  expect(st.headSha).toBe("abc123");
  expect(calls[0]!.join(" ")).toContain("headRefOid");
});

test("GithubForge.listIssues: createdAt is parsed to a finite ms number from ISO string", async () => {
  const isoDate = "2024-03-15T10:30:00Z";
  const expectedMs = Date.parse(isoDate);
  const issuesJson = JSON.stringify([
    { number: 1, title: "T", body: "b", url: "u", labels: [], createdAt: isoDate },
  ]);
  const { run } = fakeRunner({ "issue list": issuesJson });
  const forge = new GithubForge("o/r", {}, run);
  const issues = await forge.listIssues();
  expect(issues[0]!.createdAt).toBe(expectedMs);
  expect(Number.isFinite(issues[0]!.createdAt)).toBe(true);
});

test("GithubForge.listIssues: missing createdAt falls back to Date.now() (finite number)", async () => {
  const before = Date.now();
  const issuesJson = JSON.stringify([
    { number: 2, title: "T2", body: "", url: "u2", labels: [] },
    // no createdAt field
  ]);
  const { run } = fakeRunner({ "issue list": issuesJson });
  const forge = new GithubForge("o/r", {}, run);
  const issues = await forge.listIssues();
  const after = Date.now();
  expect(Number.isFinite(issues[0]!.createdAt)).toBe(true);
  expect(issues[0]!.createdAt).toBeGreaterThanOrEqual(before);
  expect(issues[0]!.createdAt).toBeLessThanOrEqual(after);
});

test("GithubForge.listIssues: invalid createdAt string falls back to Date.now() (finite)", async () => {
  const before = Date.now();
  const issuesJson = JSON.stringify([
    { number: 3, title: "T3", body: "", url: "u3", labels: [], createdAt: "not-a-date" },
  ]);
  const { run } = fakeRunner({ "issue list": issuesJson });
  const forge = new GithubForge("o/r", {}, run);
  const issues = await forge.listIssues();
  const after = Date.now();
  expect(Number.isFinite(issues[0]!.createdAt)).toBe(true);
  expect(issues[0]!.createdAt).toBeGreaterThanOrEqual(before);
  expect(issues[0]!.createdAt).toBeLessThanOrEqual(after);
});

test("GithubForge.prStatus: picks newest human review, skips pending/dismissed", async () => {
  const prJson = JSON.stringify([
    {
      number: 7,
      url: "u",
      title: "feat",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      reviews: [
        {
          author: { login: "alice" },
          state: "COMMENTED",
          body: "nit",
          submittedAt: "2024-01-01T00:00:00Z",
        },
        {
          author: { login: "bob" },
          state: "CHANGES_REQUESTED",
          body: "fix this",
          submittedAt: "2024-01-02T00:00:00Z",
        },
        {
          author: { login: "carol" },
          state: "PENDING",
          body: "wip",
          submittedAt: "2024-01-03T00:00:00Z",
        },
      ],
    },
  ]);
  const { run } = fakeRunner({ "pr list": prJson });
  const forge = new GithubForge("o/r", {}, run);
  const st = await forge.prStatus("feature");
  expect(st.latestReview).toEqual({
    state: "changes_requested",
    author: "bob",
    submittedAt: Date.parse("2024-01-02T00:00:00Z"),
  });
});

test("GithubForge.prStatus: excludes critic-marked reviews from latestReview", async () => {
  const prJson = JSON.stringify([
    {
      number: 7,
      url: "u",
      title: "feat",
      state: "OPEN",
      reviews: [
        {
          author: { login: "alice" },
          state: "COMMENTED",
          body: "human note",
          submittedAt: "2024-01-01T00:00:00Z",
        },
        {
          author: { login: "alice" },
          state: "CHANGES_REQUESTED",
          body: "critic findings\n\n<!-- shepherd-critic -->",
          submittedAt: "2024-01-02T00:00:00Z",
        },
      ],
    },
  ]);
  const { run } = fakeRunner({ "pr list": prJson });
  const forge = new GithubForge("o/r", {}, run);
  const st = await forge.prStatus("feature");
  expect(st.latestReview).toEqual({
    state: "commented",
    author: "alice",
    submittedAt: Date.parse("2024-01-01T00:00:00Z"),
  });
});

test("GithubForge.prStatus: no reviews → latestReview undefined", async () => {
  const prJson = JSON.stringify([{ number: 7, url: "u", title: "f", state: "OPEN", reviews: [] }]);
  const { run, calls } = fakeRunner({ "pr list": prJson });
  const st = await new GithubForge("o/r", {}, run).prStatus("feature");
  expect(st.latestReview).toBeUndefined();
  expect(calls[0]!.join(",")).toContain("reviews");
});

test("GithubForge.listWorkflowRuns: newest run per workflow, jobs mapped, newest-first", async () => {
  // run list newest-first: CI has two runs (keep #200), Deploy one (#150).
  const runList = JSON.stringify([
    {
      databaseId: 200,
      workflowName: "CI",
      workflowDatabaseId: 11,
      status: "completed",
      conclusion: "failure",
      headSha: "sha2",
      createdAt: "2024-05-02T00:00:00Z",
      url: "https://gh/run/200",
    },
    {
      databaseId: 150,
      workflowName: "Deploy",
      workflowDatabaseId: 22,
      status: "in_progress",
      conclusion: null,
      headSha: "sha2",
      createdAt: "2024-05-01T12:00:00Z",
      url: "https://gh/run/150",
    },
    {
      databaseId: 100,
      workflowName: "CI",
      workflowDatabaseId: 11,
      status: "completed",
      conclusion: "success",
      headSha: "sha1",
      createdAt: "2024-05-01T00:00:00Z",
      url: "https://gh/run/100",
    },
  ]);
  const jobsById: Record<string, string> = {
    "200": JSON.stringify({
      jobs: [
        { name: "lint", status: "completed", conclusion: "success", url: "https://gh/job/a" },
        { name: "test", status: "completed", conclusion: "failure", url: "https://gh/job/b" },
      ],
    }),
    "150": JSON.stringify({
      jobs: [{ name: "deploy", status: "in_progress", conclusion: null, url: "https://gh/job/c" }],
    }),
  };
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "repo" && args[1] === "view")
      return JSON.stringify({ defaultBranchRef: { name: "main" } });
    if (args[0] === "run" && args[1] === "list") return runList;
    if (args[0] === "run" && args[1] === "view") return jobsById[args[2]!] ?? "{}";
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  const runs = await forge.listWorkflowRuns();

  expect(runs).toEqual([
    {
      runId: 200,
      workflowId: 11,
      workflowName: "CI",
      runUrl: "https://gh/run/200",
      headSha: "sha2",
      createdAt: Date.parse("2024-05-02T00:00:00Z"),
      state: "failure",
      jobs: [
        { name: "lint", state: "success", url: "https://gh/job/a" },
        { name: "test", state: "failure", url: "https://gh/job/b" },
      ],
    },
    {
      runId: 150,
      workflowId: 22,
      workflowName: "Deploy",
      runUrl: "https://gh/run/150",
      headSha: "sha2",
      createdAt: Date.parse("2024-05-01T12:00:00Z"),
      state: "pending",
      jobs: [{ name: "deploy", state: "pending", url: "https://gh/job/c" }],
    },
  ]);
  // queried the default branch, never the stale CI run #100
  const listCall = calls.find((c) => c[0] === "run" && c[1] === "list")!;
  expect(listCall).toContain("main");
  expect(calls.some((c) => c[0] === "run" && c[1] === "view" && c[2] === "100")).toBe(false);
});

test("GithubForge.listWorkflowRuns: no default branch → []", async () => {
  const { run } = fakeRunner({ "repo view": "{}" });
  expect(await new GithubForge("o/r", {}, run).listWorkflowRuns()).toEqual([]);
});

test("GithubForge.listWorkflowRuns: empty run list → []", async () => {
  const { run } = fakeRunner({
    "repo view": JSON.stringify({ defaultBranchRef: { name: "main" } }),
    "run list": "[]",
  });
  expect(await new GithubForge("o/r", {}, run).listWorkflowRuns()).toEqual([]);
});

test("GithubForge.listWorkflowRuns: caps at 10 workflows", async () => {
  const runList = JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({
      databaseId: i,
      workflowName: `wf-${i}`,
      status: "completed",
      conclusion: "success",
      headSha: "s",
      createdAt: `2024-05-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
      url: `u${i}`,
    })),
  );
  let viewCalls = 0;
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === "repo" && args[1] === "view")
      return JSON.stringify({ defaultBranchRef: { name: "main" } });
    if (args[0] === "run" && args[1] === "list") return runList;
    if (args[0] === "run" && args[1] === "view") {
      viewCalls++;
      return JSON.stringify({ jobs: [] });
    }
    return "";
  };
  const runs = await new GithubForge("o/r", {}, run).listWorkflowRuns();
  expect(runs.length).toBe(10);
  expect(viewCalls).toBe(10);
});

test("GithubForge.rerunWorkflowRun: full re-run invokes gh run rerun with the id + repo", async () => {
  const { run, calls } = fakeRunner({});
  await new GithubForge("o/r", {}, run).rerunWorkflowRun(200, { failedOnly: false });
  expect(calls[0]).toEqual(["run", "rerun", "200", "--repo", "o/r"]);
});

test("GithubForge.rerunWorkflowRun: failedOnly adds --failed", async () => {
  const { run, calls } = fakeRunner({});
  await new GithubForge("o/r", {}, run).rerunWorkflowRun(200, { failedOnly: true });
  expect(calls[0]).toEqual(["run", "rerun", "200", "--repo", "o/r", "--failed"]);
});

test("GithubForge.cancelWorkflowRun: invokes gh run cancel with the id + repo", async () => {
  const { run, calls } = fakeRunner({});
  await new GithubForge("o/r", {}, run).cancelWorkflowRun(150);
  expect(calls[0]).toEqual(["run", "cancel", "150", "--repo", "o/r"]);
});

test("GithubForge.postReview: request-changes falls back to pr comment when review is rejected", async () => {
  // GitHub 422s request-changes on a self-authored PR; emulate gh exiting non-zero
  // on the review call, then succeeding (and echoing the URL) on pr comment.
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "review") throw new Error("Can not request changes on your own pull request");
    return "https://github.com/o/r/pull/7#issuecomment-99\n";
  };
  const forge = new GithubForge("o/r", {}, run);
  const result = await forge.postReview(7, { event: "REQUEST_CHANGES", body: "nope" });
  expect(result).toEqual({ url: "https://github.com/o/r/pull/7#issuecomment-99" });
  expect(calls[0]!.slice(0, 2)).toEqual(["pr", "review"]);
  expect(calls[1]).toEqual(["pr", "comment", "7", "--repo", "o/r", "--body", "nope"]);
});

test("GithubForge.listPrComments: parses id/author/body/createdAt from gh pr view", async () => {
  const COMMENTS_JSON = JSON.stringify({
    comments: [
      { id: "IC_1", author: { login: "alice" }, body: "first", createdAt: "2024-02-02T00:00:00Z" },
      // no id → falls back to the comment url so per-round dedup still has a stable key
      {
        url: "https://gh/c/2",
        author: { login: "bob" },
        body: "second",
        createdAt: "2024-02-03T00:00:00Z",
      },
    ],
  });
  const { run, calls } = fakeRunner({ "pr view": COMMENTS_JSON });
  const forge = new GithubForge("o/r", {}, run);
  const comments = await forge.listPrComments(7);
  expect(comments).toEqual([
    { id: "IC_1", author: "alice", body: "first", createdAt: Date.parse("2024-02-02T00:00:00Z") },
    {
      id: "https://gh/c/2",
      author: "bob",
      body: "second",
      createdAt: Date.parse("2024-02-03T00:00:00Z"),
    },
  ]);
  expect(calls[0]).toEqual(["pr", "view", "7", "--repo", "o/r", "--json", "comments"]);
});

test("GithubForge.listPrComments: empty/absent comments → []", async () => {
  const { run } = fakeRunner({ "pr view": JSON.stringify({}) });
  const forge = new GithubForge("o/r", {}, run);
  expect(await forge.listPrComments(7)).toEqual([]);
});

test("GithubForge.closeIssue: invokes gh issue close with the issue number and repo", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.closeIssue(42);
  expect(calls[0]).toEqual(["issue", "close", "42", "--repo", "o/r"]);
});

test("GithubForge.comment: posts a PR comment via gh pr comment", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.comment(7, "@dependabot rebase");
  expect(calls).toEqual([["pr", "comment", "7", "--repo", "o/r", "--body", "@dependabot rebase"]]);
});

test("GithubForge.listRunJobs: maps a run's jobs to the four-light vocab", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === "run" && args[1] === "view" && args[2] === "200")
      return JSON.stringify({
        jobs: [
          { name: "lint", status: "completed", conclusion: "success", url: "https://gh/job/a" },
          { name: "test", status: "in_progress", conclusion: null },
        ],
      });
    return "{}";
  };
  const jobs = await new GithubForge("o/r", {}, run).listRunJobs(200);
  expect(jobs).toEqual([
    { name: "lint", state: "success", url: "https://gh/job/a" },
    { name: "test", state: "pending", url: undefined },
  ]);
});

test("GithubForge.listWorkflowRunHistory: filters by workflow + branch, jobs empty, newest-first", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "repo" && args[1] === "view")
      return JSON.stringify({ defaultBranchRef: { name: "main" } });
    if (args[0] === "run" && args[1] === "list")
      return JSON.stringify([
        {
          databaseId: 90,
          workflowName: "CI",
          workflowDatabaseId: 11,
          status: "completed",
          conclusion: "success",
          headSha: "shaA",
          createdAt: "2024-05-01T00:00:00Z",
          url: "https://gh/run/90",
        },
        {
          databaseId: 99,
          workflowName: "CI",
          workflowDatabaseId: 11,
          status: "completed",
          conclusion: "failure",
          headSha: "shaB",
          createdAt: "2024-05-03T00:00:00Z",
          url: "https://gh/run/99",
        },
      ]);
    return "";
  };
  const runs = await new GithubForge("o/r", {}, run).listWorkflowRunHistory(11, { limit: 10 });

  // newest-first; jobs deliberately empty (lazy)
  expect(runs).toEqual([
    {
      runId: 99,
      workflowId: 11,
      workflowName: "CI",
      runUrl: "https://gh/run/99",
      headSha: "shaB",
      createdAt: Date.parse("2024-05-03T00:00:00Z"),
      state: "failure",
      jobs: [],
    },
    {
      runId: 90,
      workflowId: 11,
      workflowName: "CI",
      runUrl: "https://gh/run/90",
      headSha: "shaA",
      createdAt: Date.parse("2024-05-01T00:00:00Z"),
      state: "success",
      jobs: [],
    },
  ]);
  const listCall = calls.find((c) => c[0] === "run" && c[1] === "list")!;
  expect(listCall).toContain("--workflow");
  expect(listCall).toContain("11");
  expect(listCall).toContain("--branch");
  expect(listCall).toContain("main");
  expect(listCall).toContain("--limit");
  expect(listCall).toContain("10");
  // never fans out to per-run job views for history
  expect(calls.some((c) => c[0] === "run" && c[1] === "view")).toBe(false);
});

test("GithubForge.listWorkflowRunHistory: no default branch → []", async () => {
  const run = async (args: string[]): Promise<string> => (args[0] === "repo" ? "{}" : "");
  expect(await new GithubForge("o/r", {}, run).listWorkflowRunHistory(11, { limit: 10 })).toEqual(
    [],
  );
});

test("GithubForge.ensureIssueLink: appends Closes #N when body has no link", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return "Some PR description";
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  await forge.ensureIssueLink!(7, 3);
  const editCall = calls.find((c) => c[0] === "pr" && c[1] === "edit")!;
  expect(editCall).toBeDefined();
  expect(editCall).toContain("--body");
  const bodyIdx = editCall.indexOf("--body");
  expect(editCall[bodyIdx + 1]).toBe("Some PR description\n\nCloses #3");
});

test("GithubForge.ensureIssueLink: appends to empty body without leading newlines", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return "";
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  await forge.ensureIssueLink!(7, 3);
  const editCall = calls.find((c) => c[0] === "pr" && c[1] === "edit")!;
  const bodyIdx = editCall.indexOf("--body");
  expect(editCall[bodyIdx + 1]).toBe("Closes #3");
});

test("GithubForge.ensureIssueLink: no-op when body already contains Closes #N", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return "Description\n\nCloses #3";
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  await forge.ensureIssueLink!(7, 3);
  expect(calls.find((c) => c[0] === "pr" && c[1] === "edit")).toBeUndefined();
});

test("GithubForge.ensureIssueLink: no-op when body contains a different closing keyword (Fixes #N)", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return "Description\n\nFixes #3";
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  await forge.ensureIssueLink!(7, 3);
  expect(calls.find((c) => c[0] === "pr" && c[1] === "edit")).toBeUndefined();
});

test("GithubForge.ensureIssueLink: does not treat Closes #15 as a link for issue #1", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") return "Description\n\nCloses #15";
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  await forge.ensureIssueLink!(7, 1);
  // #15 should NOT match issue #1 — edit must be called
  expect(calls.find((c) => c[0] === "pr" && c[1] === "edit")).toBeDefined();
});

test("GithubForge.ensureIssueLink: null body (gh serializes body-less PR as literal 'null') → Closes #N only", async () => {
  // `gh pr view --json body -q '.body // empty'` returns empty string for a null body.
  // The old query `.body` returned the literal string "null", which corrupted the body.
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    // Simulate the fixed jq query: `.body // empty` returns "" for a null body.
    // The -q arg is at index args.indexOf("-q") + 1; verify the query is correct.
    if (args[0] === "pr" && args[1] === "view") {
      const qIdx = args.indexOf("-q");
      const query = qIdx >= 0 ? args[qIdx + 1] : "";
      // With the old broken query `.body`, gh would emit "null" (jq serializes JSON null).
      // With the fixed query `.body // empty`, gh emits "" (empty output → trims to "").
      // We simulate what the fixed gh+jq produces: empty string.
      return query === ".body // empty" ? "" : "null";
    }
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  await forge.ensureIssueLink!(7, 3);
  const editCall = calls.find((c) => c[0] === "pr" && c[1] === "edit")!;
  expect(editCall).toBeDefined();
  const bodyIdx = editCall.indexOf("--body");
  expect(editCall[bodyIdx + 1]).toBe("Closes #3");
});

test("GithubForge.prStatus: mergeStateStatus mapped from uppercase GitHub enum values", async () => {
  const mkSt = async (raw: string) => {
    const prJson = JSON.stringify([
      { number: 1, url: "u", title: "t", state: "OPEN", mergeStateStatus: raw },
    ]);
    return new GithubForge("o/r", {}, fakeRunner({ "pr list": prJson }).run).prStatus("feature");
  };
  expect((await mkSt("DIRTY")).mergeStateStatus).toBe("dirty");
  expect((await mkSt("BLOCKED")).mergeStateStatus).toBe("blocked");
  expect((await mkSt("UNSTABLE")).mergeStateStatus).toBe("unstable");
  expect((await mkSt("CLEAN")).mergeStateStatus).toBe("clean");
});

test("GithubForge.prStatus: mergeStateStatus undefined when field absent", async () => {
  const prJson = JSON.stringify([{ number: 1, url: "u", title: "t", state: "OPEN" }]);
  const { run } = fakeRunner({ "pr list": prJson });
  const st = await new GithubForge("o/r", {}, run).prStatus("feature");
  expect(st.mergeStateStatus).toBeUndefined();
});

test("GithubForge.prStatus: mergeStateStatus undefined for unrecognised/future value", async () => {
  const prJson = JSON.stringify([
    { number: 1, url: "u", title: "t", state: "OPEN", mergeStateStatus: "SOME_FUTURE_VALUE" },
  ]);
  const { run } = fakeRunner({ "pr list": prJson });
  const st = await new GithubForge("o/r", {}, run).prStatus("feature");
  expect(st.mergeStateStatus).toBeUndefined();
});

test("GithubForge: a rejecting runner propagates as a rejected promise (fail-closed)", async () => {
  const run = async (): Promise<string> => {
    throw new Error("gh: network error");
  };
  const forge = new GithubForge("o/r", {}, run);
  await expect(forge.listIssues()).rejects.toThrow("gh: network error");
});

test("GithubForge.openPr: draft:true appends --draft to gh pr create args", async () => {
  const prListJson = JSON.stringify([
    {
      number: 5,
      url: "u",
      title: "T",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
    },
  ]);
  const { run, calls } = fakeRunner({ "pr list": prListJson });
  const forge = new GithubForge("o/r", {}, run);
  await forge.openPr({ head: "feat", base: "main", title: "T", body: "B", draft: true });
  const createCall = calls.find((c) => c[0] === "pr" && c[1] === "create")!;
  expect(createCall).toBeDefined();
  expect(createCall).toContain("--draft");
});

test("GithubForge.openPr: draft:false (or omitted) does NOT pass --draft", async () => {
  const prListJson = JSON.stringify([
    {
      number: 5,
      url: "u",
      title: "T",
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
    },
  ]);
  const { run, calls } = fakeRunner({ "pr list": prListJson });
  const forge = new GithubForge("o/r", {}, run);
  await forge.openPr({ head: "feat", base: "main", title: "T", body: "B" });
  const createCall = calls.find((c) => c[0] === "pr" && c[1] === "create")!;
  expect(createCall).toBeDefined();
  expect(createCall).not.toContain("--draft");
});

test("GithubForge.openPr: empty diff (gh stderr 'No commits between') → EmptyDiffError", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "create") {
      // Mirror an execFile rejection: stderr carries gh's empty-diff message.
      const err = new Error("Command failed: gh pr create") as Error & { stderr?: string };
      err.stderr = "No commits between main and epic/327-foo\n";
      throw err;
    }
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  let caught: unknown;
  try {
    await forge.openPr({ head: "epic/327-foo", base: "main", title: "T", body: "B" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(EmptyDiffError);
  expect((caught as EmptyDiffError).head).toBe("epic/327-foo");
  expect((caught as EmptyDiffError).base).toBe("main");
});

test("GithubForge.openPr: unrelated failure propagates unchanged (NOT EmptyDiffError)", async () => {
  const boom = new Error("network unreachable") as Error & { stderr?: string };
  boom.stderr = "network unreachable";
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "create") throw boom;
    return "";
  };
  const forge = new GithubForge("o/r", {}, run);
  let caught: unknown;
  try {
    await forge.openPr({ head: "feat", base: "main", title: "T", body: "B" });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBe(boom);
  expect(caught).not.toBeInstanceOf(EmptyDiffError);
});

test("GithubForge.markReady: invokes gh pr ready <n> --repo", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.markReady!(42);
  expect(calls[0]).toEqual(["pr", "ready", "42", "--repo", "o/r"]);
});

test("GithubForge.convertToDraft: invokes gh pr ready <n> --repo --undo", async () => {
  const { run, calls } = fakeRunner({});
  const forge = new GithubForge("o/r", {}, run);
  await forge.convertToDraft!(42);
  expect(calls[0]).toEqual(["pr", "ready", "42", "--repo", "o/r", "--undo"]);
});

test("GithubForge.canPush: WRITE → true", async () => {
  const { run } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "WRITE" }),
  });
  expect(await new GithubForge("o/r", {}, run).canPush!()).toBe(true);
});

test("GithubForge.canPush: ADMIN → true", async () => {
  const { run } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "ADMIN" }),
  });
  expect(await new GithubForge("o/r", {}, run).canPush!()).toBe(true);
});

test("GithubForge.canPush: MAINTAIN → true", async () => {
  const { run } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "MAINTAIN" }),
  });
  expect(await new GithubForge("o/r", {}, run).canPush!()).toBe(true);
});

test("GithubForge.canPush: READ → false", async () => {
  const { run } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "READ" }),
  });
  expect(await new GithubForge("o/r", {}, run).canPush!()).toBe(false);
});

test("GithubForge.canPush: NONE → false", async () => {
  const { run } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "NONE" }),
  });
  expect(await new GithubForge("o/r", {}, run).canPush!()).toBe(false);
});

test("GithubForge.canPush: TRIAGE → false (definitive deny)", async () => {
  const { run } = fakeRunner({
    "repo view": JSON.stringify({ viewerPermission: "TRIAGE" }),
  });
  expect(await new GithubForge("o/r", {}, run).canPush!()).toBe(false);
});

// A probe failure is NOT a definitive deny — it throws so the caller can treat it
// as retryable, rather than silently reporting "no push access".
test("GithubForge.canPush: garbled JSON → throws (probe failure)", async () => {
  const { run } = fakeRunner({ "repo view": "not-json{{" });
  expect(new GithubForge("o/r", {}, run).canPush!()).rejects.toThrow();
});

test("GithubForge.canPush: runner throws → rethrows (probe failure)", async () => {
  const run = async (): Promise<string> => {
    throw new Error("network error");
  };
  expect(new GithubForge("o/r", {}, run).canPush!()).rejects.toThrow();
});

test("GithubForge.canPush: absent/unknown permission → throws (probe failure)", async () => {
  const { run } = fakeRunner({ "repo view": JSON.stringify({}) });
  expect(new GithubForge("o/r", {}, run).canPush!()).rejects.toThrow();
});

test("GithubForge.listPullRequests: maps headSha (from headRefOid) and headRefName", async () => {
  const prsJson = JSON.stringify([
    {
      number: 9,
      title: "feat: stuff",
      url: "https://github.com/o/r/pull/9",
      author: { login: "alice" },
      createdAt: "2024-03-01T00:00:00Z",
      isDraft: false,
      mergeable: "MERGEABLE",
      statusCheckRollup: [],
      reviews: [],
      headRefName: "feat/stuff",
      headRefOid: "deadbeef1234",
    },
  ]);
  const { run, calls } = fakeRunner({ "pr list": prsJson });
  const forge = new GithubForge("o/r", {}, run);
  const prs = await forge.listPullRequests();
  expect(prs[0]!.headSha).toBe("deadbeef1234");
  expect(prs[0]!.headRefName).toBe("feat/stuff");
  // headRefOid must be in the --json field list
  const prListCall = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  expect(prListCall.join(" ")).toContain("headRefOid");
});

test("GithubForge.listPullRequests: headSha/headRefName undefined when absent in payload", async () => {
  const prsJson = JSON.stringify([
    { number: 1, title: "t", url: "u", author: { login: "a" }, createdAt: "2024-01-01T00:00:00Z" },
  ]);
  const { run } = fakeRunner({ "pr list": prsJson });
  const prs = await new GithubForge("o/r", {}, run).listPullRequests();
  expect(prs[0]!.headSha).toBeUndefined();
  expect(prs[0]!.headRefName).toBeUndefined();
});

test("GithubForge.prReviewMeta: parses body/baseRefName/isCrossRepository/state (OPEN→open)", async () => {
  const viewJson = JSON.stringify({
    body: "PR description",
    baseRefName: "main",
    isCrossRepository: false,
    state: "OPEN",
  });
  const { run, calls } = fakeRunner({ "pr view": viewJson });
  const forge = new GithubForge("o/r", {}, run);
  const meta = await forge.prReviewMeta!(7);
  expect(meta).toEqual({
    body: "PR description",
    baseRefName: "main",
    isCrossRepository: false,
    state: "open",
  });
  // number-keyed: args must contain ["pr", "view", "7"]
  expect(calls[0]!.slice(0, 3)).toEqual(["pr", "view", "7"]);
  expect(calls[0]!).toContain("--repo");
  expect(calls[0]!).toContain("o/r");
  const jsonArg = calls[0]!.join(" ");
  expect(jsonArg).toContain("body");
  expect(jsonArg).toContain("baseRefName");
  expect(jsonArg).toContain("isCrossRepository");
  expect(jsonArg).toContain("state");
});

test("GithubForge.prReviewMeta: MERGED → merged", async () => {
  const viewJson = JSON.stringify({
    body: "",
    baseRefName: "main",
    isCrossRepository: true,
    state: "MERGED",
  });
  const { run } = fakeRunner({ "pr view": viewJson });
  const meta = await new GithubForge("o/r", {}, run).prReviewMeta!(7);
  expect(meta!.state).toBe("merged");
  expect(meta!.isCrossRepository).toBe(true);
});

test("GithubForge.prReviewMeta: CLOSED → closed", async () => {
  const viewJson = JSON.stringify({
    body: "",
    baseRefName: "dev",
    isCrossRepository: false,
    state: "CLOSED",
  });
  const { run } = fakeRunner({ "pr view": viewJson });
  const meta = await new GithubForge("o/r", {}, run).prReviewMeta!(7);
  expect(meta!.state).toBe("closed");
});

test("GithubForge.prReviewMeta: unexpected state → none", async () => {
  const viewJson = JSON.stringify({
    body: "",
    baseRefName: "main",
    isCrossRepository: false,
    state: "UNKNOWN_FUTURE",
  });
  const { run } = fakeRunner({ "pr view": viewJson });
  const meta = await new GithubForge("o/r", {}, run).prReviewMeta!(7);
  expect(meta!.state).toBe("none");
});

test("GithubForge.prReviewMeta: runner throws → returns null (best-effort)", async () => {
  const run = async (): Promise<string> => {
    throw new Error("not found");
  };
  const forge = new GithubForge("o/r", {}, run);
  const meta = await forge.prReviewMeta!(99);
  expect(meta).toBeNull();
});

test("GithubForge.prReviewMeta: missing fields default to empty/false", async () => {
  const viewJson = JSON.stringify({ state: "OPEN" });
  const { run } = fakeRunner({ "pr view": viewJson });
  const meta = await new GithubForge("o/r", {}, run).prReviewMeta!(7);
  expect(meta).toEqual({ body: "", baseRefName: "", isCrossRepository: false, state: "open" });
});

test("GithubForge.prReviewMeta: REST fallback during GraphQL backoff", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr") throw new Error("unexpected gh pr view");
    return JSON.stringify({
      body: "REST body",
      state: "closed",
      merged_at: "2026-01-01T00:00:00Z",
      base: { ref: "main", repo: { full_name: "o/r" } },
      head: { repo: { full_name: "fork/r" } },
    });
  };
  blockGraphql();
  try {
    const meta = await new GithubForge("o/r", {}, run).prReviewMeta!(7);
    expect(meta).toEqual({
      body: "REST body",
      baseRefName: "main",
      isCrossRepository: true,
      state: "merged",
    });
    expect(calls[0]!.slice(0, 4)).toEqual(["api", "--method", "GET", "repos/o/r/pulls/7"]);
  } finally {
    unblockGraphql();
  }
});

test("GithubForge.prReviewMeta: retries REST after GraphQL rate-limit error", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr") throw { stderr: "API rate limit exceeded for graphql resource" };
    return JSON.stringify({
      body: "REST body",
      state: "open",
      merged_at: null,
      base: { ref: "dev", repo: { full_name: "o/r" } },
      head: { repo: { full_name: "o/r" } },
    });
  };
  const meta = await new GithubForge("o/r", {}, run).prReviewMeta!(7);
  expect(meta).toEqual({
    body: "REST body",
    baseRefName: "dev",
    isCrossRepository: false,
    state: "open",
  });
  expect(calls.some((c) => c[0] === "pr" && c[1] === "view")).toBe(true);
  expect(calls.some((c) => c.slice(0, 4).join(" ") === "api --method GET repos/o/r/pulls/7")).toBe(
    true,
  );
});

// ── listOpenPrStatuses + countOpenPrs ────────────────────────────────────────

/** A complete GhPr-shaped node exercising every field that mapGhPr touches. */
const FULL_PR_NODE = {
  number: 42,
  url: "https://github.com/o/r/pull/42",
  title: "feat: full parity",
  state: "OPEN",
  createdAt: "2025-01-15T12:00:00Z",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  isDraft: false,
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "ci",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://gh/job/ci",
    },
  ],
  headRefOid: "deadbeef1234",
  headRefName: "feat/full",
  baseRefName: "main",
  reviews: [
    {
      author: { login: "alice" },
      state: "APPROVED",
      body: "",
      submittedAt: "2025-01-14T00:00:00Z",
    },
  ],
  reviewRequests: [{ login: "bob" }],
  headRepositoryOwner: { login: "o" },
};

test("mapGhPr parity: prStatus and listOpenPrStatuses produce identical PrStatus fields", async () => {
  const prListJson = JSON.stringify([FULL_PR_NODE]);
  const { run } = fakeRunner({ "pr list": prListJson });
  const forge = new GithubForge("o/r", { deployWorkflow: "deploy.yml" }, run);

  const fromPrStatus = await forge.prStatus("feat/full");

  const map = await forge.listOpenPrStatuses!();
  const fromBatch = map.get("feat/full");

  expect(fromBatch).toBeDefined();
  const fields = [
    "state",
    "number",
    "url",
    "title",
    "createdAt",
    "mergeable",
    "mergeStateStatus",
    "isDraft",
    "checks",
    "headSha",
    "baseRefName",
    "latestReview",
    "requestedReviewers",
    "deployConfigured",
  ] as const;
  for (const f of fields) {
    expect(fromBatch![f]).toEqual(fromPrStatus[f]);
  }
});

test("listOpenPrStatuses: non-fork selects expected-owner PR regardless of array order", async () => {
  const internalPr = {
    number: 10,
    url: "u10",
    title: "internal",
    state: "OPEN",
    headRefName: "feat/shared",
    headRepositoryOwner: { login: "o" },
  };
  const forkPr = {
    number: 20,
    url: "u20",
    title: "forker",
    state: "OPEN",
    headRefName: "feat/shared",
    headRepositoryOwner: { login: "someforker" },
  };

  // Sub-case A: internal PR first in array
  {
    const { run } = fakeRunner({ "pr list": JSON.stringify([internalPr, forkPr]) });
    const map = await new GithubForge("o/r", {}, run).listOpenPrStatuses!();
    expect(map.get("feat/shared")!.number).toBe(10);
  }

  // Sub-case B: forker PR first in array — must still resolve to internal
  {
    const { run } = fakeRunner({ "pr list": JSON.stringify([forkPr, internalPr]) });
    const map = await new GithubForge("o/r", {}, run).listOpenPrStatuses!();
    expect(map.get("feat/shared")!.number).toBe(10);
  }
});

test("listOpenPrStatuses: fork forge selects fork-owner PR over upstream-owner", async () => {
  const upstreamPr = {
    number: 5,
    url: "u5",
    title: "upstream",
    state: "OPEN",
    headRefName: "feat/thing",
    headRepositoryOwner: { login: "up" },
  };
  const forkPr = {
    number: 9,
    url: "u9",
    title: "fork",
    state: "OPEN",
    headRefName: "feat/thing",
    headRepositoryOwner: { login: "me" },
  };

  // forkSlug "me/r", slug "up/r" → forkOwner = "me"
  const { run } = fakeRunner({ "pr list": JSON.stringify([upstreamPr, forkPr]) });
  const forge = new GithubForge("up/r", {}, run, "me/r");
  const map = await forge.listOpenPrStatuses!();
  expect(map.get("feat/thing")!.number).toBe(9);
});

test("listOpenPrStatuses: distinct headRefNames → distinct keys; missing headRefName skipped", async () => {
  const prs = [
    {
      number: 1,
      url: "u1",
      title: "a",
      state: "OPEN",
      headRefName: "branch-a",
      headRepositoryOwner: { login: "o" },
    },
    {
      number: 2,
      url: "u2",
      title: "b",
      state: "OPEN",
      headRefName: "branch-b",
      headRepositoryOwner: { login: "o" },
    },
    { number: 3, url: "u3", title: "c", state: "OPEN" /* no headRefName */ },
  ];
  const { run } = fakeRunner({ "pr list": JSON.stringify(prs) });
  const forge = new GithubForge("o/r", {}, run);
  const map = await forge.listOpenPrStatuses!();
  expect(map.size).toBe(2);
  expect(map.has("branch-a")).toBe(true);
  expect(map.has("branch-b")).toBe(true);
  expect(map.get("branch-a")!.number).toBe(1);
  expect(map.get("branch-b")!.number).toBe(2);
});

test("listOpenPrStatuses: cap log fires once at ≥200, latches on second call", async () => {
  const prs200 = Array.from({ length: 200 }, (_, i) => ({
    number: i + 1,
    url: `u${i + 1}`,
    title: `pr${i + 1}`,
    state: "OPEN",
    headRefName: `branch-${i + 1}`,
  }));
  const { run } = fakeRunner({ "pr list": JSON.stringify(prs200) });
  const forge = new GithubForge("o/r", {}, run);

  const warnCalls: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnCalls.push(args);
  try {
    await forge.listOpenPrStatuses!();
    await forge.listOpenPrStatuses!(); // second call: latch must suppress
  } finally {
    console.warn = origWarn;
  }

  expect(warnCalls.length).toBe(1);
  expect(String(warnCalls[0]![0])).toContain("≥200");
});

test("countOpenPrs: returns array length from --json number response", async () => {
  const prs = Array.from({ length: 7 }, (_, i) => ({ number: i + 1 }));
  const { run, calls } = fakeRunner({ "pr list": JSON.stringify(prs) });
  const forge = new GithubForge("o/r", {}, run);
  const count = await forge.countOpenPrs!();
  expect(count).toBe(7);
  const listCall = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  expect(listCall).toContain("number");
  expect(listCall).toContain("open");
});

// ── listOpenPrSnapshot ───────────────────────────────────────────────────────

/** Multi-PR fixture for golden-equivalence tests. Every node has a parseable
 *  createdAt so comparisons don't flake on Date.now() fallback. */
const SNAPSHOT_NODES = [
  {
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "feat: alpha",
    state: "OPEN",
    author: { login: "alice" },
    createdAt: "2026-01-02T03:04:05Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        name: "ci",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        detailsUrl: "https://gh/job/ci",
      },
    ],
    reviews: [
      {
        author: { login: "bob" },
        state: "APPROVED",
        body: "",
        submittedAt: "2026-01-01T00:00:00Z",
      },
    ],
    reviewRequests: [{ login: "carol" }],
    headRefName: "feat/alpha",
    headRefOid: "aaa111",
    baseRefName: "main",
    labels: [{ name: "feature" }],
    headRepositoryOwner: { login: "o" },
  },
  {
    number: 2,
    url: "https://github.com/o/r/pull/2",
    title: "fix: beta",
    state: "OPEN",
    author: { login: "dave" },
    createdAt: "2026-01-03T00:00:00Z",
    isDraft: true,
    mergeable: "CONFLICTING",
    mergeStateStatus: "DIRTY",
    statusCheckRollup: [],
    reviews: [],
    reviewRequests: [],
    headRefName: "fix/beta",
    headRefOid: "bbb222",
    baseRefName: "main",
    labels: [],
    headRepositoryOwner: { login: "o" },
  },
];

/** Expected PullRequest[] golden output for SNAPSHOT_NODES (no defaultBranch → def=null). */
const EXPECTED_PRS: PullRequest[] = [
  {
    number: 1,
    title: "feat: alpha",
    url: "https://github.com/o/r/pull/1",
    author: "alice",
    kind: "regular",
    createdAt: Date.parse("2026-01-02T03:04:05Z"),
    isDraft: false,
    mergeable: true,
    mergeStateStatus: "clean",
    checks: "success",
    jobs: [{ name: "CI / ci", state: "success", url: "https://gh/job/ci" }],
    latestReview: {
      state: "approved",
      author: "bob",
      submittedAt: Date.parse("2026-01-01T00:00:00Z"),
    },
    nonDefaultBase: undefined,
    headSha: "aaa111",
    headRefName: "feat/alpha",
  },
  {
    number: 2,
    title: "fix: beta",
    url: "https://github.com/o/r/pull/2",
    author: "dave",
    kind: "regular",
    createdAt: Date.parse("2026-01-03T00:00:00Z"),
    isDraft: true,
    mergeable: false,
    mergeStateStatus: "dirty",
    checks: "none",
    jobs: [],
    latestReview: undefined,
    nonDefaultBase: undefined,
    headSha: "bbb222",
    headRefName: "fix/beta",
  },
];

/** Expected statuses Map golden output for SNAPSHOT_NODES (deployConfigured=false). */
const EXPECTED_STATUSES: Map<string, PrStatus> = new Map([
  [
    "feat/alpha",
    {
      state: "open",
      number: 1,
      url: "https://github.com/o/r/pull/1",
      title: "feat: alpha",
      createdAt: Date.parse("2026-01-02T03:04:05Z"),
      mergeable: true,
      mergeStateStatus: "clean",
      isDraft: false,
      checks: "success",
      runningChecks: undefined,
      headSha: "aaa111",
      baseRefName: "main",
      latestReview: {
        state: "approved",
        author: "bob",
        submittedAt: Date.parse("2026-01-01T00:00:00Z"),
      },
      reviewerStates: {
        bob: { state: "approved", latestAt: Date.parse("2026-01-01T00:00:00Z") },
      },
      requestedReviewers: ["carol"],
      deployConfigured: false,
    },
  ],
  [
    "fix/beta",
    {
      state: "open",
      number: 2,
      url: "https://github.com/o/r/pull/2",
      title: "fix: beta",
      createdAt: Date.parse("2026-01-03T00:00:00Z"),
      mergeable: false,
      mergeStateStatus: "dirty",
      isDraft: true,
      checks: "none",
      runningChecks: undefined,
      headSha: "bbb222",
      baseRefName: "main",
      latestReview: undefined,
      reviewerStates: {} as Record<string, PrReviewerState>,
      requestedReviewers: [],
      deployConfigured: false,
    },
  ],
]);

test("listOpenPrSnapshot: golden equivalence — prs matches PullRequest[] shape", async () => {
  const { run } = fakeRunner({ "pr list": JSON.stringify(SNAPSHOT_NODES) });
  const forge = new GithubForge("o/r", {}, run);
  const snap = await forge.listOpenPrSnapshot!();
  expect(snap.prs).toEqual(EXPECTED_PRS);
});

test("listOpenPrSnapshot: golden equivalence — statuses matches Map<string, PrStatus>", async () => {
  const { run } = fakeRunner({ "pr list": JSON.stringify(SNAPSHOT_NODES) });
  const forge = new GithubForge("o/r", {}, run);
  const snap = await forge.listOpenPrSnapshot!();
  expect(snap.statuses).toEqual(EXPECTED_STATUSES);
});

test("listOpenPrSnapshot: single underlying fetch — one pr list call yields both shapes", async () => {
  const { run, calls } = fakeRunner({ "pr list": JSON.stringify(SNAPSHOT_NODES) });
  const forge = new GithubForge("o/r", {}, run);
  const snap = await forge.listOpenPrSnapshot!();
  const prListCalls = calls.filter((c) => c[0] === "pr" && c[1] === "list");
  expect(prListCalls.length).toBe(1);
  // Both shapes populated from the single call
  expect(snap.prs.length).toBe(2);
  expect(snap.statuses.size).toBe(2);
});

test("listOpenPrSnapshot: requests union field set including author, labels, state, mergeStateStatus", async () => {
  const { run, calls } = fakeRunner({ "pr list": "[]" });
  const forge = new GithubForge("o/r", {}, run);
  await forge.listOpenPrSnapshot!();
  const listCall = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  const jsonFields = (listCall[listCall.indexOf("--json") + 1] ?? "").split(",");
  for (const field of [
    "author",
    "labels",
    "state",
    "mergeStateStatus",
    "reviewRequests",
    "headRepositoryOwner",
  ]) {
    expect(jsonFields).toContain(field);
  }
});

test("listOpenPrSnapshot: fork-collision dedup — expectedOwner wins regardless of order", async () => {
  const ownedPr = {
    number: 10,
    url: "u10",
    title: "owned",
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    headRefName: "feat/shared",
    headRepositoryOwner: { login: "o" },
  };
  const forkPr = {
    number: 20,
    url: "u20",
    title: "fork",
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    headRefName: "feat/shared",
    headRepositoryOwner: { login: "someforker" },
  };

  // fork-owner first → owned PR should still win
  {
    const { run } = fakeRunner({ "pr list": JSON.stringify([forkPr, ownedPr]) });
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.statuses.get("feat/shared")!.number).toBe(10);
  }

  // owned PR first → still 10
  {
    const { run } = fakeRunner({ "pr list": JSON.stringify([ownedPr, forkPr]) });
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.statuses.get("feat/shared")!.number).toBe(10);
  }
});

test("listOpenPrSnapshot: capped=true when 200 nodes returned", async () => {
  const prs200 = Array.from({ length: 200 }, (_, i) => ({
    number: i + 1,
    url: `u${i + 1}`,
    title: `pr${i + 1}`,
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    headRefName: `branch-${i + 1}`,
  }));
  const { run } = fakeRunner({ "pr list": JSON.stringify(prs200) });
  const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
  expect(snap.capped).toBe(true);
});

test("listOpenPrSnapshot: capped=false when fewer than 200 nodes returned", async () => {
  const { run } = fakeRunner({ "pr list": JSON.stringify(SNAPSHOT_NODES) });
  const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
  expect(snap.capped).toBe(false);
});

test("listOpenPrSnapshot: REST fallback during GraphQL backoff maps PRs and avoids GraphQL helpers", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" || args[0] === "repo" || args[0] === "run") {
      throw new Error(`unexpected GraphQL helper: ${args.join(" ")}`);
    }
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 9,
          html_url: "https://github.com/o/r/pull/9",
          title: "feat: rest",
          body: "Closes #1",
          state: "open",
          draft: true,
          created_at: "2026-01-04T00:00:00Z",
          mergeable: false,
          mergeable_state: "dirty",
          user: { login: "alice" },
          head: { ref: "feat/rest", sha: "sha9", repo: { owner: { login: "o" } } },
          base: { ref: "main" },
          requested_reviewers: [{ login: "bob" }],
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha9/status")) {
      return JSON.stringify({ state: "success" });
    }
    if (args.includes("repos/o/r/commits/sha9/check-runs")) {
      expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
      return JSON.stringify({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "success" }],
      });
    }
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.prs).toEqual([
      {
        number: 9,
        title: "feat: rest",
        url: "https://github.com/o/r/pull/9",
        author: "alice",
        kind: "regular",
        createdAt: Date.parse("2026-01-04T00:00:00Z"),
        isDraft: true,
        mergeable: false,
        checks: "success",
        jobs: [],
        headSha: "sha9",
        headRefName: "feat/rest",
      },
    ]);
    expect(snap.statuses.get("feat/rest")).toMatchObject({
      state: "open",
      number: 9,
      checks: "success",
      requestedReviewers: ["bob"],
      baseRefName: "main",
    });
    expect(calls.some((c) => c[0] === "pr" || c[0] === "repo" || c[0] === "run")).toBe(false);
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: gh pr list rate-limit fallback does not start defaultBranch or awaitingApproval", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      throw { stderr: "API rate limit exceeded for graphql resource" };
    }
    if (args[0] === "repo" || args[0] === "run") {
      throw new Error(`unexpected helper after rate limit: ${args.join(" ")}`);
    }
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 10,
          html_url: "u10",
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/x", sha: "sha10", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha10/status"))
      return JSON.stringify({ state: "success" });
    if (args.includes("repos/o/r/commits/sha10/check-runs")) {
      return JSON.stringify({ total_count: 0, check_runs: [] });
    }
    return "";
  };
  const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
  expect(snap.statuses.get("feat/x")!.checks).toBe("success");
  expect(calls.some((c) => c[0] === "repo" || c[0] === "run")).toBe(false);
});

test("listOpenPrSnapshot: REST check lookup failure maps repo-wide checks to pending", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 11,
          html_url: "u11",
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/pending", sha: "sha11", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha11/status"))
      return JSON.stringify({ state: "success" });
    if (args.includes("repos/o/r/commits/sha11/check-runs")) throw new Error("check-runs failed");
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.prs[0]!.checks).toBe("pending");
    expect(snap.statuses.get("feat/pending")!.checks).toBe("pending");
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: malformed REST status JSON maps that PR to pending", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 15,
          html_url: "u15",
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/bad-status", sha: "sha15", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha15/status")) return "not-json";
    if (args.includes("repos/o/r/commits/sha15/check-runs")) {
      return JSON.stringify({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "success" }],
      });
    }
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.prs[0]!.checks).toBe("pending");
    expect(snap.statuses.get("feat/bad-status")!.checks).toBe("pending");
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: REST check enrichment reuses cached head checks", async () => {
  let checkCalls = 0;
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 16,
          html_url: "u16",
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/cache", sha: "sha16", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha16/status")) {
      checkCalls++;
      return JSON.stringify({ state: "success" });
    }
    if (args.includes("repos/o/r/commits/sha16/check-runs")) {
      checkCalls++;
      return JSON.stringify({ total_count: 0, check_runs: [] });
    }
    return "";
  };
  blockGraphql();
  try {
    const forge = new GithubForge("o/r", {}, run);
    expect((await forge.listOpenPrSnapshot!()).prs[0]!.checks).toBe("success");
    expect((await forge.listOpenPrSnapshot!()).prs[0]!.checks).toBe("success");
    expect(checkCalls).toBe(2);
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: REST check enrichment budget maps overflow PRs to pending", async () => {
  let checkCalls = 0;
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify(
        Array.from({ length: 41 }, (_, i) => ({
          number: i + 1,
          html_url: `u${i + 1}`,
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: `feat/${i + 1}`, sha: `sha${i + 1}`, repo: { owner: { login: "o" } } },
        })),
      );
    }
    if (args.some((arg) => arg.includes("/status"))) {
      checkCalls++;
      return JSON.stringify({ state: "success" });
    }
    if (args.some((arg) => arg.includes("/check-runs"))) {
      checkCalls++;
      return JSON.stringify({ total_count: 0, check_runs: [] });
    }
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.prs.slice(0, 40).every((pr) => pr.checks === "success")).toBe(true);
    expect(snap.prs[40]!.checks).toBe("pending");
    expect(checkCalls).toBe(80);
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: REST ignores combined-status pending sentinel when no legacy statuses exist", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 14,
          html_url: "u14",
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/actions", sha: "sha14", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha14/status")) {
      return JSON.stringify({ state: "pending", statuses: [] });
    }
    if (args.includes("repos/o/r/commits/sha14/check-runs")) {
      return JSON.stringify({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "success" }],
      });
    }
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.prs[0]!.checks).toBe("success");
    expect(snap.statuses.get("feat/actions")!.checks).toBe("success");
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: incomplete REST check-runs pagination maps falsely-green data to pending", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 12,
          html_url: "u12",
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/truncated", sha: "sha12", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha12/status"))
      return JSON.stringify({ state: "success" });
    if (args.includes("repos/o/r/commits/sha12/check-runs")) {
      return JSON.stringify({
        total_count: 201,
        check_runs: Array.from({ length: 100 }, () => ({
          status: "completed",
          conclusion: "success",
        })),
      });
    }
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.prs[0]!.checks).toBe("pending");
    expect(snap.statuses.get("feat/truncated")!.checks).toBe("pending");
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: REST check-runs pagination reads later failure", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 13,
          html_url: "u13",
          title: "feat",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/page2", sha: "sha13", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("repos/o/r/commits/sha13/status"))
      return JSON.stringify({ state: "success" });
    if (args.includes("repos/o/r/commits/sha13/check-runs")) {
      if (args.includes("page=2")) {
        return JSON.stringify({
          total_count: 101,
          check_runs: [{ status: "completed", conclusion: "failure" }],
        });
      }
      return JSON.stringify({
        total_count: 101,
        check_runs: Array.from({ length: 100 }, () => ({
          status: "completed",
          conclusion: "success",
        })),
      });
    }
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.prs[0]!.checks).toBe("failure");
    expect(calls.some((c) => c.includes("page=2"))).toBe(true);
  } finally {
    unblockGraphql();
  }
});

test("listOpenPrSnapshot: REST fallback same-head collision keeps expected owner", async () => {
  const run = async (args: string[]): Promise<string> => {
    if (args.includes("repos/o/r/pulls")) {
      return JSON.stringify([
        {
          number: 20,
          html_url: "u20",
          title: "fork",
          state: "open",
          user: { login: "forker" },
          head: { ref: "feat/shared", sha: "sha20", repo: { owner: { login: "forker" } } },
        },
        {
          number: 10,
          html_url: "u10",
          title: "owned",
          state: "open",
          user: { login: "alice" },
          head: { ref: "feat/shared", sha: "sha10", repo: { owner: { login: "o" } } },
        },
      ]);
    }
    if (args.includes("/status")) return JSON.stringify({ state: "success" });
    if (args.includes("/check-runs")) return JSON.stringify({ total_count: 0, check_runs: [] });
    return "";
  };
  blockGraphql();
  try {
    const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
    expect(snap.statuses.get("feat/shared")!.number).toBe(10);
  } finally {
    unblockGraphql();
  }
});

test("listPullRequests delegates to listOpenPrSnapshot: same output via wrapper", async () => {
  const { run } = fakeRunner({ "pr list": JSON.stringify(SNAPSHOT_NODES) });
  const forge = new GithubForge("o/r", {}, run);
  const prs = await forge.listPullRequests();
  expect(prs).toEqual(EXPECTED_PRS);
});

test("listOpenPrStatuses delegates to listOpenPrSnapshot: same output via wrapper", async () => {
  const { run } = fakeRunner({ "pr list": JSON.stringify(SNAPSHOT_NODES) });
  const forge = new GithubForge("o/r", {}, run);
  const statuses = await forge.listOpenPrStatuses!();
  expect(statuses).toEqual(EXPECTED_STATUSES);
});

test("listOpenPrSnapshot: flags PRs whose head is awaiting workflow approval", async () => {
  const { run, calls } = fakeRunner({
    "pr list": JSON.stringify(SNAPSHOT_NODES),
    // Awaiting-approval run whose headSha matches PR #1's headRefOid (aaa111).
    "run list": JSON.stringify([{ headSha: "aaa111" }]),
  });
  const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
  // The action_required run-list call is actually issued (real wiring, not stubbed).
  const runListCall = calls.find((c) => c[0] === "run" && c[1] === "list");
  expect(runListCall).toBeDefined();
  expect(runListCall).toContain("action_required");
  // The head-SHA match flags PR #1; the non-matching PR #2 stays unflagged.
  const [alpha, beta] = snap.prs;
  expect(alpha!.awaitingWorkflowApproval).toBe(true);
  expect(beta!.awaitingWorkflowApproval).toBeFalsy();
});

test("listOpenPrSnapshot: run-list failure degrades to no-flag without emptying prs/statuses", async () => {
  // The awaiting-approval leg throws; the snapshot must still return full prs +
  // statuses (a rejection here would empty the PRs tab AND break the poller batch).
  const run = async (args: string[]): Promise<string> => {
    if (args[0] === "run" && args[1] === "list") throw new Error("boom");
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(SNAPSHOT_NODES);
    return "";
  };
  const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
  expect(snap.prs.length).toBe(2);
  expect(snap.statuses.size).toBe(2);
  expect(snap.prs.every((p) => !p.awaitingWorkflowApproval)).toBe(true);
});

test("listOpenPrSnapshot: unparseable run-list output degrades to no-flag", async () => {
  const { run } = fakeRunner({
    "pr list": JSON.stringify(SNAPSHOT_NODES),
    "run list": "not json",
  });
  const snap = await new GithubForge("o/r", {}, run).listOpenPrSnapshot!();
  expect(snap.prs.length).toBe(2);
  expect(snap.prs.every((p) => !p.awaitingWorkflowApproval)).toBe(true);
});

test("GithubForge.listOpenPrClosingIssues: GraphQL rate limit returns conservative empty fallback", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "graphql") {
      throw { stderr: "API rate limit exceeded for graphql resource" };
    }
    return "";
  };
  const closed = await new GithubForge("o/r", {}, run).listOpenPrClosingIssues!();
  expect(closed).toEqual([]);
  expect(calls.some((c) => c.includes("repos/o/r/pulls"))).toBe(false);
});

// ── latestFailedRunForPr (retry-ci resolution, #1629) ────────────────────────
test("latestFailedRunForPr: resolves the PR head, prefers the run matching its headSha", async () => {
  const { run, calls } = fakeRunner({
    "pr view": JSON.stringify({ headRefName: "feat/x", headRefOid: "sha-head" }),
    "run list": JSON.stringify([
      { databaseId: 10, headSha: "sha-old", createdAt: "2024-01-03T00:00:00Z" },
      { databaseId: 11, headSha: "sha-head", createdAt: "2024-01-02T00:00:00Z" },
    ]),
  });
  const runId = await new GithubForge("o/r", {}, run).latestFailedRunForPr!(42);
  expect(runId).toBe(11); // matches PR headSha even though run 10 is newer
  // lists failed runs on the resolved head branch
  const listCall = calls.find((c) => c[0] === "run" && c[1] === "list")!;
  expect(listCall).toContain("--branch");
  expect(listCall).toContain("feat/x");
  expect(listCall).toContain("--status");
  expect(listCall).toContain("failure");
});

test("latestFailedRunForPr: no headSha match → newest failed run on the branch", async () => {
  const { run } = fakeRunner({
    "pr view": JSON.stringify({ headRefName: "feat/x", headRefOid: "sha-head" }),
    "run list": JSON.stringify([
      { databaseId: 10, headSha: "sha-a", createdAt: "2024-01-03T00:00:00Z" },
      { databaseId: 11, headSha: "sha-b", createdAt: "2024-01-02T00:00:00Z" },
    ]),
  });
  expect(await new GithubForge("o/r", {}, run).latestFailedRunForPr!(42)).toBe(10);
});

test("latestFailedRunForPr: no failed runs → null", async () => {
  const { run } = fakeRunner({
    "pr view": JSON.stringify({ headRefName: "feat/x", headRefOid: "sha-head" }),
    "run list": "[]",
  });
  expect(await new GithubForge("o/r", {}, run).latestFailedRunForPr!(42)).toBeNull();
});

test("latestFailedRunForPr: unresolvable PR (no head ref) → null", async () => {
  const { run } = fakeRunner({ "pr view": "{}" });
  expect(await new GithubForge("o/r", {}, run).latestFailedRunForPr!(42)).toBeNull();
});

test("GithubForge.listPullRequests: maps mergeStateStatus so the PRs-tab conflict chip can read DIRTY", async () => {
  // A conflicting DRAFT: GitHub reports mergeStateStatus DIRTY (DRAFT masks BEHIND, not DIRTY)
  // while `mergeable` may still be UNKNOWN. The chip keys off `dirty` for exactly this case, so
  // the field has to survive the PullRequest mapper — not just the PrStatus one.
  const prsJson = JSON.stringify([
    {
      number: 11,
      title: "wip: thing",
      url: "https://github.com/o/r/pull/11",
      author: { login: "alice" },
      createdAt: "2024-02-02T00:00:00Z",
      isDraft: true,
      mergeable: "UNKNOWN",
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [],
      reviews: [],
    },
  ]);
  const { run } = fakeRunner({ "pr list": prsJson });
  const forge = new GithubForge("o/r", {}, run);
  const prs = await forge.listPullRequests();
  expect(prs[0]!.mergeStateStatus).toBe("dirty");
  expect(prs[0]!.mergeable).toBeNull();
});
