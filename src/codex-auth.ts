/**
 * Codex CLI auth-mode detection. Some Codex models return HTTP 400
 * ("… not supported when using Codex with a ChatGPT account") under a ChatGPT-account login but
 * work with an API key, so role/main spawn resolution must know the auth mode to avoid pinning a
 * doomed model (see `clampCodexModelForAuth` in ./default-model).
 *
 * Detection is STRUCTURAL, not by any single field: a real `~/.codex/auth.json` may omit an
 * explicit `auth_mode`, so relying on it alone would silently mis-detect a ChatGPT operator as
 * `unknown` and never clamp. Precedence: a real API key wins; else a present OAuth access token
 * means a ChatGPT-account login; else an explicit `auth_mode` corroborates; else `unknown`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codex-usage";
import type { CodexAuthMode } from "./default-model";

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Classify a parsed `auth.json` object into a {@link CodexAuthMode}. Pure — no I/O.
 * Order matters: an API key is authoritative (it overrides a stale tokens block); a present
 * `tokens.access_token` is the affirmative ChatGPT-account signal; `auth_mode` is only a
 * last-resort corroborator so a file lacking tokens still resolves when it names its mode.
 */
export function parseCodexAuthMode(raw: unknown): CodexAuthMode {
  if (typeof raw !== "object" || raw === null) return "unknown";
  const obj = raw as Record<string, unknown>;

  if (nonEmptyString(obj.OPENAI_API_KEY)) return "apikey";

  const tokens = obj.tokens;
  if (typeof tokens === "object" && tokens !== null) {
    if (nonEmptyString((tokens as Record<string, unknown>).access_token)) return "chatgpt";
  }

  if (obj.auth_mode === "chatgpt") return "chatgpt";
  if (obj.auth_mode === "apikey") return "apikey";

  return "unknown";
}

/**
 * Read `<dir>/auth.json` and detect the Codex auth mode. Fail-open: any error — missing file,
 * unreadable, invalid JSON, non-Codex host — resolves to `unknown` so a spawn is never blocked on
 * a false positive. Read on demand (auth mode can change at runtime); no caching.
 */
export function readCodexAuthMode(dir = codexHome()): CodexAuthMode {
  try {
    return parseCodexAuthMode(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")));
  } catch {
    return "unknown";
  }
}
