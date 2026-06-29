import { test, expect, describe } from "bun:test";
import {
  normalizeDefaultModelSetting,
  normalizeRepoDefaultModelSetting,
  resolveDefaultModelSetting,
  resolveRoleEnvironment,
  normalizeRoleCli,
  normalizeRoleModelToken,
  drainSpawnModel,
  spawnModelForAvailability,
  normalizeFableAvailable,
} from "../src/default-model";
import { MODELS } from "../src/types";

describe("normalizeDefaultModelSetting", () => {
  test("accepts 'auto'", () => {
    expect(normalizeDefaultModelSetting("auto")).toBe("auto");
  });

  test("accepts 'default'", () => {
    expect(normalizeDefaultModelSetting("default")).toBe("default");
  });

  test("accepts each MODELS alias", () => {
    for (const alias of MODELS) {
      expect(normalizeDefaultModelSetting(alias)).toBe(alias);
    }
  });

  test("returns null for unknown string", () => {
    expect(normalizeDefaultModelSetting("gpt4")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(normalizeDefaultModelSetting("")).toBeNull();
  });

  test("returns null for null", () => {
    expect(normalizeDefaultModelSetting(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(normalizeDefaultModelSetting(undefined)).toBeNull();
  });

  test("returns null for number", () => {
    expect(normalizeDefaultModelSetting(123)).toBeNull();
  });

  test("returns null for object", () => {
    expect(normalizeDefaultModelSetting({})).toBeNull();
  });
});

describe("drainSpawnModel", () => {
  test("'auto' → null", () => {
    expect(drainSpawnModel("auto")).toBeNull();
  });

  test("'default' → null", () => {
    expect(drainSpawnModel("default")).toBeNull();
  });

  test("'fable' → 'fable'", () => {
    expect(drainSpawnModel("fable")).toBe("fable");
  });

  test("'opus' → 'opus'", () => {
    expect(drainSpawnModel("opus")).toBe("opus");
  });

  test("'sonnet' → 'sonnet'", () => {
    expect(drainSpawnModel("sonnet")).toBe("sonnet");
  });

  test("'haiku' → 'haiku'", () => {
    expect(drainSpawnModel("haiku")).toBe("haiku");
  });

  test("1M aliases round-trip unchanged into the spawn flag", () => {
    // The drain/autopilot default-model setting space must accept and pass through
    // the bracketed 1M aliases so an operator can set 1M Opus/Sonnet as an unattended
    // default. Fails on pre-fix code (the aliases weren't in MODELS/SETTING_VALUES).
    expect(normalizeDefaultModelSetting("opus[1m]")).toBe("opus[1m]");
    expect(normalizeDefaultModelSetting("sonnet[1m]")).toBe("sonnet[1m]");
    expect(drainSpawnModel("opus[1m]")).toBe("opus[1m]");
    expect(drainSpawnModel("sonnet[1m]")).toBe("sonnet[1m]");
  });
});

describe("normalizeRepoDefaultModelSetting", () => {
  test("accepts 'inherit'", () => {
    expect(normalizeRepoDefaultModelSetting("inherit")).toBe("inherit");
  });

  test("accepts everything the global setting accepts", () => {
    for (const v of ["auto", "default", ...MODELS]) {
      expect(normalizeRepoDefaultModelSetting(v)).toBe(v);
    }
  });

  test("returns null for unknown / wrong type", () => {
    expect(normalizeRepoDefaultModelSetting("gpt4")).toBeNull();
    expect(normalizeRepoDefaultModelSetting("")).toBeNull();
    expect(normalizeRepoDefaultModelSetting(null)).toBeNull();
    expect(normalizeRepoDefaultModelSetting(123)).toBeNull();
  });
});

describe("resolveDefaultModelSetting", () => {
  test("'inherit' defers to the global setting", () => {
    expect(resolveDefaultModelSetting("inherit", "opus")).toBe("opus");
    expect(resolveDefaultModelSetting("inherit", "auto")).toBe("auto");
  });

  test("unset / invalid repo override defers to the global setting", () => {
    expect(resolveDefaultModelSetting(null, "sonnet")).toBe("sonnet");
    expect(resolveDefaultModelSetting(undefined, "sonnet")).toBe("sonnet");
    expect(resolveDefaultModelSetting("gpt4", "sonnet")).toBe("sonnet");
  });

  test("an explicit repo override wins over the global setting", () => {
    expect(resolveDefaultModelSetting("haiku", "opus")).toBe("haiku");
    expect(resolveDefaultModelSetting("default", "opus")).toBe("default");
    expect(resolveDefaultModelSetting("auto", "opus")).toBe("auto");
  });

  test("composed with drainSpawnModel: repo override drives the spawn flag", () => {
    expect(drainSpawnModel(resolveDefaultModelSetting("haiku", "auto"))).toBe("haiku");
    expect(drainSpawnModel(resolveDefaultModelSetting("inherit", "opus"))).toBe("opus");
    expect(drainSpawnModel(resolveDefaultModelSetting("inherit", "auto"))).toBeNull();
  });
});

describe("normalizeRoleCli", () => {
  test("accepts inherit + each provider", () => {
    expect(normalizeRoleCli("inherit")).toBe("inherit");
    expect(normalizeRoleCli("claude")).toBe("claude");
    expect(normalizeRoleCli("codex")).toBe("codex");
  });
  test("rejects unknown / wrong type", () => {
    expect(normalizeRoleCli("gpt")).toBeNull();
    expect(normalizeRoleCli("")).toBeNull();
    expect(normalizeRoleCli(42)).toBeNull();
  });
});

describe("normalizeRoleModelToken", () => {
  test("accepts 'default' + any provider alias", () => {
    expect(normalizeRoleModelToken("default")).toBe("default");
    expect(normalizeRoleModelToken("opus")).toBe("opus");
    expect(normalizeRoleModelToken("gpt-5.5")).toBe("gpt-5.5");
  });
  test("rejects unknown / wrong type", () => {
    expect(normalizeRoleModelToken("inherit")).toBeNull(); // inherit lives on the cli, not the model
    expect(normalizeRoleModelToken("gpt4")).toBeNull();
    expect(normalizeRoleModelToken(null)).toBeNull();
  });
});

describe("resolveRoleEnvironment", () => {
  // cli "inherit" follows the global provider + model; with the shipped "auto" global model this is
  // the provider default (null = no --model) — i.e. today's critic/planner/doc-agent behavior.
  test("cli 'inherit' + global 'auto' → global provider, null model", () => {
    expect(resolveRoleEnvironment("inherit", "default", "claude", "auto", true)).toEqual({
      provider: "claude",
      model: null,
    });
  });

  test("cli 'inherit' follows the global provider AND model", () => {
    expect(resolveRoleEnvironment("inherit", "default", "claude", "opus", true)).toEqual({
      provider: "claude",
      model: "opus",
    });
    expect(resolveRoleEnvironment("inherit", "default", "codex", "auto", true)).toEqual({
      provider: "codex",
      model: null,
    });
  });

  test("explicit cli + model wins over the global default", () => {
    expect(resolveRoleEnvironment("claude", "haiku", "claude", "opus", true)).toEqual({
      provider: "claude",
      model: "haiku",
    });
    expect(resolveRoleEnvironment("codex", "gpt-5.5", "claude", "opus", true)).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  test("explicit cli + 'default' model → null (provider default)", () => {
    expect(resolveRoleEnvironment("codex", "default", "claude", "opus", true)).toEqual({
      provider: "codex",
      model: null,
    });
  });

  test("clamp: a model not in the chosen provider's list → null (provider default)", () => {
    // opus is a Claude alias, not a Codex one → clamped away when cli is codex.
    expect(resolveRoleEnvironment("codex", "opus", "claude", "auto", true)).toEqual({
      provider: "codex",
      model: null,
    });
  });

  test("unset / invalid cli defers to the global", () => {
    expect(resolveRoleEnvironment(null, "haiku", "claude", "sonnet", true)).toEqual({
      provider: "claude",
      model: "sonnet",
    });
    expect(resolveRoleEnvironment("gpt", "haiku", "claude", "sonnet", true)).toEqual({
      provider: "claude",
      model: "sonnet",
    });
  });

  test("fable substitution applies at the role layer when unavailable", () => {
    expect(resolveRoleEnvironment("claude", "fable", "claude", "auto", false)).toEqual({
      provider: "claude",
      model: "opus[1m]",
    });
    expect(resolveRoleEnvironment("claude", "fable", "claude", "auto", true)).toEqual({
      provider: "claude",
      model: "fable",
    });
    // inherited fable from the global default also substitutes
    expect(resolveRoleEnvironment("inherit", "default", "claude", "fable", false)).toEqual({
      provider: "claude",
      model: "opus[1m]",
    });
  });
});

describe("spawnModelForAvailability", () => {
  test("fable unavailable → opus[1m]", () => {
    expect(spawnModelForAvailability("fable", false)).toBe("opus[1m]");
  });

  test("fable available → fable", () => {
    expect(spawnModelForAvailability("fable", true)).toBe("fable");
  });

  test("non-fable model unaffected when unavailable", () => {
    expect(spawnModelForAvailability("opus", false)).toBe("opus");
  });

  test("null model unaffected when unavailable", () => {
    expect(spawnModelForAvailability(null, false)).toBeNull();
  });

  test("opus[1m] unaffected when fable unavailable", () => {
    expect(spawnModelForAvailability("opus[1m]", false)).toBe("opus[1m]");
  });
});

describe("normalizeFableAvailable", () => {
  test("true → true", () => expect(normalizeFableAvailable(true)).toBe(true));
  test('"true" → true', () => expect(normalizeFableAvailable("true")).toBe(true));
  test('"1" → true', () => expect(normalizeFableAvailable("1")).toBe(true));
  test("false → false", () => expect(normalizeFableAvailable(false)).toBe(false));
  test('"false" → false', () => expect(normalizeFableAvailable("false")).toBe(false));
  test('"0" → false', () => expect(normalizeFableAvailable("0")).toBe(false));
  test('"nonsense" → null', () => expect(normalizeFableAvailable("nonsense")).toBeNull());
  test("undefined → null", () => expect(normalizeFableAvailable(undefined)).toBeNull());
  test("42 → null", () => expect(normalizeFableAvailable(42)).toBeNull());
});
