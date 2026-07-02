// Build-time importer: render the repo's `docs/*.md` sources into the Starlight
// content collection WITHOUT duplicating them. `docs/` stays the single source of
// truth; the pages this writes under `src/content/docs/reference/` are git-ignored
// generated artifacts (see ../.gitignore).
//
// Why this is a function called from astro.config.mjs (not a package.json script):
// vercel.json pins `framework: astro`, so the deploy runs `astro build` directly
// and bypasses npm scripts. Astro evaluates astro.config.mjs on every command, so
// invoking syncDocs() there guarantees the generated pages exist on every path
// (build / dev / check / preview), production deploy included.
//
// Each source is a plain `# H1` + body with no frontmatter. For each we:
//   - strip the leading `# H1` (Starlight renders the title from frontmatter — a
//     body H1 would double-render),
//   - rewrite repo-relative markdown links to absolute GitHub URLs (the sources
//     live in `docs/`, so relative links resolve against `docs/`; inline code
//     spans like `src/sandbox.ts` are not links and are left as-is),
//   - prepend `title` / `description` frontmatter.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const docsSiteRoot = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "..", "..");

// Base for rewriting a source's repo-relative markdown links to absolute GitHub
// URLs. Each PAGES entry picks the `linkBase` matching where its source lives, so
// a relative link resolves against the source file's own directory (as GitHub
// renders it): `docs/*.md` links resolve under `docs/`, root files under the repo.
const GITHUB_BLOB_BASE = "https://github.com/erwins-enkel/shepherd/blob/main/";
const GITHUB_DOCS_BASE = `${GITHUB_BLOB_BASE}docs/`;

// Each entry imports one in-repo markdown file as a content page:
//   srcDir   — directory of the source, relative to repoRoot ("docs" or "." for root).
//   src      — file name within srcDir.
//   dest     — path within the Starlight docs collection (src/content/docs/).
//   linkBase — GitHub blob base its relative links rewrite against (see above).
//   title/description — frontmatter written for the page.
// Exported so ui/scripts/gen-docs-manifest.ts derives the command bar's Docs manifest
// from the SAME source of truth for these build-time-generated (git-ignored) pages,
// rather than globbing the filesystem (which is non-deterministic across dev/CI).
export const PAGES = [
  {
    srcDir: "docs",
    src: "plugins.md",
    dest: "reference/plugins.md",
    linkBase: GITHUB_DOCS_BASE,
    title: "Plugins",
    description: "Write server-side plugins: spawn hooks, routes, status/UI panels, and gear-menu items.",
  },
  {
    srcDir: "docs",
    src: "external-task-api.md",
    dest: "reference/external-task-api.md",
    linkBase: GITHUB_DOCS_BASE,
    title: "External Task API",
    description: "Submit tasks to Shepherd from external agents over plain HTTP.",
  },
  {
    srcDir: "docs",
    src: "sandbox-security.md",
    dest: "reference/security.md",
    linkBase: GITHUB_DOCS_BASE,
    title: "Security",
    description: "Sandbox membrane, egress firewall, and accepted security residuals.",
  },
  {
    // The repo's house rules (CLAUDE.md, at the repo root) — single source of truth
    // for contributor & agent conventions, rendered verbatim (no re-authoring). Its
    // `<id>` / `{@html}` / `[[epic|epic]]` tokens all sit inside inline code spans, so
    // this `.md` (NOT `.mdx`) renders them literally with no MDX/expansion.
    srcDir: ".",
    src: "CLAUDE.md",
    dest: "reference/house-rules.md",
    linkBase: GITHUB_BLOB_BASE,
    title: "Project house rules",
    description: "Shepherd's in-repo contributor & agent house rules (CLAUDE.md), rendered verbatim.",
  },
];

/** Drop the first `# H1` line (and a single trailing blank line) from the body. */
function stripLeadingH1(markdown) {
  const lines = markdown.split("\n");
  const idx = lines.findIndex((l) => l.trim() !== "");
  if (idx !== -1 && /^#\s+/.test(lines[idx])) {
    lines.splice(idx, 1);
    if (lines[idx] !== undefined && lines[idx].trim() === "") lines.splice(idx, 1);
  }
  return lines.join("\n");
}

/** Rewrite repo-relative markdown links (`](rel)`) to absolute GitHub URLs under `linkBase`. */
function rewriteRelativeLinks(markdown, linkBase) {
  return markdown.replace(/\]\((?!https?:\/\/|\/|#|mailto:)([^)]+)\)/g, (_m, rel) => `](${linkBase}${rel})`);
}

export function syncDocs() {
  for (const page of PAGES) {
    const source = readFileSync(join(repoRoot, page.srcDir, page.src), "utf8");
    const body = rewriteRelativeLinks(stripLeadingH1(source), page.linkBase).replace(/^\n+/, "");
    const frontmatter = `---\ntitle: ${JSON.stringify(page.title)}\ndescription: ${JSON.stringify(
      page.description,
    )}\n---\n\n`;
    const destPath = join(docsSiteRoot, "src", "content", "docs", page.dest);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, frontmatter + body);
  }
}

// Allow `node scripts/sync-docs.mjs` for a manual run.
if (import.meta.url === `file://${process.argv[1]}`) syncDocs();
