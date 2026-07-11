#!/usr/bin/env bun
/**
 * Vendors herdr's native socket JSON-RPC schema into `src/generated/herdr-schema.json` (issue
 * #1529 opportunity #5). MANUAL — run against a live herdr binary whenever the protocol changes;
 * everyday codegen (`gen:herdr-types`) reads only the vendored file, never a live herdr.
 *
 * Writes `herdr api schema --json`'s stdout pretty-printed (2-space indent + trailing newline)
 * so the vendored file is diff-stable across herdr builds that don't actually change the schema.
 *
 * Usage: bun run gen:herdr-schema   (HERDR_BIN=/path/to/herdr to override the binary on PATH)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const herdrBin = process.env.HERDR_BIN || "herdr";
const outPath = join(import.meta.dir, "..", "src", "generated", "herdr-schema.json");

const proc = Bun.spawn([herdrBin, "api", "schema", "--json"], {
  stdout: "pipe",
  stderr: "inherit",
});
const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
if (exitCode !== 0) {
  throw new Error(`\`${herdrBin} api schema --json\` exited with code ${exitCode}`);
}

// Round-trip through JSON.parse/stringify: fails loudly on malformed stdout and normalizes
// formatting regardless of how herdr itself prints it.
const schema: unknown = JSON.parse(stdout);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(schema, null, 2) + "\n");
console.log(`Wrote ${outPath}`);
