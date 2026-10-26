import type { HeldTask, HoldReason, Session, SessionUsageSnapshot } from "../../src/types";
import type { UpNextSnapshot } from "../../src/up-next-core";
import type { UpNextPr } from "../../src/up-next-prs";
import type { SessionUsageDto } from "../../src/server";

export const issueRef = {
  number: 42,
  url: "https://github.com/example/repo/issues/42",
  title: "Queue parity",
  body: "Implement the queue.",
};
export function held(
  repoPath: string,
  id = "held-fixture",
  reason: HeldTask["reason"] = "usage",
  createdAt = 1800000000000,
): HeldTask {
  return {
    id,
    repoPath,
    input: { repoPath, baseBranch: "main", prompt: "Queue parity", model: null, images: [] },
    createdAt,
    reason,
  };
}
/** A waiting PR whose next action is a fix: conflicts and a red job, every optional field set. */
export function waitingPr(repoPath: string): UpNextPr {
  return {
    repoPath,
    repoSlug: "example/repo",
    repoLabel: "repo",
    number: 77,
    title: "Native parity",
    url: "https://github.com/example/repo/pull/77",
    author: "operator",
    kind: "regular",
    createdAt: 1799999999000,
    checks: "failure",
    mergeable: false,
    mergeStateStatus: "dirty",
    latestReview: { state: "commented", author: "reviewer", submittedAt: 1799999999500 },
    awaitingWorkflowApproval: false,
    baseRefName: "main",
    mergeMethod: "squash",
    closesIssue: issueRef.number,
    band: "blocked",
    action: "fix",
    blockReason: "conflict",
    headRefName: "feat/native-parity",
    headSha: "abc123",
    jobs: [
      { name: "test", state: "failure", url: "https://github.com/example/repo/actions/1" },
      { name: "lint", state: "success", startedAt: 1799999999100, completedAt: 1799999999200 },
    ],
  };
}
/** A CI-running Dependabot row: action null, no optional fields. */
export const pendingDependabotPr: UpNextPr = {
  repoPath: "/repo",
  repoSlug: null,
  repoLabel: "repo",
  number: 78,
  title: "chore(deps): bump",
  url: "https://github.com/example/repo/pull/78",
  author: "app/dependabot",
  kind: "dependabot",
  createdAt: 1799999998000,
  checks: "pending",
  mergeable: null,
  band: "dependabot",
  action: null,
};
export const snapshot: UpNextSnapshot = {
  generatedAt: 1800000000000,
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  sections: [
    {
      kind: "priority",
      repoPath: null,
      repoSlug: null,
      repoLabel: null,
      totalCount: 1,
      items: [
        {
          repoPath: "/repo",
          repoSlug: "example/repo",
          repoLabel: "repo",
          number: issueRef.number,
          title: issueRef.title,
          url: issueRef.url,
          kind: "epic",
          priority: true,
          createdAt: 1799999999999,
          labels: ["priority"],
          labelColors: { priority: "ff0000" },
          epicParent: { number: 10, title: "Native" },
          issueRef: { number: issueRef.number, url: issueRef.url, title: issueRef.title },
          fromFork: true,
          mine: true,
        },
      ],
    },
  ],
  filter: {
    hiddenCount: 3,
    hiddenBy: { scope: 1, forks: 1, labels: 1, repo: 0 },
    hiddenByRepo: { "/repo": 3 },
    optionCounts: {
      scope: { all: 3, mine_unassigned: 1, mine: 1 },
      forks: { all: 2, own: 1, hide: 0 },
    },
  },
  pullRequests: [waitingPr("/repo"), pendingDependabotPr],
};
export const hold: HoldReason = { code: "halted-error" };
export const halted: Pick<Session, "id" | "haltReason" | "haltedAt"> = {
  id: "fixture",
  haltReason: "usage_limit",
  haltedAt: 1800000000000,
};
export const noUsage: SessionUsageDto = {
  available: false,
  source: "none",
  total: 0,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  messageCount: null,
  byModel: null,
};
export function usageSnapshot(session: Session): SessionUsageSnapshot {
  return {
    sessionId: session.id,
    desig: session.desig,
    name: session.name,
    repoPath: session.repoPath,
    model: "claude",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    weightedUnits: 0,
    cacheReadUnits: 0,
    messageCount: 0,
    byModel: {},
    rawByModel: {},
    createdAt: session.createdAt,
    archivedAt: 1800000000000,
    snapshotAt: 1800000000000,
  };
}
