#!/usr/bin/env node
// Announcement-version gate: a NEWLY-ADDED feature-announcement fragment must
// be stamped at an UNRELEASED version — strictly greater than the last release.
//
// THE FAILURE MODE this closes: `package.json`'s version lags at the last
// RELEASED version between releases (release-please only bumps it when its
// release PR merges). An agent that reads package.json to fill `sinceVersion`
// picks an already-released version; the entry then never surfaces in the
// What's-New drawer, because `ui/src/lib/feature-gate.ts` only shows entries
// where `lastSeen < sinceVersion <= currentVersion` and an upgraded user's
// `lastSeen` already covers that released version. Silent rot — builds clean,
// passes every other gate, and the feature is just invisible.
//
// So for each entry file ADDED in this branch's range we assert:
//   (1) sinceVersion > last-released version  (i.e. it targets a future release), and
//   (2) the filename's `v<version>-` prefix matches the `sinceVersion` field.
// The floor is `> released` (not `== next-version`) so a legitimately
// further-out target still passes; `bun run next-version` prints the canonical
// value to reach for. Only ADDED files are checked — editing a historical entry
// (whose sinceVersion is naturally <= released) must not trip the gate.
// Separately, EVERY entry is checked for a stranded version (see strandedErrors).
//
// Base defaults to origin/main; CI can override via $BASE_REF. Fails CLOSED if
// the base can't be resolved (mirrors scripts/check-feature-catalog.sh) so an
// unresolvable ref can't wave a bad entry through on a vacuous pass.
//
// Plain ESM — no dependencies, no transpile. See .claude/rules/ui-feature-catalog.md.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareSemver,
  nextVersion,
  readChangelogVersions,
  readReleasedVersion,
  strandedVersion,
} from "./next-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES_DIR = "ui/src/lib/feature-announcements/entries";
const BASE = process.env.BASE_REF || "origin/main";

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

// Make sure we actually have the base to diff against (CI shallow-clones).
git(["fetch", "--quiet", "origin", "main"]);

// Fail CLOSED if the base can't be resolved — a missing ref must not yield an
// empty added-file list and a silent pass.
if (!git(["rev-parse", "--verify", "--quiet", `${BASE}^{commit}`]).ok) {
  console.error(
    `✗ announcement versions: base ref '${BASE}' could not be resolved — refusing a vacuous pass.`,
  );
  console.error(
    `  Fetch it first (e.g. \`git fetch origin main\`), or set $BASE_REF to a local base.`,
  );
  process.exit(1);
}

// Catalog-wide STRANDED check (every entry, not just added ones): each
// sinceVersion must be released (a CHANGELOG heading) or still upcoming
// (> released). Anything else aimed at a release that shipped under another
// number — e.g. 1.48.0 entries when release-please cut 2.0.0 — and the drawer
// groups them under a version that never existed. On the release-please PR the
// manifest + CHANGELOG are already bumped, so this fires BEFORE the release lands.
function strandedErrors(released) {
  const releasedSet = readChangelogVersions();
  const out = [];
  for (const name of readdirSync(join(ROOT, ENTRIES_DIR)).filter((f) => f.endsWith(".ts"))) {
    const file = `${ENTRIES_DIR}/${name}`;
    const since = /sinceVersion:\s*["'`]([^"'`]+)["'`]/.exec(
      readFileSync(join(ROOT, file), "utf8"),
    )?.[1];
    if (!since) continue; // reported for added files below; historical entries all carry one
    let stranded;
    try {
      stranded = strandedVersion(since, releasedSet, released);
    } catch {
      out.push(`${file}: sinceVersion "${since}" is not a valid semver version`);
      continue;
    }
    if (stranded) {
      out.push(
        `${file}: sinceVersion "${since}" was never released and is <= ${released} — its release ` +
          `shipped under another number. Rename to v${released}-… / "${released}" if it shipped in ` +
          `${released}, else use \`bun run next-version\` (${nextVersion(released)}).`,
      );
    }
  }
  return out;
}

const released = readReleasedVersion();
const stranded = strandedErrors(released);
if (stranded.length) {
  console.error(`✗ announcement versions: ${stranded.length} stranded catalog entr(y/ies):`);
  for (const e of stranded) console.error(`    • ${e}`);
  process.exit(1);
}

// Files added by this branch under the entries dir (three-dot = vs merge-base,
// --diff-filter=A = additions only, so edits to historical entries are ignored).
const added = git(["diff", "--name-only", "--diff-filter=A", `${BASE}...HEAD`, "--", ENTRIES_DIR])
  .out.split("\n")
  .map((f) => f.trim())
  .filter((f) => f.endsWith(".ts"));

if (added.length === 0) {
  console.log(`✓ announcement versions: no new fragments in ${ENTRIES_DIR} — nothing to check`);
  process.exit(0);
}

const errors = [];

for (const file of added) {
  const source = readFileSync(join(ROOT, file), "utf8");

  const fieldMatch = /sinceVersion:\s*["'`]([^"'`]+)["'`]/.exec(source);
  if (!fieldMatch) {
    errors.push(`${file}: no \`sinceVersion\` field found`);
    continue;
  }
  const since = fieldMatch[1];

  const nameMatch = /^v(\d+\.\d+\.\d+)-/.exec(basename(file));
  if (!nameMatch) {
    errors.push(`${file}: filename must start with \`v<version>-\` (e.g. v${released}-<id>.ts)`);
  } else if (nameMatch[1] !== since) {
    errors.push(
      `${file}: filename version v${nameMatch[1]} ≠ sinceVersion "${since}" — keep them identical`,
    );
  }

  let cmp;
  try {
    cmp = compareSemver(since, released);
  } catch {
    errors.push(`${file}: sinceVersion "${since}" is not a valid semver version`);
    continue;
  }
  if (cmp <= 0) {
    errors.push(
      `${file}: sinceVersion "${since}" is <= the last released version ${released} — it would ` +
        `NEVER surface in What's-New. Stamp the NEXT release instead (\`bun run next-version\` → ${nextVersion(released)}).`,
    );
  }
}

if (errors.length) {
  console.error(`✗ announcement versions: ${errors.length} problem(s) in new catalog fragment(s):`);
  for (const e of errors) console.error(`    • ${e}`);
  console.error(
    `\n  Between releases, package.json holds the LAST released version — do not copy it into a\n` +
      `  new announcement. Run \`bun run next-version\` (currently ${nextVersion(released)}) and use that for\n` +
      `  both the \`v<version>-<id>.ts\` filename and the \`sinceVersion\` field. See .claude/rules/ui-feature-catalog.md.`,
  );
  process.exit(1);
}

console.log(
  `✓ announcement versions: ${added.length} new fragment(s) stamped > released ${released}`,
);
