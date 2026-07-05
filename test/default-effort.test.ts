import { test, expect, describe } from "bun:test";
import {
  normalizeEffort,
  normalizeDefaultEffortSetting,
  normalizeRepoDefaultEffortSetting,
  resolveDefaultEffortSetting,
  drainSpawnEffort,
  effortForSpawn,
  effortsForProvider,
  effortBelowHigh,
} from "../src/default-effort";
import { EFFORTS } from "../src/types";

describe("normalizeEffort", () => {
  test("accepts each EFFORTS tier", () => {
    for (const tier of EFFORTS) expect(normalizeEffort(tier)).toBe(tier);
  });
  test("rejects the settings sentinels and junk", () => {
    for (const v of ["default", "inherit", "minimal", "", "gpt4", null, undefined, 3])
      expect(normalizeEffort(v)).toBeNull();
  });
});

describe("normalizeDefaultEffortSetting", () => {
  test("accepts 'default'", () => {
    expect(normalizeDefaultEffortSetting("default")).toBe("default");
  });
  test("accepts each EFFORTS tier", () => {
    for (const tier of EFFORTS) expect(normalizeDefaultEffortSetting(tier)).toBe(tier);
  });
  test("rejects 'inherit', 'auto', junk, non-strings", () => {
    for (const v of ["inherit", "auto", "minimal", "", null, undefined, 1])
      expect(normalizeDefaultEffortSetting(v)).toBeNull();
  });
});

describe("normalizeRepoDefaultEffortSetting", () => {
  test("accepts 'inherit', 'default', each tier", () => {
    for (const v of ["inherit", "default", ...EFFORTS])
      expect(normalizeRepoDefaultEffortSetting(v)).toBe(v);
  });
  test("rejects 'auto', junk, non-strings", () => {
    for (const v of ["auto", "minimal", "", null, undefined])
      expect(normalizeRepoDefaultEffortSetting(v)).toBeNull();
  });
});

describe("drainSpawnEffort", () => {
  test("'default' → null (no flag)", () => {
    expect(drainSpawnEffort("default")).toBeNull();
  });
  test("each tier passes through", () => {
    for (const tier of EFFORTS) expect(drainSpawnEffort(tier)).toBe(tier);
  });
});

describe("resolveDefaultEffortSetting (session/repo/global precedence)", () => {
  test("repo override wins when not 'inherit'", () => {
    expect(resolveDefaultEffortSetting("high", "default")).toBe("high");
    expect(resolveDefaultEffortSetting("low", "max")).toBe("low");
  });
  test("'inherit' / unset / invalid defer to global", () => {
    expect(resolveDefaultEffortSetting("inherit", "high")).toBe("high");
    expect(resolveDefaultEffortSetting(null, "medium")).toBe("medium");
    expect(resolveDefaultEffortSetting(undefined, "default")).toBe("default");
    expect(resolveDefaultEffortSetting("bogus", "xhigh")).toBe("xhigh");
  });
});

describe("effortForSpawn (argv-build seam)", () => {
  test("null / unrecognised → null (no flag)", () => {
    expect(effortForSpawn("claude", null)).toBeNull();
    expect(effortForSpawn("claude", "bogus")).toBeNull();
    expect(effortForSpawn("codex", "minimal")).toBeNull();
  });
  test("Claude passes every tier through (CLI self-clamps unsupported models)", () => {
    for (const tier of EFFORTS) expect(effortForSpawn("claude", tier)).toBe(tier);
  });
  test("Codex clamps xhigh/max → high, others pass through", () => {
    expect(effortForSpawn("codex", "xhigh")).toBe("high");
    expect(effortForSpawn("codex", "max")).toBe("high");
    expect(effortForSpawn("codex", "low")).toBe("low");
    expect(effortForSpawn("codex", "medium")).toBe("medium");
    expect(effortForSpawn("codex", "high")).toBe("high");
  });
});

describe("effortsForProvider", () => {
  test("Claude exposes all tiers", () => {
    expect(effortsForProvider("claude")).toEqual(EFFORTS);
  });
  test("Codex hides xhigh and max", () => {
    expect(effortsForProvider("codex")).toEqual(["low", "medium", "high"]);
  });
});

describe("effortBelowHigh (critic guardrail)", () => {
  test("low and medium tiers are below high", () => {
    expect(effortBelowHigh("low")).toBe(true);
    expect(effortBelowHigh("medium")).toBe(true);
  });
  test("'default' is treated as below high (no --effort flag → CLI's below-high native default)", () => {
    expect(effortBelowHigh("default")).toBe(true);
  });
  test("high, xhigh and max are not below high", () => {
    expect(effortBelowHigh("high")).toBe(false);
    expect(effortBelowHigh("xhigh")).toBe(false);
    expect(effortBelowHigh("max")).toBe(false);
  });
  test("unknown/junk strings are not below high", () => {
    for (const v of ["inherit", "minimal", "", "gpt4"]) expect(effortBelowHigh(v)).toBe(false);
  });
});
