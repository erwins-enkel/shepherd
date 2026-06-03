import { describe, it, expect } from "vitest";
import { deriveStage, STAGE_ORDER } from "./stage";
import type { GitState, ReviewVerdict, ChecksState } from "$lib/types";

function git(over: Partial<GitState>): GitState {
  return {
    kind: "github",
    state: "none",
    checks: "none",
    deployConfigured: false,
    ...over,
  };
}

const verdict: ReviewVerdict = {
  sessionId: "s1",
  headSha: "abc",
  decision: "commented",
  summary: "",
  body: "",
  findings: [],
  addressRound: 0,
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 0,
  updatedAt: 0,
};

describe("deriveStage", () => {
  it("coding: no git", () => {
    const s = deriveStage({ reviewing: false, readyToMerge: false });
    expect(s.reached).toBe("coding");
    expect(s.index).toBe(0);
    expect(s.ci).toBe("none");
    expect(s.terminal).toBeNull();
  });

  it("coding: git state none", () => {
    const s = deriveStage({ git: git({ state: "none" }), reviewing: false, readyToMerge: false });
    expect(s.index).toBe(0);
    expect(s.reached).toBe("coding");
  });

  it("pr: open + checks none", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "none" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(1);
    expect(s.reached).toBe("pr");
    expect(s.ci).toBe("none");
  });

  for (const checks of ["pending", "success", "failure"] as ChecksState[]) {
    it(`ci: open + checks ${checks} → index 2, ci passthrough`, () => {
      const s = deriveStage({
        git: git({ state: "open", checks }),
        reviewing: false,
        readyToMerge: false,
      });
      expect(s.index).toBe(2);
      expect(s.reached).toBe("ci");
      expect(s.ci).toBe(checks);
    });
  }

  it("review: reviewing=true bumps to 3", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "success" }),
      reviewing: true,
      readyToMerge: false,
    });
    expect(s.index).toBe(3);
    expect(s.reached).toBe("review");
  });

  it("review: verdict present bumps to 3", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "none" }),
      verdict,
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(3);
  });

  it("review: git.latestReview present bumps to 3", () => {
    const s = deriveStage({
      git: git({
        state: "open",
        checks: "none",
        latestReview: { state: "commented", author: "x", submittedAt: 0 },
      }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(3);
  });

  it("review does not pull a no-PR session below coding", () => {
    // no git, but reviewing → review still wins via max()
    const s = deriveStage({ reviewing: true, readyToMerge: false });
    expect(s.index).toBe(3);
  });

  it("ready: readyToMerge true", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "success" }),
      reviewing: false,
      readyToMerge: true,
    });
    expect(s.index).toBe(4);
    expect(s.reached).toBe("ready");
    expect(s.terminal).toBeNull();
  });

  it("ready: merged", () => {
    const s = deriveStage({
      git: git({ state: "merged", checks: "success" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.index).toBe(4);
    expect(s.reached).toBe("ready");
    expect(s.terminal).toBe("merged");
  });

  it("terminal: closed", () => {
    const s = deriveStage({
      git: git({ state: "closed", checks: "failure" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(s.terminal).toBe("closed");
    expect(s.ci).toBe("failure");
  });

  it("STAGE_ORDER index matches reached", () => {
    const s = deriveStage({
      git: git({ state: "open", checks: "pending" }),
      reviewing: false,
      readyToMerge: false,
    });
    expect(STAGE_ORDER[s.index]).toBe(s.reached);
  });
});
