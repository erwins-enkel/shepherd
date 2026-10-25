import { describe, expect, test } from "vitest";
import type { IssueFilterSettings, UpNextItem, UpNextSnapshot } from "#lib/types.js";
import {
  activeChips,
  activeRuleCount,
  forkRepos,
  hiddenFor,
  labelOptions,
  toggledLabels,
} from "./up-next-filter";

const F: IssueFilterSettings = {
  scope: "all",
  forks: "all",
  hiddenLabels: [],
  hideActive: false,
  hideSubIssues: true,
  hideBlocked: true,
};
const it = (repoLabel: string, labels: string[], fromFork = false) =>
  ({ repoLabel, labels, fromFork }) as unknown as UpNextItem;
const snap = (items: UpNextItem[]) => ({ sections: [{ items }] }) as unknown as UpNextSnapshot;
const stats = {
  hiddenCount: 7,
  hiddenBy: { scope: 4, forks: 2, labels: 1 },
  hiddenByRepo: { "/a": 3, "/b": 4 },
  optionCounts: {
    scope: { all: 0, mine_unassigned: 0, mine: 0 },
    forks: { all: 0, own: 0, hide: 0 },
  },
};

describe("up-next-filter", () => {
  test("activeRuleCount", () => {
    expect(activeRuleCount(F)).toBe(0);
    expect(activeRuleCount({ ...F, scope: "mine", forks: "own", hiddenLabels: ["a", "b"] })).toBe(
      4,
    );
  });

  test("activeChips lists one chip per rule", () => {
    expect(
      activeChips({ ...F, scope: "mine", forks: "hide", hiddenLabels: ["docs"] }),
    ).toHaveLength(3);
    expect(activeChips(F)).toEqual([]);
  });

  test("hiddenFor sums hiddenByRepo over the repo chips", () => {
    expect(hiddenFor(stats, new Set())).toBe(7);
    expect(hiddenFor(stats, new Set(["/a", "/c"]))).toBe(3);
    expect(hiddenFor(undefined, new Set())).toBe(0);
  });

  test("labelOptions unions queue labels with hidden ones, deduped and sorted", () => {
    const s = snap([it("r", ["bug", "shepherd:priority", "UI"]), it("r", ["Bug"])]);
    expect(labelOptions(s, ["docs"])).toEqual(["bug", "docs", "UI"]);
  });

  test("forkRepos names fork repos once", () => {
    expect(forkRepos(snap([it("up", [], true), it("up", [], true), it("own", [])]))).toEqual([
      "up",
    ]);
  });

  test("toggledLabels is case-insensitive", () => {
    expect(toggledLabels({ ...F, hiddenLabels: ["Docs"] }, "docs")).toEqual([]);
    expect(toggledLabels(F, "docs")).toEqual(["docs"]);
  });
});
