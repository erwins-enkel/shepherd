import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Result of a fast-forward attempt against the local default-branch checkout. */
export type PullResult =
  | { ok: true; branch: string; updated: boolean; sha: string }
  | { ok: false; reason: "wrong_branch" | "dirty" | "diverged" | "error"; branch?: string };

// Every git call runs in the repo `dir`, with prompts disabled (a missing
// credential must fail fast, never block the server on a TTY prompt) and an 8s
// ceiling so a wedged fetch can't freeze the loop.
const gitOpts = (dir: string) =>
  ({
    cwd: dir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 8_000,
    encoding: "utf8" as const,
  }) as const;

/** Async git that returns trimmed stdout. Rejects on non-zero exit / timeout.
 *  Async (not sync) so even the local steps — `status`/`merge` can do real work
 *  on a large repo — never block the single-threaded event loop. */
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, gitOpts(dir));
  return stdout.trim();
}

/**
 * Resolve the default branch name for `dir`, in order:
 *   1. `hint` — only if `origin/<hint>` actually exists (never trust the client blindly).
 *   2. local `origin/HEAD` (`origin/main` → `main`).
 *   3. `await opts.forgeDefault?.()`.
 *   4. none → null.
 * A failing git step just falls through to the next source.
 */
export async function resolveDefaultBranch(
  dir: string,
  opts: { hint?: string; forgeDefault?: () => Promise<string | null> },
): Promise<string | null> {
  // 1. validated hint
  if (opts.hint) {
    try {
      await git(dir, ["rev-parse", "--verify", "--quiet", `origin/${opts.hint}`]);
      return opts.hint;
    } catch {
      /* hint ref missing — fall through */
    }
  }

  // 2. local origin/HEAD (exits non-zero when origin/HEAD is unset)
  try {
    const ref = await git(dir, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    if (ref) return ref.replace(/^origin\//, "");
  } catch {
    /* origin/HEAD unset — fall through */
  }

  // 3. forge
  try {
    const fromForge = await opts.forgeDefault?.();
    if (fromForge) return fromForge;
  } catch {
    /* forge lookup failed — fall through */
  }

  // 4. nothing
  return null;
}

/**
 * Fast-forward the local default-branch checkout in `dir` to `origin/<branch>`.
 * Fails closed and NEVER throws — any error maps to `{ ok:false }`:
 *   - HEAD not on `branch`           → wrong_branch (normal for a feature checkout)
 *   - working tree dirty             → dirty
 *   - `merge --ff-only` non-zero     → diverged
 *   - any other throw/timeout        → error
 * Every git step is async so neither the network fetch nor a slow local
 * status/merge on a large repo can block the single-threaded event loop.
 */
export async function fastForwardDefaultBranch(dir: string, branch: string): Promise<PullResult> {
  try {
    const current = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current !== branch) return { ok: false, reason: "wrong_branch", branch };

    const status = await git(dir, ["status", "--porcelain"]);
    if (status.length > 0) return { ok: false, reason: "dirty", branch };

    const beforeSha = await git(dir, ["rev-parse", "HEAD"]);

    await git(dir, ["fetch", "origin", "--", branch]);

    // Local fast-forward; non-zero exit (e.g. diverged history) rejects → diverged.
    try {
      await git(dir, ["merge", "--ff-only", `origin/${branch}`]);
    } catch {
      return { ok: false, reason: "diverged", branch };
    }

    const afterSha = await git(dir, ["rev-parse", "HEAD"]);
    return { ok: true, branch, updated: beforeSha !== afterSha, sha: afterSha };
  } catch {
    return { ok: false, reason: "error" };
  }
}
