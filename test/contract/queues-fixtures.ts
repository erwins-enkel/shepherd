import type { HeldTask, HoldReason, Session, SessionUsageSnapshot } from "../../src/types";
import type { UpNextSnapshot } from "../../src/up-next-core";
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
          issueRef,
        },
      ],
    },
  ],
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
