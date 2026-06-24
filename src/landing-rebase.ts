import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorktreeMgr } from "./worktree";
import { execFileSync } from "./instrument";

const execFileAsync = promisify(execFile);

/**
 * Fast, local-only probe: returns true when `merge.i18n-union.driver` is set in the
 * repo's shared git config. Used by the drain driver-pause fast-path to re-probe
 * cheaply without spawning a full rebase attempt.
 *
 * ASYNC: reached from the drain tick (single Bun event loop) — a sync child-process
 * here would freeze the web terminal. No forge call; purely local `git config --get`.
 */
export async function isUnionDriverRegistered(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "merge.i18n-union.driver"], {
      cwd: repoPath,
    });
    return stdout.trim().length > 0;
  } catch {
    // Non-zero exit (key absent / not a repo / git error) → not registered.
    return false;
  }
}

export type LandingRebaseResult =
  | { kind: "rebased"; headSha: string } // replayed onto origin/<default>, force-pushed
  | { kind: "current" } // branch already contains origin/<default>; nothing to do
  | { kind: "conflict" } // genuine clash (non-union path, OR union path + self-test PASSED)
  | { kind: "driver-absent" } // merge.i18n-union.driver unregisterable
  | { kind: "driver-broken" } // union-only conflict + driver self-test FAILED
  | { kind: "transient" }; // fetch/worktree/push (e.g. stale lease) error

export interface LandingRebaseDeps {
  worktrees: Pick<WorktreeMgr, "createDetached" | "remove">;
  git: (cwd: string, args: string[]) => Promise<{ stdout: string }>;
  registerDriver: (repoPath: string) => void;
}

/** Validate a git refname component (same grammar as WorktreeMgr). */
function validRef(ref: string): boolean {
  return /^(?!-)[A-Za-z0-9._/-]{1,200}$/.test(ref);
}

/**
 * Run the union merge driver self-test in a temp dir.
 * Writes base/ours/theirs JSON, runs json-union-merge.mjs,
 * and returns true iff exit 0 and the merged ours contains keys a, b, AND c.
 */
async function driverSelfTest(repoPath: string): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-selftest-"));
  try {
    const base = join(dir, "base.json");
    const ours = join(dir, "ours.json");
    const theirs = join(dir, "theirs.json");
    writeFileSync(base, JSON.stringify({ a: "1" }));
    writeFileSync(ours, JSON.stringify({ a: "1", b: "2" }));
    writeFileSync(theirs, JSON.stringify({ a: "1", c: "3" }));
    // %O %A %B %P — base, ours/OUTPUT, theirs, pathname
    const scriptPath = join(repoPath, "scripts", "json-union-merge.mjs");
    if (!existsSync(scriptPath)) return false;
    await execFileAsync("node", [scriptPath, base, ours, theirs, "test.json"], { cwd: repoPath });
    const merged = JSON.parse(readFileSync(ours, "utf8"));
    return (
      typeof merged === "object" &&
      merged !== null &&
      "a" in merged &&
      "b" in merged &&
      "c" in merged
    );
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse .gitattributes and return the set of globs that use the union or i18n-union merge driver.
 * These are the paths that the union merge driver handles.
 */
function parseUnionGlobs(repoPath: string): string[] {
  const attrPath = join(repoPath, ".gitattributes");
  let content: string;
  try {
    content = readFileSync(attrPath, "utf8");
  } catch {
    return [];
  }
  const globs: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const glob = parts[0]!;
    const hasUnionDriver = parts
      .slice(1)
      .some((attr) => attr === "merge=union" || attr === "merge=i18n-union");
    if (hasUnionDriver) globs.push(glob);
  }
  return globs;
}

/** Match a file path against a gitattributes glob pattern.
 *
 * The pattern is converted to a FULL-PATH-anchored regex (`^…$`), translating
 * `**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`. This deliberately does NOT implement
 * real gitattributes basename semantics for slash-free patterns (where `*.json`
 * would match any `*.json` at any depth). All Shepherd union globs in
 * `.gitattributes` contain a slash (`ui/messages/*.json`,
 * `extension/messages/*.json`, `ui/src/lib/feature-announcements.ts`), so this is
 * exact for every real union glob. A hypothetical slash-free union glob would
 * therefore NOT be treated as union-managed — and that is the fail-SAFE direction:
 * an unmatched conflicted path is classified as a non-union conflict, yielding
 * `conflict` (operator hand-off) rather than a wrongly-auto-resolved push.
 */
function matchGlob(glob: string, filePath: string): boolean {
  const normalized = glob.replace(/\\/g, "/");
  const fileParts = filePath.replace(/\\/g, "/");

  // Convert glob to regex
  let regexStr = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*" && normalized[i + 1] === "*") {
      regexStr += ".*";
      i += 2;
      if (normalized[i] === "/") i++; // skip trailing slash after **
    } else if (ch === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(fileParts);
}

/** Check if a file path is covered by any of the union-managed globs. */
function isUnionManaged(filePath: string, unionGlobs: string[]): boolean {
  return unionGlobs.some((glob) => matchGlob(glob, filePath));
}

function makeDefaultGit(cwd: string, args: string[]): Promise<{ stdout: string }> {
  return execFileAsync("git", args, { cwd }).then(({ stdout }) => ({ stdout }));
}

function makeDefaultRegisterDriver(repoPath: string): void {
  execFileSync("node", ["scripts/register-merge-driver.mjs"], { cwd: repoPath, stdio: "pipe" });
}

/**
 * Rebase a session-less epic landing/integration branch onto the default branch.
 * Auto-resolves union-merge-driver false conflicts.
 *
 * @param repoPath - absolute path to the main repo checkout
 * @param integrationBranch - the epic landing branch to rebase (e.g. "epic/42-my-epic")
 * @param defaultBranch - the branch to rebase onto (e.g. "main")
 * @param deps - injectable deps for testing
 */
export async function rebaseLandingBranch(
  repoPath: string,
  integrationBranch: string,
  defaultBranch: string,
  deps?: Partial<LandingRebaseDeps>,
): Promise<LandingRebaseResult> {
  if (!validRef(integrationBranch)) {
    console.error(`[landing-rebase] invalid integrationBranch: ${integrationBranch}`);
    return { kind: "transient" };
  }
  if (!validRef(defaultBranch)) {
    console.error(`[landing-rebase] invalid defaultBranch: ${defaultBranch}`);
    return { kind: "transient" };
  }

  const git = deps?.git ?? ((cwd: string, args: string[]) => makeDefaultGit(cwd, args));
  const registerDriver = deps?.registerDriver ?? makeDefaultRegisterDriver;

  // Determine worktrees dep — use real WorktreeMgr by default
  let worktrees: Pick<WorktreeMgr, "createDetached" | "remove">;
  if (deps?.worktrees) {
    worktrees = deps.worktrees;
  } else {
    // Lazy import to avoid circular deps; real path
    const { WorktreeMgr: Mgr } = await import("./worktree");
    worktrees = new Mgr();
  }

  // 1. Driver precondition
  try {
    const { stdout } = await git(repoPath, ["config", "--get", "merge.i18n-union.driver"]);
    if (!stdout.trim()) {
      throw new Error("empty driver config");
    }
  } catch {
    // Driver not registered; attempt to register
    try {
      registerDriver(repoPath);
    } catch (err) {
      console.error(`[landing-rebase] registerDriver failed:`, err);
      return { kind: "driver-absent" };
    }
    // Re-check
    try {
      const { stdout } = await git(repoPath, ["config", "--get", "merge.i18n-union.driver"]);
      if (!stdout.trim()) {
        return { kind: "driver-absent" };
      }
    } catch {
      return { kind: "driver-absent" };
    }
  }

  // 2. Fetch both refs using explicit refspecs so tracking refs are created/updated
  // even in single-branch clones (where only `main` is in the fetch refspec config).
  try {
    await git(repoPath, [
      "fetch",
      "origin",
      `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
      `refs/heads/${integrationBranch}:refs/remotes/origin/${integrationBranch}`,
    ]);
  } catch (err) {
    console.error(`[landing-rebase] fetch failed:`, err);
    return { kind: "transient" };
  }

  // 3. leaseSha + ancestor check
  let leaseSha: string;
  try {
    const { stdout } = await git(repoPath, ["rev-parse", `origin/${integrationBranch}`]);
    leaseSha = stdout.trim();
  } catch (err) {
    console.error(`[landing-rebase] rev-parse failed:`, err);
    return { kind: "transient" };
  }

  try {
    // If origin/<default> is already an ancestor of origin/<integrationBranch>, nothing to do
    await git(repoPath, [
      "merge-base",
      "--is-ancestor",
      `origin/${defaultBranch}`,
      `origin/${integrationBranch}`,
    ]);
    return { kind: "current" };
  } catch {
    // Not an ancestor → need to rebase
  }

  // 4. Create detached worktree
  let wt: { worktreePath: string };
  try {
    wt = await worktrees.createDetached(repoPath, integrationBranch, leaseSha);
  } catch (err) {
    console.error(`[landing-rebase] createDetached failed:`, err);
    return { kind: "transient" };
  }

  try {
    // 5. Rebase with the merge backend pinned.
    // Belt-and-suspenders for git < 2.34: there the default `apply` backend
    // bypasses gitattributes `merge=` drivers entirely, silently skipping our
    // union drivers and false-conflicting the append-only catalog hunks. Pinning
    // `merge` forces the drivers to run. (On modern git the `apply` backend also
    // runs drivers via its 3-way fallback, so the divergence is untestable on
    // current git — but we pin regardless so an older/misconfigured host can't
    // bypass them.)
    try {
      await git(wt.worktreePath, [
        "-c",
        "rebase.backend=merge",
        "rebase",
        `origin/${defaultBranch}`,
      ]);
    } catch {
      // 6. Rebase failed — classify before labeling
      let conflictedPaths: string[];
      try {
        const { stdout } = await git(wt.worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
        conflictedPaths = stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        conflictedPaths = [];
      }

      const unionGlobs = parseUnionGlobs(repoPath);

      // Abort the rebase before returning
      const abortRebase = async () => {
        try {
          await git(wt.worktreePath, ["rebase", "--abort"]);
        } catch {
          /* best effort */
        }
      };

      if (conflictedPaths.length === 0) {
        // No conflicted paths but rebase still failed (e.g. empty)
        await abortRebase();
        return { kind: "conflict" };
      }

      // 6a/6b: Check if any path is outside union-managed globs
      const hasNonUnionConflict = conflictedPaths.some((p) => !isUnionManaged(p, unionGlobs));
      if (hasNonUnionConflict) {
        await abortRebase();
        return { kind: "conflict" };
      }

      // 6c: All conflicted paths are union-managed — run driver self-test
      const selfTestPassed = await driverSelfTest(repoPath);
      await abortRebase();
      if (selfTestPassed) {
        // Driver works → genuine same-key clash
        return { kind: "conflict" };
      } else {
        // Driver non-functional
        return { kind: "driver-broken" };
      }
    }

    // 7. Force-push with lease
    try {
      await git(wt.worktreePath, [
        "push",
        `--force-with-lease=${integrationBranch}:${leaseSha}`,
        "origin",
        `HEAD:refs/heads/${integrationBranch}`,
      ]);
    } catch (err) {
      console.error(`[landing-rebase] push failed (stale lease or remote error):`, err);
      return { kind: "transient" };
    }

    // 9. Success — get new head SHA. The push already landed, so a rev-parse
    // failure here is a local read glitch; surface it as transient (a retry
    // resolves to `current`, no double-count) rather than an unhandled rejection.
    try {
      const { stdout: headOut } = await git(wt.worktreePath, ["rev-parse", "HEAD"]);
      return { kind: "rebased", headSha: headOut.trim() };
    } catch (err) {
      console.error(`[landing-rebase] rev-parse HEAD after push failed:`, err);
      return { kind: "transient" };
    }
  } finally {
    // 8. Always clean up the worktree
    try {
      worktrees.remove(wt.worktreePath);
    } catch (err) {
      console.error(`[landing-rebase] worktree remove failed:`, err);
    }
  }
}
