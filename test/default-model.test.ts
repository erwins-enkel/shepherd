import { test, expect, describe } from "bun:test";
import {
  normalizeDefaultModelSetting,
  normalizeRepoDefaultModelSetting,
  resolveDefaultModelSetting,
  drainSpawnModel,
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
