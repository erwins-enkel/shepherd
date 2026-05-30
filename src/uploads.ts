import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  copyFileSync,
  rmSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import type { SessionStore } from "./store";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Extension for a supported image MIME, or null if unsupported. */
export function extForMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null;
}

/** Pre-session staging dir for New Task uploads (worktree doesn't exist yet). */
export function stagingDir(repoRoot: string): string {
  return join(repoRoot, ".shepherd-uploads-staging");
}

/** Per-session uploads dir inside a worktree (removed with the worktree). */
export function worktreeUploadsDir(worktreePath: string): string {
  return join(worktreePath, ".shepherd-uploads");
}

/** Generate a fresh, traversal-safe filename for a validated image. */
export function uploadFilename(ext: string): string {
  return `${randomUUID()}.${ext}`;
}

/**
 * Move each staged file into the worktree's uploads dir; return new absolute
 * paths (basename preserved). Falls back to copy+unlink across devices.
 */
export function moveStagedIntoWorktree(images: string[], worktreePath: string): string[] {
  const dir = worktreeUploadsDir(worktreePath);
  mkdirSync(dir, { recursive: true });
  return images.map((src) => {
    const dest = join(dir, basename(src));
    try {
      renameSync(src, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      copyFileSync(src, dest);
      rmSync(src, { force: true });
    }
    return dest;
  });
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
}

/** POST /api/uploads — multipart `file`; optional `?session=<id>`. Returns { path }. */
export async function handleUpload(req: Request, deps: UploadDeps): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return j({ error: "missing file field" }, 400);

  const ext = extForMime(file.type);
  if (!ext) return j({ error: "unsupported image type" }, 415);
  if (file.size > MAX_UPLOAD_BYTES) return j({ error: "file too large" }, 413);

  const sessionId = new URL(req.url).searchParams.get("session");
  let destDir: string;
  if (sessionId) {
    const s = deps.store.get(sessionId);
    if (!s) return j({ error: "unknown session" }, 404);
    destDir = worktreeUploadsDir(s.worktreePath);
  } else {
    destDir = stagingDir(deps.repoRoot);
  }

  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, uploadFilename(ext));
  await Bun.write(path, file);
  return j({ path });
}
