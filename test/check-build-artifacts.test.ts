import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// The gate under test lives with the package it validates; the test lives here,
// matching check-generated-docs.test.ts / check-feature-catalog.test.ts (both of
// which also reach into a standalone package's tree from root test/).
const SCRIPT = join(import.meta.dir, "..", "site", "scripts", "check-build-artifacts.mjs");

// Family names as Astro emits them: the human name plus a content hash. The hash
// is arbitrary here — the gate must never depend on its value.
const SG = "Space Grotesk-e5e3653021f8a4c5";
const JB = "JetBrains Mono-b581649cf8f10209";

let fixture: string;
let pages: string;
let dist: string;
let config: string;

/** A stand-in astro.config.mjs — the gate reads its `cssVariable` entries as the
 *  source of truth for which font families must be present. */
function writeConfig(cssVars: string[]) {
  const entries = cssVars
    .map((v) => `    { name: "X", cssVariable: "${v}", provider: fontProviders.npm() },`)
    .join("\n");
  writeFileSync(config, `export default defineConfig({\n  fonts: [\n${entries}\n  ],\n});\n`);
}

function write(root: string, rel: string, contents: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

interface PageOpts {
  /** Families given a real `url()`-backed @font-face. Omitting one models the
   *  measured silent-fallback build, where the variable is still declared but the
   *  family it names has no webfont. */
  webfontFamilies?: string[];
  /** CSS variables to declare. */
  vars?: Record<string, string>;
}

/** Build page HTML shaped like Astro's minified output: the font `@font-face`
 *  blocks (webfont + `local()` metric fallback) and the `--font-*` stack. */
function pageHtml({
  webfontFamilies = [SG, JB],
  vars = {
    "--font-space-grotesk": `"${SG}","${SG} fallback: Arial",system-ui,sans-serif`,
    "--font-jetbrains-mono": `"${JB}","${JB} fallback: Courier New",ui-monospace,monospace`,
  },
}: PageOpts = {}) {
  const faces: string[] = [];
  for (const family of [SG, JB]) {
    if (webfontFamilies.includes(family)) {
      const file = family.startsWith("Space") ? "sg.woff2" : "jb.woff2";
      faces.push(
        `@font-face{font-family:"${family}";src:url("/_astro/fonts/${file}") format("woff2")}`,
      );
    }
    // The metric-adjusted local() fallback is emitted either way — which is
    // precisely why matching on the family name alone cannot discriminate.
    const fallback = family.startsWith("Space") ? "Arial" : "Courier New";
    faces.push(
      `@font-face{font-family:"${family} fallback: ${fallback}";src:local("${fallback}")}`,
    );
  }
  const decls = Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  // Padded past the gate's 2000-byte route floor, as a real page is.
  const filler = `<p>${"marketing copy ".repeat(150)}</p>`;
  return `<!DOCTYPE html><html><head><style>${faces.join("")}:root{${decls}}</style></head><body>${filler}</body></html>`;
}

/** A woff2 comfortably over the gate's 512-byte truncation floor. */
function woff2(bytes = 4096) {
  return "w".repeat(bytes);
}

/** Seed a healthy three-route site: pages + matching dist + two font files. */
function seedHealthy() {
  for (const name of ["index", "privacy", "impressum"]) {
    write(pages, `${name}.astro`, "<h1>page</h1>\n");
  }
  write(dist, "index.html", pageHtml());
  write(dist, "privacy/index.html", pageHtml());
  write(dist, "impressum/index.html", pageHtml());
  write(dist, "_astro/fonts/sg.woff2", woff2());
  write(dist, "_astro/fonts/jb.woff2", woff2());
}

function runGate(): { code: number; out: string } {
  const r = spawnSync("bun", [SCRIPT], {
    env: { ...process.env, SITE_DIST: dist, SITE_PAGES: pages, SITE_CONFIG: config },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "shepherd-site-artifacts-"));
  pages = join(fixture, "src", "pages");
  dist = join(fixture, "dist");
  config = join(fixture, "astro.config.mjs");
  mkdirSync(pages, { recursive: true });
  mkdirSync(dist, { recursive: true });
  writeConfig(["--font-space-grotesk", "--font-jetbrains-mono"]);
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

test("healthy build passes", () => {
  seedHealthy();
  const { code, out } = runGate();
  expect(code).toBe(0);
  expect(out).toContain("All build artifact checks passed");
});

// THE load-bearing case: the measured silent-fallback shape. The variable is
// declared and `@font-face` blocks exist, but the family the variable names has
// only a local() fallback. Every aggregate check passes here — if this test ever
// goes green on a loosened assertion, the gate has stopped doing its job.
test("family with only a local() fallback fails", () => {
  seedHealthy();
  const degraded = pageHtml({ webfontFamilies: [SG] });
  write(dist, "index.html", degraded);
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("--font-jetbrains-mono");
  expect(out).toContain("no url()-backed @font-face");
});

test("truncated woff2 fails", () => {
  seedHealthy();
  write(dist, "_astro/fonts/jb.woff2", "xx");
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("truncated font file");
});

test("missing route fails", () => {
  seedHealthy();
  rmSync(join(dist, "privacy"), { recursive: true, force: true });
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("privacy/index.html");
  expect(out).toContain("was not emitted");
});

test("undersized route fails", () => {
  seedHealthy();
  write(dist, "privacy/index.html", "<html></html>");
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("is only");
});

test("missing --font-* declaration fails", () => {
  seedHealthy();
  write(dist, "index.html", pageHtml({ vars: { "--font-space-grotesk": `"${SG}",system-ui` } }));
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("--font-jetbrains-mono is not declared");
});

test("no woff2 emitted fails", () => {
  seedHealthy();
  rmSync(join(dist, "_astro"), { recursive: true, force: true });
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("no .woff2 files were emitted");
});

// Route derivation must walk subdirectories: a flat glob would silently under-cover
// a nested page while the gate still reported green.
test("nested page is asserted on", () => {
  seedHealthy();
  write(pages, join("legal", "terms.astro"), "<h1>terms</h1>\n");
  const missing = runGate();
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("legal/terms/index.html");

  write(dist, "legal/terms/index.html", pageHtml());
  expect(runGate().code).toBe(0);
});

test("nested index page maps to its directory", () => {
  seedHealthy();
  write(pages, join("legal", "index.astro"), "<h1>legal</h1>\n");
  write(dist, "legal/index.html", pageHtml());
  expect(runGate().code).toBe(0);
});

test("unmappable page extension fails loudly", () => {
  seedHealthy();
  write(pages, "notes.md", "# notes\n");
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("no known output mapping");
});

test("dynamic route fails loudly", () => {
  seedHealthy();
  write(pages, "[slug].astro", "<h1>dynamic</h1>\n");
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("no known output mapping");
});

test("empty pages directory fails rather than passing vacuously", () => {
  write(dist, "index.html", pageHtml());
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("no pages found");
});

// Astro excludes underscore-prefixed paths from routing, so asserting on them
// would be a false failure — but they must not be able to make the run vacuous.
test("underscore-prefixed pages are not treated as routes", () => {
  seedHealthy();
  write(pages, "_draft.astro", "<h1>draft</h1>\n");
  write(pages, join("_components", "Card.astro"), "<div>card</div>\n");
  expect(runGate().code).toBe(0);
});

test("a pages directory of only non-routed files fails rather than passing vacuously", () => {
  write(pages, "_draft.astro", "<h1>draft</h1>\n");
  write(dist, "index.html", pageHtml());
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("no pages found");
});

test("dot-prefixed junk under src/pages is ignored", () => {
  seedHealthy();
  write(pages, ".DS_Store", "junk\n");
  expect(runGate().code).toBe(0);
});

// The expected font list is read from astro.config.mjs rather than hardcoded, so a
// family added to the config is checked immediately instead of drifting out of
// coverage while the gate keeps reporting green.
test("a family added to the config is checked without touching the script", () => {
  seedHealthy();
  writeConfig(["--font-space-grotesk", "--font-jetbrains-mono", "--font-newly-added"]);
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("--font-newly-added is not declared");
});

test("a family removed from the config is no longer required", () => {
  seedHealthy();
  writeConfig(["--font-space-grotesk"]);
  write(dist, "index.html", pageHtml({ webfontFamilies: [SG] }));
  expect(runGate().code).toBe(0);
});

// The variable name is interpolated into a RegExp, so an unescaped metacharacter
// either throws (unbalanced paren) or matches the wrong declaration. Both tests
// below fail if the escaping is removed.
test("a cssVariable with an unbalanced paren reports cleanly instead of throwing", () => {
  seedHealthy();
  writeConfig(["--font-space-grotesk", "--font-jetbrains-mono", "--font-a(b"]);
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("--font-a(b is not declared");
  expect(out).not.toContain("Invalid regular expression");
});

test("a '.' in a cssVariable does not match a similarly-named declaration", () => {
  seedHealthy();
  writeConfig(["--font-a.c"]);
  // The decoy is declared FIRST and resolves to a family with no webfont, so an
  // unescaped `.` matches it and the run fails; matching literally finds the real
  // declaration and passes.
  const vars = { "--font-a-c": `"${JB}"`, "--font-a.c": `"${SG}"` };
  for (const route of ["index.html", "privacy/index.html", "impressum/index.html"]) {
    write(dist, route, pageHtml({ webfontFamilies: [SG], vars }));
  }
  expect(runGate().code).toBe(0);
});

// A family left commented out during a swap is not configured — requiring it would
// red the gate for a font the site no longer ships.
test("a commented-out cssVariable is not required", () => {
  seedHealthy();
  writeFileSync(
    config,
    `export default defineConfig({
  fonts: [
    { cssVariable: "--font-space-grotesk" },
    { cssVariable: "--font-jetbrains-mono" },
    // { cssVariable: "--font-old-and-removed" },
  ],
});
`,
  );
  expect(runGate().code).toBe(0);
});

test("a block-commented family entry is not required", () => {
  seedHealthy();
  writeFileSync(
    config,
    `export default defineConfig({
  fonts: [
    { cssVariable: "--font-space-grotesk" },
    { cssVariable: "--font-jetbrains-mono" },
    /* swapped out:
       { cssVariable: "--font-old-and-removed" }, */
  ],
});
`,
  );
  expect(runGate().code).toBe(0);
});

// Comment stripping must be string-aware: truncating at the `//` of a URL would
// drop the real entry after it, silently under-checking instead of false-reding.
test("a // inside a string does not hide a later cssVariable", () => {
  seedHealthy();
  writeFileSync(
    config,
    `export default defineConfig({
  fonts: [
    { url: "https://example.com/f.css", cssVariable: "--font-space-grotesk" },
    { cssVariable: "--font-jetbrains-mono" },
    { cssVariable: "--font-not-in-html" },
  ],
});
`,
  );
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("--font-not-in-html is not declared");
  // The entry sharing a line with the URL must survive: a naive line-strip would
  // truncate at the `//` and quietly stop checking --font-space-grotesk.
  expect(out).toContain("declares 3 family variable(s)");
  expect(out).toContain("--font-space-grotesk");
});

test("an unreadable font config fails rather than checking nothing", () => {
  seedHealthy();
  rmSync(config);
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("cannot read font config");
});

test("a font config with no cssVariable entries fails", () => {
  seedHealthy();
  writeFileSync(config, "export default defineConfig({ fonts: [] });\n");
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("no cssVariable entries");
});

// statSync reports a nonzero size for a directory, so without an isFile() guard a
// directory sitting where a route's index.html belongs would clear the size floor.
test("a directory in place of a route's html fails", () => {
  seedHealthy();
  rmSync(join(dist, "privacy", "index.html"));
  mkdirSync(join(dist, "privacy", "index.html"), { recursive: true });
  const { code, out } = runGate();
  expect(code).toBe(1);
  expect(out).toContain("was not emitted");
});
