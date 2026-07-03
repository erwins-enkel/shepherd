import { promises as fsp } from "node:fs";
import { join, relative, dirname, sep, normalize, isAbsolute } from "node:path";

/**
 * Generic, root-parameterized read-only filesystem browse core. Every path a caller supplies is
 * treated as RELATIVE to `root` and is realpath-contained to it: `..`, absolute paths, and
 * symlink escapes all resolve to null/dropped. Shared by the session scratchpad browser
 * (`src/scratchpad.ts`) and, eventually, a worktree browser — both need the same containment
 * trust boundary, just with a different root and (for worktrees) a `.git` hideSegment.
 */

export interface BrowseEntry {
  name: string;
  type: "file" | "dir";
  /** Path relative to the root, forward-slash separated, no leading slash. */
  path: string;
  /** true when this entry is a symlink that resolves OUTSIDE the root (only set in onEscape:"mark"). */
  linkOutside?: boolean;
}

export interface BrowseListing {
  /** The directory being listed, relative to the root ("" = root). */
  path: string;
  /** Parent dir relative to the root, or null at the root. */
  parent: string | null;
  entries: BrowseEntry[];
}

export interface BrowseOptions {
  /** Reject/skip any path whose relative segments include a match. Used to hide `.git`. */
  hideSegment?: (seg: string) => boolean;
  /**
   * How listDir treats a symlink that resolves outside the root:
   *  - "drop" (default): omit it silently (scratchpad behavior).
   *  - "mark": surface it as a non-navigable entry with `linkOutside: true`.
   */
  onEscape?: "drop" | "mark";
}

/** true when `real` is the root itself or lives inside it (realpath containment). */
export function within(real: string, rootReal: string): boolean {
  return real === rootReal || real.startsWith(rootReal + sep);
}

/** Root-relative, forward-slash form of an absolute path known to be within `rootReal`. */
export function relFromRoot(rootReal: string, abs: string): string {
  if (abs === rootReal) return "";
  return relative(rootReal, abs).split(sep).join("/");
}

/**
 * Resolve a caller-supplied RELATIVE path against `root`, enforcing containment via realpath.
 * Returns `{ rootReal, resolved }`, or null when: root is absent/unreadable, the request escapes
 * the root (`..`, absolute, symlink), the target doesn't exist, or a relative segment matches
 * `hideSegment`.
 */
export async function resolveInRoot(
  root: string,
  relPath: string,
  opts?: BrowseOptions,
): Promise<{ rootReal: string; resolved: string } | null> {
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(root);
  } catch {
    return null; // root not created / unreadable
  }
  // Treat as root-relative. Reject any normalized path that climbs above the root (`..`) or is
  // absolute; realpath containment below is the backstop (catches symlink escapes too).
  const norm = normalize(relPath || "");
  if (norm === ".." || norm.startsWith(".." + sep) || isAbsolute(norm)) return null;

  if (opts?.hideSegment) {
    const segments = norm.split(sep);
    if (segments.some((seg) => opts.hideSegment!(seg))) return null;
  }

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
 * List one directory under `root`. Returns null on escape/missing/not-a-directory.
 * Sort: directories first, then locale-aware alphabetical within each group.
 */
export async function listDir(
  root: string,
  relPath: string,
  opts?: BrowseOptions,
): Promise<BrowseListing | null> {
  const r = await resolveInRoot(root, relPath, opts);
  if (!r) return null;
  const { rootReal, resolved } = r;

  let dirents;
  try {
    dirents = await fsp.readdir(resolved, { withFileTypes: true });
  } catch {
    return null; // not a directory / unreadable
  }

  const entries: BrowseEntry[] = [];
  for (const d of dirents) {
    if (opts?.hideSegment?.(d.name)) continue;
    const abs = join(resolved, d.name);

    if (d.isSymbolicLink()) {
      let real: string;
      try {
        real = await fsp.realpath(abs);
      } catch {
        continue; // broken symlink / unreadable → skip
      }
      if (within(real, rootReal)) {
        let isDir: boolean;
        try {
          isDir = (await fsp.stat(abs)).isDirectory();
        } catch {
          continue;
        }
        entries.push({
          name: d.name,
          type: isDir ? "dir" : "file",
          path: relFromRoot(rootReal, abs),
        });
      } else if (opts?.onEscape === "mark") {
        let type: "file" | "dir" = "file";
        try {
          type = (await fsp.stat(abs)).isDirectory() ? "dir" : "file";
        } catch {
          // best-effort — default to "file" on throw
        }
        entries.push({
          name: d.name,
          type,
          path: relFromRoot(rootReal, abs),
          linkOutside: true,
        });
      }
      // else ("drop" / default): never surface an entry that escapes the root
      continue;
    }

    if (d.isDirectory()) {
      // No realpath/stat — a non-symlink child of an in-root dir is provably in-root.
      entries.push({ name: d.name, type: "dir", path: relFromRoot(rootReal, abs) });
    } else if (d.isFile()) {
      entries.push({ name: d.name, type: "file", path: relFromRoot(rootReal, abs) });
    }
    // else: sockets/fifos/devices are not surfaced
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
 * Resolve a path under `root` that must be a regular FILE (for download). Returns the canonical
 * absolute path, or null on escape / missing / not-a-regular-file / hideSegment match.
 */
export async function resolveFileInRoot(
  root: string,
  relPath: string,
  opts?: BrowseOptions,
): Promise<string | null> {
  const r = await resolveInRoot(root, relPath, opts);
  if (!r) return null;
  try {
    if (!(await fsp.stat(r.resolved)).isFile()) return null;
  } catch {
    return null;
  }
  return r.resolved;
}
