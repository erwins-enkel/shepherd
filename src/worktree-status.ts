import { pinFor, resolveBaseRef } from "./diff";
import { timedAsync } from "./instrument";
import { execGit, type GitPin } from "./safe-git";
import type { UnpushedCommit, WorktreeStatus } from "./types";

/** At most this many unpushed commits are listed; `unpushedCount` still carries the total. */
export const MAX_UNPUSHED_LISTED = 50;

const SEP = "\x1f";

async function git(cwd: string, pin: GitPin | null, args: string[]): Promise<string> {
  const verb = args.find((a) => !a.startsWith("-"));
  const { stdout } = await timedAsync(`git ${verb}`, () => execGit(args, { cwd, pin }));
  return stdout.trim();
}

async function refExists(cwd: string, pin: GitPin | null, ref: string): Promise<boolean> {
  try {
    await git(cwd, pin, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function parseCommits(out: string): UnpushedCommit[] {
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [sha = "", at = "0", subject = ""] = line.split(SEP);
    return { sha, subject, authoredAt: Number(at) * 1000 };
  });
}

/** Commits on HEAD that `origin/<branch>` lacks — or, when the branch was never pushed, that the
 *  base lacks. Relies on the local remote-tracking ref, which the worktree's own pushes keep current. */
async function unpushed(
  cwd: string,
  pin: GitPin | null,
  branch: string,
  baseRef: string,
): Promise<Pick<WorktreeStatus, "upstream" | "unpushedCount" | "unpushed">> {
  const remote = `origin/${branch}`;
  const upstream = (await refExists(cwd, pin, remote)) ? remote : null;
  const range = `${upstream ?? baseRef}..HEAD`;
  const [count, log] = await Promise.all([
    git(cwd, pin, ["rev-list", "--count", range]),
    git(cwd, pin, [
      "log",
      `--max-count=${MAX_UNPUSHED_LISTED}`,
      `--format=%H${SEP}%at${SEP}%s`,
      range,
      "--",
    ]),
  ]);
  return { upstream, unpushedCount: Number(count), unpushed: parseCommits(log) };
}

/**
 * Live state of a session's worktree against its (freshly fetched) base: fork point, behind/ahead,
 * unpushed commits and the dirty flag. A non-isolated session (no branch) answers nulls without
 * touching git. `repoPath` (trusted) pins the gitdir against a rewritten worktree `.git` gitfile.
 */
export async function computeWorktreeStatus(
  worktreePath: string,
  base: string,
  branch: string | null,
  repoPath?: string,
): Promise<WorktreeStatus> {
  if (!branch) {
    return {
      base,
      baseRef: base,
      fetchFailed: false,
      head: null,
      headSha: null,
      mergeBase: null,
      baseSha: null,
      behindBase: null,
      aheadOfBase: null,
      upstream: null,
      unpushedCount: null,
      unpushed: [],
      dirty: null,
    };
  }
  if (base.startsWith("-")) throw new Error(`invalid base branch: ${base}`);
  const pin = await pinFor(worktreePath, repoPath);
  const { ref, fetchFailed } = await resolveBaseRef(worktreePath, base, pin);
  const [headSha, baseSha, mergeBase, counts, status, push] = await Promise.all([
    git(worktreePath, pin, ["rev-parse", "HEAD"]),
    git(worktreePath, pin, ["rev-parse", `${ref}^{commit}`]),
    git(worktreePath, pin, ["merge-base", ref, "HEAD"]),
    git(worktreePath, pin, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]),
    // No index refresh: a status read must never take index.lock out from under the agent.
    git(worktreePath, pin, ["--no-optional-locks", "status", "--porcelain"]),
    unpushed(worktreePath, pin, branch, ref),
  ]);
  const [behind = "0", ahead = "0"] = counts.split(/\s+/);
  return {
    base,
    baseRef: ref,
    fetchFailed,
    head: branch,
    headSha,
    mergeBase,
    baseSha,
    behindBase: Number(behind),
    aheadOfBase: Number(ahead),
    ...push,
    dirty: status !== "",
  };
}
