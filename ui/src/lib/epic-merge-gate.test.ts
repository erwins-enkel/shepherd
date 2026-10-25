import { describe, it, expect } from "vitest";
import type { EpicChild, EpicRun, GitState } from "#lib/types.js";
import { awaitingMerge, incrementalStallRisk, mergeOff } from "./epic-merge-gate";

describe("mergeOff", () => {
  it("is false only when autopilot and auto-merge are on and draftMode is off", () => {
    expect(mergeOff({ autoMerge: true, autopilot: true, draftMode: false })).toBe(false);
    expect(mergeOff({ autoMerge: false, autopilot: true, draftMode: false })).toBe(true);
    expect(mergeOff({ autoMerge: true, autopilot: false, draftMode: false })).toBe(true);
    expect(mergeOff({ autoMerge: true, autopilot: true, draftMode: true })).toBe(true);
  });
});

describe("incrementalStallRisk", () => {
  const risky = { landing: "incremental" as const, hasEdges: true, mergeOff: true, stacks: false };
  it("warns for incremental + edges + nobody merging + no stacks", () => {
    expect(incrementalStallRisk(risky)).toBe(true);
  });
  it("stays quiet when any condition is missing", () => {
    expect(incrementalStallRisk({ ...risky, landing: "integration" })).toBe(false);
    expect(incrementalStallRisk({ ...risky, hasEdges: false })).toBe(false);
    expect(incrementalStallRisk({ ...risky, mergeOff: false })).toBe(false);
    expect(incrementalStallRisk({ ...risky, stacks: true })).toBe(false);
  });
});

function child(
  number: number,
  state: EpicChild["state"],
  blockedBy: number[] = [],
  pr: number | null = null,
): EpicChild {
  return {
    number,
    title: `c${number}`,
    url: "",
    order: number,
    body: "",
    blockedBy,
    state,
    sessionId: pr == null ? null : `s${number}`,
    prNumber: pr,
    issueClosed: false,
    claimed: false,
  };
}

const run = (over: Partial<EpicRun> = {}): EpicRun => ({
  repoPath: "/r",
  parentIssueNumber: 1,
  mode: "auto",
  status: "running",
  landing: "incremental",
  ...over,
});

const git = (checks: GitState["checks"], noCi = false) =>
  ({ checks, noCi, url: "https://example.test/pull/14" }) as GitState;

describe("awaitingMerge", () => {
  // #4 merged; #5 in review (PR 14) blocks #6 and #7; #8 blocked by #5 and the running #9.
  const children = [
    child(4, "merged"),
    child(5, "in-review", [4], 14),
    child(6, "blocked", [5]),
    child(7, "blocked", [4, 5]),
    child(9, "running", [4]),
    child(8, "blocked", [5, 9]),
  ];
  const green = () => git("success");

  it("names the green PR and the children it alone holds", () => {
    expect(awaitingMerge({ run: run(), children }, true, green)).toEqual([
      { child: 5, pr: 14, url: "https://example.test/pull/14", blocks: [6, 7] },
    ]);
  });

  it("counts a no-CI repo as green, but not a bare pre-CI none", () => {
    expect(awaitingMerge({ run: run(), children }, true, () => git("none", true))).toHaveLength(1);
    expect(awaitingMerge({ run: run(), children }, true, () => git("none"))).toEqual([]);
  });

  it("lists nothing while checks run or fail, or the session is unknown", () => {
    expect(awaitingMerge({ run: run(), children }, true, () => git("pending"))).toEqual([]);
    expect(awaitingMerge({ run: run(), children }, true, () => git("failure"))).toEqual([]);
    expect(awaitingMerge({ run: run(), children }, true, () => null)).toEqual([]);
  });

  it("lists nothing when the train merges, for integration landing or a paused run", () => {
    expect(awaitingMerge({ run: run(), children }, false, green)).toEqual([]);
    expect(awaitingMerge({ run: run({ landing: "integration" }), children }, true, green)).toEqual(
      [],
    );
    expect(awaitingMerge({ run: run({ status: "paused" }), children }, true, green)).toEqual([]);
  });

  it("ignores a dependent that already started (stacked)", () => {
    const stacked = [child(4, "in-review", [], 14), child(5, "running", [4])];
    expect(awaitingMerge({ run: run(), children: stacked }, true, green)).toEqual([]);
  });

  it("lists both PRs when a dependent waits on two green PRs", () => {
    const two = [
      child(2, "in-review", [], 20),
      child(3, "in-review", [], 30),
      child(4, "blocked", [2, 3]),
    ];
    expect(
      awaitingMerge({ run: run(), children: two }, true, green).map((w) => [w.pr, w.blocks]),
    ).toEqual([
      [20, [4]],
      [30, [4]],
    ]);
  });
});
