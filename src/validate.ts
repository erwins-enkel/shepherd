import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { CreateSessionInput } from "./types";

type Ok = { ok: true; value: CreateSessionInput };
type Err = { ok: false; error: string };
type Result = Ok | Err;

const err = (error: string): Err => ({ ok: false, error });

const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const ALLOWED_KEYS = new Set(["repoPath", "baseBranch", "prompt"]);

/** Pure validator — no side-effects beyond fs.statSync for the repoPath check. */
export function validateCreate(body: unknown, repoRoot: string): Result {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return err("body must be a non-null object");
  }

  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) return err(`unknown key: ${key}`);
  }

  // prompt
  if (typeof obj.prompt !== "string") return err("prompt must be a string");
  const prompt = obj.prompt.trim();
  if (prompt.length === 0) return err("prompt must not be empty");
  if (prompt.length > 8000) return err("prompt must be ≤ 8000 chars");

  // baseBranch
  if (typeof obj.baseBranch !== "string") return err("baseBranch must be a string");
  if (!BRANCH_RE.test(obj.baseBranch)) return err("baseBranch contains invalid characters");

  // repoPath
  if (typeof obj.repoPath !== "string" || obj.repoPath.length === 0) {
    return err("repoPath must be a non-empty string");
  }
  const resolved = resolve(obj.repoPath);
  const root = resolve(repoRoot);
  const inside = resolved === root || resolved.startsWith(root + sep);
  if (!inside) return err("repoPath must be inside the configured repoRoot");

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return err("repoPath must be a directory");
  } catch {
    return err("repoPath does not exist");
  }

  return {
    ok: true,
    value: { repoPath: resolved, baseBranch: obj.baseBranch, prompt },
  };
}

/**
 * Timing-safe token check.
 * Returns true when token config is null (auth disabled) or header matches.
 */
export function isAuthorized(
  headerValue: string | null | undefined,
  token: string | null,
): boolean {
  if (token === null) return true;
  if (!headerValue) return false;
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return false;
  const provided = headerValue.slice(prefix.length);
  // Guard length before timingSafeEqual (it throws on unequal-length buffers)
  if (provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

/** Returns true when the terminalId is safe to pass to spawn args. */
export function isValidTerminalId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !id.startsWith("-");
}

/** Returns true when the request should be allowed through the CSRF origin check. */
export function originAllowed(
  originHeader: string | null | undefined,
  allowedHosts: string[],
): boolean {
  if (!originHeader) return true; // no-browser client (curl, CLI)
  try {
    const hostname = new URL(originHeader).hostname;
    return allowedHosts.includes(hostname);
  } catch {
    return false; // malformed origin
  }
}
