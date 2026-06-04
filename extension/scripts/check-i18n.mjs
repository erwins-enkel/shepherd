#!/usr/bin/env node
// i18n gate: every locale catalog under extension/messages/ must carry the SAME set of
// keys, and no value may be empty. Paraglide silently falls back to the base
// locale for a missing key, so an incomplete translation ships looking "fine" —
// this check turns that into a hard failure (CI `verify` + pre-push).
//
// It does NOT detect hardcoded strings that bypass the catalog entirely; that's
// covered by the i18n steering in CLAUDE.md + code review.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MESSAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "messages");
const META_KEYS = new Set(["$schema"]);

const files = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".json"));
if (files.length < 2) {
  console.error(`i18n: expected ≥2 locale catalogs in ${MESSAGES_DIR}, found ${files.length}`);
  process.exit(1);
}

/** @type {Map<string, Set<string>>} locale → key set */
const keysByLocale = new Map();
/** @type {Map<string, string[]>} locale → keys with empty values */
const emptyByLocale = new Map();

for (const file of files) {
  const locale = file.replace(/\.json$/, "");
  const data = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf8"));
  const keys = new Set();
  const empty = [];
  for (const [k, v] of Object.entries(data)) {
    if (META_KEYS.has(k)) continue;
    keys.add(k);
    if (typeof v === "string" && v.trim() === "") empty.push(k);
  }
  keysByLocale.set(locale, keys);
  emptyByLocale.set(locale, empty);
}

const locales = [...keysByLocale.keys()];
const union = new Set(locales.flatMap((l) => [...keysByLocale.get(l)]));

const problems = [];
for (const locale of locales) {
  const has = keysByLocale.get(locale);
  const missing = [...union].filter((k) => !has.has(k)).sort();
  if (missing.length)
    problems.push(`  ${locale}.json missing ${missing.length}: ${missing.join(", ")}`);
  const empty = emptyByLocale.get(locale);
  if (empty.length) problems.push(`  ${locale}.json empty values: ${empty.join(", ")}`);
}

if (problems.length) {
  console.error(
    `i18n: catalog parity check failed (${locales.join(", ")} must share identical, non-empty keys):\n${problems.join("\n")}`,
  );
  process.exit(1);
}

console.log(`✓ i18n: ${locales.length} locales in parity (${union.size} keys each)`);
