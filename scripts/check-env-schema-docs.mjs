#!/usr/bin/env node
// Env-schema ⇒ docs parity gate (#2361, stage 2 of the varlock adoption): every
// operator-settable knob declared in `.env.schema` must also carry a row on the
// Configuration page of the docs site.
//
// WHAT STAGE 1 LEFT OPEN. `bun run check:env-schema` (`varlock audit`, #2347/#2348)
// proves a knob is DECLARED — code and schema cannot drift apart in either
// direction. It says nothing about whether an operator can ever FIND the knob,
// which is the gap the adoption research measured in the first place: at the time
// this gate was written, `.env.schema` held 135 gated `SHEPHERD_*` keys and the
// docs page documented 64 of them.
//
// THE RULE. A key needs a `configuration.md` row IFF it is `SHEPHERD_*`-namespaced
// and carries neither `@auditIgnore` nor `@docsExempt` — i.e. the gated,
// operator-settable surface.
//   • `SHEPHERD_*` because a non-namespaced key is either ambient (`NODE_ENV`,
//     `GIT_AUTHOR_NAME`), a third-party pin (`CLAUDE_CODE_NO_FLICKER`) or another
//     tool's contract (`HERDR_BIN`, `DO_NOT_TRACK`) — not Shepherd's to document as
//     configuration. Several ARE documented anyway; that stays legal, the rule is a
//     floor, not a whitelist.
//   • `@auditIgnore` already means "catalogued, not enforced" (varlock cannot see
//     the read site), and in practice marks internal handshakes and injected child
//     env — `SHEPHERD_DISCARD_SIG`, `SHEPHERD_HERDR_RECOVERY_LOG`, the CI-injected
//     workflow inputs. Reusing it keeps one exemption vocabulary instead of two.
//   • `@docsExempt` is this gate's own escape hatch, for the rare gated `SHEPHERD_*`
//     key that is genuinely contributor-only (see `.env.schema` for today's three).
//     varlock ignores decorators it does not know, so adding one does NOT disturb
//     `varlock audit` — verified against varlock 1.19.0.
//
// BOTH DIRECTIONS, asymmetric in value. Forward (schema ⇒ docs) is the point.
// Reverse (docs ⇒ schema) can never fire for a legitimately removed key — stage 1
// deletes it from the schema and this gate then flags its orphaned row — but it
// costs nothing and catches the likelier slip: a typo'd key name in a NEW row,
// which would otherwise satisfy nothing and be silently useless.
//
// PRESENCE, NOT CONTENT. This asserts a row EXISTS. It deliberately does not compare
// the documented default against the schema's value: the page's Default column is
// prose (`~` (home)`, `_(auto-generated)_`, `SHEPHERD_PORT + 1` (e.g. `7331`)`), so
// equality against a literal would be a false-positive machine. Whether a row is any
// GOOD is review's job, not a script's.
//
// Plain ESM — no dependencies, no transpile. Mirrors the shape and style of
// scripts/check-model-mirror.mjs. Importable (parseSchemaKeys / parseDocumentedKeys /
// compare) by test/check-env-schema-docs.test.ts.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, never process.cwd(), so the CLI works from any directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_REL = ".env.schema";
const DOCS_REL = "docs-site/src/content/docs/reference/configuration.md";

/**
 * Every key declared in a `.env.schema` source, with the decorators attached to it.
 *
 * A key's decorators are the `@…` lines in the comment block immediately above it,
 * exactly as varlock reads them. The block accumulates from the previous key or
 * blank line, so a section banner's note never leaks onto the first key beneath it
 * (there is always a blank line between the two).
 *
 * Only lines that START a decorator (`# @…`) are scanned for decorator names. The
 * header prose explains `@auditIgnore` in sentences — "declared here with
 * `@auditIgnore` so the …" — and a looser "does the block contain the word" test
 * would read those as marks on whatever key followed.
 */
export function parseSchemaKeys(source) {
  const keys = [];
  let decorators = [];

  for (const line of source.split("\n")) {
    if (/^#\s*@/.test(line)) {
      decorators.push(line);
      continue;
    }
    if (/^\s*#/.test(line)) continue; // prose comment — not a decorator, not a reset

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) {
      const block = decorators.join("\n");
      keys.push({
        key: match[1],
        auditIgnore: /@auditIgnore\b/.test(block),
        docsExempt: /@docsExempt\b/.test(block),
      });
    }
    // A key line consumes its decorators; a blank (or any other) line ends the block.
    decorators = [];
  }

  return keys;
}

/** Does this key have to appear on the docs page? See THE RULE above. */
export function requiresDocs(key) {
  return key.key.startsWith("SHEPHERD_") && !key.auditIgnore && !key.docsExempt;
}

/**
 * The keys documented by a `configuration.md` source: the first cell of every row
 * of every `| Variable | Default | Purpose |` table.
 *
 * Scoped to that exact header rather than "any table row that looks like a
 * CONSTANT" because the page carries other tables — the per-agent sandbox profile
 * matrix, the maintain loop's band thresholds — whose first column is not a
 * variable name. Picking rows out of those would feed the reverse check garbage.
 */
export function parseDocumentedKeys(source) {
  const documented = new Set();
  let inTable = false;

  for (const line of source.split("\n")) {
    if (/^\|\s*Variable\s*\|\s*Default\s*\|\s*Purpose\s*\|\s*$/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("|")) {
      inTable = false; // any non-row line closes the table
      continue;
    }

    const match = line.match(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/);
    if (match) documented.add(match[1]);
  }

  return documented;
}

/**
 * Structured deltas — prose formatting lives only in the CLI below, so tests assert
 * on data rather than substring-matching a message that is free to be reworded.
 */
export function compare(schemaKeys, documented) {
  const declared = new Set(schemaKeys.map((k) => k.key));
  const missingDocs = schemaKeys.filter((k) => requiresDocs(k) && !documented.has(k.key));
  const unknownRows = [...documented].filter((k) => !declared.has(k));

  return {
    ok: missingDocs.length === 0 && unknownRows.length === 0,
    missingDocs: missingDocs.map((k) => k.key),
    unknownRows,
    gatedCount: schemaKeys.filter(requiresDocs).length,
    documentedCount: documented.size,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * Is this module the process entry point (i.e. run as the CLI, not imported)?
 * Both normalizations matter — `import.meta.url` is percent-encoded and Node
 * realpath-resolves the entry module but not `argv[1]`. See the long note on the
 * same function in scripts/check-model-mirror.mjs; getting either wrong makes the
 * gate exit 0 having compared nothing.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const schemaKeys = parseSchemaKeys(readFileSync(join(ROOT, SCHEMA_REL), "utf8"));
  const documented = parseDocumentedKeys(readFileSync(join(ROOT, DOCS_REL), "utf8"));

  // Fail CLOSED on an unparseable file: zero keys or zero rows means the shape
  // changed under the parser, and comparing two empties is a vacuous pass.
  if (schemaKeys.length === 0 || documented.size === 0) {
    console.error(
      `env-schema docs: parsed ${schemaKeys.length} keys from ${SCHEMA_REL} and` +
        ` ${documented.size} rows from ${DOCS_REL} — at least one parser found nothing,` +
        ` so the file shape has changed. Fix the parser in scripts/check-env-schema-docs.mjs.`,
    );
    process.exit(1);
  }

  const result = compare(schemaKeys, documented);

  if (!result.ok) {
    const lines = [];
    if (result.missingDocs.length) {
      lines.push(
        `  ${result.missingDocs.length} gated SHEPHERD_* key(s) have no row in ${DOCS_REL}:`,
        ...result.missingDocs.map((k) => `    ${k}`),
        `  Fix: add a row for each to the right section of that page` +
          ` (a | Variable | Default | Purpose | table).`,
        `  If the key is genuinely contributor-only and not operator-settable, mark it`,
        `  \`# @docsExempt\` in ${SCHEMA_REL} and say in its description why.`,
      );
    }
    if (result.unknownRows.length) {
      lines.push(
        `  ${result.unknownRows.length} row(s) in ${DOCS_REL} name a key absent from ${SCHEMA_REL}:`,
        ...result.unknownRows.map((k) => `    ${k}`),
        `  Fix: correct the spelling, or delete the row if the key is gone.`,
      );
    }
    console.error(`env-schema docs: ${SCHEMA_REL} and ${DOCS_REL} disagree:\n${lines.join("\n")}`);
    process.exit(1);
  }

  console.log(
    `✓ env-schema docs: all ${result.gatedCount} gated SHEPHERD_* keys documented` +
      ` (${result.documentedCount} rows on the Configuration page)`,
  );
}
