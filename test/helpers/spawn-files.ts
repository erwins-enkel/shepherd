import { readFileSync } from "node:fs";

/** Flags whose value a session spawn passes as a PATH to a 0600 file since #3337. */
const FILE_FLAGS = new Set(["--settings", "--mcp-config"]);

/** Copy of a captured spawn argv with each `--settings` / `--mcp-config` file path replaced by the
 *  file's content, so a test can assert the JSON the spawn hands claude. Call it at capture time:
 *  archive removes the files. A value that is not a readable absolute path is kept as-is. */
export function inlineSpawnFiles(argv: string[]): string[] {
  return argv.map((v, i) => {
    if (!FILE_FLAGS.has(argv[i - 1] ?? "") || !v.startsWith("/")) return v;
    try {
      return readFileSync(v, "utf8");
    } catch {
      return v;
    }
  });
}
