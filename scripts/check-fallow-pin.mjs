#!/usr/bin/env node
// Fallow version-pin gate (#2182): every place the repo names the pinned fallow
// release must name the SAME release.
//
// THE HAZARD this closes: the pin is deliberately NOT `@latest`, and it is written out
// twelve times across six files — a CI step, a pre-push argv, a `.fallowrc.jsonc`
// baseline recipe, four spots in CONTRIBUTING.md, a test comment, and `FALLOW_VERSION`
// in src/maintain-core.ts. Every site carried a "keep in sync" comment and nothing
// enforced it. Since #2179 that is no longer merely untidy: the `dead_code_drift`
// maintain band uses `FALLOW_VERSION` to MEASURE and to run `fallow fix`, unattended.
// A one-sided edit is silent in both directions:
//   • bump ci.yml only        → the band keeps scoring on the old analyser, and a
//                               Tier-3 PR can land CI-red on findings it never saw.
//   • bump FALLOW_VERSION only → the loop opens PRs for a finding class CI does not
//                               enforce.
//
// WHY TEXTUAL rather than one exported constant every site reads: `.github/workflows/
// ci.yml`, `CONTRIBUTING.md` and `.fallowrc.jsonc` cannot import TypeScript, so the
// duplication is STRUCTURAL — a gate is the only thing that can close it. Same argument,
// and same shape, as scripts/check-model-mirror.mjs (#1936); all three wiring points
// (the `check:fallow-pin` package script, the pre-push `gates` lane, the PR-hygiene
// workflow) invoke a gate as a bare command, which a `bun test` assertion cannot fill.
//
// WHY REPO-WIDE rather than a declared file list (which is what check-model-mirror.mjs
// does, and what #2182 proposed): a `bunx fallow@…` invocation can appear in ANY new
// file, unlike a `const` in a known module. A fixed list reproduces the very hole this
// gate exists to close, one level up — a pin added in a seventh file would be invisible.
// Enumerating tracked files costs a few milliseconds and covers new sites for free.
//
// WHY ONE TOKEN: five of the twelve sites used to name the version in PROSE ("pins
// fallow to X", "Verified against fallow X"). No safe pattern can match those, because
// the SAME comment blocks legitimately name other releases — `(fallow 2.98+)`, the
// release that introduced the synthetic Svelte <template> metric, and "the old 2.97
// pin". #2182 reworded all five to carry the `fallow@<semver>` token instead, so the
// legitimate prose stays unmatched BY CONSTRUCTION (no `@`) rather than by an exclusion
// list. Keep it that way: write a new pin site as `fallow@<version>`, and keep prose
// about some OTHER release in the un-`@`-ed form.
//
// It fails CLOSED, in both directions: an unparseable canonical is an error, and so is
// finding ZERO pinned invocations (which means the pattern rotted, not that the repo is
// clean — the exact vacuous pass a gate must never produce).
//
// Plain ESM — no dependencies, no transpile. Importable (extractPinRefs /
// extractCanonicalVersion / comparePins / scanTree) by test/check-fallow-pin.test.ts.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file, never process.cwd(), so the CLI works from any directory.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The file holding `FALLOW_VERSION` — the canonical every other site is compared to. */
export const CANONICAL_REL = "src/maintain-core.ts";

/**
 * A full semver, prerelease and build metadata included.
 *
 * The tails are not decoration: with a bare `\d+\.\d+\.\d+` a site pinned to
 * `<x.y.z>-beta.1` would capture only `<x.y.z>` and compare EQUAL to a plain `<x.y.z>`
 * elsewhere — drift the gate would wave through.
 */
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;

/**
 * A pinned invocation: `fallow@<semver>`, the form every non-TypeScript site uses
 * (`bunx fallow@<version> audit …`, the pre-push argv, the CONTRIBUTING snippets).
 *
 * Deliberately narrow. `fallow@…` and `fallow@<pinned>` — the two intentionally
 * version-free placeholders in the tree (scripts/pre-push.ts, src/maintain.ts and the
 * docs-site configuration reference) — do not match, and neither does prose naming a
 * different release without the `@`.
 */
const invocationRe = () => new RegExp(String.raw`fallow@(` + SEMVER + `)`, "g");

/**
 * The `FALLOW_VERSION` declaration. Scanned repo-wide, not just in {@link CANONICAL_REL},
 * so a SECOND declaration (a hand-copied UI mirror, say) is caught rather than assumed
 * absent.
 *
 * Anchored on the `const` keyword rather than the loose `<NAME>[^=]*=` idiom used
 * elsewhere in scripts/ — check-model-mirror.mjs learned that one the hard way: these
 * names appear in PROSE right next to their declarations (maintain-core.ts's own doc
 * comment argues about keeping `FALLOW_VERSION` in sync), and an import statement names
 * it too. `\b` rejects a longer name sharing the prefix.
 */
const declarationRe = () =>
  new RegExp(
    String.raw`(?:export\s+)?const\s+FALLOW_VERSION\b\s*(?::[^=]*)?=\s*["'](` + SEMVER + `)["']`,
    "g",
  );

/** 1-based line number of `index` in `source`. */
function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * Every pin reference in one file's text, sorted by line. Returns `[]` for a file that
 * names no pinned version — the overwhelmingly common case.
 */
export function extractPinRefs(source) {
  const refs = [];
  for (const [kind, re] of [
    ["invocation", invocationRe()],
    ["declaration", declarationRe()],
  ]) {
    let m;
    while ((m = re.exec(source)) !== null) {
      refs.push({ kind, version: m[1], line: lineOf(source, m.index) });
    }
  }
  return refs.sort((a, b) => a.line - b.line);
}

/** The version `FALLOW_VERSION` is declared as, or null when it cannot be parsed. */
export function extractCanonicalVersion(source) {
  const m = declarationRe().exec(source);
  return m ? m[1] : null;
}

/**
 * Compare every reference against the canonical. Returns STRUCTURED data — prose
 * formatting lives only in the CLI below, so tests assert on facts rather than
 * substring-matching a message that is free to be reworded.
 *
 * `reason` is one of "no-canonical" (nothing to compare against), "no-invocations" (the
 * pattern found nothing, so the comparison would be vacuous), "drift", or null when ok.
 */
export function comparePins(canonical, refs) {
  const invocations = refs.filter((r) => r.kind === "invocation").length;
  const base = {
    canonical,
    invocations,
    declarations: refs.length - invocations,
    files: new Set(refs.map((r) => r.file)).size,
    mismatches: [],
  };

  if (!canonical) return { ...base, ok: false, reason: "no-canonical" };
  if (invocations === 0) return { ...base, ok: false, reason: "no-invocations" };

  const mismatches = refs.filter((r) => r.version !== canonical);
  return {
    ...base,
    mismatches,
    ok: mismatches.length === 0,
    reason: mismatches.length ? "drift" : null,
  };
}

// ── the tree ─────────────────────────────────────────────────────────────────

/**
 * `process.env` minus git's repo-local variables.
 *
 * Git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / … into hooks, and this gate
 * runs from one. Inherited, they would point `git ls-files` at the hook's repository no
 * matter which `cwd` it is given — so a run from a fixture tree would enumerate the REAL
 * repo instead. `.husky/pre-push` scrubs the same set for the same reason. The list is
 * asked of git rather than hardcoded so it stays right as git adds variables; the
 * fallback covers a `git` that cannot answer.
 */
export function gitEnv() {
  const env = { ...process.env };
  const r = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" });
  const names =
    r.status === 0
      ? r.stdout.split("\n").map((s) => s.trim())
      : ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"];
  for (const name of names) if (name) delete env[name];
  return env;
}

/** Every file git tracks under `root`, as repo-relative paths. */
function trackedFiles(root, env) {
  const r = spawnSync("git", ["ls-files", "-z"], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const why = r.stderr?.toString().trim() || r.error?.message || `exit ${r.status}`;
    throw new Error(`\`git ls-files\` failed in ${root}: ${why}`);
  }
  return r.stdout.toString("utf8").split("\0").filter(Boolean);
}

/**
 * Scan every tracked file for pin references. Each ref carries its repo-relative `file`.
 *
 * Two files are skipped rather than parsed: one that is gone from the working tree (a
 * staged deletion, or a broken symlink) and one that looks binary. The `fallow` prefilter
 * is what keeps this cheap — it rejects ~99% of the tree on a substring test, before any
 * UTF-8 decode. Both spellings are checked because the two patterns need exactly those:
 * lowercase for `fallow@`, uppercase for `FALLOW_VERSION`.
 */
export function scanTree(root, env = gitEnv()) {
  const refs = [];
  for (const rel of trackedFiles(root, env)) {
    let buf;
    try {
      buf = readFileSync(join(root, rel));
    } catch {
      continue;
    }
    if (!buf.includes("fallow") && !buf.includes("FALLOW")) continue;
    if (buf.subarray(0, 8000).includes(0)) continue;
    for (const ref of extractPinRefs(buf.toString("utf8"))) refs.push({ file: rel, ...ref });
  }
  return refs;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * Is this module the process entry point (i.e. run as the CLI, not imported)?
 *
 * Both normalizations matter, and getting either wrong silently skips the CLI block — so
 * `node scripts/check-fallow-pin.mjs` exits 0 having compared NOTHING, the exact vacuous
 * pass this gate exists to prevent. See the long-form derivation in
 * scripts/check-model-mirror.mjs: `fileURLToPath` because import.meta.url is
 * percent-encoded, and `realpathSync(argv[1])` because Node realpath-resolves the entry
 * module but leaves argv[1] merely resolved. Both are covered by regression tests in
 * test/check-fallow-pin.test.ts.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // argv[1] isn't a resolvable path (eval/bundler harness) → not the CLI entry.
    return false;
  }
}

/** Human-readable failure text for a non-ok result. Wording is intentionally untested. */
function formatFailure(result) {
  const fix =
    `Fix: make every site name the same version. \`FALLOW_VERSION\` in ${CANONICAL_REL} is the` +
    ` canonical — it drives the unattended maintain loop, so a site disagreeing with it means the` +
    ` loop measures against one analyser while CI gates with another.`;

  if (result.reason === "no-canonical") {
    return (
      `fallow pin: could not parse \`FALLOW_VERSION\` in ${CANONICAL_REL} —` +
      ` expected \`export const FALLOW_VERSION = "<semver>";\`.\n` +
      `There is nothing to compare the other ${result.invocations} pin site(s) against, so this is` +
      ` an error rather than a skipped comparison.`
    );
  }

  if (result.reason === "no-invocations") {
    return (
      `fallow pin: found ZERO pinned \`fallow@<semver>\` invocations in the tree.\n` +
      `Either every pinned invocation is gone, or this gate's pattern has rotted — both are` +
      ` errors, never a silent pass. Pin sites are written as \`fallow@<version>\`; prose about a` +
      ` DIFFERENT release stays in the un-\`@\`-ed form on purpose.`
    );
  }

  const lines = result.mismatches.map(
    (m) =>
      `  ${m.file}:${m.line} — ${m.kind === "declaration" ? "FALLOW_VERSION" : "pinned invocation"}` +
      ` names ${m.version}, canonical is ${result.canonical}`,
  );
  return `fallow pin: ${result.mismatches.length} site(s) disagree with the canonical:\n${lines.join("\n")}\n\n${fix}`;
}

if (isMainModule()) {
  let result;
  try {
    const refs = scanTree(ROOT);
    const canonical = extractCanonicalVersion(readFileSync(join(ROOT, CANONICAL_REL), "utf8"));
    result = comparePins(canonical, refs);
  } catch (err) {
    console.error(`fallow pin: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(formatFailure(result));
    process.exit(1);
  }

  console.log(
    `✓ fallow pin: ${result.canonical} everywhere — ${result.invocations} pinned invocation(s)` +
      ` + ${result.declarations} FALLOW_VERSION declaration(s) across ${result.files} file(s).`,
  );
}
