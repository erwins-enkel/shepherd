import { readdirSync, statSync, realpathSync } from "node:fs";
import { resolve, join, dirname, sep } from "node:path";
import { expandHome } from "./validate";

/**
 * realpath-resolve `ceiling` to its canonical absolute path. Falls back to a plain
 * resolve when realpath fails (e.g. the dir doesn't exist yet) so callers always
 * get a usable absolute boundary.
 */
function resolveCeiling(ceiling: string): string {
  const abs = resolve(expandHome(ceiling));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** true when `real` is the ceiling or lives inside it (mirrors safeRepoDir). */
function withinCeiling(real: string, ceilingReal: string): boolean {
  return real === ceilingReal || real.startsWith(ceilingReal + sep);
}

const home = (): string => process.env.HOME ?? "";

/** Collapse a leading home-dir prefix to `~` for friendlier display. */
export function collapseHome(p: string): string {
  const h = home();
  return h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  /** Absolute path currently being listed. */
  path: string;
  /** `~`-collapsed form of `path` for display. */
  display: string;
  /** Parent dir, or null when at the filesystem root. */
  parent: string | null;
  /** Immediate sub-directories (dotdirs excluded), sorted by name. */
  entries: DirEntry[];
}

/**
 * List the immediate sub-directories of `pathRaw` for the root-directory browser,
 * confined to `ceiling` (the immutable repo-root ceiling). Read-only.
 *
 * The listing can never escape the ceiling: empty/invalid input or any target that
 * resolves outside the ceiling is clamped back to the ceiling itself, and `parent`
 * is null at the ceiling (its real parent is never exposed). Entries that resolve
 * outside the ceiling (e.g. symlinks pointing out) are dropped.
 */
export function listDirs(pathRaw: string, ceiling: string): DirListing {
  const ceilingReal = resolveCeiling(ceiling);

  // default start is the ceiling, not $HOME
  const start = pathRaw && pathRaw.trim() ? pathRaw.trim() : ceilingReal;
  let dir = resolve(expandHome(start));
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = ceilingReal;
  }

  // clamp to the ceiling: realpath the target and reject anything outside it.
  let dirReal: string;
  try {
    dirReal = realpathSync(dir);
  } catch {
    dirReal = ceilingReal;
  }
  if (!withinCeiling(dirReal, ceilingReal)) dirReal = ceilingReal;
  dir = dirReal;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }

  const entries = names
    .filter((n) => !n.startsWith("."))
    .map((n) => ({ name: n, path: join(dir, n) }))
    .filter((e) => {
      try {
        if (!statSync(e.path).isDirectory()) return false;
        // never surface an entry that escapes the ceiling (e.g. an out-pointing symlink)
        return withinCeiling(realpathSync(e.path), ceilingReal);
      } catch {
        return false; // unreadable / broken symlink → skip
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // parent is null at (or above) the ceiling — never expose the ceiling's parent
  const parent = dirname(dir);
  const parentReal = parent === dir ? null : parent;
  return {
    path: dir,
    display: collapseHome(dir),
    parent:
      dir === ceilingReal || parentReal === null || !withinCeiling(parentReal, ceilingReal)
        ? null
        : parentReal,
    entries,
  };
}

/**
 * Validate a candidate repo root, confined to `ceiling`. Returns the resolved
 * absolute path only when it is the ceiling or inside it (realpath containment);
 * otherwise null.
 */
export function validateRoot(pathRaw: unknown, ceiling: string): string | null {
  if (typeof pathRaw !== "string" || pathRaw.trim().length === 0) return null;
  const ceilingReal = resolveCeiling(ceiling);
  let real: string;
  try {
    real = realpathSync(resolve(expandHome(pathRaw.trim())));
  } catch {
    return null; // non-existent path → reject
  }
  if (!withinCeiling(real, ceilingReal)) return null;
  try {
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
