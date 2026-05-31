import { statSync, realpathSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { MODELS, type CreateSessionInput, type Steer } from "./types";
import { stagingDir } from "./uploads";

/** Expand a leading `~` / `~/` to the user's home dir (the UI suggests `~/Work/…`). */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

type Ok = { ok: true; value: CreateSessionInput };
type Err = { ok: false; error: string };
type Result = Ok | Err;

const err = (error: string): Err => ({ ok: false, error });

const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;
const ALLOWED_KEYS = new Set(["repoPath", "baseBranch", "prompt", "model", "images"]);

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

  // model — optional; absent/null/"default" → null (claude's own default, no --model flag)
  let model: string | null = null;
  if (obj.model != null && obj.model !== "default") {
    if (typeof obj.model !== "string") return err("model must be a string");
    if (!(MODELS as readonly string[]).includes(obj.model)) return err("unknown model");
    model = obj.model;
  }

  // repoPath
  if (typeof obj.repoPath !== "string" || obj.repoPath.length === 0) {
    return err("repoPath must be a non-empty string");
  }
  const resolved = resolve(expandHome(obj.repoPath));
  const root = resolve(expandHome(repoRoot));
  const inside = resolved === root || resolved.startsWith(root + sep);
  if (!inside) return err("repoPath must be inside the configured repoRoot");

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return err("repoPath must be a directory");
  } catch {
    return err("repoPath does not exist");
  }

  // images — optional array of staged upload paths, confined to the staging dir
  const images: string[] = [];
  if (obj.images != null) {
    if (!Array.isArray(obj.images)) return err("images must be an array");
    if (obj.images.length > 10) return err("images must be ≤ 10 entries");
    // an empty list needs no confinement — don't require a staging dir to exist
    // (the staging dir is created lazily on first upload; a fresh repoRoot has none)
    if (obj.images.length > 0) {
      let stagingReal: string;
      try {
        stagingReal = realpathSync(stagingDir(root));
      } catch {
        return err("no staged uploads exist");
      }
      for (const it of obj.images) {
        if (typeof it !== "string") return err("each image must be a string path");
        let real: string;
        try {
          real = realpathSync(resolve(it));
        } catch {
          return err("image does not exist");
        }
        const inside = real === stagingReal || real.startsWith(stagingReal + sep);
        if (!inside) return err("image must be inside the staging dir");
        try {
          if (!statSync(real).isFile()) return err("image must be a file");
        } catch {
          return err("image does not exist");
        }
        images.push(real);
      }
      if (new Set(images).size !== images.length) return err("duplicate image paths");
    }
  }

  return {
    ok: true,
    value: { repoPath: resolved, baseBranch: obj.baseBranch, prompt, model, images },
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

/**
 * Parse + clamp terminal dimensions from untrusted query params.
 * Garbage / out-of-range falls back to 100×30 (herdr's default attach size).
 */
export function parseTermDims(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return { cols: clampDim(cols, 100), rows: clampDim(rows, 30) };
}

function clampDim(v: unknown, fallback: number): number {
  const n = typeof v === "string" || typeof v === "number" ? Math.floor(Number(v)) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
}

/** Returns true when the terminalId is safe to pass to spawn args. */
export function isValidTerminalId(id: string): boolean {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) && !id.startsWith("-");
}

/** Resolve a repo path, confined to repoRoot and required to be an existing directory. null if invalid. */
export function safeRepoDir(repoPathRaw: string, repoRoot: string): string | null {
  if (typeof repoPathRaw !== "string" || repoPathRaw.length === 0) return null;
  // realpath both sides so a symlink inside repoRoot can't escape the containment check
  let resolvedReal: string;
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(expandHome(repoRoot)));
    resolvedReal = realpathSync(resolve(expandHome(repoPathRaw)));
  } catch {
    return null; // non-existent path (realpath throws) → reject
  }
  const inside = resolvedReal === rootReal || resolvedReal.startsWith(rootReal + sep);
  if (!inside) return null;
  try {
    return statSync(resolvedReal).isDirectory() ? resolvedReal : null;
  } catch {
    return null;
  }
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

const STEER_LABEL_MAX = 60;
const STEER_TEXT_MAX = 4000;
const STEER_MAX = 40;

/** Validate + normalize a PUT /api/steers payload. Returns null on any violation. */
export function validateSteers(body: unknown): Steer[] | null {
  if (!Array.isArray(body) || body.length > STEER_MAX) return null;
  const out: Steer[] = [];
  for (const it of body) {
    if (it === null || typeof it !== "object" || Array.isArray(it)) return null;
    const o = it as Record<string, unknown>;
    if (typeof o.label !== "string" || typeof o.text !== "string") return null;
    const label = o.label.trim();
    const text = o.text.trim();
    if (label.length === 0 || label.length > STEER_LABEL_MAX) return null;
    if (text.length === 0 || text.length > STEER_TEXT_MAX) return null;
    const id = typeof o.id === "string" && o.id.length > 0 ? o.id : randomUUID();
    out.push({ id, label, text });
  }
  return out;
}

/** Validate a POST /api/broadcast payload. Returns null on any violation. */
export function validateBroadcast(body: unknown): { text: string; ids: string[] } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.text !== "string") return null;
  const text = o.text.trim();
  if (text.length === 0 || text.length > STEER_TEXT_MAX) return null;
  if (!Array.isArray(o.ids)) return null;
  const ids: string[] = [];
  for (const id of o.ids) {
    if (typeof id !== "string" || id.length === 0) return null;
    ids.push(id);
  }
  return { text, ids };
}
