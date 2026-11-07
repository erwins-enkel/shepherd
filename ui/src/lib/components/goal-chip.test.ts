import { describe, it, expect } from "vitest";
import { goalChip } from "./goal-chip";
import type { Session } from "#lib/types.js";

type GoalFields = Pick<Session, "planPhase" | "goalState" | "goalCondition">;
const s = (p: Partial<GoalFields>): GoalFields => ({ planPhase: null, ...p });

describe("goalChip", () => {
  it("held while planning shows the held chip", () => {
    expect(
      goalChip(s({ planPhase: "planning", goalState: "held", goalCondition: "tests pass" })),
    ).toEqual({
      kind: "held",
      condition: "tests pass",
    });
  });
  it("held outside planning shows nothing", () => {
    expect(goalChip(s({ planPhase: "executing", goalState: "held", goalCondition: "x" }))).toEqual({
      kind: "none",
    });
    expect(goalChip(s({ planPhase: null, goalState: "held", goalCondition: "x" }))).toEqual({
      kind: "none",
    });
  });
  it("active shows in any phase", () => {
    for (const planPhase of ["planning", "executing", null] as const) {
      expect(goalChip(s({ planPhase, goalState: "active", goalCondition: "x" }))).toEqual({
        kind: "active",
        condition: "x",
      });
    }
  });
  it("missing, blank or null condition shows nothing", () => {
    expect(goalChip(s({ planPhase: "planning", goalState: "held" }))).toEqual({ kind: "none" });
    expect(goalChip(s({ goalState: "active", goalCondition: null }))).toEqual({ kind: "none" });
    expect(goalChip(s({ goalState: "active", goalCondition: "   " }))).toEqual({ kind: "none" });
  });
  it("no goal state shows nothing", () => {
    expect(goalChip(s({ goalCondition: "x" }))).toEqual({ kind: "none" });
    expect(goalChip(s({ goalState: null, goalCondition: "x" }))).toEqual({ kind: "none" });
  });
  it("trims the condition", () => {
    expect(goalChip(s({ goalState: "active", goalCondition: "  ship it \n" }))).toEqual({
      kind: "active",
      condition: "ship it",
    });
  });
});
