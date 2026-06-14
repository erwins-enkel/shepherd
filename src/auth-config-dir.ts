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
 * Mechanism: build a mirror dir that (a) symlinks every entry from the operator's
 * real `~/.claude` EXCEPT `.credentials.json`, and (b) COPIES in `$HOME/.claude.json`
 * (see {@link CONFIG_FILE}). Callers set `CLAUDE_CONFIG_DIR` to this mirror for every
 * api-key spawn. The symlinks keep skills/commands/CLAUDE.md/plugins/settings live and
 * cheap; the credential file is absent so the spawn is "not logged in" and authenticates
 * via `--settings apiKeyHelper` instead — with no "Use custom API key?" prompt.
 *
 * Why `.claude.json` is copied, not symlinked: Claude Code writes to it (onboarding/
 * project state), and symlinking would mutate — and race the live shepherd on — the
 * operator's real config. A snapshot copy is isolated and refreshed each provision.
 *
 * Verified with a live api-key spawn: a config dir holding a copied `.claude.json`
 * (with its `oauthAccount` field) but NO `.credentials.json` reports "Not logged in",
 * and an `apiKeyHelper` then authenticates with no approval prompt — so `oauthAccount`
 * metadata is not itself a login and no HOME shim is needed.
 */

import { dirname, join } from "node:path";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";

/** The OAuth token file — its absence is what makes a config dir "not logged in." */
export const CREDENTIAL_FILE = ".credentials.json";

/**
 * Claude Code's config/state file. It lives at `$HOME/.claude.json` — a SIBLING of
 * `~/.claude`, NOT a child — so the symlink mirror never picks it up. But when
 * `CLAUDE_CONFIG_DIR` is set, Claude Code reads `.claude.json` from THAT dir (not
 * `$HOME`), so the mirror must provide one or the spawn fails to start ("configuration
 * file not found"). We copy it in (see below). Safe: the OAuth token is in
 * `.credentials.json` (excluded) — `.claude.json` only carries config + onboarding/trust
 * state + an `oauthAccount` DISPLAY field, which is NOT a login (a config dir with
 * `.claude.json` but no `.credentials.json` reports "Not logged in").
 */
export const CONFIG_FILE = ".claude.json";

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
  for (const entry of readdirSync(destDir)) {
    _pruneStaleDestEntry(entry, { sourceClaudeDir, destDir, sourceEntries });
  }

  // ── 2. Create symlinks for all source entries except CREDENTIAL_FILE ──────
  for (const entry of sourceEntries) {
    if (entry === CREDENTIAL_FILE) continue;
    _ensureSourceSymlink(entry, { sourceClaudeDir, destDir });
  }

  // ── 3. Guarantee no credential file in dest ───────────────────────────────
  _removeCredentialIfPresent(destDir);

  // ── 4. Provide .claude.json (a HOME sibling, never mirrored above) ─────────
  // Claude reads it from CLAUDE_CONFIG_DIR, so the spawn can't start without it.
  _copyConfigFile(sourceClaudeDir, destDir);

  return destDir;
}

/**
 * Whether `path` is a symlink whose target is exactly `expectedTarget`.
 * Swallows lstat/readlink failures (missing entry, perms) → `false`.
 */
function _isSymlinkTo(path: string, expectedTarget: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === expectedTarget;
  } catch {
    return false;
  }
}

/**
 * Step-1 per-entry cleanup: remove a dest entry that is stale (gone from
 * source), a leftover real file/dir, or a symlink to the wrong target.
 * CREDENTIAL_FILE is always removed (enforced absent in step 3).
 */
function _pruneStaleDestEntry(
  entry: string,
  ctx: { sourceClaudeDir: string; destDir: string; sourceEntries: Set<string> },
): void {
  const destEntryPath = join(ctx.destDir, entry);
  if (entry === CREDENTIAL_FILE) {
    _tryRemove(destEntryPath);
    return;
  }
  // .claude.json is a copied HOME sibling (step 4), not a mirrored source child —
  // it would otherwise look "stale" (absent from sourceEntries) and be pruned. Keep it.
  if (entry === CONFIG_FILE) return;
  const isStale = !ctx.sourceEntries.has(entry);
  if (isStale || !_isSymlinkTo(destEntryPath, join(ctx.sourceClaudeDir, entry))) {
    _tryRemove(destEntryPath);
  }
}

/**
 * Step-2 per-entry linking: ensure `destDir/entry` is a symlink to the source
 * entry. Leaves an already-correct symlink untouched; otherwise removes any
 * leftover and (re)creates the link best-effort (a single failure never aborts
 * the loop).
 */
function _ensureSourceSymlink(
  entry: string,
  ctx: { sourceClaudeDir: string; destDir: string },
): void {
  const sourcePath = join(ctx.sourceClaudeDir, entry);
  const destEntryPath = join(ctx.destDir, entry);

  if (_isSymlinkTo(destEntryPath, sourcePath)) return; // already correct — leave it

  // Wrong target or a real file/dir (shouldn't happen after step 1, but be defensive).
  _tryRemove(destEntryPath);
  try {
    symlinkSync(sourcePath, destEntryPath);
  } catch {
    // Best-effort per entry; don't abort the whole provisioning loop.
  }
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

/**
 * Copy `$HOME/.claude.json` (sibling of `sourceClaudeDir`) into `destDir`.
 * Written via a per-process temp file + atomic rename so a concurrent spawn
 * reading the shared mirror never sees a torn/partial config. Best-effort: if the
 * source is absent or the copy fails, leave any existing copy and let Claude Code
 * recreate/onboard. Never throws.
 */
function _copyConfigFile(sourceClaudeDir: string, destDir: string): void {
  const src = join(dirname(sourceClaudeDir), CONFIG_FILE);
  if (!existsSync(src)) return;
  const dest = join(destDir, CONFIG_FILE);
  const tmp = `${dest}.tmp.${process.pid}`;
  try {
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch {
    _tryRemove(tmp); // clean a half-written temp; keep any prior good copy
  }
}

function _tryRemove(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // best-effort; a single entry failure must not abort the loop
  }
}
