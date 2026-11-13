import { describe, expect, it } from "vitest";
import { relaunchOverrides } from "./relaunch-payload";

describe("Relaunch Task payload", () => {
  const base = {
    repoPath: "/repo/other",
    baseBranch: "main",
    prompt: "do the thing",
    model: null,
    effort: null,
    images: [],
    planGateEnabled: null,
  };

  for (const autopilotEnabled of [null, true, false]) {
    it(`forwards autopilotEnabled=${String(autopilotEnabled)}`, () => {
      expect(relaunchOverrides({ ...base, autopilotEnabled })).toMatchObject({
        autopilotEnabled,
      });
    });
  }

  it("forwards a picked sandboxProfile", () => {
    expect(
      relaunchOverrides({ ...base, autopilotEnabled: null, sandboxProfile: "trusted" }),
    ).toMatchObject({ sandboxProfile: "trusted" });
  });

  it("sends an explicit null sandboxProfile for Default (inherit, never re-carry)", () => {
    expect(relaunchOverrides({ ...base, autopilotEnabled: null })).toMatchObject({
      sandboxProfile: null,
    });
  });
});
