import { describe, it, expect } from "vitest";
import { handsOffPatch, handsOffDelta, type HandsOffFlags } from "./epic-handsoff";

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

  it("covers every recommended setting exactly once", () => {
    const keys = handsOffDelta(ALL_OFF)
      .map((i) => i.key)
      .sort();
    expect(keys).toEqual([
      "autoaddress",
      "automerge",
      "autopilot",
      "critic",
      "epicmode",
      "plangate",
    ]);
  });
});
