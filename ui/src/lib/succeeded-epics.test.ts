import { describe, expect, it } from "vitest";
import type { CompletedEpic } from "#lib/types.js";
import {
  epicIssueHref,
  isSucceededEpic,
  succeededEpicsOf,
  successTime,
} from "#lib/succeeded-epics.js";

const epic = (n: number, over: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: "/repos/sevdesk-mcp",
  parentIssueNumber: n,
  parentTitle: `Epic ${n}`,
  completedAt: 1_000 + n,
  children: [
    {
      number: 3,
      title: "docs",
      url: "https://github.com/o/sevdesk-mcp/issues/3",
      prNumber: 25,
      prUrl: "https://github.com/o/sevdesk-mcp/pull/25",
      mergedAt: 900,
      integrated: true,
    },
  ],
  landingPrNumber: null,
  landingPrUrl: null,
  landingState: "pending",
  migrationPaths: [],
  migrationsAckedAt: null,
  landingConflictReworkCount: 0,
  ...over,
});

describe("succeeded epics (#3838)", () => {
  it("counts only a merged landing or a finished incremental epic as success", () => {
    expect(isSucceededEpic(epic(1, { outcome: "landed" }))).toBe(true);
    expect(isSucceededEpic(epic(1, { outcome: "incremental" }))).toBe(true);
    expect(isSucceededEpic(epic(1, { outcome: "closed-unlanded" }))).toBe(false);
    expect(isSucceededEpic(epic(1, { outcome: null, landingState: "open" }))).toBe(false);
    // Integrated children with the landing still pending are no success, whatever the state says.
    expect(isSucceededEpic(epic(1, { landingState: "merged" }))).toBe(false);
  });

  it("keeps the successes, newest success first", () => {
    const list = [
      epic(1, { outcome: "landed", succeededAt: 5_000 }),
      epic(2, { landingState: "open" }),
      epic(3, { outcome: "incremental", succeededAt: 9_000 }),
      epic(4, { outcome: "landed" }),
    ];
    expect(succeededEpicsOf(list).map((e) => e.parentIssueNumber)).toEqual([3, 1, 4]);
    expect(successTime(epic(4))).toBe(1_004);
  });

  it("derives the epic issue's URL from a child issue", () => {
    expect(epicIssueHref(epic(23))).toBe("https://github.com/o/sevdesk-mcp/issues/23");
    expect(epicIssueHref(epic(23, { children: [] }))).toBeNull();
  });
});
