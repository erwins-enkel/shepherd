import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  buildOutputs,
  renderStrings,
  staleOutputs,
  stringsLiteral,
} from "../native/scripts/gen-strings";
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

describe("gen-strings core resources", () => {
  test("strings source escapes syntax and controls", () => {
    expect(stringsLiteral('a"b\\c\n\r\t\u0001')).toBe('"a\\"b\\\\c\\n\\r\\t\\U0001"');
  });

  test("German reorders the English argument positions once", () => {
    const order = placeholderOrder("{first} paid {second}, 50%");
    expect(convert("{second} von {first}, 50%", order)).toBe("%2$@ von %1$@, 50%%");
    expect(convert("50% off", placeholderOrder("50% off"))).toBe("50% off");
  });

  test("rendered strings are sorted and escape keys as well as values", () => {
    expect(renderStrings({ 'z"key': "line\n", "a\\key": "100%" })).toBe(
      '"a\\\\key" = "100%";\n"z\\"key" = "line\\n";\n',
    );
  });

  test("catalog comments preserve the placeholder names", () => {
    const outputs = buildOutputs();
    const catalogPath = Object.keys(outputs).find((path) =>
      path.endsWith("Catalog/Localizable.xcstrings"),
    );
    const catalog = catalogPath === undefined ? undefined : outputs[catalogPath];
    if (catalog === undefined) throw new Error("generated core catalog is missing");
    const parsed = JSON.parse(catalog) as {
      strings: Record<string, { comment?: string }>;
    };
    const mismatch = parsed.strings.native_banner_mismatch;
    if (mismatch === undefined) throw new Error("native_banner_mismatch is missing");
    expect(mismatch.comment).toBe("%1$@ = serverVersion, %2$@ = appVersion");
  });

  test("duplicate manifests and unknown German placeholders are rejected", () => {
    expect(duplicateKeys(["same", "same"])).toEqual(["same"]);
    expect(() => convert("{unknown}", placeholderOrder("{known}"))).toThrow(
      /unknown placeholder \{unknown\}/,
    );
  });

  test("fresh output directories and each missing or stale output are detected independently", () => {
    const directory = mkdtempSync(join(tmpdir(), "shepherd-strings-core-"));
    try {
      const outputs = buildOutputs(directory);
      expect(staleOutputs(outputs).sort()).toEqual(Object.keys(outputs).sort());
      for (const [path, text] of Object.entries(outputs)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      expect(staleOutputs(outputs)).toEqual([]);
      for (const path of Object.keys(outputs)) {
        const original = readFileSync(path, "utf8");
        writeFileSync(path, original + "stale\n");
        expect(staleOutputs(outputs)).toEqual([path]);
        writeFileSync(path, original);
        expect(staleOutputs(outputs)).toEqual([]);
        unlinkSync(path);
        expect(staleOutputs(outputs)).toEqual([path]);
        writeFileSync(path, original);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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

describe("gen-strings outputs", () => {
  test("checks all three outputs and detects a missing German runtime file", () => {
    const directory = mkdtempSync(join(tmpdir(), "shepherd-strings-"));
    try {
      const outputs = buildOutputs(directory);
      expect(Object.keys(outputs)).toHaveLength(3);
      expect(staleOutputs(outputs)).toHaveLength(3);
      for (const [path, text] of Object.entries(outputs)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
      }
      expect(staleOutputs(outputs)).toEqual([]);
      const german = join(directory, "de.lproj", "Localizable.strings");
      unlinkSync(german);
      expect(staleOutputs(outputs)).toEqual([german]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
