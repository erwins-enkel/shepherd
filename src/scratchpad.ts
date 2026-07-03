import { promises as fsp } from "node:fs";
import { join, basename, extname, sep, normalize, isAbsolute } from "node:path";
import { sessionScratchpadDir } from "./tmp-sweep";
import {
  within,
  relFromRoot,
  resolveInRoot,
  listDir,
  resolveFileInRoot,
  type BrowseEntry,
  type BrowseListing,
} from "./fs-browse";

/**
 * Read-only browser of a session's scratchpad subtree (#1164). Every path the operator supplies
 * is treated as RELATIVE to the scratchpad root and is realpath-contained to it: `..`, absolute
 * paths, and symlink escapes all resolve to null/dropped. The genuinely new power vs. the
 * existing `/api/fs/dirs` browser is streaming file BYTES, so containment is the trust boundary.
 * The containment core lives in `./fs-browse` (shared with the worktree browser); this module
 * just binds it to the per-session scratchpad root.
 */

export type ScratchEntry = BrowseEntry;
export type ScratchListing = BrowseListing;

/**
 * Resolve a caller-supplied RELATIVE path against the session scratchpad root, enforcing
 * containment via realpath. Returns the canonical `{ rootReal, resolved }`, or null when:
 * `claudeSessionId` is blank, the root is absent, the request escapes the root (`..`, absolute,
 * symlink), or the target doesn't exist.
 */
export async function resolveScratchpadPath(
  worktreePath: string,
  claudeSessionId: string,
  relPath: string,
): Promise<{ rootReal: string; resolved: string } | null> {
  if (!claudeSessionId) return null;
  return resolveInRoot(sessionScratchpadDir(worktreePath, claudeSessionId), relPath);
}

/**
 * List one directory of the scratchpad subtree. Returns null when the path can't be resolved
 * (escape / missing) or isn't a directory. Entries include files AND subdirs AND dotfiles
 * (it's the operator's own scratchpad); per-entry realpath filtering drops anything that points
 * outside the root (e.g. an out-pointing symlink) so it never renders as a clickable row.
 * Sort: directories first, then locale-aware alphabetical within each group.
 */
export async function listScratchpad(
  worktreePath: string,
  claudeSessionId: string,
  relPath: string,
): Promise<ScratchListing | null> {
  if (!claudeSessionId) return null;
  return listDir(sessionScratchpadDir(worktreePath, claudeSessionId), relPath);
}

/**
 * Resolve a scratchpad path that must be a regular FILE (for download). Returns the canonical
 * absolute path, or null on escape / missing / not-a-regular-file.
 */
export async function resolveScratchpadFile(
  worktreePath: string,
  claudeSessionId: string,
  relPath: string,
): Promise<string | null> {
  if (!claudeSessionId) return null;
  return resolveFileInRoot(sessionScratchpadDir(worktreePath, claudeSessionId), relPath);
}

/**
 * Build a safe `Content-Disposition` header for an attachment download. Emits both an ASCII
 * `filename="…"` (control chars / quote / backslash replaced) and an RFC 5987
 * `filename*=UTF-8''…` so non-ASCII names survive without throwing an invalid-header (500) or
 * allowing header injection on a CR/LF in the name.
 */
export function attachmentDisposition(name: string): string {
  const ascii =
    [...name]
      .map((c) => {
        const code = c.charCodeAt(0);
        return code < 0x20 || code > 0x7e || c === '"' || c === "\\" ? "_" : c;
      })
      .join("") || "download";
  // RFC 5987 ext-value: encodeURIComponent leaves `'()*` unescaped, but those are not valid
  // `attr-char`s — percent-encode them too so the header is conformant.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Resolve the target upload directory for a session scratchpad upload. Creates the scratchpad
 * root on demand (start-of-session uploads before the agent has written anything). Returns
 * `{ rootReal, dirReal }` or `null` when: `claudeSessionId` is blank, `relDir` escapes the
 * root (`..", absolute paths, symlinks pointing outside), the subdirectory doesn't exist, or
 * the path resolves to a file rather than a directory.
 *
 * IMPORTANT: only the scratchpad root is ever created — never the requested subdir — to avoid
 * silently creating unexpected paths.
 */
export async function resolveScratchpadUploadDir(
  worktreePath: string,
  claudeSessionId: string,
  relDir: string,
): Promise<{ rootReal: string; dirReal: string } | null> {
  if (!claudeSessionId) return null;

  // Ensure the root exists — async mkdir so the event loop isn't blocked.
  const root = sessionScratchpadDir(worktreePath, claudeSessionId);
  await fsp.mkdir(root, { recursive: true });

  let rootReal: string;
  try {
    rootReal = await fsp.realpath(root);
  } catch {
    return null;
  }

  // Reject any normalized path that climbs above the root or is absolute.
  const norm = normalize(relDir || "");
  if (norm === ".." || norm.startsWith(".." + sep) || isAbsolute(norm)) return null;

  // Resolve target dir: root itself when empty/dot, else realpath of the join.
  let dirReal: string;
  if (norm === "" || norm === ".") {
    dirReal = rootReal;
  } else {
    try {
      dirReal = await fsp.realpath(join(rootReal, norm));
    } catch {
      return null; // subdir doesn't exist
    }
  }

  // Containment check via realpath.
  if (!within(dirReal, rootReal)) return null;

  // Must be a directory: prevents a ?path pointing at a file from reaching Bun.write and
  // throwing ENOTDIR as an uncaught 500.
  try {
    if (!(await fsp.stat(dirReal)).isDirectory()) return null;
  } catch {
    return null;
  }

  return { rootReal, dirReal };
}

/**
 * Sanitize a raw upload filename to a single safe path segment. Takes the basename, strips path
 * separators and control characters, and maps blank/dot/dotdot/all-dot names to "upload".
 * Must run BEFORE any join — `basename("..") === ".."` would otherwise escape the root.
 */
function sanitizeUploadName(rawName: string): string {
  // Take basename first to eliminate any directory components.
  let name = basename(rawName);
  // Strip path separators (/ and \) and control characters (U+0000–U+001F, U+007F).
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[/\\]/g, "").replace(/[\x00-\x1f\x7f]/g, "");
  // Map blank, ".", "..", and all-dot names to a generated fallback.
  if (!name || /^\.+$/.test(name)) return "upload";
  return name;
}

/**
 * Choose a non-colliding path for an uploaded file within `dirReal`.
 *
 * Collision detection uses `lstat` (not `stat`/`existsSync`) so that symlinks at the target
 * name are treated as collisions and skipped — this prevents a planted/dangling symlink from
 * being followed out of the root by `Bun.write`. The candidate is the first lstat-ENOENT name.
 *
 * NOTE: the lstat→Bun.write window is not atomic; two concurrent same-name uploads could pick
 * the same suffix. Acceptable for a single-operator tool — no lock needed.
 *
 * Returns `{ abs, rel }` or `null` if the final abs path fails the backstop containment check.
 */
export async function placeScratchpadUpload(
  rootReal: string,
  dirReal: string,
  rawName: string,
): Promise<{ abs: string; rel: string } | null> {
  const name = sanitizeUploadName(rawName);

  // Split into stem and extension for collision suffixing.
  const ext = extname(name); // e.g. ".pdf" or "" for extensionless
  const stem = ext ? name.slice(0, -ext.length) : name;

  let candidate = name;
  let n = 1;
  for (;;) {
    const target = join(dirReal, candidate);
    try {
      await fsp.lstat(target); // throws ENOENT when absent
      // Entry exists (any type, incl. symlinks) — try next suffix.
      n++;
      candidate = ext ? `${stem} (${n})${ext}` : `${stem} (${n})`;
    } catch {
      // ENOENT — this candidate is free.
      break;
    }
  }

  const abs = join(dirReal, candidate);

  // Backstop containment re-validation.
  if (!within(abs, rootReal)) return null;

  const rel = relFromRoot(rootReal, abs);
  return { abs, rel };
}
