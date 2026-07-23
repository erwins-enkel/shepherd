import { randomUUID } from "node:crypto";
import { mkdirSync, copyFileSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { SessionStore } from "./store";

/** Sized for smartphone screen recordings (~0.63 MB/s HEVC → ≈6–7 min), uniform across
 *  all upload endpoints (New Task staging, in-session attach, scratchpad). */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

/** Transport cap for the main Bun.serve — MUST stay above MAX_UPLOAD_BYTES (headroom for
 *  multipart framing), else Bun rejects bodies before the app-level 413 can fire. */
export const MAX_REQUEST_BODY_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/** Age after which an abandoned staged upload (New Task or relaunch carry) is reclaimed. */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

const VIDEO_MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
};

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/markdown": "md",
  "text/plain": "txt",
  ...VIDEO_MIME_EXT,
};

const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** In-session attach accepts images and videos (screen recordings), nothing else. */
const SESSION_ATTACH_MIME_EXT: Record<string, string> = {
  ...IMAGE_MIME_EXT,
  ...VIDEO_MIME_EXT,
};

const SAFE_EXT_RE = /^[a-z0-9]{1,16}$/;

/** Extension for a supported upload MIME, or null if unsupported. */
export function extForMime(mime: string): string | null {
  return MIME_EXT[mime.toLowerCase().split(";", 1)[0] ?? ""] ?? null;
}

/** Extension for a supported live terminal image MIME, or null if unsupported. */
export function imageExtForMime(mime: string): string | null {
  return IMAGE_MIME_EXT[mime.toLowerCase().split(";", 1)[0] ?? ""] ?? null;
}

/** Extension for a supported in-session attachment MIME (image or video), or null. */
export function sessionAttachExtForMime(mime: string): string | null {
  return SESSION_ATTACH_MIME_EXT[mime.toLowerCase().split(";", 1)[0] ?? ""] ?? null;
}

function safeExt(ext: string | null | undefined): string | null {
  const normalized = ext?.toLowerCase() ?? "";
  return SAFE_EXT_RE.test(normalized) ? normalized : null;
}

function extensionFromName(name: string): string | null {
  const filename = name.split(/[\\/]/).pop() ?? "";
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1);
}

/** Safe stored extension for a generic staged attachment. */
export function uploadExtension(file: Pick<File, "name" | "type">): string {
  const namedExt = extensionFromName(file.name);
  if (namedExt != null) return safeExt(namedExt) ?? "bin";
  return safeExt(extForMime(file.type)) ?? "bin";
}

/** Safe stored extension for an already-uploaded file being re-staged. */
export function uploadExtensionFromName(name: string): string {
  return safeExt(extensionFromName(name)) ?? "bin";
}

/** Pre-session staging dir for New Task uploads (worktree doesn't exist yet). */
export function stagingDir(repoRoot: string): string {
  return join(repoRoot, ".shepherd-uploads-staging");
}

/** Per-session uploads dir inside a worktree (removed with the worktree). */
export function worktreeUploadsDir(worktreePath: string): string {
  return join(worktreePath, ".shepherd-uploads");
}

/** Generate a fresh, traversal-safe filename for a validated upload. */
export function uploadFilename(ext: string): string {
  return `${randomUUID()}.${safeExt(ext) ?? "bin"}`;
}

export interface UploadCopyResult {
  src: string;
  copiedPath: string | null;
}

/**
 * Copy each staged file into the worktree's uploads dir; return new absolute paths
 * (basename preserved) for the files that actually existed. COPY-not-move keeps the
 * staged original recoverable: a spawn that fails after this runs (or a "Jetzt starten"
 * retry of a held task) finds the source still present, so this copy is repeatable — the
 * old renameSync made a failed first spawn permanently un-retryable (ENOENT). The
 * sweepStaging TTL reclaims the leftover staged copies. A source that is genuinely gone
 * (e.g. already swept after 24h) is skipped, not thrown on, so the spawn proceeds without
 * it; the caller surfaces the drop.
 */
export function copyStagedIntoWorktree(
  uploads: string[],
  worktreePath: string,
): UploadCopyResult[] {
  const dir = worktreeUploadsDir(worktreePath);
  mkdirSync(dir, { recursive: true });
  const copied: UploadCopyResult[] = [];
  for (const src of uploads) {
    if (!existsSync(src)) {
      copied.push({ src, copiedPath: null }); // source swept/lost — skip, caller reports the drop
      continue;
    }
    const dest = join(dir, basename(src));
    copyFileSync(src, dest);
    copied.push({ src, copiedPath: dest });
  }
  return copied;
}

/** Best-effort: delete staged files older than maxAgeMs. No-op if dir absent. */
export function sweepStaging(repoRoot: string, maxAgeMs: number, now: number): void {
  const dir = stagingDir(repoRoot);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

const j = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface UploadDeps {
  store: Pick<SessionStore, "get">;
  repoRoot: string;
  /** Test seam: overrides MAX_UPLOAD_BYTES so the 413 path is testable without
   *  allocating limit-sized fixtures. Production never sets this. */
  maxUploadBytes?: number;
}

/**
 * Parse the multipart `file` field from a request. Returns the `File` on success, or a
 * 400 `Response` when the field is absent / the body can't be parsed. Does NOT perform size
 * or MIME checks — those are caller responsibilities.
 */
export async function parseUploadFile(req: Request): Promise<File | Response> {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return j({ error: "missing file field" }, 400);
  return file;
}

/** POST /api/uploads — multipart `file`; optional `?session=<id>`. Returns { path }. */
export async function handleUpload(req: Request, deps: UploadDeps): Promise<Response> {
  const file = await parseUploadFile(req);
  if (file instanceof Response) return file;

  if (file.size > (deps.maxUploadBytes ?? MAX_UPLOAD_BYTES))
    return j({ error: "file too large" }, 413);

  const sessionId = new URL(req.url).searchParams.get("session");
  let ext: string;
  let destDir: string;
  if (sessionId) {
    const s = deps.store.get(sessionId);
    if (!s) return j({ error: "unknown session" }, 404);
    const attachExt = sessionAttachExtForMime(file.type);
    if (!attachExt) return j({ error: "unsupported attachment type" }, 415);
    ext = attachExt;
    destDir = worktreeUploadsDir(s.worktreePath);
  } else {
    ext = uploadExtension(file);
    destDir = stagingDir(deps.repoRoot);
  }

  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, uploadFilename(ext));
  await Bun.write(path, file);
  return j({ path });
}
