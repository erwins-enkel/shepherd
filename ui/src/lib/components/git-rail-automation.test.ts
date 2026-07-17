import { describe, it, expect } from "vitest";
import {
  automationCount,
  AUTOMATION_GROUPS,
  AUTOMATION_TOTAL,
  type AutomationFlags,
} from "./git-rail-automation";

const flags = (over: Partial<AutomationFlags> = {}): AutomationFlags => ({
  critic: false,
  criticAllPrs: false,
  smellLens: false,
  autoAddress: false,
  learnings: false,
  autopilot: false,
  autoDrain: false,
  autoMerge: false,
  buildQueue: false,
  planGate: false,
  draftMode: false,
  ...over,
});

describe("automationCount", () => {
  it("is 0 when everything is off", () => {
    expect(automationCount(flags())).toBe(0);
  });

  it("counts each independent automation", () => {
    expect(automationCount(flags({ critic: true }))).toBe(1);
    expect(automationCount(flags({ criticAllPrs: true }))).toBe(1);
    expect(automationCount(flags({ learnings: true, autopilot: true }))).toBe(2);
    expect(
      automationCount(flags({ critic: true, learnings: true, autopilot: true, autoDrain: true })),
    ).toBe(4);
    expect(automationCount(flags({ autoMerge: true }))).toBe(1);
    expect(automationCount(flags({ planGate: true }))).toBe(1);
  });

  it("does NOT count auto-address unless the critic is on (dependency)", () => {
    expect(automationCount(flags({ autoAddress: true }))).toBe(0);
    expect(automationCount(flags({ critic: true, autoAddress: true }))).toBe(2);
  });

  it("does NOT count the smell lens unless the critic is on (dependency)", () => {
    expect(automationCount(flags({ smellLens: true }))).toBe(0);
    expect(automationCount(flags({ critic: true, smellLens: true }))).toBe(2);
  });

  it("never exceeds 11", () => {
    expect(
      automationCount(
        flags({
          critic: true,
          criticAllPrs: true,
          smellLens: true,
          autoAddress: true,
          planGate: true,
          learnings: true,
          autopilot: true,
          autoDrain: true,
          autoMerge: true,
          buildQueue: true,
          draftMode: true,
        }),
      ),
    ).toBe(11);
  });

  it("counts draftMode independently", () => {
    expect(automationCount(flags({ draftMode: true }))).toBe(1);
  });
});

describe("AUTOMATION_GROUPS", () => {
  it("lists all eleven automation keys exactly once", () => {
    const keys = AUTOMATION_GROUPS.flatMap((g) => g.items);
    expect(keys).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
    expect(keys.sort()).toEqual(
      [
        "autoAddress",
        "autoDrain",
        "autoMerge",
        "autopilot",
        "buildQueue",
        "critic",
        "criticAllPrs",
        "smellLens",
        "draftMode",
        "learnings",
        "planGate",
      ].sort(),
    );
  });

  it("groups review / behavior / queue in order", () => {
    expect(AUTOMATION_GROUPS.map((g) => g.id)).toEqual(["review", "behavior", "queue"]);
    expect(AUTOMATION_GROUPS[0].items).toEqual([
      "critic",
      "criticAllPrs",
      "smellLens",
      "autoAddress",
      "planGate",
    ]);
    expect(AUTOMATION_GROUPS[1].items).toEqual(["learnings", "autopilot"]);
    expect(AUTOMATION_GROUPS[2].items).toEqual([
      "autoDrain",
      "autoMerge",
      "buildQueue",
      "draftMode",
    ]);
  });
});

describe("AUTOMATION_TOTAL", () => {
  it("is the item count across all groups (the pill denominator)", () => {
    expect(AUTOMATION_TOTAL).toBe(11);
    expect(AUTOMATION_TOTAL).toBe(AUTOMATION_GROUPS.flatMap((g) => g.items).length);
  });
});
