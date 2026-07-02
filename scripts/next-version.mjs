#!/usr/bin/env node
// Print the NEXT (unreleased) version — the one an in-flight feature ships in.
//
// WHY THIS EXISTS: `package.json`'s version is the LAST RELEASED version —
// release-please only bumps it when its release PR merges, so between releases
// it lags behind reality. An agent that reads package.json to stamp a feature
// announcement (`ui/src/lib/feature-announcements/entries/v<version>-<id>.ts`,
// `sinceVersion`) therefore picks an ALREADY-RELEASED version, and the entry
// silently never surfaces in the What's-New drawer: the gate in
// `ui/src/lib/feature-gate.ts` only shows entries where
// `lastSeen < sinceVersion <= currentVersion`, and an already-upgraded user's
// `lastSeen` is >= that released version. See CLAUDE.md → "Feature discovery".
//
// The correct `sinceVersion` is always the NEXT release. release-please is
// configured (`release-please-config.json`: `bump-minor-pre-major`) so any
// `feat` cuts a MINOR bump — and an announcement only exists because a feature
// shipped — so the next version is `major.(minor+1).0` off the last release.
//
// Source of truth is `.release-please-manifest.json` (release-please's own
// authoritative record of the last release), NOT package.json — the two are
// kept in sync, but the manifest is what release-please actually reasons from.
//
// Plain ESM — no dependencies, no transpile. Importable (readReleasedVersion /
// nextVersion / compareSemver) by scripts/check-announcement-versions.mjs.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".release-please-manifest.json");

/** Parse "x.y.z" into [major, minor, patch]; throws on a non-semver string. */
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) throw new Error(`not a semver version: "${v}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two semver strings. Returns <0, 0, or >0 (a<b, a==b, a>b). */
export function compareSemver(a, b) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}

/** The last released version, from the release-please manifest's root package. */
export function readReleasedVersion() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const version = manifest["."];
  if (typeof version !== "string") {
    throw new Error(`.release-please-manifest.json has no "." version entry`);
  }
  return version;
}

/** The next unreleased version — a minor bump off the last release. */
export function nextVersion(released = readReleasedVersion()) {
  const [major, minor] = parseSemver(released);
  return `${major}.${minor + 1}.0`;
}

// CLI: print the next version so agents can stamp a fresh announcement fragment.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${nextVersion()}\n`);
}
