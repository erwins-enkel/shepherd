import { describe, expect, test } from "bun:test";
import {
  convert,
  duplicateKeys,
  KEYS,
  KEYS_ACTIONS,
  KEYS_COMPOSE,
  KEYS_CORE,
  KEYS_DETAIL,
  KEYS_HERD,
  KEYS_LOCALSERVER,
  KEYS_MERGE,
  KEYS_NOTIFICATIONS,
  KEYS_PLAN,
  KEYS_QUEUES,
  KEYS_SETTINGS,
  KEYS_SIDEBAR,
  KEYS_TERMINAL,
  placeholderOrder,
} from "../native/scripts/gen-strings";

describe("gen-strings convert", () => {
  test("a literal % with no placeholder is left alone", () => {
    const order = placeholderOrder("no placeholders here");
    expect(convert("50% off", order)).toBe("50% off");
  });

  test("a placeholder string keeps %1$@ and escapes other %", () => {
    const order = placeholderOrder("{name} gets 50% off");
    expect(convert("{name} gets 50% off", order)).toBe("%1$@ gets 50%% off");
  });

  test("the same placeholder used twice numbers once and repeats", () => {
    const order = placeholderOrder("{a} {a}");
    expect(convert("{a} {a}", order)).toBe("%1$@ %1$@");
  });

  test("a placeholder present only in the DE string throws", () => {
    // The EN string carries no placeholders, so `order` is empty; converting
    // a DE string that introduces one anyway is a genuine authoring error
    // (mismatched locales), not a % to escape.
    const order = placeholderOrder("no placeholders here");
    expect(() => convert("{name} nur auf Deutsch", order)).toThrow(/unknown placeholder \{name\}/);
  });
});

describe("gen-strings manifest", () => {
  const streamManifests = [
    KEYS_TERMINAL,
    KEYS_DETAIL,
    KEYS_SIDEBAR,
    KEYS_ACTIONS,
    KEYS_LOCALSERVER,
    KEYS_NOTIFICATIONS,
    KEYS_HERD,
    KEYS_PLAN,
    KEYS_MERGE,
    KEYS_QUEUES,
    KEYS_COMPOSE,
    KEYS_SETTINGS,
  ];

  test("KEYS is exactly the per-stream manifests concatenated, in a fixed order", () => {
    expect([...KEYS]).toEqual([...KEYS_CORE, ...streamManifests.flat()]);
  });

  // Not "every stream manifest is empty": that was true only until the first
  // stream landed, and would have failed that stream's own branch. What holds
  // forever is that a stream manifest is a list of its own keys — no repeats
  // inside it, nothing it shares with the core.
  test("the core manifest is never empty", () => {
    expect(KEYS_CORE.length).toBeGreaterThan(0);
  });

  test("each stream manifest is a list of unique keys, disjoint from the core", () => {
    const core = new Set(KEYS_CORE);
    for (const manifest of streamManifests) {
      expect(Array.isArray(manifest)).toBe(true);
      expect(duplicateKeys(manifest)).toEqual([]);
      expect([...manifest].filter((key) => core.has(key))).toEqual([]);
    }
  });

  test("the core manifest stays alphabetical", () => {
    expect([...KEYS_CORE]).toEqual([...KEYS_CORE].sort());
  });

  test("no key is claimed by two manifests", () => {
    expect(duplicateKeys(KEYS)).toEqual([]);
    expect(duplicateKeys(["b", "a", "b", "a", "c"])).toEqual(["a", "b"]);
  });
});
