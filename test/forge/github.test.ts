import { test, expect } from "bun:test";
import { GithubForge } from "../../src/forge/github";

// A recording fake `gh` runner. Returns canned stdout keyed by the subcommand.
function fakeRunner(responses: Record<string, string>) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    const key = `${args[0]} ${args[1] ?? ""}`.trim();
    if (key in responses) return responses[key]!;
    return "";
  };
  return { run, calls };
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
  },
]);

test("GithubForge.listIssues: parses gh issue list output", async () => {
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
    },
  ]);
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

test("GithubForge.prStatus: no PR → state none", async () => {
  const { run } = fakeRunner({ "pr list": "[]" });
  const forge = new GithubForge("o/r", { deployWorkflow: "x.yml" }, run);
  const st = await forge.prStatus("feature");
  expect(st.state).toBe("none");
  expect(st.checks).toBe("none");
  expect(st.deployConfigured).toBe(true);
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

test("GithubForge.kind + slug", () => {
  const forge = new GithubForge("o/r", {}, () => "");
  expect(forge.kind).toBe("github");
  expect(forge.slug).toBe("o/r");
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
  const run = (args: string[]): string => {
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
  const run = (args: string[]): string => {
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
  const run = (args: string[]): string => {
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
  const run = (args: string[]): string => {
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
