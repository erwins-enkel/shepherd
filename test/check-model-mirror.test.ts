import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIRRORED_CONSTANTS,
  compareMirror,
  extractArrayLiteral,
} from "../scripts/check-model-mirror.mjs";

// Resolved from this file, never process.cwd(), so the live-tree case below behaves
// identically under `bun test ./test` and a single-file invocation.
const ROOT = join(import.meta.dir, "..");

/** A minimal `const NAME = [...] as const;` source, the shape both real files use. */
function src(name: string, elements: string[]): string {
  const body = elements.map((e) => `  "${e}",`).join("\n");
  return `export const ${name} = [\n${body}\n] as const;\n`;
}

// ── extractArrayLiteral ──────────────────────────────────────────────────────

test("parses a multi-line exported literal", () => {
  expect(extractArrayLiteral(src("CODEX_MODELS", ["gpt-5", "o3"]), "CODEX_MODELS")).toEqual([
    "gpt-5",
    "o3",
  ]);
});

test("parses a NON-exported const (the CLAUDE_MODELS shape)", () => {
  const source = `const CLAUDE_MODELS = [\n  "opus",\n  "haiku",\n] as const;\n`;
  expect(extractArrayLiteral(source, "CLAUDE_MODELS")).toEqual(["opus", "haiku"]);
});

test("parses a single-line literal (the EFFORTS shape)", () => {
  const source = `export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;\n`;
  expect(extractArrayLiteral(source, "EFFORTS")).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

test("keeps an element containing `]` intact instead of truncating there", () => {
  // A naive "up to the first ]" scan would stop inside "opus[1m]" and drop the rest.
  const elements = ["fable", "opus", "opus[1m]", "claude-opus-5[1m]", "sonnet[1m]", "haiku"];
  expect(extractArrayLiteral(src("CLAUDE_MODELS", elements), "CLAUDE_MODELS")).toEqual(elements);
});

test("does NOT run past an array that lacks `as const` into the next literal", () => {
  // The PREMIUM_MODELS shape (plain `];`) already exists in ui/src/lib/types.ts. An
  // `] as const`-anchored scan would swallow the following array's elements — which
  // in src/types.ts would mean CLAUDE_MODELS absorbing the effort tiers.
  const source =
    `export const CLAUDE_MODELS: readonly string[] = [\n  "opus",\n  "haiku",\n];\n\n` +
    `export const EFFORTS = ["low", "medium", "high"] as const;\n`;
  expect(extractArrayLiteral(source, "CLAUDE_MODELS")).toEqual(["opus", "haiku"]);
  expect(extractArrayLiteral(source, "EFFORTS")).toEqual(["low", "medium", "high"]);
});

test("ignores a doc comment naming the constant ABOVE the declaration", () => {
  // ui/src/lib/types.ts's real shape: the comment above CLAUDE_MODELS names it, and
  // carries a decoy bracketed list plus an `=` and an apostrophe.
  const source =
    `/** Selectable aliases. Mirrors src/types.ts CLAUDE_MODELS — don't diverge;\n` +
    ` *  ["decoy", "values"] here must be ignored. "default" = no flag. */\n` +
    `const CLAUDE_MODELS = [\n  "opus",\n  "haiku",\n] as const;\n`;
  expect(extractArrayLiteral(source, "CLAUDE_MODELS")).toEqual(["opus", "haiku"]);
});

test("ignores a comment naming the constant BELOW the declaration", () => {
  // src/types.ts's real shape: the CODEX_MODEL_RE comment names CODEX_MODELS after it.
  const source =
    `export const CODEX_MODELS = [\n  "gpt-5",\n  "o3",\n] as const;\n\n` +
    `/** …the installed CLI may learn names before the curated CODEX_MODELS list does. */\n` +
    `export const CODEX_MODEL_RE = /^[A-Za-z0-9]$/;\n`;
  expect(extractArrayLiteral(source, "CODEX_MODELS")).toEqual(["gpt-5", "o3"]);
});

test("ignores quoted strings and brackets inside a comment in the array body", () => {
  const source =
    `export const EFFORTS = [\n` +
    `  "low",\n` +
    `  // "ghost" and ["more", "ghosts"] — don't pick these up\n` +
    `  /* "block-ghost" */\n` +
    `  "high",\n` +
    `] as const;\n`;
  expect(extractArrayLiteral(source, "EFFORTS")).toEqual(["low", "high"]);
});

test("does not match a longer constant sharing the prefix", () => {
  const source = `export const CLAUDE_MODELS_LEGACY = ["opus"] as const;\n`;
  expect(extractArrayLiteral(source, "CLAUDE_MODELS")).toBeNull();
});

test("returns null for an absent, unterminated, or element-less literal", () => {
  expect(extractArrayLiteral(`export const OTHER = ["x"] as const;\n`, "EFFORTS")).toBeNull();
  expect(extractArrayLiteral(`export const EFFORTS = [\n  "low",\n`, "EFFORTS")).toBeNull();
  expect(extractArrayLiteral(`export const EFFORTS = [] as const;\n`, "EFFORTS")).toBeNull();
  // Shape changed to identifiers instead of string literals → unparseable, not empty.
  expect(
    extractArrayLiteral(`export const EFFORTS = [LOW, HIGH] as const;\n`, "EFFORTS"),
  ).toBeNull();
});

// ── compareMirror ────────────────────────────────────────────────────────────

/** Both sides of a synthetic mirror, so each case varies only what it tests. */
function pair(server: string[], ui: string[] = server): [string, string] {
  return [src("CLAUDE_MODELS", server), src("CLAUDE_MODELS", ui)];
}

const ONLY_CLAUDE = ["CLAUDE_MODELS"];

test("identical lists → ok with no deltas", () => {
  const [s, u] = pair(["opus", "haiku"]);
  expect(compareMirror(s, u, ONLY_CLAUDE)).toEqual({ ok: true, deltas: [] });
});

test("element added to the UI side only → onlyInUi names it", () => {
  const [s, u] = pair(["opus", "haiku"], ["opus", "claude-opus-5", "haiku"]);
  const { ok, deltas } = compareMirror(s, u, ONLY_CLAUDE);
  expect(ok).toBe(false);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]!.constant).toBe("CLAUDE_MODELS");
  expect(deltas[0]!.onlyInUi).toEqual(["claude-opus-5"]);
  expect(deltas[0]!.onlyInServer).toEqual([]);
  expect(deltas[0]!.orderMismatch).toBe(false);
  expect(deltas[0]!.missingIn).toEqual([]);
});

test("element added to the server side only → onlyInServer names it", () => {
  const [s, u] = pair(["opus", "claude-opus-5", "haiku"], ["opus", "haiku"]);
  const { ok, deltas } = compareMirror(s, u, ONLY_CLAUDE);
  expect(ok).toBe(false);
  expect(deltas[0]!.onlyInServer).toEqual(["claude-opus-5"]);
  expect(deltas[0]!.onlyInUi).toEqual([]);
});

test("same elements, reordered → orderMismatch with both sides clean", () => {
  const [s, u] = pair(["opus", "haiku"], ["haiku", "opus"]);
  const { ok, deltas } = compareMirror(s, u, ONLY_CLAUDE);
  expect(ok).toBe(false);
  expect(deltas[0]!.orderMismatch).toBe(true);
  expect(deltas[0]!.onlyInServer).toEqual([]);
  expect(deltas[0]!.onlyInUi).toEqual([]);
});

test("literal unparseable on ONE side → missingIn names that side, not a skip", () => {
  const [s] = pair(["opus", "haiku"]);
  const renamedUi = src("CLAUDE_MODEL_ALIASES", ["opus", "haiku"]);

  const ui = compareMirror(s, renamedUi, ONLY_CLAUDE);
  expect(ui.ok).toBe(false);
  expect(ui.deltas[0]!.missingIn).toEqual(["ui"]);

  const server = compareMirror(renamedUi, s, ONLY_CLAUDE);
  expect(server.ok).toBe(false);
  expect(server.deltas[0]!.missingIn).toEqual(["server"]);
});

test("literal absent on BOTH sides → fails closed, never a vacuous match", () => {
  const empty = `export const SOMETHING_ELSE = ["x"] as const;\n`;
  const { ok, deltas } = compareMirror(empty, empty, ONLY_CLAUDE);
  expect(ok).toBe(false);
  expect(deltas[0]!.missingIn).toEqual(["server", "ui"]);
});

test("reports every diverged constant, not just the first", () => {
  const server = `${src("CLAUDE_MODELS", ["opus"])}\n${src("EFFORTS", ["low", "high"])}`;
  const ui = `${src("CLAUDE_MODELS", ["opus", "haiku"])}\n${src("EFFORTS", ["high", "low"])}`;
  const { deltas } = compareMirror(server, ui, ["CLAUDE_MODELS", "EFFORTS"]);
  expect(deltas.map((d) => d.constant)).toEqual(["CLAUDE_MODELS", "EFFORTS"]);
  expect(deltas[0]!.onlyInUi).toEqual(["haiku"]);
  expect(deltas[1]!.orderMismatch).toBe(true);
});

// ── the live tree ────────────────────────────────────────────────────────────

test("the real src/types.ts and ui/src/lib/types.ts are in sync", () => {
  const server = readFileSync(join(ROOT, "src", "types.ts"), "utf8");
  const ui = readFileSync(join(ROOT, "ui", "src", "lib", "types.ts"), "utf8");
  expect(compareMirror(server, ui)).toEqual({ ok: true, deltas: [] });
});

test("every mirrored constant actually parses out of both real files", () => {
  // Guards against the parser silently under-matching after a future reformat —
  // without this, `compareMirror` above could pass on two nulls it never saw.
  const server = readFileSync(join(ROOT, "src", "types.ts"), "utf8");
  const ui = readFileSync(join(ROOT, "ui", "src", "lib", "types.ts"), "utf8");
  expect(MIRRORED_CONSTANTS).toEqual(["CLAUDE_MODELS", "CODEX_MODELS", "EFFORTS"]);
  for (const constant of MIRRORED_CONSTANTS) {
    expect(extractArrayLiteral(server, constant)?.length).toBeGreaterThan(0);
    expect(extractArrayLiteral(ui, constant)?.length).toBeGreaterThan(0);
  }
});
