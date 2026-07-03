import { describe, it, expect } from "vitest";
import { ciBannerState } from "./ci-banner";
import type { GitState } from "./types";

/** Minimal open-PR GitState with pending CI. */
function git(overrides: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    number: 1376,
    url: "https://github.com/o/r/pull/1376",
    checks: "pending",
    deployConfigured: false,
    ...overrides,
  };
}

describe("ciBannerState", () => {
  it("shows with names on an open PR whose CI is pending", () => {
    const s = ciBannerState({
      git: git({ runningChecks: ["verify / test", "PR hygiene / i18n"] }),
      reviewActive: false,
    });
    expect(s).toEqual({
      show: true,
      number: 1376,
      url: "https://github.com/o/r/pull/1376",
      names: ["verify / test", "PR hygiene / i18n"],
    });
  });

  it("shows with empty names (fallback copy) when runningChecks is absent", () => {
    const s = ciBannerState({ git: git({ runningChecks: undefined }), reviewActive: false });
    expect(s).toEqual({
      show: true,
      number: 1376,
      url: "https://github.com/o/r/pull/1376",
      names: [],
    });
  });

  it("hides when a review banner is active (mutual exclusion)", () => {
    expect(ciBannerState({ git: git({ runningChecks: ["a"] }), reviewActive: true })).toEqual({
      show: false,
    });
  });

  it("hides when checks are not pending", () => {
    for (const checks of ["none", "success", "failure"] as const) {
      expect(ciBannerState({ git: git({ checks }), reviewActive: false })).toEqual({ show: false });
    }
  });

  it("hides when the PR is not open", () => {
    for (const state of ["none", "merged", "closed"] as const) {
      expect(
        ciBannerState({ git: git({ state, checks: "pending" }), reviewActive: false }),
      ).toEqual({
        show: false,
      });
    }
  });

  it("hides when there is no git state", () => {
    expect(ciBannerState({ git: null, reviewActive: false })).toEqual({ show: false });
    expect(ciBannerState({ git: undefined, reviewActive: false })).toEqual({ show: false });
  });
});
