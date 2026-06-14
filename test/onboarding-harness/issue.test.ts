import { describe, expect, it } from "bun:test";
import { reportToGitHub, publishStatus } from "../../ci/onboarding-harness/issue";
import type { GhRunner } from "../../ci/onboarding-harness/issue";
import type { ScenarioResult } from "../../ci/onboarding-harness/types";

function result(over: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenarioId: "herdr-missing",
    image: "images:archlinux",
    detection: { scenarioId: "herdr-missing", detected: true, misses: [] },
    appliedVia: "verbatim",
    reachedGreen: true,
    gateEligible: true, // structured, non-detection-only
    ...over,
  };
}

const GAP = result({ reachedGreen: false }); // gate-eligible + not green → GATE GAP
const PASS = result({ reachedGreen: true });
const DETECTION_ONLY = result({ detectionOnly: true, gateEligible: false }); // by design — NOT a gap
// A prose/agent gap (e.g. git-missing): not green, but NOT gate-eligible → must not
// open/keep an issue or fail the gate.
const NON_GATE_GAP = result({
  scenarioId: "git-missing",
  reachedGreen: false,
  gateEligible: false,
});

/** Fake `gh` that records argv and replies to `issue list` with `openIssue`. */
function fakeGh(openIssue: { number: number; url: string } | null) {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify(openIssue ? [openIssue] : []), stderr: "", code: 0 };
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
    const out = await reportToGitHub([GAP, PASS, DETECTION_ONLY], "REPORT", "2026-06-15", gh);
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create).toContain("--label");
    expect(create!.join(" ")).toContain("REPORT");
    expect(calls.some((c) => c[0] === "label" && c[1] === "create")).toBe(true);
    expect(out.summary).toContain("opened");
    expect(out.issueUrl).toBe("https://github.com/x/y/issues/99");
  });

  it("comments + refreshes the existing issue when gaps persist (no duplicate)", async () => {
    const { calls, gh } = fakeGh({ number: 42, url: "https://github.com/x/y/issues/42" });
    const out = await reportToGitHub([GAP], "REPORT", "2026-06-15", gh);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "edit" && c[2] === "42")).toBe(true);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "42")).toBe(true);
    expect(out.summary).toContain("42");
    expect(out.issueUrl).toBe("https://github.com/x/y/issues/42");
  });

  it("closes the open issue when the run is clean (regression resolved)", async () => {
    const { calls, gh } = fakeGh({ number: 42, url: "https://github.com/x/y/issues/42" });
    const out = await reportToGitHub([PASS, DETECTION_ONLY], "REPORT", "2026-06-15", gh);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "close" && c[2] === "42")).toBe(true);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
    expect(out.summary).toContain("closed");
    expect(out.issueUrl).toBeNull();
  });

  it("does nothing when the run is clean and no issue is open", async () => {
    const { calls, gh } = fakeGh(null);
    const out = await reportToGitHub([PASS], "REPORT", "2026-06-15", gh);
    expect(calls.every((c) => !["create", "edit", "comment", "close"].includes(c[1]!))).toBe(true);
    expect(out.summary).toMatch(/nothing/i);
  });

  it("ignores a non-gate gap (git-missing) — it must not open an issue", async () => {
    const { calls, gh } = fakeGh(null);
    const out = await reportToGitHub([PASS, NON_GATE_GAP], "REPORT", "2026-06-15", gh);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
    expect(out.summary).toMatch(/nothing/i);
  });

  it("closes the gate issue when only a non-gate gap remains (gate is green)", async () => {
    const { calls, gh } = fakeGh({ number: 42, url: "https://github.com/x/y/issues/42" });
    await reportToGitHub([PASS, NON_GATE_GAP], "REPORT", "2026-06-15", gh);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "close" && c[2] === "42")).toBe(true);
  });
});

describe("publishStatus", () => {
  function fakeGh() {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    };
    return { calls, gh };
  }

  it("POSTs a success status with the onboarding-harness context on the SHA", async () => {
    const { calls, gh } = fakeGh();
    await publishStatus("abc123", true, "3/3 scenarios green", null, gh);
    const c = calls[0]!;
    expect(c).toEqual([
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/statuses/abc123",
      "-f",
      "state=success",
      "-f",
      "context=onboarding-harness",
      "-f",
      "description=3/3 scenarios green",
    ]);
  });

  it("POSTs failure + a target_url linking the regression issue", async () => {
    const { calls, gh } = fakeGh();
    await publishStatus("def456", false, "1 gap(s): herdr-missing", "https://x/issues/7", gh);
    const c = calls[0]!.join(" ");
    expect(c).toContain("state=failure");
    expect(c).toContain("target_url=https://x/issues/7");
  });
});
