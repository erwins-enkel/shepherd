import { describe, expect, spyOn, test } from "bun:test";
import {
  classifyClaim,
  epicClaimBlockers,
  logClaim,
  type ClaimDiagnostic,
} from "../src/drain-claims";
import type { EpicChild } from "../src/epic-core";
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

function child(number: number, over: Partial<EpicChild> = {}): EpicChild {
  return {
    number,
    title: `c${number}`,
    url: `u${number}`,
    order: number,
    body: "",
    blockedBy: [],
    state: "ready",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    integrationMerged: false,
    claimed: false,
    ...over,
  };
}

function orphan(number: number, evidence: "complete" | "unknown" = "complete"): ClaimDiagnostic {
  return { number, title: "", url: "", ownership: "unknown", evidence, mergedPrs: [] };
}

describe("epic claim blockers (#4025)", () => {
  test("a claimed child that would spawn unclaimed, with a complete orphan diagnosis, blocks", () => {
    const children = [child(2, { claimed: true }), child(1, { claimed: true })];
    expect(epicClaimBlockers(children, undefined, [orphan(1), orphan(2)], new Set())).toEqual([
      1, 2,
    ]);
  });
  test("deps unmet, integrated, live session or unclaimed children never block", () => {
    const children = [
      child(1, { claimed: true, blockedBy: [9] }),
      child(9),
      child(3, { claimed: true, integrationMerged: true }),
      child(4, { claimed: true, sessionId: "s" }),
      child(5),
    ];
    const claims = [1, 3, 4, 5].map((n) => orphan(n));
    expect(epicClaimBlockers(children, undefined, claims, new Set())).toEqual([]);
  });
  test("unknown evidence, undiagnosed and mapped (remote) claims are excluded", () => {
    const children = [1, 2, 3].map((n) => child(n, { claimed: true }));
    expect(
      epicClaimBlockers(children, undefined, [orphan(1, "unknown"), orphan(3)], new Set([3])),
    ).toEqual([]);
  });
});

test("logClaim prints one traceable line", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    logClaim("release", "/r", 7, { via: "auto-release" });
    logClaim("claim", "/r", 7, { via: "drain", desig: "TASK-3", reason: "spawned" });
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      "[claim] release /r#7 via=auto-release desig=-",
      "[claim] claim /r#7 via=drain desig=TASK-3 reason=spawned",
    ]);
  } finally {
    warn.mockRestore();
  }
});
