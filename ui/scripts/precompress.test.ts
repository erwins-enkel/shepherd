import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { MIN_BYTES, precompress } from "./precompress";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "precompress-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("writes round-tripping .br and .gz siblings for text assets, recursively", async () => {
  mkdirSync(join(dir, "_app", "immutable"), { recursive: true });
  const js = join(dir, "_app", "immutable", "a.js");
  const body = "export const a = 1;\n".repeat(200);
  writeFileSync(js, body);
  expect(await precompress(dir)).toBe(1);
  expect(brotliDecompressSync(readFileSync(`${js}.br`)).toString()).toBe(body);
  expect(gunzipSync(readFileSync(`${js}.gz`)).toString()).toBe(body);
});

test("skips small files and binaries", async () => {
  writeFileSync(join(dir, "tiny.css"), "a{}");
  writeFileSync(join(dir, "icon.png"), Buffer.alloc(MIN_BYTES * 4));
  expect(await precompress(dir)).toBe(0);
  expect(existsSync(join(dir, "tiny.css.br"))).toBe(false);
  expect(existsSync(join(dir, "icon.png.br"))).toBe(false);
});
