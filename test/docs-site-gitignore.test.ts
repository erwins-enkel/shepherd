/**
 * Every page docs-site/scripts/sync-docs.mjs generates must be git-ignored, or each
 * docs-site build/dev run leaves it untracked and easy to commit by accident (#2561).
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_SITE = join(import.meta.dir, "..", "docs-site");

test("every sync-docs PAGES dest has a docs-site/.gitignore entry", async () => {
  // Computed path keeps root tsc from resolving the untyped .mjs.
  const syncDocs = join(DOCS_SITE, "scripts", "sync-docs.mjs");
  const { PAGES } = (await import(syncDocs)) as { PAGES: { dest: string }[] };
  expect(PAGES.length).toBeGreaterThan(0);

  const ignored = new Set(
    readFileSync(join(DOCS_SITE, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim()),
  );
  const missing = PAGES.map((p) => `src/content/docs/${p.dest}`).filter((p) => !ignored.has(p));
  expect(missing).toEqual([]);
});
