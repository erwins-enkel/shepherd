/**
 * The local-work guard behind `schedule_noop`: a scheduled session may only close itself as a
 * no-op when closing loses nothing. Stricter than the session archiver's "unsynced" check — a
 * no-op made no product change at all, so ANY commit beyond the base (pushed or not) is work.
 *
 * Only an isolated session has a worktree of its own to lose; a non-isolated one runs in the main
 * checkout, which archiving never removes. Anything git refuses to answer counts as work.
 * Async only: this runs on the server's single Bun loop.
 */
import { existsSync } from "node:fs";
import { execGit, resolveWorktreePin } from "./safe-git";
import type { Session } from "./types";

type GuardSession = Pick<
  Session,
  "isolated" | "branch" | "baseBranch" | "repoPath" | "worktreePath"
>;

/** True when the session's worktree is dirty or its branch has commits beyond its base. */
export async function hasLocalWork(s: GuardSession): Promise<boolean> {
  if (!s.isolated || !s.branch || !existsSync(s.worktreePath)) return false;
  if (!s.baseBranch) return true;
  try {
    const pin = await resolveWorktreePin(s.repoPath, s.worktreePath);
    const git = async (args: string[]) =>
      (await execGit(args, { cwd: s.worktreePath, pin })).stdout.trim();
    if ((await git(["status", "--porcelain"])) !== "") return true;
    return Number(await git(["rev-list", "--count", `${s.baseBranch}..HEAD`])) !== 0;
  } catch {
    return true;
  }
}
