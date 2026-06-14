#!/usr/bin/env node
// Glossary referential-integrity gate: every term's i18n keys must exist in
// both locale catalogs, every [[id|label]] marker in those catalogs must
// resolve to a known glossary term, and every external term must carry
// per-locale Wikipedia slugs.  Exit non-zero with an actionable message on any
// breach; print a concise success line otherwise.
//
// Plain ESM — no dependencies, no transpile.  Mirrors the shape and style of
// ui/scripts/check-i18n.mjs.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GLOSSARY_TS = join(ROOT, "ui", "src", "lib", "glossary.ts");
const MESSAGES_DIR = join(ROOT, "ui", "messages");

// ---------------------------------------------------------------------------
// (a) Parse glossary.ts as text — regex-extract each term's fields.
//     We can't TS-import from a plain node script, so we pattern-match the
//     object literal directly (mirrors check-i18n's direct JSON parsing).
// ---------------------------------------------------------------------------
const glossarySource = readFileSync(GLOSSARY_TS, "utf8");

// Each term block looks like:
//   { id: "epic", kind: "internal", termKey: "gloss_epic_term", bodyKey: "gloss_epic_def" }
// or with an optional wikipedia block:
//   { id: "pr", kind: "external", termKey: "...", bodyKey: "...",
//     wikipedia: { en: "...", de: "..." } }
//
// Strategy: split on "},\n  {" to get individual object blobs, then regex-pick
// each field out of each blob.

// Grab the array body between the first "[" and last "]" of `glossary`
const arrayMatch = glossarySource.match(/glossary[^=]*=\s*\[([\s\S]*?)\];/);
if (!arrayMatch) {
  console.error("glossary: could not locate the `glossary` array in glossary.ts");
  process.exit(1);
}
const arrayBody = arrayMatch[1];

// Split into individual object blobs — each term starts with "{"
const termBlobs = arrayBody.split(/\},?\s*\{/).map((b) => b.replace(/^\s*\{/, "").replace(/\}\s*$/, ""));

/** @type {Array<{ id: string; kind: string; termKey: string; bodyKey: string; wikipedia?: { en: string; de: string } }>} */
const terms = termBlobs
  .map((blob) => {
    const id = (blob.match(/\bid:\s*["']([^"']+)["']/) || [])[1];
    const kind = (blob.match(/\bkind:\s*["']([^"']+)["']/) || [])[1];
    const termKey = (blob.match(/\btermKey:\s*["']([^"']+)["']/) || [])[1];
    const bodyKey = (blob.match(/\bbodyKey:\s*["']([^"']+)["']/) || [])[1];

    if (!id || !kind || !termKey || !bodyKey) return null;

    const wikiMatch = blob.match(/wikipedia:\s*\{[^}]*\ben:\s*["']([^"']*?)["'][^}]*\bde:\s*["']([^"']*?)["'][^}]*\}/s);
    const wikiMatchAlt = blob.match(/wikipedia:\s*\{[^}]*\bde:\s*["']([^"']*?)["'][^}]*\ben:\s*["']([^"']*?)["'][^}]*\}/s);

    let wikipedia;
    if (wikiMatch) {
      wikipedia = { en: wikiMatch[1], de: wikiMatch[2] };
    } else if (wikiMatchAlt) {
      wikipedia = { en: wikiMatchAlt[2], de: wikiMatchAlt[1] };
    }

    return { id, kind, termKey, bodyKey, wikipedia };
  })
  .filter(Boolean);

if (terms.length === 0) {
  console.error("glossary: no terms parsed from glossary.ts — regex may need updating");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// (b) Load locale catalogs
// ---------------------------------------------------------------------------
/** @type {string[]} */
const LOCALES = ["en", "de"];
/** @type {Map<string, Record<string, string>>} */
const catalogs = new Map();

for (const locale of LOCALES) {
  const path = join(MESSAGES_DIR, `${locale}.json`);
  try {
    catalogs.set(locale, JSON.parse(readFileSync(path, "utf8")));
  } catch {
    console.error(`glossary: could not read ${path}`);
    process.exit(1);
  }
}

const problems = [];

// ---------------------------------------------------------------------------
// (c) Assert every term's termKey and bodyKey exists in BOTH catalogs.
//     Also assert gloss_wikipedia_link exists in both.
// ---------------------------------------------------------------------------
const WIKIPEDIA_LINK_KEY = "gloss_wikipedia_link";

for (const term of terms) {
  for (const locale of LOCALES) {
    const catalog = catalogs.get(locale);
    if (!(term.termKey in catalog)) {
      problems.push(`  [${locale}] missing key "${term.termKey}" (term id: "${term.id}")`);
    }
    if (!(term.bodyKey in catalog)) {
      problems.push(`  [${locale}] missing key "${term.bodyKey}" (term id: "${term.id}")`);
    }
  }
}

for (const locale of LOCALES) {
  const catalog = catalogs.get(locale);
  if (!(WIKIPEDIA_LINK_KEY in catalog)) {
    problems.push(`  [${locale}] missing required key "${WIKIPEDIA_LINK_KEY}"`);
  }
}

// ---------------------------------------------------------------------------
// (d) Scan ALL string values in both catalogs for [[id|label]] markers.
//     Assert every marker id exists in the glossary registry.
// ---------------------------------------------------------------------------
const MARKER_RE = /\[\[([a-z0-9-]+)\|[^\]]+\]\]/g;
const registryIds = new Set(terms.map((t) => t.id));

for (const locale of LOCALES) {
  const catalog = catalogs.get(locale);
  for (const [msgKey, msgValue] of Object.entries(catalog)) {
    if (typeof msgValue !== "string") continue;
    let match;
    while ((match = MARKER_RE.exec(msgValue)) !== null) {
      const markerId = match[1];
      if (!registryIds.has(markerId)) {
        problems.push(
          `  [${locale}] dangling marker "[[${markerId}|...]]" in key "${msgKey}" — id not in glossary registry`,
        );
      }
    }
    // Reset lastIndex for re-use across iterations
    MARKER_RE.lastIndex = 0;
  }
}

// ---------------------------------------------------------------------------
// (e) Assert every external term has both wikipedia.en and wikipedia.de
//     non-empty.
// ---------------------------------------------------------------------------
for (const term of terms) {
  if (term.kind !== "external") continue;
  if (!term.wikipedia) {
    problems.push(
      `  term "${term.id}" is kind:"external" but has no wikipedia block — add { en: "...", de: "..." }`,
    );
    continue;
  }
  if (!term.wikipedia.en) {
    problems.push(`  term "${term.id}" is kind:"external" but wikipedia.en is empty`);
  }
  if (!term.wikipedia.de) {
    problems.push(`  term "${term.id}" is kind:"external" but wikipedia.de is empty`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (problems.length) {
  console.error(
    `glossary: referential-integrity check failed (${terms.length} terms, ${LOCALES.join(" + ")} locales):\n${problems.join("\n")}\n\nFix: add missing keys to ui/messages/en.json + de.json, register unknown marker ids in ui/src/lib/glossary.ts, or add wikipedia slugs for external terms.`,
  );
  process.exit(1);
}

console.log(
  `✓ glossary: ${terms.length} terms, keys present in all locales (${LOCALES.join(", ")}), no dangling markers, external terms have Wikipedia slugs`,
);
