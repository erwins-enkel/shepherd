#!/usr/bin/env bun
// Generator + drift gate for the command bar's Docs group (#1338).
//
// Emits ui/src/lib/docs-manifest.ts — the searchable list of documentation pages the
// command bar's Docs group filters. Sourced from COMMITTED inputs only, so the drift
// gate is deterministic in a clean CI checkout:
//   (a) git-tracked authored pages under docs-site/src/content/docs (via `git ls-files`),
//   (b) the exported PAGES array from docs-site/scripts/sync-docs.mjs — the 4 reference
//       pages that syncDocs() writes at astro-build time. Those destinations are
//       git-ignored (see docs-site/.gitignore) and absent in a clean checkout, so a
//       filesystem glob would silently drop them AND flake (they exist on dev machines
//       where astro dev already ran sync). Reading PAGES + the pages' committed SOURCES
//       (docs/*.md, root CLAUDE.md) avoids both problems.
//
// The TypeDoc API reference (src/content/docs/api/**) is likewise git-ignored and
// generated at build time — excluded here, a noted follow-up.
//
// Run `bun run gen:docs` (from ui/) to (re)write the manifest; `bun run check:docs-manifest`
// (--check) regenerates in-memory and fails on drift. Output is prettier-formatted so it
// matches the committed file byte-for-byte and passes `prettier --check`.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
// @ts-expect-error — .mjs sibling script without types; PAGES is a plain data array.
import { PAGES } from "../../docs-site/scripts/sync-docs.mjs";

export type DocsPage = { title: string; path: string; keywords: string };

const scriptDir = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "..", "..");
const DOCS_CONTENT = "docs-site/src/content/docs"; // relative to repoRoot
const OUT = join(uiRoot, "src", "lib", "docs-manifest.ts");

/** Split a markdown file into its leading `---` frontmatter block and body. Sources
 *  without frontmatter (the sync-docs inputs) yield an empty `fm` and the whole `body`. */
export function splitFrontmatter(md: string): { fm: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!match) return { fm: "", body: md };
  return { fm: match[1], body: md.slice(match[0].length) };
}

/** Read a single scalar frontmatter value, unquoting `"..."` / `'...'`. */
export function fmValue(fm: string, key: string): string | undefined {
  const line = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(fm);
  if (!line) return undefined;
  const raw = line[1].trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/** H2/H3 heading text from a markdown body (H1 is the page title, skipped). Strips
 *  inline-code backticks so `herdr status` searches as plain words. */
export function extractHeadings(body: string): string[] {
  const out: string[] = [];
  const re = /^#{2,3}\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1].replace(/`/g, ""));
  return out;
}

/** The Starlight URL path for a doc, relative to the content collection root.
 *  `getting-started.md` → `/getting-started/`; `reference/cli/session.md` →
 *  `/reference/cli/session/`; a folder `index.md` → the folder root (trailing slash). */
export function slugFor(relFromContent: string): string {
  const segs = relFromContent.replace(/\.(md|mdx)$/, "").split("/");
  if (segs[segs.length - 1] === "index") segs.pop();
  const joined = segs.join("/").toLowerCase();
  return joined === "" ? "/" : `/${joined}/`;
}

/** Lowercased search haystack: description + section headings, whitespace-collapsed. */
export function keywordsOf(description: string, headings: string[]): string {
  return [description, ...headings]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function build(): DocsPage[] {
  const entries: DocsPage[] = [];

  // (a) Committed authored pages — never the sync-written destinations.
  const tracked = execFileSync("git", ["ls-files", DOCS_CONTENT], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((l) => /\.(md|mdx)$/.test(l));

  for (const rel of tracked) {
    const md = readFileSync(join(repoRoot, rel), "utf8");
    const { fm, body } = splitFrontmatter(md);
    const title = fmValue(fm, "title");
    if (!title) continue; // pages without a title are not linkable results
    if (fmValue(fm, "template") === "splash" || fmValue(fm, "draft") === "true") continue;
    entries.push({
      title,
      path: slugFor(relative(DOCS_CONTENT, rel)),
      keywords: keywordsOf(fmValue(fm, "description") ?? "", extractHeadings(body)),
    });
  }

  // (b) Build-time-generated reference pages — title/description from PAGES, headings
  //     from each page's committed source (docs/*.md, root CLAUDE.md).
  for (const page of PAGES as {
    srcDir: string;
    src: string;
    dest: string;
    title: string;
    description: string;
  }[]) {
    const source = readFileSync(join(repoRoot, page.srcDir, page.src), "utf8");
    entries.push({
      title: page.title,
      path: slugFor(page.dest),
      keywords: keywordsOf(page.description, extractHeadings(splitFrontmatter(source).body)),
    });
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function render(pages: DocsPage[]): Promise<string> {
  const src = `// AUTO-GENERATED by ui/scripts/gen-docs-manifest.ts — do not edit by hand.
// Run \`bun run gen:docs\` (from ui/) to regenerate; \`check:docs-manifest\` guards drift.
// Source: committed docs-site pages (git ls-files) + sync-docs.mjs PAGES. See #1338.

export type DocsPage = { title: string; path: string; keywords: string };

export const DOCS_PAGES: readonly DocsPage[] = ${JSON.stringify(pages)};
`;
  const config = (await prettier.resolveConfig(OUT)) ?? {};
  return prettier.format(src, { ...config, parser: "typescript" });
}

// CLI entry only — guarded so importing this module (e.g. from unit tests, which
// exercise the pure helpers above) never shells out to git, reads docs, or writes files.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const pages = build();
  const output = await render(pages);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      /* missing file → drift */
    }
    if (current !== output) {
      console.error(
        "check:docs-manifest: ui/src/lib/docs-manifest.ts is stale.\n" +
          "The docs pages changed — run `bun run gen:docs` (from ui/) and commit the result.",
      );
      process.exit(1);
    }
    console.log("check:docs-manifest: manifest up to date.");
  } else {
    writeFileSync(OUT, output);
    console.log(`gen:docs: wrote ${pages.length} pages to ${relative(repoRoot, OUT)}.`);
  }
}
