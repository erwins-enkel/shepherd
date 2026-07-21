#!/usr/bin/env bun
// Artifact assertions for the built marketing site (`site/dist`).
//
// WHY THIS EXISTS: a green `astro build` does not prove the site is correct. The
// Fonts API's failure mode is *silent* — point a family's provider at a package it
// cannot resolve and the build still exits 0 with only a [WARN], emitting a `dist/`
// where that family has no webfont at all. Measured against a real degraded build,
// every aggregate signal survives it (`@font-face` still present, the `--font-*`
// variable still present, woff2 files still emitted, preload links still emitted).
// The one signal that discriminates is per-family: does the family named by each
// `--font-*` variable actually have a `url()`-backed `@font-face`? That is the
// assertion this script exists for; the rest are cheap floors around it.
//
// Run after `astro build`: `bun run check:artifacts`.
//
// Roots default to this package (resolved from import.meta.url, never process.cwd(),
// so running it from the repo root cannot silently derive an empty route list and
// vacuously pass). Both are env-overridable so the gate can be exercised against
// synthetic fixtures — see test/check-build-artifacts.test.ts.
//
//   SITE_DIST  (or argv[2])  build output to validate      default <pkg>/dist
//   SITE_PAGES               route source of truth         default <pkg>/src/pages

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const DIST = resolve(process.argv[2] ?? process.env.SITE_DIST ?? join(PKG_ROOT, "dist"));
const PAGES = resolve(process.env.SITE_PAGES ?? join(PKG_ROOT, "src", "pages"));

/** CSS custom properties every built page must declare, one per configured font
 *  family (see `fonts` in astro.config.mjs). Listed explicitly rather than derived
 *  from the built CSS: deriving from the output would make the check vacuous if a
 *  family were dropped from the config entirely. */
const EXPECTED_FONT_VARS = ["--font-space-grotesk", "--font-jetbrains-mono"];

/** Minimum size of an emitted route's HTML. The three real routes measure
 *  28825 / 13862 / 12778 bytes, so this only catches an empty/stub write. */
const MIN_ROUTE_BYTES = 2000;

/** Minimum size of an emitted woff2 — catches a truncated font, which otherwise
 *  passes both the presence floor and the per-family check (the file exists and
 *  its `@font-face` still carries a `url()`). The smallest legitimately emitted
 *  woff2 measures 1160 bytes, so 1 KB would leave only ~136 bytes of headroom and
 *  would red the gate whenever subsetting re-chunks. 512 sits comfortably under
 *  every real file and well over a stub write. */
const MIN_WOFF2_BYTES = 512;

let failed = false;

function pass(msg) {
  console.log(`PASS  ${msg}`);
}

function fail(msg) {
  console.log(`FAIL  ${msg}`);
  failed = true;
}

/** Every file under `dir`, recursively. Returns [] when `dir` does not exist. */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

/** Size of a regular file, or -1 if it is missing or is not a regular file.
 *  The isFile() guard matters: statSync on a directory returns a nonzero size,
 *  so a directory sitting where a route's index.html belongs would otherwise
 *  sail past the size floor. */
function sizeOf(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** Map a page file to the HTML Astro emits for it under the default
 *  `build.format: "directory"`:
 *
 *    index.astro            → index.html
 *    privacy.astro          → privacy/index.html
 *    legal/terms.astro      → legal/terms/index.html
 *    legal/index.astro      → legal/index.html
 *
 *  Returns "" for a file Astro deliberately does not route (see below), and null
 *  for anything this mapping does not understand. The caller fails loudly on null
 *  rather than skipping — silently ignoring an unmapped page is the same
 *  under-coverage bug as not walking subdirectories at all. */
function routeForPage(rel) {
  const segments = rel.split(sep);
  // Astro excludes any path with an underscore-prefixed segment from routing
  // (_components/, _draft.astro), so these are not missing routes — asserting on
  // them would be a false failure.
  if (segments.some((s) => s.startsWith("_"))) return "";
  if (!rel.endsWith(".astro")) return null;
  segments[segments.length - 1] = segments[segments.length - 1].slice(0, -".astro".length);
  // Dynamic and spread routes ([slug].astro, [...rest].astro) expand via
  // getStaticPaths at build time, so their outputs cannot be derived from the
  // filename alone.
  if (segments.some((s) => s.includes("[") || s.includes("]"))) return null;
  if (segments[segments.length - 1] === "index") {
    return join(...segments.slice(0, -1), "index.html");
  }
  return join(...segments, "index.html");
}

function checkRoutes() {
  const routes = [];
  for (const abs of walk(PAGES)) {
    const rel = relative(PAGES, abs);
    const route = routeForPage(rel);
    if (route === null) {
      fail(`page ${rel} has no known output mapping (only static .astro pages are supported)`);
      continue;
    }
    if (route !== "") routes.push(route);
  }

  // Guard against a vacuous pass: an empty (or wrong) pages root, or one holding
  // nothing but non-routed files, would otherwise assert nothing at all.
  if (routes.length === 0) {
    fail(`no pages found under ${PAGES} — cannot derive the expected route list`);
    return [];
  }

  for (const route of routes) {
    const size = sizeOf(join(DIST, route));
    if (size < 0) fail(`route ${route} was not emitted`);
    else if (size <= MIN_ROUTE_BYTES) fail(`route ${route} is only ${size} bytes`);
    else pass(`route ${route} emitted (${size} bytes)`);
  }

  return routes;
}

// ── Fonts ────────────────────────────────────────────────────────────────────

/** Every `@font-face` block in `html`, as { family, src }. Tolerates both minified
 *  and expanded CSS. Nested braces do not occur inside `@font-face`. */
function parseFontFaces(html) {
  const faces = [];
  for (const match of html.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1];
    const family = /font-family\s*:\s*([^;]+)/.exec(body)?.[1];
    const src = /src\s*:\s*([^;]+)/.exec(body)?.[1];
    if (family) faces.push({ family: unquote(family), src: src ?? "" });
  }
  return faces;
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

/** The first family named by a font stack — e.g.
 *  `"Space Grotesk-abc","Space Grotesk-abc fallback: Arial",system-ui` → `Space Grotesk-abc` */
function primaryFamily(declarationValue) {
  return unquote(declarationValue.split(",")[0] ?? "");
}

function checkFontsForRoute(route) {
  const file = join(DIST, route);
  let html;
  try {
    html = readFileSync(file, "utf8");
  } catch {
    return; // absence already reported by checkRoutes
  }

  const faces = parseFontFaces(html);
  // A family counts as really present only when it has a webfont — a `local()`
  // metric-adjusted fallback block is emitted even when the provider resolved
  // nothing, so matching on the family name alone would not discriminate.
  const familiesWithWebfont = new Set(
    faces.filter((f) => f.src.includes("url(")).map((f) => f.family),
  );

  for (const varName of EXPECTED_FONT_VARS) {
    const declaration = new RegExp(`${varName}\\s*:\\s*([^;}]+)`).exec(html)?.[1];
    if (!declaration) {
      fail(`${route}: CSS variable ${varName} is not declared`);
      continue;
    }
    const family = primaryFamily(declaration);
    if (!familiesWithWebfont.has(family)) {
      fail(
        `${route}: ${varName} resolves to "${family}", which has no url()-backed @font-face ` +
          `— the font pipeline degraded to system fallbacks`,
      );
      continue;
    }
    pass(`${route}: ${varName} → "${family}" has a webfont`);
  }
}

function checkFontFiles() {
  const woff2 = walk(DIST).filter((f) => f.endsWith(".woff2"));
  if (woff2.length === 0) {
    fail("no .woff2 files were emitted");
    return;
  }
  // Sanity floor only — a degraded build still emits *some* woff2 (the families
  // that did resolve), so this can never be the discriminating signal.
  pass(`${woff2.length} .woff2 file(s) emitted`);

  const truncated = woff2.filter((f) => sizeOf(f) <= MIN_WOFF2_BYTES);
  if (truncated.length > 0) {
    for (const f of truncated) {
      fail(`${relative(DIST, f)} is only ${sizeOf(f)} bytes — truncated font file`);
    }
    return;
  }
  pass(`all .woff2 files exceed ${MIN_WOFF2_BYTES} bytes`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`Checking build artifacts in ${DIST}`);
const routes = checkRoutes();
for (const route of routes) checkFontsForRoute(route);
checkFontFiles();

if (failed) {
  console.error("\nBuild artifact checks FAILED");
  process.exit(1);
}
console.log("\nAll build artifact checks passed");
