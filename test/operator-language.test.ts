import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPERATOR_LANGUAGES,
  normalizeOperatorLanguage,
  operatorLanguageBlock,
  visualBlockLanguageLine,
} from "../src/operator-language";

// ── OPERATOR_LANGUAGES ────────────────────────────────────────────────────────

describe("OPERATOR_LANGUAGES", () => {
  test("is the ordered ['en', 'de'] list", () => {
    expect(OPERATOR_LANGUAGES).toEqual(["en", "de"]);
  });

  test("is usable as a membership check", () => {
    expect((OPERATOR_LANGUAGES as readonly string[]).includes("en")).toBe(true);
    expect((OPERATOR_LANGUAGES as readonly string[]).includes("de")).toBe(true);
    expect((OPERATOR_LANGUAGES as readonly string[]).includes("fr")).toBe(false);
  });
});

// ── normalizeOperatorLanguage ─────────────────────────────────────────────────

describe("normalizeOperatorLanguage", () => {
  test("accepts 'en'", () => {
    expect(normalizeOperatorLanguage("en")).toBe("en");
  });

  test("accepts 'de'", () => {
    expect(normalizeOperatorLanguage("de")).toBe("de");
  });

  test("returns null for unknown string", () => {
    expect(normalizeOperatorLanguage("fr")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(normalizeOperatorLanguage("")).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(normalizeOperatorLanguage(undefined)).toBeNull();
  });

  test("returns null for null", () => {
    expect(normalizeOperatorLanguage(null)).toBeNull();
  });

  test("is case-sensitive — 'EN'/'DE' are not accepted", () => {
    expect(normalizeOperatorLanguage("EN")).toBeNull();
    expect(normalizeOperatorLanguage("DE")).toBeNull();
  });
});

// ── operatorLanguageBlock ─────────────────────────────────────────────────────

describe("operatorLanguageBlock", () => {
  test("returns null for 'en' (byte-identical prompts for existing operators)", () => {
    expect(operatorLanguageBlock("en")).toBeNull();
  });

  test("returns a <operator-language> wrapped block for 'de'", () => {
    const block = operatorLanguageBlock("de");
    expect(block).not.toBeNull();
    expect(block as string).toMatch(/^<operator-language>\n/);
    expect(block as string).toMatch(/\n<\/operator-language>$/);
  });

  test("'de' block names German and covers the key carve-outs", () => {
    const block = operatorLanguageBlock("de") as string;
    expect(block).toContain("German");
    expect(block).toContain(".shepherd-plan.md");
    expect(block).toContain("code");
    expect(block).toContain("commit messages");
    expect(block).toContain("research report");
  });
});

// ── visualBlockLanguageLine — field-level drift guard ─────────────────────────
//
// The point of this test: every string-valued field each VALIDATORS entry in
// src/visual-blocks.ts reads must be named by visualBlockLanguageLine("de") in
// exactly one of the translate / verbatim classifications — never both, never
// neither. A type-level check (every VALIDATORS key + every enum member) is NOT
// sufficient: it would pass even if a specific string field (e.g.
// `data-model.fields[].change`) went unruled. So this test enumerates FIELDS,
// not just block types.

const VISUAL_BLOCKS_SRC = readFileSync(join(import.meta.dir, "../src/visual-blocks.ts"), "utf8");

// Fields that must read as natural-language prose and get translated to German.
// Copied verbatim from the approved field lists (task-1-brief.md).
const TRANSLATE_FIELDS = [
  "rich-text.markdown",
  "callout.markdown",
  "file-tree.title",
  "file-tree.entries[].note",
  "diff.summary",
  "diff.annotations[].label",
  "diff.annotations[].note",
  "annotated-code.annotations[].label",
  "annotated-code.annotations[].note",
  "api-endpoint.summary",
  "api-endpoint.params[].note",
  "api-endpoint.responses[].description",
  "checklist.items[].label",
  "checklist.items[].note",
  "mermaid.caption",
  "wireframe.caption",
  "question-form.questions[].prompt",
  "question-form.questions[].options[]",
] as const;

// Fields that are identifiers / enums / paths / machine-read and must NEVER be
// translated. Copied verbatim from the approved field lists, PLUS one field the
// brief's authoritative list omitted: `api-endpoint.change`. visual-blocks.ts
// reads it exactly like the other two "change" enums (`typeof r.change ===
// "string"`, line ~366) and recap-core.ts's own prompt spec constrains it to
// `"added"|"modified"|"deprecated"` (src/recap-core.ts:161) — an enum value, not
// prose. Left unruled it would be silently untranslated-or-mistranslated by an
// agent with no explicit instruction either way; this is exactly the kind of gap
// the field-level guard below exists to catch.
const VERBATIM_FIELDS = [
  "type",
  "id",
  "callout.tone",
  "file-tree.entries[].change",
  "data-model.fields[].change",
  "api-endpoint.change",
  "wireframe.surface",
  "wireframe.html",
  "diff.path",
  "code.filename",
  "annotated-code.filename",
  "file-tree.entries[].path",
  "data-model.entities[].name",
  "data-model.fields[].name",
  "data-model.fields[].type",
  "data-model.fields[].fk",
  "data-model.fields[].was",
  "data-model.relations[].from",
  "data-model.relations[].to",
  "data-model.relations[].kind",
  "api-endpoint.method",
  "api-endpoint.path",
  "api-endpoint.params[].name",
  "api-endpoint.params[].in",
  "api-endpoint.params[].type",
  "api-endpoint.responses[].example",
  "question-form.questions[].kind",
  "mermaid.source",
] as const;

// table.columns / table.rows are conditional — translated cell by cell, never a
// path/flag/identifier/enum/command fragment. Named in their own rule, not in
// either list above.
const TABLE_CONDITIONAL_FIELDS = ["table.columns", "table.rows"] as const;

const ALL_FIELD_TOKENS = [...TRANSLATE_FIELDS, ...VERBATIM_FIELDS, ...TABLE_CONDITIONAL_FIELDS];

describe("visualBlockLanguageLine — field inventory integrity (guards the guard)", () => {
  test("no field token is listed more than once across translate/verbatim/table", () => {
    const seen = new Set<string>();
    for (const token of ALL_FIELD_TOKENS) {
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  // Cross-check the hardcoded field inventory above against the actual validator
  // source, so a new string field added to visual-blocks.ts can't silently ship
  // without an explicit translate/verbatim rule. Every `typeof x.field === "string"`
  // / `typeof x.field !== "string"` guard and every `SOME_ENUM.includes(x.field as
  // Type)` enum guard in the VALIDATORS bodies is a string-valued field read; the
  // counts below are the current, hand-verified totals. If a future validator adds
  // a new field via either idiom, these counts drift and this test fails — forcing
  // the new field to be added to TRANSLATE_FIELDS or VERBATIM_FIELDS (and to
  // visualBlockLanguageLine's prose) before it can ship.
  test("typeof-string field-read idiom count matches the hand-verified total", () => {
    const matches = VISUAL_BLOCKS_SRC.match(/typeof [a-zA-Z]+\.[a-zA-Z]+ *[!=]== *"string"/g) ?? [];
    expect(matches.length).toBe(39);
  });

  test("ENUM.includes(x.field as Type) field-read idiom count matches the hand-verified total", () => {
    const matches = VISUAL_BLOCKS_SRC.match(/[A-Z_]+\.includes\([a-zA-Z]+\.[a-zA-Z]+ as/g) ?? [];
    expect(matches.length).toBe(5);
  });

  test("'is string =>' array-filter idiom count matches the hand-verified total (table.columns, question-form options)", () => {
    const matches = VISUAL_BLOCKS_SRC.match(/\([a-zA-Z]+\): [a-zA-Z]+ is string =>/g) ?? [];
    expect(matches.length).toBe(2);
  });

  // KNOWN LIMITATION: these count-regexes match `typeof r.field === "string"` and
  // `ENUM.includes(r.field as Type)` directly, but NOT the indirect
  // `const x = r.field; if (typeof x === "string")` idiom — the one `parseBlock`
  // itself uses for `type` and `id` (src/visual-blocks.ts:570-574: `const id = r.id;
  // if (typeof id !== "string") ...`). A future field added to a validator via that
  // same indirect assign-then-typeof idiom will NOT increment either count above, so
  // it can slip past this backstop silently. It must be added to TRANSLATE_FIELDS /
  // VERBATIM_FIELDS by hand — this backstop only catches the two idioms it greps
  // for; review must catch the rest.

  test("every VALIDATORS block type is represented in the field inventory", () => {
    const validatorsBlock = VISUAL_BLOCKS_SRC.slice(VISUAL_BLOCKS_SRC.indexOf("const VALIDATORS"));
    const blockTypes = [
      ...validatorsBlock.matchAll(/^\s*(?:"([\w-]+)"|([\w-]+)):\s*validate/gm),
    ].map((m) => m[1] ?? m[2]);
    expect(blockTypes.length).toBeGreaterThan(0);
    for (const type of blockTypes) {
      const hasField = ALL_FIELD_TOKENS.some((f) => f === type || f.startsWith(`${type}.`));
      expect(hasField).toBe(true);
    }
  });
});

describe("visualBlockLanguageLine", () => {
  test("returns null for 'en'", () => {
    expect(visualBlockLanguageLine("en")).toBeNull();
  });

  test("returns non-null prose for 'de'", () => {
    const line = visualBlockLanguageLine("de");
    expect(line).not.toBeNull();
    expect(typeof line).toBe("string");
  });

  test("every translate field is named exactly once, and not in the verbatim section", () => {
    const line = visualBlockLanguageLine("de") as string;
    for (const token of TRANSLATE_FIELDS) {
      // Count literal `` `token` `` occurrences via split — no regex, so no metacharacter
      // escaping to get wrong (the tokens contain `.`/`[`/`]`, and CodeQL rightly flags a
      // hand-rolled escape that misses backslashes).
      const needle = "`" + token + "`";
      expect(line.split(needle).length - 1).toBe(1);
    }
  });

  test("every verbatim field is named exactly once, and not in the translate section", () => {
    const line = visualBlockLanguageLine("de") as string;
    for (const token of VERBATIM_FIELDS) {
      // Count literal `` `token` `` occurrences via split — no regex, so no metacharacter
      // escaping to get wrong (the tokens contain `.`/`[`/`]`, and CodeQL rightly flags a
      // hand-rolled escape that misses backslashes).
      const needle = "`" + token + "`";
      expect(line.split(needle).length - 1).toBe(1);
    }
  });

  test("every field token in the emitted text is accounted for exactly once total (never both, never neither)", () => {
    const line = visualBlockLanguageLine("de") as string;
    for (const token of ALL_FIELD_TOKENS) {
      // Count literal `` `token` `` occurrences via split — no regex, so no metacharacter
      // escaping to get wrong (the tokens contain `.`/`[`/`]`, and CodeQL rightly flags a
      // hand-rolled escape that misses backslashes).
      const needle = "`" + token + "`";
      expect(line.split(needle).length - 1).toBe(1);
    }
  });

  test("includes the conditional table cell-by-cell rule", () => {
    const line = visualBlockLanguageLine("de") as string;
    expect(line).toContain("`table.columns`");
    expect(line).toContain("`table.rows`");
    expect(line.toLowerCase()).toContain("never a path, flag, identifier, enum value, or command");
  });

  // The specific fields review called out as easily missed by a type-level (not
  // field-level) guard — assert them explicitly, in addition to the loop above.
  test("names the previously-easy-to-miss fields explicitly", () => {
    const line = visualBlockLanguageLine("de") as string;
    expect(line).toContain("`data-model.fields[].change`");
    expect(line).toContain("`data-model.relations[].from`");
    expect(line).toContain("`data-model.relations[].to`");
    expect(line).toContain("`data-model.fields[].fk`");
    expect(line).toContain("`data-model.fields[].was`");
    expect(line).toContain("`api-endpoint.responses[].example`");
    expect(line).toContain("`api-endpoint.change`");
    expect(line).toContain("`question-form.questions[].kind`");
  });
});

// ── No new `./config` import in recap.ts / plan-gate.ts ──────────────────────
//
// The point of this test: `deps.operatorLanguage` in recap.ts and plan-gate.ts
// defaults to the literal () => "en" precisely so neither module needs a
// `./config` import — the live value is wired at the composition root
// (src/index.ts) instead. A module-level `./config` import in either file would
// risk the config value getting read (and frozen) at import time rather than
// per-spawn — see the plan's "import-time freeze" note for
// PLAN_GATE_DIRECTIVE_INTERACTIVE / PLAN_GATE_DIRECTIVE_AUTO. This is a
// source-level regression guard for that constraint, not a behavioral test.

describe("no new ./config import (import-time-freeze guard)", () => {
  const RECAP_SRC = readFileSync(join(import.meta.dir, "../src/recap.ts"), "utf8");
  const PLAN_GATE_SRC = readFileSync(join(import.meta.dir, "../src/plan-gate.ts"), "utf8");
  const CONFIG_IMPORT_RE = /from\s+["']\.\/config["']/;

  test("src/recap.ts does not import from ./config", () => {
    expect(CONFIG_IMPORT_RE.test(RECAP_SRC)).toBe(false);
  });

  test("src/plan-gate.ts does not import from ./config", () => {
    expect(CONFIG_IMPORT_RE.test(PLAN_GATE_SRC)).toBe(false);
  });
});
