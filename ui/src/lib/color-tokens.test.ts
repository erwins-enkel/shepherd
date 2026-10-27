// A `var(--color-*)` that app.css never declares resolves to nothing — a transparent
// fill or an inherited color, with no error anywhere. Every read must name a real token.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECL = /(--color-[a-z0-9-]+)\s*:/g;
// Terminator required so dynamic prefixes like `--color-data-${n}` don't match.
const READ = /var\((--color-[a-z0-9-]+)[,)\s]/g;

const declared = (text: string) => new Set([...text.matchAll(DECL)].map((m) => m[1]));
const appTokens = declared(readFileSync(join(src, "app.css"), "utf8"));

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "paraglide") yield* sources(p);
    } else if (/\.(svelte|ts|css)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) yield p;
  }
}

test("every var(--color-*) read names a token declared in app.css", () => {
  const undefinedReads: string[] = [];
  for (const file of sources(src)) {
    const text = readFileSync(file, "utf8");
    const local = declared(text);
    for (const [, token] of text.matchAll(READ)) {
      if (!appTokens.has(token) && !local.has(token)) {
        undefinedReads.push(`${relative(src, file)}: ${token}`);
      }
    }
  }
  expect(undefinedReads).toEqual([]);
});
