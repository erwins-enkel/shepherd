import { describe, it, expect } from "vitest";
import { deriveIntegratedEpicStatus } from "./integrated-epic-status";
import type { CompletedEpic, CompletedEpicChild } from "./types";

function child(number: number, integrated: boolean): CompletedEpicChild {
  return {
    number,
    title: `#${number}`,
    url: `https://example.test/issues/${number}`,
    prNumber: integrated ? number + 100 : null,
    prUrl: integrated ? `https://example.test/pull/${number + 100}` : null,
    mergedAt: integrated ? 1_700_000_000_000 : null,
    integrated,
  };
}

const someMerged = [child(1, true), child(2, true), child(3, false)]; // merged = 2
const noneMerged = [child(1, false), child(2, false)]; // merged = 0

function landing(over: Partial<CompletedEpic> = {}): CompletedEpic {
  return {
    repoPath: "/repo",
    parentIssueNumber: 7,
    parentTitle: "Epic",
    completedAt: 1,
    children: someMerged,
    landingState: "open",
    landingPrNumber: 42,
    landingPrUrl: "https://example.test/pull/42",
    migrationPaths: [],
    migrationsAckedAt: null,
    landingConflictReworkCount: 0,
    ...over,
  };
}

describe("deriveIntegratedEpicStatus", () => {
  it.each([
    [{ landingState: "pending" }, "preparing", "nothing-to-do", 2],
    [{ landingChecks: "pending", landingMergeable: true }, "checking", "nothing-to-do", 2],
    [{ landingChecks: "success", landingMergeable: null }, "checking", "nothing-to-do", 2],
    [{ landingRepairing: true, landingMergeable: false }, "repairing", "nothing-to-do", 2],
    [{ landingChecks: "failure", landingMergeable: true }, "ci-failed", "your-turn", 1],
    [{ landingMergeable: false }, "conflicts", "your-turn", 1],
    [{ landingState: "none" }, "nothing-to-land", "your-turn", 1],
    [{ landingReady: true }, "ready", "ready", 0],
    [{ landingState: "merged" }, "landed", "done", 3],
    [{ landingState: "error" }, "error", "your-turn", 1],
    [
      { landingChecks: "success", landingMergeable: true, landingReady: false },
      "not-ready",
      "your-turn",
      1,
    ],
  ] as const)("derives %j as %s", (over, situation, turn, sortOrder) => {
    expect(deriveIntegratedEpicStatus(landing(over))).toMatchObject({ situation, turn, sortOrder });
  });

  it("only confirms a currently ready landing with a PR number", () => {
    expect(deriveIntegratedEpicStatus(landing({ landingReady: true }), true).situation).toBe(
      "confirming",
    );
    expect(
      deriveIntegratedEpicStatus(landing({ landingReady: true, landingPrNumber: null }), true)
        .canLand,
    ).toBe(false);
    expect(deriveIntegratedEpicStatus(landing({ landingChecks: "failure" }), true).situation).toBe(
      "ci-failed",
    );
  });

  it("live repair outranks conflicts and failing CI, and does not ask the operator", () => {
    expect(
      deriveIntegratedEpicStatus(
        landing({ landingRepairing: true, landingMergeable: false, landingChecks: "failure" }),
      ),
    ).toMatchObject({
      situation: "repairing",
      repairKind: "conflicts",
      needsOperator: false,
      canLand: false,
      canResolveConflicts: false,
    });
    expect(
      deriveIntegratedEpicStatus(landing({ landingRepairing: true, landingChecks: "failure" }))
        .repairKind,
    ).toBe("ci");
  });

  it.each(["cap", "conflict", "driver"] as const)(
    "a %s pause outranks pending CI and unknown mergeability",
    (landingRebasePauseReason) => {
      const status = deriveIntegratedEpicStatus(
        landing({ landingRebasePauseReason, landingChecks: "pending", landingMergeable: null }),
      );
      expect(status.situation).toBe("conflicts");
      expect(status.canResolveConflicts).toBe(landingRebasePauseReason === "conflict");
    },
  );

  it("conflicts outrank CI failure, which outranks unknown mergeability", () => {
    expect(
      deriveIntegratedEpicStatus(landing({ landingMergeable: false, landingChecks: "failure" }))
        .situation,
    ).toBe("conflicts");
    expect(
      deriveIntegratedEpicStatus(landing({ landingMergeable: null, landingChecks: "failure" }))
        .situation,
    ).toBe("ci-failed");
  });

  it("missing signals never authorize landing, but the server can clear a no-CI repo", () => {
    expect(deriveIntegratedEpicStatus(landing())).toMatchObject({
      situation: "checking",
      canLand: false,
      needsOperator: false,
    });
    expect(
      deriveIntegratedEpicStatus(landing({ landingChecks: "none", landingReady: true })),
    ).toMatchObject({ situation: "ready", canLand: true, tone: "ready" });
  });

  it.each([{ children: someMerged }, { children: noneMerged }, { children: [] }])(
    "none stays actionable regardless of included children",
    ({ children }) => {
      expect(deriveIntegratedEpicStatus(landing({ landingState: "none", children }))).toMatchObject(
        { situation: "nothing-to-land", needsOperator: true, canLand: false },
      );
    },
  );

  it("landed stays slate even with stale ready signals", () => {
    expect(
      deriveIntegratedEpicStatus(landing({ landingState: "merged", landingReady: true })),
    ).toMatchObject({ tone: "quiet", canLand: false, needsOperator: false });
  });
});
