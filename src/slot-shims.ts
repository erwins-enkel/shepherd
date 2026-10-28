// PATH shims that put a Codex session's heavy checks behind the heavy-check slot (#3550).
// Codex has no rewriting PreToolUse hook, so each tool the guard's detection can call heavy gets a
// tiny `sh` shim in one directory that is put first on the Codex session's PATH; the shim runs
// scripts/slot-shim.mjs, which decides (scripts/tool-guard.mjs → isHeavyCommand) and either goes
// through the slot runner or execs the real binary. See docs-site operating.md → heavy-check slot.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts");

/** The tools scripts/tool-guard.mjs can classify as heavy (binaries, subcommand tools, runners). */
export const SLOT_SHIM_TOOLS = [
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "cargo",
  "swift",
  "vitest",
  "jest",
  "tsc",
  "vue-tsc",
  "svelte-check",
  "playwright",
  "xcodebuild",
] as const;

const q = (x: string) => `'${x.replaceAll("'", `'\\''`)}'`;

function shimBody(dir: string, node: string, script: string, tool: string): string {
  return `#!/bin/sh\nSHEPHERD_SLOT_SHIM_DIR=${q(dir)} exec ${q(node)} ${q(script)} ${tool} "$@"\n`;
}

/**
 * Create (idempotently) the shim directory and return it, or null when the shim script is not
 * reachable from here (then nothing is shimmed and the session runs unmanaged, as before).
 */
export async function ensureSlotShims(
  dir: string,
  node: string = process.execPath,
  script: string = join(SCRIPTS_DIR, "slot-shim.mjs"),
): Promise<string | null> {
  if (!existsSync(script)) return null;
  try {
    await mkdir(dir, { recursive: true });
    for (const tool of SLOT_SHIM_TOOLS) {
      const path = join(dir, tool);
      const body = shimBody(dir, node, script, tool);
      if ((await readFile(path, "utf8").catch(() => null)) !== body) await writeFile(path, body);
      await chmod(path, 0o755);
    }
    return dir;
  } catch (err) {
    console.warn(`[slot-shims] could not prepare ${dir}: ${(err as Error).message}`);
    return null;
  }
}
