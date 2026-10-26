import { describe, expect, test } from "bun:test";
import type { PullRequest } from "../src/forge/types";
import { DEFAULT_ISSUE_FILTER, type IssueFilterSettings } from "../src/issue-filter";
import {
  buildUpNextPrs,
  classifyUpNextPr,
  prFixPrompt,
  prsHeldBySessions,
  type UpNextPr,
  type UpNextPrContext,
  type UpNextPrRepo,
} from "../src/up-next-prs";

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `pr${number}`,
    url: `https://x/pull/${number}`,
    author: "me",
    kind: "regular",
    createdAt: number,
    isDraft: false,
    mergeable: true,
    mergeStateStatus: "clean",
    checks: "success",
    jobs: [],
    baseRefName: "main",
    headRefName: `b${number}`,
    headSha: `sha${number}`,
    ...over,
  };
}

const CTX: UpNextPrContext = { viewer: "me", noCi: false };
const DEP = { author: "app/dependabot", kind: "dependabot" as const };
const classify = (over: Partial<PullRequest>, ctx = CTX) => classifyUpNextPr(pr(1, over), ctx);

describe("classifyUpNextPr", () => {
  test("own PR, green and mergeable → ready / merge", () => {
    expect(classify({})).toEqual({ band: "ready", action: "merge" });
  });
  test("own PR while CI runs or mergeability is unknown → ready / null", () => {
    expect(classify({ checks: "pending" })).toEqual({ band: "ready", action: null });
    expect(classify({ mergeable: null, mergeStateStatus: "unknown" })).toEqual({
      band: "ready",
      action: null,
    });
  });
  test("checks none: green only in a repo without CI", () => {
    expect(classify({ checks: "none" }, { viewer: "me", noCi: true })).toEqual({
      band: "ready",
      action: "merge",
    });
    expect(classify({ checks: "none" })).toEqual({ band: "ready", action: null });
  });
  test("foreign PR without a review, or only commented → review / review", () => {
    expect(classify({ author: "other" })).toEqual({ band: "review", action: "review" });
    const commented = { state: "commented" as const, author: "me", submittedAt: 1 };
    expect(classify({ author: "other", latestReview: commented })).toEqual({
      band: "review",
      action: "review",
    });
  });
  test("foreign PR without a review while CI runs → review / null", () => {
    expect(classify({ author: "other", checks: "pending" })).toEqual({
      band: "review",
      action: null,
    });
  });
  test("foreign PR the branch protection blocks for a missing review still asks for one", () => {
    expect(classify({ author: "other", mergeStateStatus: "blocked" })).toEqual({
      band: "review",
      action: "review",
    });
  });
  test("approved foreign PR → ready / merge", () => {
    const approved = { state: "approved" as const, author: "me", submittedAt: 1 };
    expect(classify({ author: "other", latestReview: approved })).toEqual({
      band: "ready",
      action: "merge",
    });
  });
  test("changes requested waits on the author → excluded", () => {
    const changes = { state: "changes_requested" as const, author: "x", submittedAt: 1 };
    expect(classify({ author: "other", latestReview: changes })).toBeNull();
    expect(classify({ latestReview: changes })).toBeNull();
  });
  test("green and mergeable but blocked by a required review from someone else → excluded", () => {
    expect(classify({ mergeStateStatus: "blocked" })).toBeNull();
    const approved = { state: "approved" as const, author: "me", submittedAt: 1 };
    expect(
      classify({ author: "other", latestReview: approved, mergeStateStatus: "blocked" }),
    ).toBeNull();
  });
  test("blocked while CI runs stays in its band, disabled", () => {
    expect(classify({ mergeStateStatus: "blocked", checks: "pending" })).toEqual({
      band: "ready",
      action: null,
    });
  });
  test("workflow awaiting approval → blocked / approve_on_forge, before every other fact", () => {
    const want = {
      band: "blocked",
      action: "approve_on_forge",
      blockReason: "workflow_approval",
    } as const;
    expect(classify({ awaitingWorkflowApproval: true, checks: "none" })).toEqual(want);
    expect(classify({ awaitingWorkflowApproval: true, mergeStateStatus: "dirty" })).toEqual(want);
    expect(classify({ ...DEP, awaitingWorkflowApproval: true })).toEqual(want);
  });
  test("conflicts → blocked / fix / conflict, ahead of red CI", () => {
    const want = { band: "blocked", action: "fix", blockReason: "conflict" } as const;
    expect(classify({ mergeStateStatus: "dirty" })).toEqual(want);
    expect(classify({ mergeable: false, mergeStateStatus: undefined })).toEqual(want);
    expect(classify({ mergeStateStatus: "dirty", checks: "failure" })).toEqual(want);
  });
  test("red CI → blocked / fix / ci_failed, ahead of behind", () => {
    const want = { band: "blocked", action: "fix", blockReason: "ci_failed" } as const;
    expect(classify({ checks: "failure" })).toEqual(want);
    expect(classify({ checks: "failure", mergeStateStatus: "behind" })).toEqual(want);
    expect(classify({ checks: "failure", author: "other" })).toEqual(want);
  });
  test("behind its base → blocked / fix / behind", () => {
    expect(classify({ mergeStateStatus: "behind" })).toEqual({
      band: "blocked",
      action: "fix",
      blockReason: "behind",
    });
  });
  test("Dependabot: green → merge, CI running → null", () => {
    expect(classify(DEP)).toEqual({ band: "dependabot", action: "merge" });
    expect(classify({ ...DEP, checks: "pending" })).toEqual({ band: "dependabot", action: null });
  });
  test("Dependabot with conflicts or behind → dependabot / dependabot_rebase", () => {
    expect(classify({ ...DEP, mergeStateStatus: "dirty" })).toEqual({
      band: "dependabot",
      action: "dependabot_rebase",
      blockReason: "conflict",
    });
    expect(classify({ ...DEP, mergeStateStatus: "behind", checks: "failure" })).toEqual({
      band: "dependabot",
      action: "dependabot_rebase",
      blockReason: "behind",
    });
  });
  test("Dependabot with red CI → blocked / fix", () => {
    expect(classify({ ...DEP, checks: "failure" })).toEqual({
      band: "blocked",
      action: "fix",
      blockReason: "ci_failed",
    });
  });
  test("drafts and release PRs are never listed", () => {
    expect(classify({ isDraft: true })).toBeNull();
    expect(classify({ kind: "release", author: "app/github-actions" })).toBeNull();
  });
  test("an unknown viewer reads every PR as the operator's own", () => {
    expect(classify({ author: "other" }, { viewer: null, noCi: false })).toEqual({
      band: "ready",
      action: "merge",
    });
  });
});

function repo(over: Partial<UpNextPrRepo> = {}): UpNextPrRepo {
  return {
    repoPath: "/r/a",
    repoSlug: "o/a",
    repoLabel: "a",
    viewer: "me",
    isFork: false,
    openPrs: [],
    ...over,
  };
}

const NONE = () => undefined;
const build = (
  repos: UpNextPrRepo[],
  filter: Partial<IssueFilterSettings> = {},
  inFlight: Parameters<typeof buildUpNextPrs>[2] = NONE,
) => buildUpNextPrs(repos, { ...DEFAULT_ISSUE_FILTER, ...filter }, inFlight);
const numbers = (prs: UpNextPr[]) => prs.map((p) => p.number);

describe("buildUpNextPrs", () => {
  test("maps the PR row and its repo into the wire shape", () => {
    const job = { name: "test", state: "success" as const, url: "https://x/job" };
    const review = { state: "approved" as const, author: "x", submittedAt: 5 };
    const [row] = build([
      repo({
        openPrs: [
          pr(7, {
            author: "other",
            latestReview: review,
            mergeMethod: "squash",
            jobs: [job],
          }),
        ],
        closingIssueByPr: { 7: 3 },
      }),
    ]);
    expect(row).toEqual({
      repoPath: "/r/a",
      repoSlug: "o/a",
      repoLabel: "a",
      number: 7,
      title: "pr7",
      url: "https://x/pull/7",
      author: "other",
      kind: "regular",
      createdAt: 7,
      checks: "success",
      mergeable: true,
      mergeStateStatus: "clean",
      latestReview: review,
      baseRefName: "main",
      mergeMethod: "squash",
      closesIssue: 3,
      band: "ready",
      action: "merge",
      headRefName: "b7",
      headSha: "sha7",
      jobs: [job],
    });
  });
  test("orders by band, actionable before CI-running, then newest first", () => {
    const rows = build([
      repo({
        openPrs: [
          pr(1, { ...DEP }),
          pr(2, { checks: "failure" }),
          pr(3, { author: "other" }),
          pr(4, { checks: "pending" }),
          pr(5),
          pr(6),
        ],
      }),
    ]);
    expect(numbers(rows)).toEqual([6, 5, 4, 3, 2, 1]);
    const withPending = build([repo({ openPrs: [pr(8, { checks: "pending" }), pr(5)] })]);
    expect(numbers(withPending)).toEqual([5, 8]);
  });
  test("reads noCi per repo", () => {
    const rows = build([repo({ openPrs: [pr(1, { checks: "none" })], noCi: true })]);
    expect(rows[0]!.action).toBe("merge");
  });
  test("drops PRs a live session holds — by head branch or PR number, in that repo only", () => {
    const inFlight = (path: string) =>
      path === "/r/a" ? { heads: new Set(["b1"]), numbers: new Set([2]) } : undefined;
    const rows = build(
      [
        repo({ openPrs: [pr(1), pr(2), pr(3)] }),
        repo({ repoPath: "/r/b", openPrs: [pr(1), pr(2)] }),
      ],
      {},
      inFlight,
    );
    expect(rows.map((r) => `${r.repoPath}#${r.number}`).sort()).toEqual([
      "/r/a#3",
      "/r/b#1",
      "/r/b#2",
    ]);
  });
  test("scope `mine` keeps own and Dependabot PRs and hides foreign ones", () => {
    const openPrs = [pr(1), pr(2, { author: "other" }), pr(3, { ...DEP })];
    expect(numbers(build([repo({ openPrs })], { scope: "mine" })).sort()).toEqual([1, 3]);
    expect(numbers(build([repo({ openPrs })])).sort()).toEqual([1, 2, 3]);
  });
  test("forks: `hide` drops a fork repo, `own` keeps own and Dependabot PRs there", () => {
    const openPrs = [pr(1), pr(2, { author: "other" }), pr(3, { ...DEP })];
    const fork = repo({ isFork: true, openPrs });
    expect(build([fork], { forks: "hide" })).toEqual([]);
    expect(numbers(build([fork], { forks: "own" })).sort()).toEqual([1, 3]);
  });
  test("a repo override replaces scope and forks for that repo", () => {
    const openPrs = [pr(1), pr(2, { author: "other" })];
    const rows = build([repo({ openPrs }), repo({ repoPath: "/r/b", openPrs })], {
      repoOverrides: { "/r/a": "hide", "/r/b": "mine" },
    });
    expect(rows.map((r) => `${r.repoPath}#${r.number}`)).toEqual(["/r/b#1"]);
  });
  test("hidden labels never hide a PR", () => {
    expect(build([repo({ openPrs: [pr(1)] })], { hiddenLabels: ["bug"] })).toHaveLength(1);
  });
  test("a repo without PR input contributes nothing", () => {
    expect(build([repo({ openPrs: undefined })])).toEqual([]);
  });
});

describe("prFixPrompt", () => {
  const row = (over: Partial<PullRequest>) =>
    build([repo({ openPrs: [pr(9, { title: "Fix it", ...over })] })])[0]!;

  test("conflicts: rebase onto the base, force-with-lease push to the head, no new PR", () => {
    const text = prFixPrompt(row({ mergeStateStatus: "dirty" }), "main");
    expect(text).toContain('#9 ("Fix it")');
    expect(text).toContain("https://x/pull/9");
    expect(text).toContain("merge conflicts with `main`");
    expect(text).toContain("git fetch origin main && git rebase origin/main");
    expect(text).toContain("git push --force-with-lease origin HEAD:b9");
    expect(text).toContain("Do NOT open a new pull request");
  });
  test("behind: rebase and force-with-lease push", () => {
    const text = prFixPrompt(row({ mergeStateStatus: "behind" }), "main");
    expect(text).toContain("behind `main`");
    expect(text).toContain("git push --force-with-lease origin HEAD:b9");
  });
  test("red CI: names the red jobs and pushes plainly", () => {
    const jobs = [
      { name: "lint", state: "failure" as const, url: "https://x/lint" },
      { name: "test", state: "success" as const },
      { name: "e2e", state: "failure" as const },
    ];
    const text = prFixPrompt(row({ checks: "failure", jobs }), "main");
    expect(text).toContain("- lint (https://x/lint)\n- e2e");
    expect(text).not.toContain("- test");
    expect(text).toContain("git push origin HEAD:b9");
    expect(text).not.toContain("git rebase");
  });
  test("conflict and red CI together name both and push with lease", () => {
    const text = prFixPrompt(row({ mergeStateStatus: "dirty", checks: "failure" }), "dev");
    expect(text).toContain("merge conflicts with `dev`");
    expect(text).toContain("CI is red");
    expect(text).toContain("git push --force-with-lease origin HEAD:b9");
  });
  test("a steer leads as the operator's instruction", () => {
    const text = prFixPrompt(row({ checks: "failure" }), "main", "  Write a test first.  ");
    expect(text.startsWith("Operator instruction:\nWrite a test first.\n\n")).toBe(true);
  });
});

describe("prsHeldBySessions", () => {
  const session = (over: Partial<Parameters<typeof prsHeldBySessions>[0][number]>) => ({
    repoPath: "/r/a",
    branch: null,
    baseBranch: "main",
    landingRepair: false,
    mergeTrainPrs: null,
    ...over,
  });

  test("collects each repo's session branches, fix-session bases and train PRs", () => {
    const held = prsHeldBySessions([
      session({ branch: "feat/x" }),
      session({ branch: "shepherd/fix-1", baseBranch: "feat/y", landingRepair: true }),
      session({ branch: "shepherd/train", mergeTrainPrs: [4, 5] }),
      session({ repoPath: "/r/b", branch: "feat/z" }),
    ]);
    expect([...held.get("/r/a")!.heads].sort()).toEqual([
      "feat/x",
      "feat/y",
      "shepherd/fix-1",
      "shepherd/train",
    ]);
    expect([...held.get("/r/a")!.numbers]).toEqual([4, 5]);
    expect([...held.get("/r/b")!.heads]).toEqual(["feat/z"]);
  });

  test("a plain session's base branch does not hold a PR", () => {
    const held = prsHeldBySessions([session({ branch: "shepherd/a", baseBranch: "feat/y" })]);
    expect(held.get("/r/a")!.heads.has("feat/y")).toBe(false);
  });
});
