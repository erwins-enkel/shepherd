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

const ISSUES_JSON = JSON.stringify([
  { number: 1, title: "Fix crash", body: "boom", url: "u1", labels: [{ name: "bug" }] },
]);

test("GithubForge.listIssues: parses gh issue list output", async () => {
  const { run } = fakeRunner({ "issue list": ISSUES_JSON });
  const forge = new GithubForge("o/r", { deployWorkflow: "deploy.yml" }, run);
  const issues = await forge.listIssues();
  expect(issues).toEqual([
    { number: 1, title: "Fix crash", body: "boom", url: "u1", labels: ["bug"] },
  ]);
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
