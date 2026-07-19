import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

// Couples the host_capacity DIAGNOSE doc-links to real headings in the operating
// guide. The links point at `docs.shepherd.run/operating/#<anchor>`; Starlight
// derives that anchor from the heading text with github-slugger. If a heading is
// renamed without updating the link, the anchor silently 404s — this test fails
// instead, forcing both to move together.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const docsDoc = readFileSync(`${repoRoot}/ui/src/lib/diagnostics-docs.ts`, "utf8");
const operatingMd = readFileSync(`${repoRoot}/docs-site/src/content/docs/operating.md`, "utf8");

/** Anchor fragments in DOC_LINKS that target the operating guide. */
function operatingAnchors(source: string): string[] {
  return [...source.matchAll(/operating\/#([a-z0-9-]+)/g)].map((m) => m[1] ?? "");
}

/** Slug every ATX heading in the doc the way Starlight/github-slugger does.
 *  Fenced code blocks are skipped so `#`-prefixed shell/ini comments inside them
 *  aren't mistaken for headings. A fresh slugger per call so its dedup counter
 *  matches a clean build. */
function headingSlugs(markdown: string): Set<string> {
  const slugger = new GithubSlugger();
  const slugs = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m?.[1] !== undefined) slugs.add(slugger.slug(m[1].trim()));
  }
  return slugs;
}

describe("host_capacity doc-link anchors", () => {
  it("every operating-guide anchor resolves to a real heading", () => {
    const anchors = operatingAnchors(docsDoc);
    // Guard the guard: the extraction must actually find the links it protects.
    expect(anchors.length).toBeGreaterThan(0);

    const slugs = headingSlugs(operatingMd);
    for (const anchor of anchors) {
      expect(slugs.has(anchor)).toBe(true);
    }
  });
});
