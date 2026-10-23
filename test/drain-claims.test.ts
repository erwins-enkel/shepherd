import { describe, expect, test } from "bun:test";
import { classifyClaim } from "../src/drain-claims";
import type { Issue } from "../src/forge/types";

const issue = {
  number: 133,
  title: "Calendar",
  url: "https://github.com/o/r/issues/133",
  labels: ["shepherd:auto", "shepherd:active"],
} as Issue;
describe("claim diagnosis", () => {
  test("a claim without session or PR is visible with ownership explicitly unknown", () => {
    expect(classifyClaim(issue, false, [])).toMatchObject({
      number: 133,
      ownership: "unknown",
      evidence: "complete",
      mergedPrs: [],
    });
  });
  test("live manual sessions and open PRs exclude a claim", () => {
    expect(classifyClaim(issue, true, [])).toBeNull();
    expect(
      classifyClaim(issue, false, [{ number: 212, url: "foreign", state: "open" }]),
    ).toBeNull();
  });
  test("merged mentions are evidence, closed unmerged PRs are not", () => {
    expect(
      classifyClaim(issue, false, [
        { number: 212, url: "merged", state: "merged" },
        { number: 213, url: "closed", state: "closed" },
      ])?.mergedPrs,
    ).toEqual([{ number: 212, url: "merged", state: "merged" }]);
  });
  test("missing evidence cannot be interpreted as no PR", () => {
    expect(classifyClaim(issue, false, null)).toMatchObject({
      evidence: "unknown",
      ownership: "unknown",
    });
    expect(classifyClaim({ ...issue, labels: [] }, false, [])).toBeNull();
  });
});
