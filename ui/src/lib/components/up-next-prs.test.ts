import { describe, expect, test } from "vitest";
import type { UpNextPr } from "#lib/types.js";
import {
  buttonAction,
  ciShown,
  mergeBlock,
  prBandGroups,
  prsInRepos,
  readyPrCount,
} from "./up-next-prs";

const pr = (number: number, over: Partial<UpNextPr> = {}): UpNextPr => ({
  repoPath: "/r/a",
  repoSlug: "o/a",
  repoLabel: "a",
  number,
  title: `pr${number}`,
  url: `https://x/pull/${number}`,
  author: "me",
  kind: "regular",
  createdAt: number,
  checks: "success",
  mergeable: true,
  band: "ready",
  action: "merge",
  ...over,
});

describe("prBandGroups", () => {
  test("orders the bands and keeps the server's order inside each", () => {
    const groups = prBandGroups([
      pr(1, { band: "dependabot", kind: "dependabot" }),
      pr(2, { band: "blocked", action: "fix", blockReason: "ci_failed" }),
      pr(4),
      pr(3),
      pr(5, { band: "review", action: "review" }),
    ]);
    expect(groups.map((g) => [g.band, g.items.map((p) => p.number)])).toEqual([
      ["ready", [4, 3]],
      ["review", [5]],
      ["blocked", [2]],
      ["dependabot", [1]],
    ]);
  });
  test("leaves out empty bands", () => {
    expect(prBandGroups([pr(1)]).map((g) => g.band)).toEqual(["ready"]);
    expect(prBandGroups([])).toEqual([]);
  });
});

test("readyPrCount counts only rows that can merge right now", () => {
  expect(
    readyPrCount([
      pr(1),
      pr(2, { action: null, checks: "pending" }),
      pr(3, { band: "dependabot", kind: "dependabot" }),
      pr(4),
    ]),
  ).toBe(2);
  expect(readyPrCount(undefined)).toBe(0);
});

test("buttonAction shows the band's action, disabled, while CI runs", () => {
  expect(buttonAction(pr(1))).toBe("merge");
  expect(buttonAction(pr(1, { action: null }))).toBe("merge");
  expect(buttonAction(pr(1, { band: "review", action: null }))).toBe("review");
  expect(buttonAction(pr(1, { band: "dependabot", action: null }))).toBe("merge");
  expect(buttonAction(pr(1, { band: "blocked", action: "fix" }))).toBe("fix");
});

describe("mergeBlock", () => {
  test("is null when the next action is the merge", () => {
    expect(mergeBlock(pr(1))).toBeNull();
  });
  test("names the block reason, a missing review or what is still running", () => {
    expect(mergeBlock(pr(1, { band: "blocked", action: "fix", blockReason: "conflict" }))).toBe(
      "conflict",
    );
    expect(mergeBlock(pr(1, { band: "review", action: "review" }))).toBe("review");
    expect(mergeBlock(pr(1, { action: null, checks: "pending" }))).toBe("ci_running");
    expect(mergeBlock(pr(1, { action: null, checks: "none" }))).toBe("ci_running");
    expect(mergeBlock(pr(1, { action: null, mergeable: null }))).toBe("mergeability");
  });
});

test("ciShown reads a terminal none as no CI and a waiting none as running", () => {
  expect(ciShown(pr(1))).toBe("green");
  expect(ciShown(pr(1, { checks: "failure" }))).toBe("red");
  expect(ciShown(pr(1, { checks: "pending" }))).toBe("running");
  expect(ciShown(pr(1, { checks: "none", action: null }))).toBe("running");
  expect(ciShown(pr(1, { checks: "none" }))).toBe("none");
});

test("prsInRepos keeps the chip-rail repos, or everything when none is picked", () => {
  const rows = [pr(1), pr(2, { repoPath: "/r/b" })];
  expect(prsInRepos(rows, new Set()).map((p) => p.number)).toEqual([1, 2]);
  expect(prsInRepos(rows, new Set(["/r/b"])).map((p) => p.number)).toEqual([2]);
});
