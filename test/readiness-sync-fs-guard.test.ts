// #4088: the readiness analyzer runs on the server's single loop, so `src/readiness.ts` must do
// all file I/O through `node:fs/promises` — no sync `node:fs` API, imported or called.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const source = await readFile(join(import.meta.dir, "../src/readiness.ts"), "utf8");

test("readiness.ts imports only types from node:fs", () => {
  const fsImports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(?:node:)?fs";/gms)];
  for (const m of fsImports) expect(m[1]).toBe("type ");
  expect(source).not.toMatch(/require\(\s*"(?:node:)?fs"\s*\)/);
});

test("readiness.ts calls no *Sync API", () => {
  expect(source.match(/\b\w+Sync\s*\(/g) ?? []).toEqual([]);
});
