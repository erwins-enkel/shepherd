#!/usr/bin/env bun
// Post-build step: write `.br` + `.gz` siblings next to every text asset in the build dir, so
// the server's `serveStatic` (src/server.ts, policy in src/static-assets.ts) can ship them
// without compressing on its single event loop. Cuts the cold PWA boot from ~4.8 MB raw to
// ~1.1 MB — the difference between booting and never finishing on in-flight Wi-Fi.
//
// Usage: bun scripts/precompress.ts <outDir>
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Same extension set as `isCompressible` in src/static-assets.ts. */
const COMPRESSIBLE = /\.(js|css|html|svg|json|webmanifest|txt)$/;
/** Below this, headers + a decompress cost more than the bytes saved. */
export const MIN_BYTES = 1024;

async function compressOne(path: string): Promise<boolean> {
  const body = await readFile(path);
  if (body.length < MIN_BYTES) return false;
  const [br, gzipped] = await Promise.all([
    brotli(body, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    }),
    gz(body, { level: 9 }),
  ]);
  await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gzipped)]);
  return true;
}

/** Precompress every eligible file under `dir`; returns how many got siblings. */
export async function precompress(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && COMPRESSIBLE.test(e.name))
    .map((e) => join(e.parentPath, e.name));
  const done = await Promise.all(files.map(compressOne));
  return done.filter(Boolean).length;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun scripts/precompress.ts <outDir>");
    process.exit(1);
  }
  const n = await precompress(dir);
  console.log(`precompressed ${n} files in ${dir}`);
}
