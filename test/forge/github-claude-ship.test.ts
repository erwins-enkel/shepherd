import { afterEach, expect, test } from "bun:test";
import { GithubForge } from "../../src/forge/github";
import { graphRateLimit } from "../../src/forge/rate-limit";

afterEach(() => graphRateLimit.noteSuccess());

const ci = {
  __typename: "CheckRun",
  name: "test",
  workflowName: "CI",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};
const app = (name: string, status: string, conclusion: string) => ({
  __typename: "CheckRun",
  name,
  workflowName: "",
  status,
  conclusion,
});

/** One open PR row as `gh pr list --json` prints it. */
const row = (rollup: unknown[], labels: Array<{ name: string }> = []) => ({
  number: 9,
  url: "https://github.com/o/r/pull/9",
  title: "feat",
  state: "OPEN",
  author: { login: "operator" },
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  statusCheckRollup: rollup,
  headRefOid: "sha9",
  baseRefName: "main",
  reviews: [],
  reviewRequests: [],
  labels,
});

const statusOf = (pr: unknown) =>
  new GithubForge("o/r", {}, async () => JSON.stringify([pr])).prStatus("feature");

test("a failing Claude Approvals check is not CI: checks stay green, signal carries it", async () => {
  const st = await statusOf(
    row(
      [ci, app("Claude Approvals", "COMPLETED", "FAILURE")],
      [{ name: "claude-pr-steward-watching" }],
    ),
  );
  expect(st.checks).toBe("success");
  expect(st.jobs?.map((j) => j.name)).toEqual(["CI / test"]);
  expect(st.claudeShip).toEqual({ stewardWatching: true, approvals: "failure" });
});

test("a running Claude Code Review is not a running CI check", async () => {
  const st = await statusOf(row([ci, app("Claude Code Review", "IN_PROGRESS", "")]));
  expect(st.checks).toBe("success");
  expect(st.runningChecks).toBeUndefined();
  expect(st.claudeShip).toEqual({ stewardWatching: false, codeReview: "pending" });
});

test("a failing Actions job named Claude Code Review stays CI red", async () => {
  const job = { ...app("Claude Code Review", "COMPLETED", "FAILURE"), workflowName: "Review" };
  const st = await statusOf(row([ci, job]));
  expect(st.checks).toBe("failure");
  expect(st).not.toHaveProperty("claudeShip");
});

test("a PR without Claude Ship signs carries no claudeShip key", async () => {
  const st = await statusOf(row([ci], [{ name: "bug" }]));
  expect(st.checks).toBe("success");
  expect(st).not.toHaveProperty("claudeShip");
});

test("the single-PR read requests labels", async () => {
  const calls: string[][] = [];
  const forge = new GithubForge("o/r", {}, async (args) => {
    calls.push(args);
    return "[]";
  });
  await forge.prStatus("feature");
  const fields = calls[0]![calls[0]!.indexOf("--json") + 1]!;
  expect(fields.split(",")).toContain("labels");
});

/** REST rate-limit fallback: one open PR on sha9 whose check runs are `runs`. */
function restForge(runs: unknown[]) {
  return new GithubForge("o/r", {}, async (args) => {
    if (args[0] === "pr" && args[1] === "list")
      throw { stderr: "API rate limit exceeded for graphql resource" };
    if (args.includes("repos/o/r/pulls"))
      return JSON.stringify([
        {
          number: 9,
          state: "open",
          mergeable: true,
          mergeable_state: "blocked",
          head: { ref: "feature", sha: "sha9", repo: { owner: { login: "o" } } },
          base: { ref: "main" },
        },
      ]);
    if (args.includes("repos/o/r/commits/sha9/status")) return JSON.stringify({ statuses: [] });
    if (args.includes("repos/o/r/commits/sha9/check-runs"))
      return JSON.stringify({ total_count: runs.length, check_runs: runs });
    return "";
  });
}

const restRun = (name: string, conclusion: string | null, slug: string) => ({
  name,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  app: { slug },
});

test("REST fallback: a holding Approvals check reads pending, never failure", async () => {
  const st = await restForge([
    restRun("test", "success", "github-actions"),
    restRun("Claude Approvals", "failure", "claude"),
  ]).prStatus("feature");
  expect(st.checks).toBe("pending");
});

test("REST fallback: Code Review and a cleared Approvals check leave CI alone", async () => {
  const st = await restForge([
    restRun("test", "success", "github-actions"),
    restRun("Claude Code Review", "failure", "claude"),
    restRun("Claude Approvals", "neutral", "claude"),
  ]).prStatus("feature");
  expect(st.checks).toBe("success");
});

test("REST fallback: a same-named Actions job stays CI red", async () => {
  const st = await restForge([restRun("Claude Code Review", "failure", "github-actions")]).prStatus(
    "feature",
  );
  expect(st.checks).toBe("failure");
});
