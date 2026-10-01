import { describe, it, expect } from "vitest";
import {
  activeReworkBannerState,
  conclusionOutcome,
  criticSteerCanLand,
  reviewBannerState,
  cancelledBannerState,
  type ReviewBannerInput,
} from "./review-banner";

describe("criticSteerCanLand", () => {
  it("cannot land when auto-address is off", () => {
    expect(criticSteerCanLand(false, undefined)).toBe(false);
    expect(criticSteerCanLand(false, { addressRound: 0, addressCap: 3 })).toBe(false);
  });
  it("can land with no prior verdict (round 0 < cap)", () => {
    expect(criticSteerCanLand(true, undefined)).toBe(true);
  });
  it("can land while under the verdict cap", () => {
    expect(criticSteerCanLand(true, { addressRound: 1, addressCap: 3 })).toBe(true);
  });
  it("cannot land once the streak reaches the cap (stalled)", () => {
    expect(criticSteerCanLand(true, { addressRound: 3, addressCap: 3 })).toBe(false);
    expect(criticSteerCanLand(true, { addressRound: 4, addressCap: 3 })).toBe(false);
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
    held: false,
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

  it("in-flight: held wins over escalated", () => {
    expect(reviewBannerState({ ...base, escalated: true, held: true })).toEqual({
      show: true,
      phase: "in-flight",
      tone: "held",
      copyKey: "reviewbanner_held",
    });
    expect(
      reviewBannerState({ ...base, kind: "plangate", autoAddressOn: false, held: true }),
    ).toMatchObject({ phase: "in-flight", tone: "held" });
  });

  it("cancelled tier carries the kind for Restart", () => {
    expect(cancelledBannerState("plangate")).toEqual({
      show: true,
      phase: "cancelled",
      tone: "cancelled",
      kind: "plangate",
      copyKey: "reviewbanner_cancelled",
    });
  });

  const watch = {
    show: true,
    phase: "in-flight",
    tone: "watch",
    copyKey: "reviewbanner_watch",
  };

  it("critic in-flight: progress-only watch tier when auto-address off", () => {
    expect(reviewBannerState({ ...base, autoAddressOn: false })).toEqual(watch);
  });

  it("critic in-flight: watch tier once stalled at cap", () => {
    expect(reviewBannerState({ ...base, verdict: { addressRound: 3, addressCap: 3 } })).toEqual(
      watch,
    );
  });

  it("critic in-flight: typing never escalates a review that cannot paste", () => {
    expect(reviewBannerState({ ...base, autoAddressOn: false, escalated: true })).toEqual(watch);
  });

  it("critic in-flight: a held review stays held even if auto-address went off", () => {
    expect(reviewBannerState({ ...base, autoAddressOn: false, held: true })).toMatchObject({
      tone: "held",
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

describe("activeReworkBannerState", () => {
  const base = {
    planPhase: "planning" as const,
    dStatus: "running" as const,
    planGate: { decision: "changes_requested" as const, round: 1, cap: 5 },
    planReviewing: false,
    review: undefined,
    criticReviewing: false,
    activitySummary: "edited .shepherd-plan.md",
  };

  it("shows plan-gate rework only while planning, changes were requested, reviewer idle, and display status is running", () => {
    expect(activeReworkBannerState(base)).toEqual({
      show: true,
      phase: "addressing",
      tone: "calm",
      kind: "plangate",
      round: 1,
      cap: 5,
      summary: "edited .shepherd-plan.md",
      fallbackKey: "reviewbanner_rework_plan_fallback",
    });
  });

  it("hides parked plan-gate rework for non-running display statuses", () => {
    for (const dStatus of ["idle", "blocked", "done", "archived"] as const) {
      expect(activeReworkBannerState({ ...base, dStatus })).toEqual({ show: false });
    }
  });

  it("hides plan-gate rework while the plan reviewer is in flight", () => {
    expect(activeReworkBannerState({ ...base, planReviewing: true })).toEqual({ show: false });
  });

  it("hides plan-gate rework when there is no changes-requested verdict", () => {
    expect(
      activeReworkBannerState({
        ...base,
        planGate: { decision: "approved", round: 1, cap: 5 },
      }),
    ).toEqual({ show: false });
  });

  it("shows critic rework while executing with a changes-requested review and no critic in flight", () => {
    expect(
      activeReworkBannerState({
        ...base,
        planPhase: "executing",
        planGate: undefined,
        review: { decision: "changes_requested", addressRound: 2, addressCap: 5 },
        activitySummary: "edited Viewport.svelte",
      }),
    ).toEqual({
      show: true,
      phase: "addressing",
      tone: "calm",
      kind: "critic",
      round: 2,
      cap: 5,
      summary: "edited Viewport.svelte",
      fallbackKey: "reviewbanner_rework_critic_fallback",
    });
  });

  it("shows critic rework without a counter when no auto-address round is active", () => {
    expect(
      activeReworkBannerState({
        ...base,
        planPhase: null,
        planGate: undefined,
        review: { decision: "changes_requested", addressRound: 0, addressCap: 5 },
        activitySummary: null,
      }),
    ).toEqual({
      show: true,
      phase: "addressing",
      tone: "calm",
      kind: "critic",
      summary: null,
      fallbackKey: "reviewbanner_rework_critic_fallback",
    });
  });

  it("hides critic rework while the critic is in flight", () => {
    expect(
      activeReworkBannerState({
        ...base,
        planPhase: "executing",
        planGate: undefined,
        review: { decision: "changes_requested", addressRound: 1, addressCap: 5 },
        criticReviewing: true,
      }),
    ).toEqual({ show: false });
  });

  it("does not show critic rework during the planning phase", () => {
    expect(
      activeReworkBannerState({
        ...base,
        planGate: undefined,
        review: { decision: "changes_requested", addressRound: 1, addressCap: 5 },
      }),
    ).toEqual({ show: false });
  });

  it("hides plan-gate rework when the operator dismissed it", () => {
    expect(
      activeReworkBannerState({
        ...base,
        planGate: { decision: "changes_requested", round: 1, cap: 5, dismissed: true },
      }),
    ).toEqual({ show: false });
  });

  it("hides plan-gate rework when the loop has stalled (takeover)", () => {
    expect(activeReworkBannerState({ ...base, planStalled: true })).toEqual({ show: false });
  });

  it("hides critic rework when dismissed or stalled", () => {
    const criticBase = {
      ...base,
      planPhase: "executing" as const,
      planGate: undefined,
      review: { decision: "changes_requested" as const, addressRound: 2, addressCap: 5 },
    };
    expect(
      activeReworkBannerState({
        ...criticBase,
        review: { ...criticBase.review, dismissed: true },
      }),
    ).toEqual({ show: false });
    expect(activeReworkBannerState({ ...criticBase, criticStalled: true })).toEqual({
      show: false,
    });
  });
});
