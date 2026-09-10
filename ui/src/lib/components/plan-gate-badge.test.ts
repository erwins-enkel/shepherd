import { describe, it, expect } from "vitest";
import {
  canOfferPlanReview,
  canTriggerPlanReview,
  planEdited,
  planGateChip,
} from "./plan-gate-badge";
import type { PlanGate, Session } from "$lib/types";

const baseGate: PlanGate = {
  sessionId: "s1",
  planHash: "hash",
  decision: "changes_requested",
  summary: "",
  body: "",
  findings: [],
  round: 3,
  cap: 3,
  approved: false,
  plan: "",
  updatedAt: 1_000_000,
};
const gate = (p: Partial<PlanGate>): PlanGate => ({ ...baseGate, ...p });
const session = (planPhase: Session["planPhase"]): Pick<Session, "planPhase"> => ({ planPhase });

describe("canTriggerPlanReview", () => {
  it("reviewing wins over an approved gate", () => {
    expect(canTriggerPlanReview(session("planning"), gate({ approved: true }), true)).toBe(
      "reviewing",
    );
  });
  it("an approved gate blocks when not reviewing", () => {
    expect(canTriggerPlanReview(session("planning"), gate({ approved: true }), false)).toBe(
      "approved",
    );
  });
  it("a startable gate (e.g. changes_requested at cap) is not blocked", () => {
    expect(
      canTriggerPlanReview(
        session("planning"),
        gate({ decision: "changes_requested", round: 3, cap: 3, approved: false }),
        false,
      ),
    ).toBeNull();
  });
  it("off the plan phase, an UNEDITED gate is never blocked (the control isn't offered)", () => {
    expect(canTriggerPlanReview(session("executing"), gate({ approved: true }), true)).toBeNull();
  });
  it("no gate at all, not reviewing, is startable", () => {
    expect(canTriggerPlanReview(session("planning"), undefined, false)).toBeNull();
  });
});

// ── #2224: a plan edited after approval ───────────────────────────────────────

/** The shape the server writes once a settle edge finds the live plan no longer matching. */
const editedGate = (p: Partial<PlanGate> = {}) =>
  gate({
    decision: "approved",
    approved: true,
    planHash: "APPROVED",
    livePlanHash: "REWRITTEN",
    round: 0,
    ...p,
  });

describe("planEdited", () => {
  it("is true only for an approved gate whose live hash has diverged", () => {
    expect(planEdited(editedGate())).toBe(true);
    expect(planEdited(editedGate({ livePlanHash: "APPROVED" }))).toBe(false);
    // Never checked (or a row predating the field) reads as un-edited, not as edited.
    expect(planEdited(editedGate({ livePlanHash: null }))).toBe(false);
    expect(planEdited(editedGate({ livePlanHash: undefined }))).toBe(false);
    expect(planEdited(undefined)).toBe(false);
  });
  it("is false before approval — a plan under review is expected to move", () => {
    expect(planEdited(gate({ approved: false, planHash: "A", livePlanHash: "B" }))).toBe(false);
  });
});

describe("canOfferPlanReview", () => {
  it("is always on while planning, edited or not", () => {
    expect(canOfferPlanReview(session("planning"), undefined)).toBe(true);
    expect(canOfferPlanReview(session("planning"), editedGate())).toBe(true);
    expect(canOfferPlanReview(session("planning"), editedGate({ livePlanHash: "APPROVED" }))).toBe(
      true,
    );
  });
  it("during execution is on ONLY for an edited approved plan", () => {
    expect(canOfferPlanReview(session("executing"), editedGate())).toBe(true);
    expect(canOfferPlanReview(session("executing"), editedGate({ livePlanHash: "APPROVED" }))).toBe(
      false,
    );
    expect(canOfferPlanReview(session("executing"), undefined)).toBe(false);
  });
  it("is off entirely when the plan gate is off", () => {
    expect(canOfferPlanReview(session(null), editedGate())).toBe(false);
  });
});

describe("canTriggerPlanReview with an edited plan (#2224)", () => {
  it("an EDITED approved gate is startable in both phases", () => {
    expect(canTriggerPlanReview(session("planning"), editedGate(), false)).toBeNull();
    expect(canTriggerPlanReview(session("executing"), editedGate(), false)).toBeNull();
  });
  it("an in-flight review still wins over an edited gate", () => {
    expect(canTriggerPlanReview(session("executing"), editedGate(), true)).toBe("reviewing");
  });
  it("an UNEDITED approved gate still reads as blocked while planning", () => {
    expect(
      canTriggerPlanReview(session("planning"), editedGate({ livePlanHash: "APPROVED" }), false),
    ).toBe("approved");
  });
});

describe("planGateChip with an edited plan (#2224)", () => {
  it("an executing session with an edited approved plan shows the edited chip", () => {
    expect(planGateChip(session("executing"), editedGate(), false)).toEqual({ kind: "edited" });
  });
  it("an unedited executing session keeps the read-only view chip", () => {
    expect(
      planGateChip(session("executing"), editedGate({ livePlanHash: "APPROVED" }), false),
    ).toEqual({ kind: "view" });
  });
  it("the dense list surfaces still opt out entirely", () => {
    expect(planGateChip(session("executing"), editedGate(), false, { allowView: false })).toEqual({
      kind: "none",
    });
  });
  it("while planning an approved gate still reads as ready, edited or not", () => {
    expect(planGateChip(session("planning"), editedGate(), false)).toEqual({ kind: "ready" });
  });
});
