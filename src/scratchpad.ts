import { promises as fsp } from "node:fs";
import { join, relative, dirname, sep, normalize, isAbsolute } from "node:path";
import { sessionScratchpadDir } from "./tmp-sweep";

/**
 * Read-only browser of a session's scratchpad subtree (#1164). Every path the operator supplies
 * is treated as RELATIVE to the scratchpad root and is realpath-contained to it: `..`, absolute
 * paths, and symlink escapes all resolve to null/dropped. The genuinely new power vs. the
 * existing `/api/fs/dirs` browser is streaming file BYTES, so containment is the trust boundary.
 */

export interface ScratchEntry {
  name: string;
  type: "file" | "dir";
  /** Path relative to the scratchpad root, forward-slash separated, no leading slash. */
  path: string;
}

export interface ScratchListing {
  /** The directory being listed, relative to the root ("" = root). */
  path: string;
  /** Parent dir relative to the root, or null at the root. */
  parent: string | null;
  entries: ScratchEntry[];
}

/** true when `real` is the root itself or lives inside it (realpath containment). */
function within(real: string, rootReal: string): boolean {
  return real === rootReal || real.startsWith(rootReal + sep);
}

/** Root-relative, forward-slash form of an absolute path known to be within `rootReal`. */
function relFromRoot(rootReal: string, abs: string): string {
  if (abs === rootReal) return "";
  return relative(rootReal, abs).split(sep).join("/");
}

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
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(sessionScratchpadDir(worktreePath, claudeSessionId));
  } catch {
    return null; // root not created yet (agent wrote nothing) / unreadable
  }
  // Treat as root-relative. Reject any normalized path that climbs above the root (`..`) or is
  // absolute; realpath containment below is the backstop (catches symlink escapes too).
  const norm = normalize(relPath || "");
  if (norm === ".." || norm.startsWith(".." + sep) || isAbsolute(norm)) return null;
  const target = norm === "" || norm === "." ? rootReal : join(rootReal, norm);
  let resolved: string;
  try {
    resolved = await fsp.realpath(target);
  } catch {
    return null;
  }
  if (!within(resolved, rootReal)) return null;
  return { rootReal, resolved };
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
  const r = await resolveScratchpadPath(worktreePath, claudeSessionId, relPath);
  if (!r) return null;
  const { rootReal, resolved } = r;

  let dirents;
  try {
    dirents = await fsp.readdir(resolved, { withFileTypes: true });
  } catch {
    return null; // not a directory / unreadable
  }

  const entries: ScratchEntry[] = [];
  for (const d of dirents) {
    const abs = join(resolved, d.name);
    let real: string;
    try {
      real = await fsp.realpath(abs);
    } catch {
      continue; // broken symlink / unreadable → skip
    }
    if (!within(real, rootReal)) continue; // never surface an entry that escapes the root
    let isDir: boolean;
    try {
      isDir = (await fsp.stat(abs)).isDirectory();
    } catch {
      continue;
    }
    entries.push({ name: d.name, type: isDir ? "dir" : "file", path: relFromRoot(rootReal, abs) });
  }

  entries.sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
  );

  const here = relFromRoot(rootReal, resolved);
  return {
    path: here,
    parent: here === "" ? null : relFromRoot(rootReal, dirname(resolved)),
    entries,
  };
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
  const r = await resolveScratchpadPath(worktreePath, claudeSessionId, relPath);
  if (!r) return null;
  try {
    if (!(await fsp.stat(r.resolved)).isFile()) return null;
  } catch {
    return null;
  }
  return r.resolved;
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
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
