import { describe, expect, it } from "bun:test";
import { reportToGitHub } from "../../ci/onboarding-harness/issue";
import type { GhRunner } from "../../ci/onboarding-harness/issue";
import type { ScenarioResult } from "../../ci/onboarding-harness/types";

function result(over: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenarioId: "herdr-missing",
    image: "images:archlinux",
    detection: { scenarioId: "herdr-missing", detected: true, misses: [] },
    appliedVia: "verbatim",
    reachedGreen: true,
    ...over,
  };
}

const GAP = result({ reachedGreen: false }); // detected but not green → ADVICE GAP
const PASS = result({ reachedGreen: true });
const DETECTION_ONLY = result({ detectionOnly: true }); // by design — NOT a gap

/** Fake `gh` that records argv and replies to `issue list` with `openIssue`. */
function fakeGh(openIssue: number | null) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      const rows = openIssue == null ? [] : [{ number: openIssue }];
      return { stdout: JSON.stringify(rows), stderr: "", code: 0 };
    }
    if (args[0] === "issue" && args[1] === "create") {
      return { stdout: "https://github.com/x/y/issues/99", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, gh };
}

describe("reportToGitHub", () => {
  it("opens a labelled issue when there are gaps and none is open", async () => {
    const { calls, gh } = fakeGh(null);
    const action = await reportToGitHub([GAP, PASS, DETECTION_ONLY], "REPORT", "2026-06-15", gh);
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("--label");
    expect(create!.join(" ")).toContain("REPORT");
    expect(calls.some((c) => c[0] === "label" && c[1] === "create")).toBe(true); // ensures label exists
    expect(action).toContain("opened");
  });

  it("comments + refreshes the existing issue when gaps persist (no duplicate issue)", async () => {
    const { calls, gh } = fakeGh(42);
    const action = await reportToGitHub([GAP], "REPORT", "2026-06-15", gh);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "edit" && c[2] === "42")).toBe(true);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "42")).toBe(true);
    expect(action).toContain("42");
  });

  it("closes the open issue when the run is clean (regression resolved)", async () => {
    const { calls, gh } = fakeGh(42);
    const action = await reportToGitHub([PASS, DETECTION_ONLY], "REPORT", "2026-06-15", gh);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "close" && c[2] === "42")).toBe(true);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
    expect(action).toContain("closed");
  });

  it("does nothing when the run is clean and no issue is open", async () => {
    const { calls, gh } = fakeGh(null);
    const action = await reportToGitHub([PASS], "REPORT", "2026-06-15", gh);
    expect(calls.every((c) => !["create", "edit", "comment", "close"].includes(c[1]!))).toBe(true);
    expect(action).toMatch(/nothing/i);
  });
});
