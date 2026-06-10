import { test, expect, describe } from "bun:test";
import { normalizeDefaultModelSetting, drainSpawnModel } from "../src/default-model";
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
