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

import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — .mjs sibling script without types; PAGES is a plain data array.
import { PAGES } from "../../docs-site/scripts/sync-docs.mjs";

export type DocsPage = { title: string; path: string; keywords: string };

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** This script's own checkout. Its `.prettierrc` and `sync-docs.mjs` are the trusted inputs. */
const ownRepoRoot = resolve(scriptDir, "..", "..");
const DOCS_CONTENT = "docs-site/src/content/docs"; // relative to repoRoot
const OUT_REL = join("ui", "src", "lib", "docs-manifest.ts");

/** The repo to read pages from and write the manifest into: `--root <dir>`, else this script's
 *  own checkout. Shepherd's doc agent passes `--root <worktree>` and runs the SERVER's copy of this
 *  script, so the worktree is only ever data — none of its code or config is loaded. */
export function parseRoot(argv: readonly string[], fallback: string = ownRepoRoot): string {
  const i = argv.indexOf("--root");
  if (i < 0) return fallback;
  const dir = argv[i + 1];
  if (!dir || dir.startsWith("--")) throw new Error("--root needs a directory");
  return resolve(dir);
}

/** Throw unless `abs` lies inside `root` without following a symlink out: `abs` itself must not
 *  be a symlink (when it exists) and its parent must realpath inside `root`. Guards every read and
 *  the manifest write against a committed symlink pointing outside the repo. */
export function assertContainedFile(root: string, abs: string): void {
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(dirname(abs));
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new Error(`refusing path outside ${root}: ${abs}`);
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return; // not there yet (the manifest on first write)
  }
  if (!st.isFile()) throw new Error(`refusing non-regular file: ${abs}`);
}

function readContained(root: string, rel: string): string {
  const abs = join(root, rel);
  assertContainedFile(root, abs);
  return readFileSync(abs, "utf8");
}

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

function build(repoRoot: string): DocsPage[] {
  const entries: DocsPage[] = [];

  // (a) Committed authored pages — never the sync-written destinations. Hooks and fsmonitor off:
  //     the repo's own config must not run anything here (GIT_DIR may be pinned by the caller).
  const tracked = execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-files", DOCS_CONTENT],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter((l) => /\.(md|mdx)$/.test(l));

  for (const rel of tracked) {
    const md = readContained(repoRoot, rel);
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
    const source = readContained(repoRoot, join(page.srcDir, page.src));
    entries.push({
      title: page.title,
      path: slugFor(page.dest),
      keywords: keywordsOf(page.description, extractHeadings(splitFrontmatter(source).body)),
    });
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Which prettier module {@link render} formats with. Bare `"prettier"` (the default) resolves from
 *  this script's own node_modules chain — right for humans and CI, where `bun install` has run.
 *
 *  `SHEPHERD_PRETTIER_MODULE` overrides it with an absolute path, for ONE caller: Shepherd's doc
 *  agent (src/doc-agent.ts), which regenerates this manifest inside a disposable worktree that has
 *  NO node_modules at all — every transient agent spawns with `disableAllHooks`, so the repo's
 *  ensure-deps SessionStart hook never runs there. Bun would then silently satisfy the bare import
 *  by AUTO-INSTALLING prettier from its global cache: an unpinned version whose formatting can
 *  differ from the repo's, which would make this generator emit a file that fails its own
 *  `--check`. The doc agent pins the server install's prettier instead (and runs with that install
 *  as cwd, so the `.prettierrc` plugin specifiers resolve — prettier loads those relative to cwd). */
export function prettierModuleSpecifier(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHEPHERD_PRETTIER_MODULE || "prettier";
}

async function render(pages: DocsPage[]): Promise<string> {
  const src = `// AUTO-GENERATED by ui/scripts/gen-docs-manifest.ts — do not edit by hand.
// Run \`bun run gen:docs\` (from ui/) to regenerate; \`check:docs-manifest\` guards drift.
// Source: committed docs-site pages (git ls-files) + sync-docs.mjs PAGES. See #1338.

export type DocsPage = { title: string; path: string; keywords: string };

export const DOCS_PAGES: readonly DocsPage[] = ${JSON.stringify(pages)};
`;
  const prettier = await import(prettierModuleSpecifier());
  // Config from this script's own checkout, never `--root`'s: a JS prettier config there would run.
  const config = (await prettier.resolveConfig(join(ownRepoRoot, OUT_REL))) ?? {};
  return prettier.format(src, { ...config, parser: "typescript" });
}

// CLI entry only — guarded so importing this module (e.g. from unit tests, which
// exercise the pure helpers above) never shells out to git, reads docs, or writes files.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const repoRoot = parseRoot(process.argv);
  const OUT = join(repoRoot, OUT_REL);
  assertContainedFile(repoRoot, OUT);
  const pages = build(repoRoot);
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
