import { readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { expandHome } from "./validate";

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
 * List the immediate sub-directories of `pathRaw` for the root-directory browser.
 * Read-only. Empty/invalid input falls back to $HOME; an unreadable path climbs to
 * the nearest readable ancestor so the browser never lands on a dead end.
 */
export function listDirs(pathRaw: string): DirListing {
  const start = pathRaw && pathRaw.trim() ? pathRaw.trim() : home() || "/";
  let dir = resolve(expandHome(start));
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = home() || "/";
  }

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
        return statSync(e.path).isDirectory();
      } catch {
        return false; // unreadable / broken symlink → skip
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = dirname(dir);
  return {
    path: dir,
    display: collapseHome(dir),
    parent: parent === dir ? null : parent,
    entries,
  };
}

/** Validate a candidate repo root. Returns the resolved absolute path, or null if invalid. */
export function validateRoot(pathRaw: unknown): string | null {
  if (typeof pathRaw !== "string" || pathRaw.trim().length === 0) return null;
  const resolved = resolve(expandHome(pathRaw.trim()));
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}
