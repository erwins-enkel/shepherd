import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

// ── createProject ─────────────────────────────────────────────────────────────

/**
 * Injectable async gh runner so the network call never blocks Bun's loop and
 * tests can stub it. Mirrors GhRunner in forge/github.ts.
 */
export type GhRunner = (args: string[]) => Promise<void>;

const execFileAsync = promisify(execFile);

/** Default gh runner: promisified execFile wrapped in a 60s timeout.
 *  On timeout, rejects with an error whose `code` is `"_timeout"` so
 *  classifyProjectError maps it to `newproject_failed_timeout`.
 */
const defaultGhRunner: GhRunner = async (args) => {
  const TIMEOUT_MS = 60_000;
  const timeoutErr = Object.assign(new Error("gh runner timed out"), { code: "_timeout" });
  await Promise.race([
    execFileAsync("gh", args, { maxBuffer: 2 * 1024 * 1024 }).then(() => undefined),
    new Promise<never>((_, reject) => setTimeout(() => reject(timeoutErr), TIMEOUT_MS)),
  ]);
};

/** Check whether git user.name and user.email are both configured globally. */
function gitIdentityPresent(): boolean {
  try {
    const name = execFileSync("git", ["config", "--get", "user.name"], {
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    const email = execFileSync("git", ["config", "--get", "user.email"], {
      stdio: "pipe",
      timeout: 5000,
    })
      .toString()
      .trim();
    return name.length > 0 && email.length > 0;
  } catch {
    return false;
  }
}

/**
 * Classify an error from createProject into a stable `newproject_failed_*` code.
 * Mirrors classifyCloneError in style — lowercase stderr before matching.
 */
export function classifyProjectError(e: unknown): string {
  // Explicit timeout code set by the default runner
  if ((e as any).code === "_timeout") return "newproject_failed_timeout";
  // killed by SIGTERM (e.g. from execFileSync timeout option)
  if ((e as any).killed && (e as any).signal === "SIGTERM") return "newproject_failed_timeout";

  const stderr = String((e as any).stderr ?? (e as any).message ?? "").toLowerCase();

  // gh not installed
  if (
    (e as any).code === "ENOENT" ||
    stderr.includes("command not found") ||
    stderr.includes("not found")
  ) {
    return "newproject_failed_gh_missing";
  }

  // gh auth failures
  if (
    stderr.includes("not logged") ||
    stderr.includes("auth status") ||
    stderr.includes("gh auth login") ||
    stderr.includes("authentication") ||
    stderr.includes("you are not logged")
  ) {
    return "newproject_failed_gh_auth";
  }

  // GitHub repo name already exists
  if (
    stderr.includes("name already exists") ||
    stderr.includes("already exists on") ||
    (stderr.includes("could not create repository") && stderr.includes("exists"))
  ) {
    return "newproject_failed_gh_exists";
  }

  // local git failures
  if (
    stderr.includes("fatal:") ||
    stderr.includes("not a git repository") ||
    stderr.includes("author identity unknown")
  ) {
    return "newproject_failed_git";
  }

  // any other non-empty stderr from a gh repo create is a remote failure
  if (stderr.length > 0) {
    return "newproject_failed_remote";
  }

  return "newproject_failed_generic";
}

/**
 * Bootstrap a new git project at `<repoRoot>/<input.name>`.
 *
 * Returns `{ ok: true, entry }` on full success,
 * `{ ok: true, entry, warning }` when local succeeded but GitHub failed (partial success),
 * or `{ ok: false, error }` when the local setup itself failed.
 *
 * Pre-commit failures clean up the half-created directory.
 * Remote failures never clean up — the local repo is kept.
 *
 * @param ghRunner - Injectable async runner for `gh` CLI calls (default: promisified execFile + 60s timeout).
 * @param _identityCheck - Injectable identity checker; defaults to `gitIdentityPresent()`. Exposed for tests
 *   because Bun's process.env mutations don't propagate to child processes in the same way Node does.
 */
export async function createProject(
  input: { name: string; idea: string; createRemote: boolean; visibility: "private" | "public" },
  repoRoot: string,
  ghRunner?: GhRunner,
  _identityCheck?: () => boolean,
): Promise<{ ok: true; entry: RepoEntry; warning?: string } | { ok: false; error: string }> {
  const runner = ghRunner ?? defaultGhRunner;
  const identityOk = _identityCheck ?? gitIdentityPresent;

  // Step 1: Resolve paths + containment + existence checks (defense-in-depth)
  const root = resolve(expandHome(repoRoot));
  const target = join(root, input.name);

  const inside = target === root || target.startsWith(root + sep);
  if (!inside) {
    return { ok: false, error: "newproject_failed_outside" };
  }
  if (existsSync(target)) {
    return { ok: false, error: "newproject_failed_exists" };
  }

  // Step 2: Identity pre-check (before any fs mutation)
  if (!identityOk()) {
    return { ok: false, error: "newproject_failed_identity" };
  }

  // Steps 3–7: fs mutations with cleanup on pre-commit failure
  let committed = false;

  try {
    // Step 3: create the directory
    mkdirSync(target, { recursive: false });

    // Step 4: git init
    execFileSync("git", ["init", "-b", "main"], { cwd: target, stdio: "pipe", timeout: 30_000 });

    // Step 5: write bootstrap files
    const ideaText = input.idea.trim();
    const readmeIdea = ideaText || "_No description yet._";
    const claudeIdea = ideaText || "(to be defined)";

    writeFileSync(join(target, "README.md"), `# ${input.name}\n\n${readmeIdea}\n`, "utf8");

    writeFileSync(
      join(target, ".gitignore"),
      `node_modules/\n.DS_Store\n*.log\n.env\n.env.*\ndist/\nbuild/\n`,
      "utf8",
    );

    writeFileSync(
      join(target, "CLAUDE.md"),
      `# ${input.name}\n\n## Idea\n\n${claudeIdea}\n\n## Notes\n\n<!-- Project conventions go here. The first agent session authors the PRD. -->\n`,
      "utf8",
    );

    // Step 6: git add
    execFileSync("git", ["add", "-A"], { cwd: target, stdio: "pipe", timeout: 30_000 });

    // Step 7: git commit
    execFileSync("git", ["commit", "-m", "chore: project bootstrap"], {
      cwd: target,
      stdio: "pipe",
      timeout: 30_000,
    });
    committed = true;
  } catch (e) {
    if (!committed) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    return { ok: false, error: classifyProjectError(e) };
  }

  // Step 8: build RepoEntry
  const entry: RepoEntry = {
    name: input.name,
    path: target,
    display: toDisplay(target),
  };

  // Step 9: if no remote requested, done
  if (!input.createRemote) {
    return { ok: true, entry };
  }

  // Step 10: remote step — local repo is already committed; keep it on any failure here
  // Auth pre-check
  try {
    await runner(["auth", "status"]);
  } catch (e) {
    const code = classifyProjectError(e);
    const warning =
      code === "newproject_failed_gh_missing"
        ? "newproject_failed_gh_missing"
        : "newproject_failed_gh_auth";
    return { ok: true, entry, warning };
  }

  // Create + push
  try {
    await runner([
      "repo",
      "create",
      input.name,
      "--source",
      target,
      input.visibility === "public" ? "--public" : "--private",
      "--push",
    ]);
  } catch (e) {
    const stderr = String((e as any).stderr ?? (e as any).message ?? "").toLowerCase();
    const warning =
      stderr.includes("name already exists") ||
      stderr.includes("already exists on") ||
      (stderr.includes("could not create repository") && stderr.includes("exists"))
        ? "newproject_failed_gh_exists"
        : "newproject_failed_remote";
    return { ok: true, entry, warning };
  }

  return { ok: true, entry };
}
