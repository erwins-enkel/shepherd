import { describe, expect, it } from "vitest";
import {
  AUTONOMY_LEVELS,
  autonomyChain,
  autonomyLevelOf,
  autonomyPatch,
  levelNeedsForge,
  type AutonomyLevel,
} from "./autonomy";
import type { AutomationFlags } from "./components/git-rail-automation";

const OFF: AutomationFlags = {
  critic: false,
  criticAllPrs: false,
  smellLens: false,
  autoAddress: false,
  planGate: false,
  autopilot: false,
  autoDrain: false,
  autoMerge: false,
  buildQueue: false,
  draftMode: false,
};

/** The flags a repo holds after a level's patch landed on `base`. */
function flagsAfter(level: AutonomyLevel, base: AutomationFlags = OFF): AutomationFlags {
  const p = autonomyPatch(level);
  return {
    ...base,
    critic: p.criticEnabled,
    autoAddress: p.autoAddressEnabled,
    autopilot: p.autopilotEnabled,
    autoDrain: p.autoDrainEnabled,
    draftMode: p.draftMode,
    autoMerge: p.autoMergeEnabled,
  };
}

describe("autonomyPatch", () => {
  it("writes exactly the five values, the merge mode as both of its fields", () => {
    for (const level of AUTONOMY_LEVELS)
      expect(Object.keys(autonomyPatch(level)).sort()).toEqual([
        "autoAddressEnabled",
        "autoDrainEnabled",
        "autoMergeEnabled",
        "autopilotEnabled",
        "criticEnabled",
        "draftMode",
      ]);
  });

  it("sets each level's values", () => {
    expect(autonomyPatch("onCall")).toEqual({
      criticEnabled: false,
      autoAddressEnabled: false,
      autopilotEnabled: false,
      autoDrainEnabled: false,
      draftMode: false,
      autoMergeEnabled: false,
    });
    expect(autonomyPatch("review")).toEqual({
      criticEnabled: true,
      autoAddressEnabled: true,
      autopilotEnabled: true,
      autoDrainEnabled: false,
      draftMode: false,
      autoMergeEnabled: false,
    });
    expect(autonomyPatch("backlog")).toEqual({
      criticEnabled: true,
      autoAddressEnabled: true,
      autopilotEnabled: true,
      autoDrainEnabled: true,
      draftMode: false,
      autoMergeEnabled: false,
    });
    expect(autonomyPatch("full")).toEqual({
      criticEnabled: true,
      autoAddressEnabled: true,
      autopilotEnabled: true,
      autoDrainEnabled: true,
      draftMode: false,
      autoMergeEnabled: true,
    });
  });
});

describe("autonomyLevelOf", () => {
  it("reads each level back from the config its patch leaves, whatever else is set", () => {
    const busy = { ...OFF, planGate: true, buildQueue: true, smellLens: true, criticAllPrs: true };
    for (const level of AUTONOMY_LEVELS) {
      expect(autonomyLevelOf(flagsAfter(level), false)).toBe(level);
      expect(autonomyLevelOf(flagsAfter(level, busy), false)).toBe(level);
    }
  });

  it("is a custom mix when the five values match no level", () => {
    // Draft until sign-off is no level's merge mode
    expect(autonomyLevelOf({ ...flagsAfter("review"), draftMode: true }, false)).toBe("custom");
    // the drain without Autopilot
    expect(autonomyLevelOf({ ...flagsAfter("backlog"), autopilot: false }, false)).toBe("custom");
    // Autopilot alone
    expect(autonomyLevelOf({ ...OFF, autopilot: true }, false)).toBe("custom");
    // full-auto merge without the drain
    expect(autonomyLevelOf({ ...flagsAfter("review"), autoMerge: true }, false)).toBe("custom");
  });

  it("reads the values as they take effect", () => {
    // Auto-Address does nothing without the Critic
    expect(autonomyLevelOf({ ...OFF, autoAddress: true }, false)).toBe("onCall");
    // a local-only repo never drains, so a stored drain reads as With review
    expect(autonomyLevelOf(flagsAfter("backlog"), true)).toBe("review");
    // and has no draft PRs: a stored draft means you merge
    expect(autonomyLevelOf({ ...flagsAfter("review"), draftMode: true }, true)).toBe("review");
    // full-auto merge works there, but without the drain it is no level
    expect(autonomyLevelOf(flagsAfter("full"), true)).toBe("custom");
  });
});

describe("levelNeedsForge", () => {
  it("names the levels that need Auto-Drain", () => {
    expect(AUTONOMY_LEVELS.filter(levelNeedsForge)).toEqual(["backlog", "full"]);
  });
});

describe("autonomyChain", () => {
  it("hands each step to Shepherd as the levels climb", () => {
    expect(autonomyChain(flagsAfter("onCall"), false)).toEqual({
      pickup: "you",
      plan: "you",
      stops: "you",
      review: "you",
      fix: "you",
      merge: "you",
    });
    expect(autonomyChain(flagsAfter("review"), false)).toEqual({
      pickup: "you",
      plan: "you",
      stops: "shepherd",
      review: "shepherd",
      fix: "shepherd",
      merge: "you",
    });
    expect(autonomyChain(flagsAfter("backlog"), false).pickup).toBe("shepherd");
    expect(autonomyChain(flagsAfter("full"), false).merge).toBe("shepherd");
  });

  it("follows the plan gate, which no level sets", () => {
    expect(autonomyChain({ ...flagsAfter("onCall"), planGate: true }, false).plan).toBe("shepherd");
  });

  it("reads the effective values", () => {
    expect(autonomyChain({ ...OFF, autoAddress: true }, false).fix).toBe("you");
    expect(autonomyChain(flagsAfter("full"), true).pickup).toBe("you");
    expect(autonomyChain({ ...OFF, draftMode: true }, false).merge).toBe("you");
  });
});
