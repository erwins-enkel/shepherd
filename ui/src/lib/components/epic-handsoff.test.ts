import { describe, it, expect } from "vitest";
import { handsOffPatch, handsOffDelta, handsOffReady, type HandsOffFlags } from "./epic-handsoff";

const ALL_OFF: HandsOffFlags = {
  autopilot: false,
  autoMerge: false,
  draftMode: false,
  critic: false,
  autoAddress: false,
  planGate: false,
  epicModeAuto: false,
};

const ALL_RECOMMENDED: HandsOffFlags = {
  autopilot: true,
  autoMerge: true,
  draftMode: false,
  critic: true,
  autoAddress: true,
  planGate: true,
  epicModeAuto: true,
};

describe("handsOffPatch", () => {
  it("sets Autopilot, Full-auto merge (Draft off), Critic, Auto-Address", () => {
    expect(handsOffPatch()).toEqual({
      autopilotEnabled: true,
      autoMergeEnabled: true,
      draftMode: false,
      criticEnabled: true,
      autoAddressEnabled: true,
    });
  });

  it("never includes planGateEnabled (recommended ON — Apply must not flip it)", () => {
    expect(handsOffPatch()).not.toHaveProperty("planGateEnabled");
  });
});

describe("handsOffDelta", () => {
  it("flags every recommended setting as not-ok when all are off", () => {
    const delta = handsOffDelta(ALL_OFF);
    for (const item of delta) expect(item.ok).toBe(false);
  });

  it("marks every setting ok when the config already matches the recommendation", () => {
    const delta = handsOffDelta(ALL_RECOMMENDED);
    for (const item of delta) expect(item.ok).toBe(true);
  });

  it("treats Full-auto merge as not-ok while Draft mode is on (mutually exclusive)", () => {
    const item = handsOffDelta({ ...ALL_RECOMMENDED, draftMode: true }).find(
      (i) => i.key === "automerge",
    );
    expect(item?.ok).toBe(false);
  });

  it("marks plan gate as informational — not applied by one-click", () => {
    const item = handsOffDelta(ALL_OFF).find((i) => i.key === "plangate");
    expect(item?.appliedByOneClick).toBe(false);
  });

  it("marks the applied settings as appliedByOneClick", () => {
    const applied = handsOffDelta(ALL_OFF)
      .filter((i) => i.appliedByOneClick)
      .map((i) => i.key)
      .sort();
    expect(applied).toEqual(["autoaddress", "automerge", "autopilot", "critic", "epicmode"]);
  });
});

describe("handsOffReady", () => {
  it("is true only when every recommendation is satisfied", () => {
    expect(handsOffReady(ALL_RECOMMENDED)).toBe(true);
    expect(handsOffReady(ALL_OFF)).toBe(false);
    expect(handsOffReady({ ...ALL_RECOMMENDED, planGate: false })).toBe(false);
  });
});
