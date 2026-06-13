/**
 * Server-side source of truth for the persisted auth-mode SETTING value space
 * and its mapping to spawn settings.
 *
 * The SETTING space is: "subscription" | "api-key".
 *   - "subscription" (default) — spawned claude authenticates via the operator's
 *     OAuth subscription (Claude.ai Pro / Max). No extra spawn settings needed.
 *   - "api-key" — spawned claude authenticates against an Anthropic API key
 *     (Commercial Terms, footing B). The key is supplied via an apiKeyHelper
 *     executable that prints it to stdout; Shepherd writes that helper and
 *     stores ONLY its path, never the raw key.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── value space ───────────────────────────────────────────────────────────────

export type AuthMode = "subscription" | "api-key";

export const AUTH_MODES: readonly AuthMode[] = ["subscription", "api-key"] as const;

export function isAuthMode(v: unknown): v is AuthMode {
  return typeof v === "string" && (AUTH_MODES as readonly string[]).includes(v);
}

/**
 * Normalize an arbitrary value (env var, DB row, request body) to a valid
 * AuthMode, or null if the value is unrecognised / wrong type.
 * Accepted: "subscription", "api-key". Everything else → null.
 */
export function normalizeAuthModeSetting(value: unknown): AuthMode | null {
  if (typeof value !== "string") return null;
  return isAuthMode(value) ? value : null;
}

// ── apiKeyHelper filesystem lifecycle ─────────────────────────────────────────

/** Well-known filename for the helper script written into the config dir. */
export const API_KEY_HELPER_FILE = "anthropic-api-key-helper.sh";

/**
 * Escape a string for safe embedding inside POSIX single-quotes.
 * Single quotes cannot appear inside a single-quoted string; the idiom to
 * include one is: end the single-quoted string, emit a \'-escaped quote,
 * then restart the single-quoted string.  e.g. "a'b" → 'a'\''b'
 */
function singleQuoteShell(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Write an executable helper script into `dir` (created if missing) that
 * prints EXACTLY `key` to stdout when executed. The key is embedded safely
 * via POSIX single-quote escaping so shell metacharacters cannot escape.
 * Returns the absolute path of the written script.
 *
 * Throws if `key` is empty or whitespace-only.
 */
export function writeApiKeyHelper(key: string, dir: string): string {
  if (!key || !key.trim()) throw new Error("API key must be a non-empty, non-whitespace string");

  mkdirSync(dir, { recursive: true });

  const scriptPath = join(dir, API_KEY_HELPER_FILE);
  const script = `#!/bin/sh\nprintf '%s' ${singleQuoteShell(key)}\n`;
  writeFileSync(scriptPath, script, { mode: 0o700 });

  return scriptPath;
}

/**
 * Return the helper path if the script exists in `dir`, otherwise null.
 * Safe to call when `dir` does not exist (returns null).
 */
export function readApiKeyHelperPath(dir: string): string | null {
  const scriptPath = join(dir, API_KEY_HELPER_FILE);
  try {
    return existsSync(scriptPath) ? scriptPath : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort remove the helper script from `dir`. Never throws.
 */
export function clearApiKeyHelper(dir: string): void {
  const scriptPath = join(dir, API_KEY_HELPER_FILE);
  try {
    rmSync(scriptPath, { force: true });
  } catch {
    // best-effort; ignore missing file or dir
  }
}

// ── spawn settings ────────────────────────────────────────────────────────────

/**
 * Return the fragment of a claude --settings JSON that wires up apiKeyHelper
 * authentication. Callers spread this into their settings object.
 *
 * Returns `{ apiKeyHelper: helperPath }` ONLY when mode is "api-key" AND
 * `helperPath` is a non-empty string; otherwise returns `{}`.
 *
 * The empty-object-on-subscription contract is LOAD-BEARING: it guarantees
 * the subscription default produces byte-for-byte-identical --settings (no
 * extra keys) when callers spread the result.
 */
export function spawnAuthSettings(
  authMode: AuthMode,
  helperPath: string | null,
): { apiKeyHelper?: string } {
  if (authMode === "api-key" && helperPath && helperPath.length > 0) {
    return { apiKeyHelper: helperPath };
  }
  return {};
}
