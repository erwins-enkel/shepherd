import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, expect, describe } from "bun:test";
import {
  normalizeDefaultCodexModelSetting,
  normalizeDefaultModelSetting,
  normalizeRepoDefaultModelSetting,
  resolveDefaultModelSetting,
  resolveRoleEnvironment,
  resolveRoleEnvWithAuth,
  clampCodexModelForAuth,
  CHATGPT_INCOMPATIBLE_CODEX_MODELS,
  normalizeRoleCli,
  normalizeRoleModelToken,
  drainSpawnModel,
  spawnModelForAvailability,
  normalizeFableAvailable,
  modelCompatibleWithProvider,
  modelForProviderOrDefault,
  resolveProviderDefaultModelSetting,
} from "../src/default-model";
import { readCodexAuthMode } from "../src/codex-auth";
import { CODEX_MODELS, MODELS } from "../src/types";

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

describe("normalizeDefaultCodexModelSetting", () => {
  test("accepts 'default' and each curated Codex model", () => {
    expect(normalizeDefaultCodexModelSetting("default")).toBe("default");
    for (const model of CODEX_MODELS) {
      expect(normalizeDefaultCodexModelSetting(model)).toBe(model);
    }
  });

  test("rejects Claude models, auto, unknown values, and wrong types", () => {
    expect(normalizeDefaultCodexModelSetting("opus")).toBeNull();
    expect(normalizeDefaultCodexModelSetting("auto")).toBeNull();
    expect(normalizeDefaultCodexModelSetting("gpt-6-unknown")).toBeNull();
    expect(normalizeDefaultCodexModelSetting(null)).toBeNull();
  });
});

describe("resolveProviderDefaultModelSetting", () => {
  test("inherits the selected provider's saved model", () => {
    expect(resolveProviderDefaultModelSetting("inherit", "claude", "opus", "gpt-5.4")).toBe("opus");
    expect(resolveProviderDefaultModelSetting("inherit", "codex", "opus", "gpt-5.4")).toBe(
      "gpt-5.4",
    );
  });

  test("uses a compatible repo override", () => {
    expect(resolveProviderDefaultModelSetting("haiku", "claude", "opus", "gpt-5.4")).toBe("haiku");
    expect(resolveProviderDefaultModelSetting("default", "codex", "opus", "gpt-5.4")).toBe(
      "default",
    );
  });

  test("falls back to the selected provider's saved model for an incompatible override", () => {
    expect(resolveProviderDefaultModelSetting("opus", "codex", "sonnet", "gpt-5.4")).toBe(
      "gpt-5.4",
    );
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

describe("modelCompatibleWithProvider", () => {
  test("known Claude aliases are not accepted through Codex's future-alias regex", () => {
    expect(modelCompatibleWithProvider("opus", "codex")).toBe(false);
    expect(modelCompatibleWithProvider("opus[1m]", "codex")).toBe(false);
    expect(modelForProviderOrDefault("opus", "codex")).toBeNull();
  });

  test("Codex accepts curated aliases and safe future aliases", () => {
    expect(modelCompatibleWithProvider("gpt-5.5", "codex")).toBe(true);
    expect(modelCompatibleWithProvider("gpt-5.6-sol", "codex")).toBe(true);
    expect(modelCompatibleWithProvider("gpt-5.6-terra", "codex")).toBe(true);
    expect(modelCompatibleWithProvider("gpt-5.6-luna", "codex")).toBe(true);
    expect(modelCompatibleWithProvider("gpt-5.6-codex", "codex")).toBe(true);
  });

  test("Claude accepts only Claude aliases", () => {
    expect(modelCompatibleWithProvider("opus", "claude")).toBe(true);
    expect(modelCompatibleWithProvider("gpt-5.5", "claude")).toBe(false);
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
    expect(resolveRoleEnvironment("inherit", "default", "claude", "auto", true, "default")).toEqual(
      {
        provider: "claude",
        model: null,
        effort: null,
      },
    );
  });

  test("cli 'inherit' follows the global provider AND model", () => {
    expect(resolveRoleEnvironment("inherit", "default", "claude", "opus", true, "default")).toEqual(
      {
        provider: "claude",
        model: "opus",
        effort: null,
      },
    );
    expect(resolveRoleEnvironment("inherit", "default", "codex", "auto", true, "default")).toEqual({
      provider: "codex",
      model: null,
      effort: null,
    });
  });

  test("explicit cli + model wins over the global default", () => {
    expect(resolveRoleEnvironment("claude", "haiku", "claude", "opus", true, "default")).toEqual({
      provider: "claude",
      model: "haiku",
      effort: null,
    });
    expect(resolveRoleEnvironment("codex", "gpt-5.5", "claude", "opus", true, "default")).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      effort: null,
    });
  });

  test("explicit cli + 'default' model → null (provider default)", () => {
    expect(resolveRoleEnvironment("codex", "default", "claude", "opus", true, "default")).toEqual({
      provider: "codex",
      model: null,
      effort: null,
    });
  });

  test("clamp: a model not in the chosen provider's list → null (provider default)", () => {
    // opus is a Claude alias, not a Codex one → clamped away when cli is codex.
    expect(resolveRoleEnvironment("codex", "opus", "claude", "auto", true, "default")).toEqual({
      provider: "codex",
      model: null,
      effort: null,
    });
  });

  test("unset / invalid cli defers to the global", () => {
    expect(resolveRoleEnvironment(null, "haiku", "claude", "sonnet", true, "default")).toEqual({
      provider: "claude",
      model: "sonnet",
      effort: null,
    });
    expect(resolveRoleEnvironment("gpt", "haiku", "claude", "sonnet", true, "default")).toEqual({
      provider: "claude",
      model: "sonnet",
      effort: null,
    });
  });

  test("fable substitution applies at the role layer when unavailable", () => {
    expect(resolveRoleEnvironment("claude", "fable", "claude", "auto", false, "default")).toEqual({
      provider: "claude",
      model: "opus[1m]",
      effort: null,
    });
    expect(resolveRoleEnvironment("claude", "fable", "claude", "auto", true, "default")).toEqual({
      provider: "claude",
      model: "fable",
      effort: null,
    });
    // inherited fable from the global default also substitutes
    expect(
      resolveRoleEnvironment("inherit", "default", "claude", "fable", false, "default"),
    ).toEqual({
      provider: "claude",
      model: "opus[1m]",
      effort: null,
    });
  });

  // Efficacy for the per-role effort override (issue #1418): the resolved effort must reach BOTH
  // the "inherit" branch (cli inherit/unrecognized → global provider+model) and the explicit
  // branch (cli is a concrete provider) — the effort resolution is orthogonal to the cli branch.
  test("roleEffort resolves to the tier on the inherit branch", () => {
    expect(resolveRoleEnvironment("inherit", "default", "claude", "auto", true, "high")).toEqual({
      provider: "claude",
      model: null,
      effort: "high",
    });
  });

  test("roleEffort resolves to the tier on the explicit branch", () => {
    expect(resolveRoleEnvironment("claude", "haiku", "claude", "opus", true, "xhigh")).toEqual({
      provider: "claude",
      model: "haiku",
      effort: "xhigh",
    });
  });

  test('roleEffort "default" → null effort on both branches', () => {
    expect(
      resolveRoleEnvironment("inherit", "default", "claude", "auto", true, "default").effort,
    ).toBeNull();
    expect(
      resolveRoleEnvironment("claude", "haiku", "claude", "opus", true, "default").effort,
    ).toBeNull();
  });

  test("roleEffort junk/unset → null effort on both branches", () => {
    expect(
      resolveRoleEnvironment("inherit", "default", "claude", "auto", true, "bogus").effort,
    ).toBeNull();
    expect(
      resolveRoleEnvironment("claude", "haiku", "claude", "opus", true, undefined).effort,
    ).toBeNull();
    expect(
      resolveRoleEnvironment("claude", "haiku", "claude", "opus", true, null).effort,
    ).toBeNull();
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

describe("clampCodexModelForAuth", () => {
  const blocked = [...CHATGPT_INCOMPATIBLE_CODEX_MODELS][0]!;

  test("codex + chatgpt + blocklisted model → null (use account default)", () => {
    expect(clampCodexModelForAuth(blocked, "codex", "chatgpt")).toBeNull();
  });
  test("codex + chatgpt + non-blocklisted model → unchanged", () => {
    expect(clampCodexModelForAuth("gpt-5.5", "codex", "chatgpt")).toBe("gpt-5.5");
    expect(clampCodexModelForAuth("gpt-5.6-sol", "codex", "chatgpt")).toBe("gpt-5.6-sol");
    expect(clampCodexModelForAuth("gpt-5.6-terra", "codex", "chatgpt")).toBe("gpt-5.6-terra");
    expect(clampCodexModelForAuth("gpt-5.6-luna", "codex", "chatgpt")).toBe("gpt-5.6-luna");
  });
  test("codex + apikey → unchanged even for a blocklisted model", () => {
    expect(clampCodexModelForAuth(blocked, "codex", "apikey")).toBe(blocked);
  });
  test("codex + unknown → unchanged (fail-open)", () => {
    expect(clampCodexModelForAuth(blocked, "codex", "unknown")).toBe(blocked);
  });
  test("claude provider is never clamped", () => {
    expect(clampCodexModelForAuth(blocked, "claude", "chatgpt")).toBe(blocked);
  });
  test("null model stays null", () => {
    expect(clampCodexModelForAuth(null, "codex", "chatgpt")).toBeNull();
  });
});

describe("resolveRoleEnvironment codexAuthMode clamp", () => {
  const blocked = [...CHATGPT_INCOMPATIBLE_CODEX_MODELS][0]!;

  test("explicit codex role + blocklisted model under chatgpt → model null", () => {
    expect(
      resolveRoleEnvironment("codex", blocked, "claude", "opus", true, "default", "chatgpt"),
    ).toEqual({ provider: "codex", model: null, effort: null });
  });
  test("same config under apikey → model unchanged", () => {
    expect(
      resolveRoleEnvironment("codex", blocked, "claude", "opus", true, "default", "apikey"),
    ).toEqual({ provider: "codex", model: blocked, effort: null });
  });
  test("inherit/global branch also clamps a codex global default", () => {
    expect(
      resolveRoleEnvironment("inherit", "default", "codex", blocked, true, "default", "chatgpt"),
    ).toEqual({ provider: "codex", model: null, effort: null });
  });
  test("omitted authMode defaults to unknown → no clamp (backward-compatible)", () => {
    expect(resolveRoleEnvironment("codex", blocked, "claude", "opus", true, "default")).toEqual({
      provider: "codex",
      model: blocked,
      effort: null,
    });
  });
});

describe("resolveRoleEnvWithAuth (real reader→resolver seam)", () => {
  const blocked = [...CHATGPT_INCOMPATIBLE_CODEX_MODELS][0]!;
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  function chatgptAuthDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "roleenv-auth-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "abc" }, OPENAI_API_KEY: null }),
    );
    return dir;
  }

  test("a recap-shaped codex role resolves to model null when the injected reader detects chatgpt", () => {
    const dir = chatgptAuthDir();
    expect(
      resolveRoleEnvWithAuth(
        {
          roleCli: "codex",
          roleModel: blocked,
          globalProvider: "claude",
          globalModelSetting: "opus",
          fableAvailable: true,
          roleEffort: "low",
        },
        () => readCodexAuthMode(dir),
      ),
    ).toEqual({ provider: "codex", model: null, effort: "low" });
  });

  test("with an injected apikey reader the same role keeps its pinned model", () => {
    expect(
      resolveRoleEnvWithAuth(
        {
          roleCli: "codex",
          roleModel: blocked,
          globalProvider: "claude",
          globalModelSetting: "opus",
          fableAvailable: true,
          roleEffort: "low",
        },
        () => "apikey",
      ),
    ).toEqual({ provider: "codex", model: blocked, effort: "low" });
  });
});
