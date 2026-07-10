import { describe, expect, test } from "vitest";
import type { Session } from "./types";
import {
  doneRailIds,
  doneSessionsForRepoFilter,
  nextDoneSelectedId,
  resolveDoneSelected,
} from "./done-filter";

function session(id: string, repoPath: string): Session {
  return { id, repoPath } as Session;
}

const done = [
  session("shep-1", "/repo/shepherd"),
  session("shopify-1", "/repo/epamano-shopify"),
  session("theme-1", "/repo/epamano-shopifytheme"),
  session("shep-2", "/repo/shepherd"),
];

describe("doneSessionsForRepoFilter", () => {
  test("empty repo filter keeps every recent done session", () => {
    expect(doneSessionsForRepoFilter(done, new Set()).map((s) => s.id)).toEqual([
      "shep-1",
      "shopify-1",
      "theme-1",
      "shep-2",
    ]);
  });

  test("single repo filter keeps only matching repoPath sessions", () => {
    expect(doneSessionsForRepoFilter(done, new Set(["/repo/shepherd"])).map((s) => s.id)).toEqual([
      "shep-1",
      "shep-2",
    ]);
  });

  test("multi repo filter keeps sessions from any selected repo", () => {
    expect(
      doneSessionsForRepoFilter(
        done,
        new Set(["/repo/epamano-shopify", "/repo/epamano-shopifytheme"]),
      ).map((s) => s.id),
    ).toEqual(["shopify-1", "theme-1"]);
  });
});

describe("Done selection and keynav lists", () => {
  test("resolveDoneSelected cannot resolve a session hidden by the filtered list", () => {
    const filtered = doneSessionsForRepoFilter(done, new Set(["/repo/shepherd"]));
    expect(resolveDoneSelected(filtered, "shopify-1")).toBeNull();
    expect(resolveDoneSelected(filtered, "shep-2")?.id).toBe("shep-2");
  });

  test("nextDoneSelectedId preserves a visible selection", () => {
    const filtered = doneSessionsForRepoFilter(done, new Set(["/repo/shepherd"]));
    expect(nextDoneSelectedId(filtered, "shep-2")).toBe("shep-2");
  });

  test("nextDoneSelectedId moves to the first visible row when current selection is filtered out", () => {
    const filtered = doneSessionsForRepoFilter(done, new Set(["/repo/shepherd"]));
    expect(nextDoneSelectedId(filtered, "shopify-1")).toBe("shep-1");
  });

  test("nextDoneSelectedId clears when the active repo filter has no done rows", () => {
    const filtered = doneSessionsForRepoFilter(done, new Set(["/repo/missing"]));
    expect(nextDoneSelectedId(filtered, "shep-1")).toBeNull();
  });

  test("doneRailIds returns only filtered ids for Done keyboard navigation", () => {
    const filtered = doneSessionsForRepoFilter(done, new Set(["/repo/shepherd"]));
    expect(doneRailIds(filtered)).toEqual(["shep-1", "shep-2"]);
  });
});
