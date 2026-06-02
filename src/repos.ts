import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { expandHome, safeRepoDir } from "./validate";

export interface RepoEntry {
  name: string;
  path: string;
  display: string;
  /** Most-recent session createdAt for this repo; undefined if never used. */
  lastUsedAt?: number;
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

// TODO(Task 3): replace this stub with the real classification logic
export function classifyCloneError(e: unknown): string {
  void e;
  return "clonerepo_failed_generic";
}
