#!/usr/bin/env node
// CI path gate (#2568): decides which ci.yml jobs a PR can skip. The `changes` job runs
// this and the gated jobs read its outputs through a job-level `if:` — never workflow
// `paths:`, because a required check that never reports deadlocks the PR (#1859), while
// a job skipped by `if:` reports "skipped", which the ruleset counts as passing.
//
// COARSE AND FAIL-OPEN on purpose. Anything the rules below don't recognise runs every
// job; only docs-only PRs skip the test lanes. Area skipping (e.g. native-only skipping
// test-root) is out: the root suite reads native/, docs-site/ and test/fixtures across
// package lines. Pushes to main always run everything — with `strict: false` that run is
// the only check on the merged tree, and it catches a wrong rule minutes after merge.
//
// Plain .mjs so the job needs only the runner's node, no Bun setup or install.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Basenames that change how any package builds, lints or tests.
const GLOBAL_NAMES = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "bunfig.toml",
  ".prettierignore",
]);
const GLOBAL_NAME_PATTERNS = [/^tsconfig.*\.json$/, /^eslint\.config\./, /^\.prettierrc/];
// Covers contracts/openapi*.yaml and scripts/check-cli.sh, which also feed `cli`.
const GLOBAL_PREFIXES = [".github/", "scripts/", "contracts/"];
// Known package areas. A change here runs the test lanes; anything outside these,
// the docs and the globals is uncovered and runs everything.
const AREA_PREFIXES = [
  "src/",
  "test/",
  "ui/",
  "extension/",
  "native/",
  "deploy/",
  "ci/",
  "examples/",
  "docs-site/",
  "site/",
  "cli/",
];
// docs-site/scripts/sync-docs.mjs renders docs/ and the root CLAUDE.md; TypeDoc reads src/.
const DOCS_SITE_PREFIXES = ["docs-site/", "docs/", "src/"];

const basename = (f) => f.slice(f.lastIndexOf("/") + 1);
const isGlobal = (f) =>
  GLOBAL_NAMES.has(basename(f)) ||
  GLOBAL_NAME_PATTERNS.some((re) => re.test(basename(f))) ||
  GLOBAL_PREFIXES.some((p) => f.startsWith(p));
// Only docs/** and TOP-LEVEL .md. Nested .md (SKILL.md, rules) is read by tests.
const isDocs = (f) => f.startsWith("docs/") || (!f.includes("/") && f.endsWith(".md"));
const isArea = (f) => AREA_PREFIXES.some((p) => f.startsWith(p));

/** Which gated jobs must run for this change set. */
export function classify(files, { event }) {
  const all = (reason) => ({ test: true, site: true, cli: true, docs_site: true, reason });
  if (event !== "pull_request") return all(`event ${event}: run everything`);
  if (files.length === 0) return all("empty diff: run everything");
  const global = files.find(isGlobal);
  if (global) return all(`global trigger ${global}: run everything`);
  const uncovered = files.find((f) => !isDocs(f) && !isArea(f));
  if (uncovered) return all(`uncovered path ${uncovered}: run everything`);
  return {
    test: files.some((f) => !isDocs(f)),
    site: files.some((f) => f.startsWith("site/")),
    cli: files.some((f) => f.startsWith("cli/")),
    docs_site: files.some(
      (f) => f === "CLAUDE.md" || DOCS_SITE_PREFIXES.some((p) => f.startsWith(p)),
    ),
    reason: "path rules",
  };
}

/** The `$GITHUB_OUTPUT` lines for a classification. */
export function formatOutputs(r) {
  return ["test", "site", "cli", "docs_site"].map((k) => `${k}=${r[k]}\n`).join("");
}

// CLI: EVENT_NAME + BASE_REF from the workflow; needs a full-history checkout.
if (import.meta.url === `file://${process.argv[1]}`) {
  const event = process.env.EVENT_NAME ?? "";
  let files = [];
  if (event === "pull_request") {
    const base = process.env.BASE_REF;
    if (!base) throw new Error("BASE_REF is required on pull_request");
    // --no-renames lists a move as delete + add, so a src/ → docs/ move still runs tests;
    // -z keeps non-ASCII paths unquoted.
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `origin/${base}...HEAD`],
      { encoding: "utf8" },
    );
    files = out.split("\0").filter(Boolean);
  }
  const result = classify(files, { event });
  process.stdout.write(
    `${files.length} changed file(s):\n${files.map((f) => `  ${f}\n`).join("")}`,
  );
  process.stdout.write(`${result.reason}\n${formatOutputs(result)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, formatOutputs(result));
}
