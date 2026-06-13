/**
 * Credential-less CLAUDE_CONFIG_DIR provisioning for api-key spawns.
 *
 * Invariant: a spawn in "api-key" auth mode must NOT see the operator's
 * OAuth token (`.credentials.json`) — if it does, Claude Code presents an
 * interactive "Use custom API key?" approval prompt that hangs an unattended
 * process. The API key itself arrives separately via `--settings apiKeyHelper`
 * (see auth-mode.ts). This module's sole job is to remove the credential
 * surface while preserving everything else that Claude Code expects to find in
 * its config dir (skills, commands, CLAUDE.md, plugins, settings.json,
 * onboarding/theme state, statsig/, projects/, todos/, shell-snapshots/).
 *
 * Mechanism: build a mirror dir that symlinks every entry from the operator's
 * real `~/.claude` EXCEPT `.credentials.json`. Callers set `CLAUDE_CONFIG_DIR`
 * to this mirror for every api-key spawn. Symlinks keep the mirror "live" and
 * cheap — no file copying, changes in the source propagate instantly.
 *
 * Residual / open question: `~/.claude.json` (at HOME, outside CLAUDE_CONFIG_DIR)
 * may carry an `oauthAccount` display field. The actual auth TOKEN lives only in
 * `.credentials.json`; omitting that file is the documented mechanism for
 * "no login." Whether `oauthAccount` metadata alone causes Claude Code to show a
 * login-related prompt in practice has not been verified with a live api-key spawn
 * — if prompted, callers should also override HOME or create a HOME shim that
 * omits `~/.claude.json`. That is NOT handled here.
 */

import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";

/** The OAuth token file — its absence is what makes a config dir "not logged in." */
export const CREDENTIAL_FILE = ".credentials.json";

/**
 * Canonical location for the credential-less mirror, nested under Shepherd's
 * existing state dir convention (`~/.shepherd/…`).
 */
export function apiKeyConfigDir(home: string): string {
  return join(home, ".shepherd", "claude-apikey-config");
}

/**
 * (Re)build `destDir` as a symlink-mirror of `sourceClaudeDir` that omits
 * `CREDENTIAL_FILE`. Idempotent and self-healing:
 *
 *  - Stale entries in `destDir` (no longer present in `sourceClaudeDir`, or
 *    previously-present real files/dirs left by bad prior state) are removed.
 *  - For each entry in `sourceClaudeDir` except `CREDENTIAL_FILE`, a symlink
 *    pointing at the absolute source path is created (or left if already correct).
 *  - `destDir/.credentials.json` is explicitly removed even if somehow present.
 *  - If `sourceClaudeDir` does not exist, an empty `destDir` is created and
 *    returned (graceful degrade — a fresh, login-less config dir).
 *
 * Never copies file contents. Returns `destDir`.
 */
export function provisionApiKeyConfigDir(opts: {
  sourceClaudeDir: string;
  destDir: string;
}): string {
  const { sourceClaudeDir, destDir } = opts;

  mkdirSync(destDir, { recursive: true });

  if (!existsSync(sourceClaudeDir)) {
    // Degrade: source missing → just guarantee an empty credential-less dir.
    _removeCredentialIfPresent(destDir);
    return destDir;
  }

  const sourceEntries = new Set(readdirSync(sourceClaudeDir));

  // ── 1. Clean up destDir ───────────────────────────────────────────────────
  // Remove entries that are either stale (no longer in source), were left as
  // real files/dirs by a previous bad provisioning run, or are symlinks
  // pointing at the wrong absolute path. Always skip CREDENTIAL_FILE — we'll
  // enforce its absence separately.
  const destEntries = readdirSync(destDir);

  for (const entry of destEntries) {
    if (entry === CREDENTIAL_FILE) {
      // Handled explicitly below — remove unconditionally.
      _tryRemove(join(destDir, entry));
      continue;
    }

    const destEntryPath = join(destDir, entry);
    const sourcePath = join(sourceClaudeDir, entry);

    const isStale = !sourceEntries.has(entry);
    let isCorrectSymlink = false;

    if (!isStale) {
      try {
        const stat = lstatSync(destEntryPath);
        if (stat.isSymbolicLink()) {
          // Correct only if the symlink target matches the intended source path.
          isCorrectSymlink = readlinkSync(destEntryPath) === sourcePath;
        }
      } catch {
        // lstat/readlink failed — treat as not a correct symlink; fall through to remove.
      }
    }

    if (isStale || !isCorrectSymlink) {
      _tryRemove(destEntryPath);
    }
  }

  // ── 2. Create symlinks for all source entries except CREDENTIAL_FILE ──────
  for (const entry of sourceEntries) {
    if (entry === CREDENTIAL_FILE) continue;

    const sourcePath = join(sourceClaudeDir, entry);
    const destEntryPath = join(destDir, entry);

    // If a correct symlink already exists, skip it.
    try {
      const stat = lstatSync(destEntryPath);
      if (stat.isSymbolicLink() && readlinkSync(destEntryPath) === sourcePath) {
        continue; // already linked to the right target — leave it
      }
      // Wrong target or a real file/dir (shouldn't happen after step 1, but be defensive).
      _tryRemove(destEntryPath);
    } catch {
      // Entry doesn't exist — fall through to create.
    }

    try {
      symlinkSync(sourcePath, destEntryPath);
    } catch {
      // Best-effort per entry; don't abort the whole provisioning loop.
    }
  }

  // ── 3. Guarantee no credential file in dest ───────────────────────────────
  _removeCredentialIfPresent(destDir);

  return destDir;
}

/**
 * Convenience wrapper: provisions the canonical api-key config dir for `home`
 * mirroring `sourceClaudeDir`. Returns the destDir path.
 */
export function ensureApiKeyConfigDir(home: string, sourceClaudeDir: string): string {
  return provisionApiKeyConfigDir({
    sourceClaudeDir,
    destDir: apiKeyConfigDir(home),
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function _removeCredentialIfPresent(dir: string): void {
  rmSync(join(dir, CREDENTIAL_FILE), { force: true });
}

function _tryRemove(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort; a single entry failure must not abort the loop
  }
}
