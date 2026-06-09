import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "./instrument";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { expandHome, safeRepoDir } from "./validate";

export interface RepoEntry {
  name: string;
  path: string;
  display: string;
  /** Most-recent session createdAt for this repo; undefined if never used. */
  lastUsedAt?: number;
  /** Count of sessions (agents) run on this repo within the recent window; undefined if none. */
  recentAgentCount?: number;
}

/** Collapse the user's home directory to `~` in a display path, matching listRepos's convention. */
function toDisplay(p: string): string {
  const home = homedir();
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export function listRepos(repoRoot: string): RepoEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const p = join(repoRoot, name);
      return { name, path: p, display: toDisplay(p) };
    })
    .filter((e) => {
      try {
        return statSync(e.path).isDirectory() && !e.name.startsWith(".");
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Map a realpath-resolved repo dir (e.g. from {@link safeRepoDir}, which follows
 * symlinks) back to the path form {@link listRepos} enumerates — the raw
 * `join(repoRoot, name)`. That raw form is the key the backlog counts cache and
 * `buildBacklogPayload` read by, so a caller holding the realpath (the merge
 * path) must reconcile to it or it writes/reads a *different* cache key under a
 * symlinked repoRoot/repo — silently operating on a phantom entry.
 *
 * Matches by realpath-comparing each enumerated repo against `realDir`. Returns
 * `realDir` unchanged when nothing matches (e.g. a repo outside repoRoot), so the
 * caller still refreshes a sane key rather than dropping the request.
 */
export function listReposPathForReal(realDir: string, repoRoot: string): string {
  const realpathOr = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p; // broken symlink / vanished entry — can't match, skip past it
    }
  };
  const match = listRepos(repoRoot).find((r) => realpathOr(r.path) === realDir);
  return match?.path ?? realDir;
}

const TODO = "TODO.md";

export function readTodo(
  repoPathRaw: string,
  repoRoot: string,
): { ok: boolean; exists: boolean; content: string } {
  const dir = safeRepoDir(repoPathRaw, repoRoot);
  if (!dir) return { ok: false, exists: false, content: "" };
  const file = join(dir, TODO);
  if (!existsSync(file)) return { ok: true, exists: false, content: "" };
  return { ok: true, exists: true, content: readFileSync(file, "utf8") };
}

export function writeTodo(repoPathRaw: string, repoRoot: string, content: string): boolean {
  const dir = safeRepoDir(repoPathRaw, repoRoot);
  if (!dir) return false;
  if (typeof content !== "string" || content.length > 100_000) return false;
  const file = join(dir, TODO);
  // refuse to follow a symlinked TODO.md (prevents a symlink-swap write outside the repo)
  try {
    if (lstatSync(file).isSymbolicLink()) return false;
  } catch {
    /* file doesn't exist yet — fine */
  }
  writeFileSync(file, content, "utf8");
  return true;
}

/**
 * Clone a remote (or local) git repository into `<repoRoot>/<name>`.
 * Returns `{ ok: true, entry }` on success, or `{ ok: false, error }` with
 * one of: `clonerepo_failed_outside`, `clonerepo_failed_exists`, or a code
 * from `classifyCloneError`.
 */
export function cloneRepo(
  url: string,
  name: string,
  repoRoot: string,
): { ok: true; entry: RepoEntry } | { ok: false; error: string } {
  const root = resolve(expandHome(repoRoot));
  const target = join(root, name);

  // Containment guard — `name` must not escape the root (e.g. "../escape")
  if (!(target === root || target.startsWith(root + sep))) {
    return { ok: false, error: "clonerepo_failed_outside" };
  }

  // Existence guard — never overwrite an existing directory/file
  if (existsSync(target)) {
    return { ok: false, error: "clonerepo_failed_exists" };
  }

  try {
    execFileSync("git", ["clone", "--", url, target], {
      stdio: "pipe",
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    return { ok: false, error: classifyCloneError(e) };
  }

  const entry: RepoEntry = {
    name,
    path: target,
    display: toDisplay(target),
  };
  return { ok: true, entry };
}

export function classifyCloneError(e: unknown): string {
  if ((e as any).killed && (e as any).signal === "SIGTERM") return "clonerepo_failed_timeout";
  const stderr = String((e as any).stderr ?? "").toLowerCase();
  if (
    stderr.includes("authentication failed") ||
    stderr.includes("could not read username") ||
    stderr.includes("terminal prompts disabled") ||
    stderr.includes("permission denied") ||
    stderr.includes("403") ||
    stderr.includes("could not read password")
  ) {
    return "clonerepo_failed_auth";
  }
  if (stderr.includes("already exists and is not an empty directory")) {
    return "clonerepo_failed_exists";
  }
  if (
    stderr.includes("repository not found") ||
    stderr.includes("does not appear to be a git repository") ||
    stderr.includes("could not resolve host") ||
    stderr.includes("unable to access")
  ) {
    return "clonerepo_failed_url";
  }
  return "clonerepo_failed_url";
}
