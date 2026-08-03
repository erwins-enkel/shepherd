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
// Each source is a plain `# H1` + body. For each we:
//   - strip a leading YAML frontmatter block if present (the `.claude/rules/*.md`
//     sources open with agent-facing `paths:` frontmatter, which is machinery for
//     Claude Code's path-scoped rule loading and must not render into the page),
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
const GITHUB_RULES_BASE = `${GITHUB_BLOB_BASE}.claude/rules/`;

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
  // The path-scoped agent rules (`.claude/rules/*.md`). These carry the UI, i18n,
  // feature-catalog and glossary conventions that used to sit in CLAUDE.md: agents
  // load them on demand when they touch the matching files, and contributors read
  // them here. Same verbatim-render contract as house-rules above, minus the
  // `paths:` frontmatter (stripped by stripFrontmatter).
  {
    srcDir: ".claude/rules",
    src: "ui-design-system.md",
    dest: "reference/rules-design-system.md",
    linkBase: GITHUB_RULES_BASE,
    title: "Design system",
    description: "Semantic token layer, component recipes, and the modal scrim rule for any UI work.",
  },
  {
    srcDir: ".claude/rules",
    src: "i18n.md",
    dest: "reference/rules-i18n.md",
    linkBase: GITHUB_RULES_BASE,
    title: "Internationalization",
    description: "Never hardcode user-facing text — Paraglide catalogs plus the server-side notification table.",
  },
  {
    srcDir: ".claude/rules",
    src: "ui-feature-catalog.md",
    dest: "reference/rules-feature-catalog.md",
    linkBase: GITHUB_RULES_BASE,
    title: "Feature discovery",
    description: "Every shipped user-facing feature adds a What's-New catalog entry in the same PR.",
  },
  {
    srcDir: ".claude/rules",
    src: "ui-glossary.md",
    dest: "reference/rules-glossary.md",
    linkBase: GITHUB_RULES_BASE,
    title: "Glossary rules",
    description: "Registry entries, EN+DE keys, and inline markers for defined terms in UI text.",
  },
];

/**
 * Drop a leading YAML frontmatter block (`---` … `---`) if the file opens with one.
 * Only a fence on the very first non-empty line counts, so a `---` horizontal rule
 * later in the body is never mistaken for a frontmatter opener. A file with no
 * frontmatter, or an unterminated opener, is returned unchanged.
 */
function stripFrontmatter(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim() !== "");
  if (start === -1 || lines[start].trim() !== "---") return markdown;
  const end = lines.findIndex((l, i) => i > start && l.trim() === "---");
  if (end === -1) return markdown;
  return lines.slice(end + 1).join("\n");
}

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
    const body = rewriteRelativeLinks(
      stripLeadingH1(stripFrontmatter(source)),
      page.linkBase,
    ).replace(/^\n+/, "");
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
