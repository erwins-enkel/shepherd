import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compare,
  parseDocumentedKeys,
  parseSchemaKeys,
  requiresDocs,
} from "../scripts/check-env-schema-docs.mjs";

// Resolved from this file, never process.cwd(), so the live-tree cases below behave
// identically under `bun test ./test` and a single-file invocation.
const ROOT = join(import.meta.dir, "..");
const SCHEMA = join(ROOT, ".env.schema");
const DOCS = join(ROOT, "docs-site/src/content/docs/reference/configuration.md");

/** A `| Variable | Default | Purpose |` table with the given rows. */
function docsTable(rows: string[]): string {
  return ["| Variable | Default | Purpose |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

// ── parseSchemaKeys ──────────────────────────────────────────────────────────

test("attaches the decorator block immediately above a key", () => {
  const source = [
    "# A knob.",
    "# @type=string",
    "SHEPHERD_A=x",
    "",
    "# Another.",
    "# @type=boolean @auditIgnore",
    "SHEPHERD_B=false",
    "",
  ].join("\n");

  expect(parseSchemaKeys(source)).toEqual([
    { key: "SHEPHERD_A", auditIgnore: false, docsExempt: false },
    { key: "SHEPHERD_B", auditIgnore: true, docsExempt: false },
  ]);
});

test("reads a second decorator sharing one line (the `@type=… @auditIgnore` shape)", () => {
  // This is how every ignored key is actually written in .env.schema — a
  // line-anchored "the line IS @auditIgnore" test would mark none of them.
  const keys = parseSchemaKeys("# @type=port @auditIgnore\nSHEPHERD_A=1\n");
  expect(keys[0]).toEqual({ key: "SHEPHERD_A", auditIgnore: true, docsExempt: false });
});

test("PROSE naming a decorator does not mark the key below it", () => {
  // .env.schema's header explains the convention in sentences — "…are declared here
  // with `@auditIgnore` so the …". A "does the comment block contain the word" test
  // would silently exempt whatever key followed such a paragraph.
  const source = [
    "# Keys read indirectly are declared with `@auditIgnore` so the gate stays quiet.",
    "# They are catalogued, not enforced.",
    "# @type=string",
    "SHEPHERD_A=x",
    "",
  ].join("\n");

  expect(parseSchemaKeys(source)[0]).toEqual({
    key: "SHEPHERD_A",
    auditIgnore: false,
    docsExempt: false,
  });
});

test("a blank line detaches a decorator block from the key below", () => {
  const source = ["# @docsExempt", "", "# A different key.", "SHEPHERD_A=x", ""].join("\n");
  expect(parseSchemaKeys(source)).toEqual([
    { key: "SHEPHERD_A", auditIgnore: false, docsExempt: false },
  ]);
});

test("a decorator block is consumed by its key, never inherited by the next", () => {
  const source = ["# @docsExempt", "SHEPHERD_A=x", "SHEPHERD_B=y", ""].join("\n");
  expect(parseSchemaKeys(source)).toEqual([
    { key: "SHEPHERD_A", auditIgnore: false, docsExempt: true },
    { key: "SHEPHERD_B", auditIgnore: false, docsExempt: false },
  ]);
});

test("does not mistake a commented-out key for a declaration", () => {
  expect(parseSchemaKeys("# SHEPHERD_A=x\n")).toEqual([]);
});

// ── requiresDocs ─────────────────────────────────────────────────────────────

test("only gated SHEPHERD_* keys require a docs row", () => {
  const required = (key: string, extra: Partial<{ auditIgnore: boolean; docsExempt: boolean }>) =>
    requiresDocs({ key, auditIgnore: false, docsExempt: false, ...extra });

  expect(required("SHEPHERD_A", {})).toBe(true);
  expect(required("SHEPHERD_A", { auditIgnore: true })).toBe(false);
  expect(required("SHEPHERD_A", { docsExempt: true })).toBe(false);
  // Ambient / third-party / another tool's contract — not Shepherd's configuration.
  expect(required("HERDR_BIN", {})).toBe(false);
  expect(required("DO_NOT_TRACK", {})).toBe(false);
  expect(required("NODE_ENV", {})).toBe(false);
});

// ── parseDocumentedKeys ──────────────────────────────────────────────────────

test("collects the first cell of every variable-table row", () => {
  const source = docsTable([
    "| `SHEPHERD_A` | `1` | first |",
    "| `SHEPHERD_B` | _(none)_ | second |",
  ]);
  expect([...parseDocumentedKeys(source)]).toEqual(["SHEPHERD_A", "SHEPHERD_B"]);
});

test("ignores tables that are not variable tables", () => {
  // The page's sandbox-profile matrix and maintain-loop band table both have a
  // first column that is not a variable name; feeding those to the reverse check
  // would report every profile name as an unknown key.
  const source = [
    "| Profile | Network | Filesystem |",
    "| --- | --- | --- |",
    "| `TRUSTED` | full | full |",
    "",
    docsTable(["| `SHEPHERD_A` | `1` | first |"]),
  ].join("\n");

  expect([...parseDocumentedKeys(source)]).toEqual(["SHEPHERD_A"]);
});

test("a table ends at the first non-row line", () => {
  const source = [
    docsTable(["| `SHEPHERD_A` | `1` | first |"]),
    "Some prose mentioning a table-shaped thing.",
    "| `SHEPHERD_B` | `2` | orphan row outside any table |",
    "",
  ].join("\n");

  expect([...parseDocumentedKeys(source)]).toEqual(["SHEPHERD_A"]);
});

test("ignores a row whose first cell is not a CONSTANT_NAME", () => {
  const source = docsTable(["| `trusted` | — | a profile, not a key |", "| **note** | — | — |"]);
  expect([...parseDocumentedKeys(source)]).toEqual([]);
});

// ── compare ──────────────────────────────────────────────────────────────────

test("reports a gated key with no row", () => {
  const schemaKeys = parseSchemaKeys("SHEPHERD_A=1\nSHEPHERD_B=2\n");
  const result = compare(
    schemaKeys,
    parseDocumentedKeys(docsTable(["| `SHEPHERD_A` | `1` | x |"])),
  );

  expect(result.ok).toBe(false);
  expect(result.missingDocs).toEqual(["SHEPHERD_B"]);
  expect(result.unknownRows).toEqual([]);
});

test("reports a row naming a key the schema does not declare", () => {
  // The likeliest real slip: a typo in a NEW row, which otherwise documents nothing
  // and satisfies nothing.
  const schemaKeys = parseSchemaKeys("SHEPHERD_A=1\n");
  const result = compare(
    schemaKeys,
    parseDocumentedKeys(docsTable(["| `SHEPHERD_A` | `1` | x |", "| `SHEPHERD_TYPO` | `1` | x |"])),
  );

  expect(result.ok).toBe(false);
  expect(result.missingDocs).toEqual([]);
  expect(result.unknownRows).toEqual(["SHEPHERD_TYPO"]);
});

test("an exempt or ignored key needs no row, and documenting one anyway is fine", () => {
  const schemaKeys = parseSchemaKeys(
    ["# @docsExempt", "SHEPHERD_A=1", "", "# @type=string @auditIgnore", "SHEPHERD_B=2", ""].join(
      "\n",
    ),
  );
  // SHEPHERD_B carries a row despite being exempt — legal, the rule is a floor.
  const result = compare(
    schemaKeys,
    parseDocumentedKeys(docsTable(["| `SHEPHERD_B` | `2` | x |"])),
  );

  expect(result.ok).toBe(true);
  expect(result.gatedCount).toBe(0);
});

test("a non-SHEPHERD key may be documented without being required to be", () => {
  const schemaKeys = parseSchemaKeys("HERDR_BIN=herdr\n");
  expect(
    compare(schemaKeys, parseDocumentedKeys(docsTable(["| `HERDR_BIN` | `herdr` | x |"]))).ok,
  ).toBe(true);
});

// ── live tree ────────────────────────────────────────────────────────────────

test("the real .env.schema and configuration.md agree", () => {
  const schemaKeys = parseSchemaKeys(readFileSync(SCHEMA, "utf8"));
  const documented = parseDocumentedKeys(readFileSync(DOCS, "utf8"));

  // Non-vacuous: both parsers must actually find their content, or "agreeing" is
  // two empty sets comparing equal.
  expect(schemaKeys.length).toBeGreaterThan(100);
  expect(documented.size).toBeGreaterThan(100);

  const result = compare(schemaKeys, documented);
  expect(result.missingDocs).toEqual([]);
  expect(result.unknownRows).toEqual([]);
});

test("the CLI runs the comparison and exits 0", () => {
  // Guards the isMainModule() normalization: if it stops matching, the gate exits 0
  // having compared NOTHING, which no exit-code-only assertion would catch.
  const run = spawnSync("node", [join(ROOT, "scripts/check-env-schema-docs.mjs")], {
    encoding: "utf8",
  });

  expect(run.status).toBe(0);
  expect(run.stdout).toContain("gated SHEPHERD_* keys documented");
});
