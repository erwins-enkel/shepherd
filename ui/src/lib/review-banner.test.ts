import { describe, it, expect } from "vitest";
import {
  conclusionOutcome,
  criticInFlightShows,
  reviewBannerState,
  type ReviewBannerInput,
} from "./review-banner";

describe("criticInFlightShows", () => {
  it("hides when auto-address is off", () => {
    expect(criticInFlightShows(false, undefined)).toBe(false);
    expect(criticInFlightShows(false, { addressRound: 0, addressCap: 3 })).toBe(false);
  });
  it("shows with no prior verdict (round 0 < cap)", () => {
    expect(criticInFlightShows(true, undefined)).toBe(true);
  });
  it("shows while under the verdict cap", () => {
    expect(criticInFlightShows(true, { addressRound: 1, addressCap: 3 })).toBe(true);
  });
  it("hides once the streak reaches the cap (stalled)", () => {
    expect(criticInFlightShows(true, { addressRound: 3, addressCap: 3 })).toBe(false);
    expect(criticInFlightShows(true, { addressRound: 4, addressCap: 3 })).toBe(false);
  });
});

describe("conclusionOutcome", () => {
  it("errored wins regardless of delivery", () => {
    expect(conclusionOutcome("error", true, false, false)).toBe("errored");
    expect(conclusionOutcome("error", false, true, true)).toBe("errored");
  });
  it("delivered steer → pasted (critic and plan-gate)", () => {
    expect(conclusionOutcome("changes_requested", true, false, false)).toBe("pasted");
    expect(conclusionOutcome("changes_requested", true, true, false)).toBe("pasted");
  });
  it("critic clean / commented → nothing", () => {
    expect(conclusionOutcome("commented", false, false, false)).toBe("nothing");
  });
  it("changes_requested that didn't land (closed-PR/dead-pane) → nothing, not pasted", () => {
    expect(conclusionOutcome("changes_requested", false, false, false)).toBe("nothing");
    expect(conclusionOutcome("changes_requested", false, true, false)).toBe("nothing");
  });
  it("plan-gate approved + auto/autopilot → released", () => {
    expect(conclusionOutcome("approved", false, true, true)).toBe("released");
  });
  it("plan-gate approved + interactive → awaiting-go", () => {
    expect(conclusionOutcome("approved", false, true, false)).toBe("awaiting-go");
  });
});

describe("reviewBannerState", () => {
  const base: ReviewBannerInput = {
    kind: "critic",
    phase: "in-flight",
    escalated: false,
    autoAddressOn: true,
    verdict: undefined,
    decision: undefined,
    delivered: false,
    autoReleased: false,
  };

  it("hides when no review applies", () => {
    expect(reviewBannerState({ ...base, kind: null })).toEqual({ show: false });
  });

  it("critic in-flight: calm when auto-address on, no typing", () => {
    expect(reviewBannerState(base)).toEqual({
      show: true,
      phase: "in-flight",
      tone: "calm",
      copyKey: "reviewbanner_calm",
    });
  });

  it("critic in-flight: escalated once the operator typed", () => {
    expect(reviewBannerState({ ...base, escalated: true })).toEqual({
      show: true,
      phase: "in-flight",
      tone: "escalated",
      copyKey: "reviewbanner_escalated",
    });
  });

  it("critic in-flight: hidden when auto-address off", () => {
    expect(reviewBannerState({ ...base, autoAddressOn: false })).toEqual({ show: false });
  });

  it("critic in-flight: hidden once stalled at cap", () => {
    expect(reviewBannerState({ ...base, verdict: { addressRound: 3, addressCap: 3 } })).toEqual({
      show: false,
    });
  });

  it("plan-gate in-flight: always shows (even with auto-address off)", () => {
    expect(reviewBannerState({ ...base, kind: "plangate", autoAddressOn: false })).toEqual({
      show: true,
      phase: "in-flight",
      tone: "calm",
      copyKey: "reviewbanner_calm",
    });
  });

  it("conclusion: critic delivered → pasted", () => {
    expect(
      reviewBannerState({
        ...base,
        phase: "conclusion",
        decision: "changes_requested",
        delivered: true,
      }),
    ).toEqual({
      show: true,
      phase: "conclusion",
      tone: "pasted",
      copyKey: "reviewbanner_pasted",
    });
  });

  it("conclusion: plan-gate approved + autopilot → released", () => {
    expect(
      reviewBannerState({
        ...base,
        kind: "plangate",
        phase: "conclusion",
        decision: "approved",
        autoReleased: true,
      }),
    ).toEqual({
      show: true,
      phase: "conclusion",
      tone: "released",
      copyKey: "reviewbanner_released",
    });
  });

  it("conclusion: plan-gate approved interactive → awaiting-go", () => {
    expect(
      reviewBannerState({
        ...base,
        kind: "plangate",
        phase: "conclusion",
        decision: "approved",
        autoReleased: false,
      }),
    ).toEqual({
      show: true,
      phase: "conclusion",
      tone: "awaiting-go",
      copyKey: "reviewbanner_awaiting_go",
    });
  });

  it("conclusion: errored", () => {
    expect(reviewBannerState({ ...base, phase: "conclusion", decision: "error" })).toEqual({
      show: true,
      phase: "conclusion",
      tone: "errored",
      copyKey: "reviewbanner_errored",
    });
  });
});
