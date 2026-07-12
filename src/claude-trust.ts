/**
 * Read/seed Claude Code's per-folder trust flag (`hasTrustDialogAccepted`) in the
 * `.claude.json` config file, so an ephemeral spawn (the /usage probe) doesn't wedge
 * on the "Do you trust the files in this folder?" dialog. `--dangerously-skip-permissions`
 * does NOT suppress that dialog, and no flag/env skips it — pre-seeding the flag is the
 * only unattended path (#1075).
 *
 * Pure + injectable: every function takes explicit paths so the caller resolves the
 * config-dir target once and tests never touch a real `$HOME`.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

/**
 * The `.claude.json` file Claude Code actually reads, mirroring the sandbox.ts:404 rule:
 *  - DEFAULT config dir (`${home}/.claude`) → `$HOME/.claude.json` (a SIBLING of `~/.claude`).
 *  - CUSTOM `CLAUDE_CONFIG_DIR` (anything else) → `${claudeDir}/.claude.json` (INSIDE it).
 *
 * Hardcoding `$HOME/.claude.json` would target the wrong file on a custom-config-dir
 * install: the seed would miss (dialog still fires) and the read would always report
 * untrusted (spurious rewrite every run). Pass `config.claudeDir` here.
 */
export function claudeConfigPath(home: string, claudeDir: string): string {
  return claudeDir === `${home}/.claude`
    ? join(home, ".claude.json")
    : join(claudeDir, ".claude.json");
}

/**
 * True iff `configPath`'s JSON records `projects[dir].hasTrustDialogAccepted === true`.
 * Any failure (missing file, malformed JSON, unreadable) → `false` — treat "can't
 * confirm trusted" as untrusted so the caller seeds it.
 */
export async function readRepoRootTrusted(configPath: string, dir: string): Promise<boolean> {
  try {
    const j = JSON.parse(await readFile(configPath, "utf8"));
    return j?.projects?.[dir]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

/**
 * Seed `projects[dir].hasTrustDialogAccepted = true` in `configPath`, PRESERVING every
 * other field. Writes unconditionally — the caller gates on {@link readRepoRootTrusted}
 * so this only runs when actually untrusted (one write per dir, ever).
 *
 * Whole-file read-modify-write via a temp file + atomic rename: the file is never left
 * torn, but Claude writes this file frequently (onboarding/project state), so a stale
 * read + our rename can CLOBBER concurrent Claude state written between them
 * (last-writer-wins). Accepted given the read-gate's rarity and the sub-ms window.
 *
 * Emits COMPACT JSON (no pretty-print) to match Claude's on-disk format and avoid
 * reflowing a possibly-large file.
 */
export async function trustRepoRoot(configPath: string, dir: string): Promise<void> {
  let j: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed && typeof parsed === "object") j = parsed as Record<string, unknown>;
  } catch {
    // Missing or malformed → start from an empty config; Claude tolerates a minimal file.
    j = {};
  }
  const projects = (j.projects && typeof j.projects === "object" ? j.projects : {}) as Record<
    string,
    Record<string, unknown>
  >;
  const entry = projects[dir] && typeof projects[dir] === "object" ? projects[dir] : {};
  entry.hasTrustDialogAccepted = true;
  projects[dir] = entry;
  j.projects = projects;

  const tmp = `${configPath}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(j), "utf8");
  await rename(tmp, configPath);
}
