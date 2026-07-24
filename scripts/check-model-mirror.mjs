#!/usr/bin/env node
// Model-list mirror gate (#1936): the model/effort alias lists declared in BOTH
// `src/types.ts` and `ui/src/lib/types.ts` must stay element- AND order-identical.
//
// THE HAZARD this closes: `CLAUDE_MODELS`, `CODEX_MODELS` and `EFFORTS` are each
// declared twice — once server-side (validateCreate validation, the default-model
// setting space, per-role/per-repo overrides) and once, hand-copied, in the UI
// (pickers). Nothing enforced that the two stay identical, and a one-sided edit is
// silent in BOTH directions, asymmetrically:
//   • UI-only add    → the picker offers a value the server rejects with
//                      `unknown model` at task-create time.
//   • server-only add → the API accepts the value but no picker can reach it.
//
// WHY TEXTUAL rather than importing both halves into one test: all three wiring
// points (the `check:model-mirror` package script, the pre-push `gates` lane, the
// PR-hygiene workflow) invoke a gate as a bare command, which a `bun test`
// assertion cannot fill; and importing `ui/src/lib/types.ts` from `test/` would
// pull the whole UI type surface into the server `tsc` program, type-checked
// against the server tsconfig instead of the `svelte-check` config that owns it.
// (Note for the record: the root tsconfig's `exclude: ["ui", …]` is NOT the
// reason — `exclude` only filters the root file set, and an import still pulls a
// file in.)
//
// ORDER-SENSITIVE, not set-equality: on the UI side the literal order IS the order
// the model dropdown renders, so a one-sided reorder is drift worth failing on.
//
// The parser is deliberately conservative — see `extractArrayLiteral` for the two
// traps (prose naming the constant next to its declaration; a missing `as const`)
// that a looser implementation falls into. It fails CLOSED: a literal that cannot
// be parsed on EITHER side is an error, never a skipped comparison.
//
// Plain ESM — no dependencies, no transpile. Mirrors the shape and style of
// scripts/check-glossary.mjs. Importable (extractArrayLiteral / compareMirror /
// MIRRORED_CONSTANTS) by test/check-model-mirror.test.ts.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, never process.cwd(), so the CLI works from any directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_REL = "src/types.ts";
const UI_REL = "ui/src/lib/types.ts";

/**
 * The constants declared in both files that must stay identical.
 *
 * | Constant        | src/types.ts           | ui/src/lib/types.ts    |
 * | --------------- | ---------------------- | ---------------------- |
 * | `CLAUDE_MODELS` | `const` (non-exported) | `const` (non-exported) |
 * | `CODEX_MODELS`  | `export const`         | `export const`         |
 * | `EFFORTS`       | `export const`         | `export const`         |
 *
 * `MODELS_BY_PROVIDER` needs no entry — it is DERIVED from the two model arrays in
 * both files, so gating the arrays covers it transitively. `PREMIUM_MODELS` is
 * UI-only (no server counterpart), so it is not a mirror at all.
 */
export const MIRRORED_CONSTANTS = ["CLAUDE_MODELS", "CODEX_MODELS", "EFFORTS"];

/**
 * Walk a `[ … ]` literal from its opening bracket, returning the body with
 * comments stripped, or null if it is never closed.
 *
 * The scan is string- and comment-aware because the real data demands it:
 *   • elements CONTAIN `]` — "opus[1m]", "claude-opus-5[1m]", "sonnet[1m]" — so a
 *     naive "up to the first `]`" scan truncates the Claude list mid-way;
 *   • an apostrophe in a comment ("// don't …") would otherwise open a bogus
 *     string state and swallow the rest of the file.
 * Bracket depth is tracked so a nested array can't terminate the scan early.
 */
function scanArrayBody(source, openIndex) {
  let depth = 0;
  let quote = null;
  let comment = null; // "line" | "block"
  let body = "";

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (comment === "line") {
      if (ch === "\n") comment = null;
      continue;
    }
    if (comment === "block") {
      if (ch === "*" && source[i + 1] === "/") {
        comment = null;
        i += 1;
      }
      continue;
    }
    if (quote) {
      body += ch;
      if (ch === "\\") {
        // Escaped char is consumed verbatim so a trailing \" can't end the string.
        body += source[i + 1] ?? "";
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      comment = "line";
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      comment = "block";
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      body += ch;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      if (depth > 1) body += ch;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return body;
      body += ch;
      continue;
    }
    body += ch;
  }

  return null; // unterminated — caller treats it as unparseable
}

/**
 * Extract the string elements of `const <constName> = [ … ]` from a TS source, or
 * null when the literal cannot be parsed. Two traps this deliberately avoids:
 *
 *  1. The opening anchor REQUIRES the `const` keyword rather than the loose
 *     `<NAME>[^=]*=` idiom used elsewhere in scripts/, because these constant
 *     names appear in PROSE right next to their declarations — the doc comment
 *     above `ui/src/lib/types.ts`'s CLAUDE_MODELS reads "Mirrors src/types.ts
 *     CLAUDE_MODELS", and src/types.ts's CODEX_MODEL_RE comment names
 *     CODEX_MODELS just below that array. A loose anchor happens to still land on
 *     the real declaration today, which is exactly what makes it a latent trap:
 *     one comment reword from matching prose and extracting the wrong span.
 *  2. The close is found by `scanArrayBody`, NOT by anchoring on `] as const`.
 *     `as const` is incidental syntax, and an `as const`-anchored scan runs PAST
 *     any array written without it — a shape already present in the same file
 *     (`export const PREMIUM_MODELS: readonly string[] = [ … ];`) — all the way to
 *     the next `] as const`. In src/types.ts that is EFFORTS', so a CLAUDE_MODELS
 *     over-match would silently absorb the five effort tiers.
 *
 * An empty element list is reported as unparseable: none of the gated lists is
 * ever legitimately empty, so zero elements means the shape changed (identifiers
 * or an enum instead of string literals) and comparing two empty lists as "equal"
 * would be a vacuous pass.
 */
export function extractArrayLiteral(source, constName) {
  // Optional `export`, required `const`, optional type annotation (`: readonly
  // string[]`), then `= [`. \b rejects a longer name with the same prefix.
  const anchor = new RegExp(`(?:export\\s+)?const\\s+${constName}\\b\\s*(?::[^=]*)?=\\s*\\[`);
  const match = anchor.exec(source);
  if (!match) return null;

  const body = scanArrayBody(source, match.index + match[0].length - 1);
  if (body === null) return null;

  const elements = [];
  const elementRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let el;
  while ((el = elementRe.exec(body)) !== null) elements.push(el[1] ?? el[2]);

  return elements.length ? elements : null;
}

/**
 * Compare every mirrored constant across the two sources. Returns STRUCTURED
 * deltas — prose formatting lives only in the CLI below, so tests assert on data
 * rather than substring-matching a message that is free to be reworded.
 */
export function compareMirror(serverSource, uiSource, constants = MIRRORED_CONSTANTS) {
  const deltas = [];

  for (const constant of constants) {
    const server = extractArrayLiteral(serverSource, constant);
    const ui = extractArrayLiteral(uiSource, constant);

    // Fail CLOSED on EITHER side — a one-sided rename/reshape is the likeliest
    // real drift, and two absent literals must never compare as equal empties.
    const missingIn = [];
    if (!server) missingIn.push("server");
    if (!ui) missingIn.push("ui");
    if (missingIn.length) {
      deltas.push({ constant, missingIn, onlyInServer: [], onlyInUi: [], orderMismatch: false });
      continue;
    }

    const onlyInServer = server.filter((v) => !ui.includes(v));
    const onlyInUi = ui.filter((v) => !server.includes(v));
    // Only meaningful once membership matches: same elements, different sequence.
    // The separator is written as the ESCAPE "\0", never a literal NUL byte — an
    // embedded NUL makes this file binary to grep/ripgrep/file(1) (matching lines
    // are suppressed) and invisible in review. NUL is the separator because it
    // cannot occur in a model alias, so no pair of distinct lists can join equal.
    const orderMismatch =
      onlyInServer.length === 0 && onlyInUi.length === 0 && server.join("\0") !== ui.join("\0");

    if (onlyInServer.length || onlyInUi.length || orderMismatch) {
      deltas.push({ constant, missingIn: [], onlyInServer, onlyInUi, orderMismatch });
    }
  }

  return { ok: deltas.length === 0, deltas };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** Human-readable lines for one delta. Wording is intentionally untested. */
function formatDelta(delta) {
  const lines = [];
  if (delta.missingIn.length) {
    const where = delta.missingIn
      .map((side) => (side === "server" ? SERVER_REL : UI_REL))
      .join(" and ");
    lines.push(
      `  ${delta.constant}: could not parse the array literal in ${where}` +
        ` — expected \`const ${delta.constant} = [ "…", … ]\` with string elements.`,
    );
    return lines;
  }
  if (delta.onlyInServer.length) {
    lines.push(
      `  ${delta.constant}: ${delta.onlyInServer.map((v) => `"${v}"`).join(", ")}` +
        ` present in ${SERVER_REL} but MISSING from ${UI_REL}` +
        ` — the API accepts these but no picker can reach them.`,
    );
  }
  if (delta.onlyInUi.length) {
    lines.push(
      `  ${delta.constant}: ${delta.onlyInUi.map((v) => `"${v}"`).join(", ")}` +
        ` present in ${UI_REL} but MISSING from ${SERVER_REL}` +
        ` — the picker offers these but task-create rejects them as unknown.`,
    );
  }
  if (delta.orderMismatch) {
    lines.push(
      `  ${delta.constant}: same elements, DIFFERENT ORDER between ${SERVER_REL}` +
        ` and ${UI_REL} — the UI order is the order the picker renders, so keep both identical.`,
    );
  }
  return lines;
}

// `fileURLToPath` rather than string-concatenating `file://` + argv[1]: import.meta.url
// is PERCENT-ENCODED, so on any checkout path containing a space, `#`, `%` or non-ASCII
// the concat comparison is false, the CLI block never runs, and the gate exits 0 having
// checked nothing — the exact vacuous pass this script exists to prevent. Same idiom as
// scripts/json-union-merge.mjs. (scripts/next-version.mjs still uses the concat form.)
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const serverSource = readFileSync(join(ROOT, SERVER_REL), "utf8");
  const uiSource = readFileSync(join(ROOT, UI_REL), "utf8");
  const { ok, deltas } = compareMirror(serverSource, uiSource);

  if (!ok) {
    console.error(
      `model mirror: ${SERVER_REL} and ${UI_REL} have diverged:\n` +
        `${deltas.flatMap(formatDelta).join("\n")}\n\n` +
        `Fix: edit BOTH files so each list has the same elements in the same order.`,
    );
    process.exit(1);
  }

  const counts = MIRRORED_CONSTANTS.map(
    (c) => `${c} (${extractArrayLiteral(serverSource, c).length})`,
  ).join(", ");
  console.log(`✓ model mirror: ${SERVER_REL} ↔ ${UI_REL} identical — ${counts}`);
}
