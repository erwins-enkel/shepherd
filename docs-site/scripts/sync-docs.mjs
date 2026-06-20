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

const GITHUB_DOCS_BASE = "https://github.com/erwins-enkel/shepherd/blob/main/docs/";

// source path is relative to repoRoot/docs; dest is relative to the docs collection.
const PAGES = [
  {
    src: "external-task-api.md",
    dest: "reference/external-task-api.md",
    title: "External Task API",
    description: "Submit tasks to Shepherd from external agents over plain HTTP.",
  },
  {
    src: "sandbox-security.md",
    dest: "reference/security.md",
    title: "Security",
    description: "Sandbox membrane, egress firewall, and accepted security residuals.",
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

/** Rewrite repo-relative markdown links (`](rel)`) to absolute GitHub URLs. */
function rewriteRelativeLinks(markdown) {
  return markdown.replace(/\]\((?!https?:\/\/|\/|#|mailto:)([^)]+)\)/g, (_m, rel) => `](${GITHUB_DOCS_BASE}${rel})`);
}

export function syncDocs() {
  for (const page of PAGES) {
    const source = readFileSync(join(repoRoot, "docs", page.src), "utf8");
    const body = rewriteRelativeLinks(stripLeadingH1(source)).replace(/^\n+/, "");
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
