/**
 * The git half of moving a session to another machine ("Continue with…" on another machine), on
 * the SOURCE: snapshot the worktree as it stands and publish it on the session's own work branch,
 * so the target can check that very branch out (an open PR stays the same).
 *
 * - Everything the agent left uncommitted goes into ONE commit (`git add -A`, so `.gitignore` and
 *   Shepherd's exclude still apply), whose subject the target's handoff text names.
 * - Hooks never run (`--no-verify`, on top of the hardened `core.hooksPath`): a WIP snapshot must
 *   not fail on a lint gate, and it runs project code under the server's identity otherwise.
 * - The push is `--force-with-lease`: the local branch is the session's truth (an agent may have
 *   rebased it), but a branch someone else advanced on origin since the last fetch is refused rather
 *   than overwritten.
 * - Git runs pinned to the trusted repo (`resolveWorktreePin`): the worktree's own `.git` gitfile is
 *   agent-writable and never read.
 */
import { lstatSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PLAN_FILE } from "./plan-gate";
import { execGit, resolveWorktreePin, type GitPin } from "./safe-git";
import type { AgentProvider } from "./types";
import { copyRegularFileNoFollow, listRegularUploadEntries } from "./uploads";
import { MAX_IMAGES } from "./validate";

/** The subject prefix of the snapshot commit; the target's handoff text names it. */
export const HANDOFF_WIP_SUBJECT = "wip(shepherd): hand off to";

const PUSH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 30_000;
const DETAIL_MAX = 500;

export type HandoffGitCode = "handoff_commit_failed" | "handoff_push_failed";

export class HandoffGitError extends Error {
  constructor(
    public readonly code: HandoffGitCode,
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "HandoffGitError";
  }
}

export interface HandoffGitResult {
  /** A snapshot commit was made (the worktree had uncommitted changes). */
  committed: boolean;
  /** The commit pushed as the branch's tip. */
  headCommit: string;
}

function stderrOf(err: unknown): string {
  const raw = String((err as { stderr?: unknown }).stderr ?? "").trim() || String(err);
  return raw.length > DETAIL_MAX ? `${raw.slice(0, DETAIL_MAX)}…` : raw;
}

/** Commit everything uncommitted in `worktreePath` and push `branch` to origin. */
export async function commitAndPushForHandoff(args: {
  repoPath: string;
  worktreePath: string;
  branch: string;
  /** The machine the session moves to, named in the snapshot commit's subject. */
  targetName: string;
}): Promise<HandoffGitResult> {
  const { repoPath, worktreePath, branch, targetName } = args;
  let pin: GitPin | null;
  try {
    pin = await resolveWorktreePin(repoPath, worktreePath);
  } catch (err) {
    throw new HandoffGitError("handoff_commit_failed", stderrOf(err));
  }
  const git = (gitArgs: string[], timeout = GIT_TIMEOUT_MS) =>
    execGit(gitArgs, { cwd: worktreePath, pin: pin ?? undefined, timeout, killSignal: "SIGKILL" });

  let committed = false;
  let headCommit: string;
  try {
    await git(["add", "-A"]);
    const staged = await git(["diff", "--cached", "--quiet"]).then(
      () => false,
      () => true,
    );
    if (staged) {
      await git(["commit", "--no-verify", "-q", "-m", `${HANDOFF_WIP_SUBJECT} ${targetName}`]);
      committed = true;
    }
    headCommit = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
  } catch (err) {
    throw new HandoffGitError("handoff_commit_failed", stderrOf(err));
  }
  try {
    await git(
      [
        "push",
        "--no-verify",
        "--force-with-lease",
        "-u",
        "origin",
        `${branch}:refs/heads/${branch}`,
      ],
      PUSH_TIMEOUT_MS,
    );
  } catch (err) {
    throw new HandoffGitError("handoff_push_failed", stderrOf(err));
  }
  return { committed, headCommit };
}

/** Why a session cannot move right now; nothing was touched. */
export type HandoffRefusalCode =
  "not_found" | "move_no_branch" | "move_merging" | "move_unsupported_kind" | "handoff_in_progress";

export class HandoffRefusedError extends Error {
  constructor(public readonly code: HandoffRefusalCode) {
    super(`session cannot move: ${code}`);
    this.name = "HandoffRefusedError";
  }
}

/** What the source hands the coordinator once its work is pushed: the branch to continue and the
 *  task as the target recreates it. `files` are worktree-relative paths to carry along. */
export interface HandoffSource {
  branch: string;
  headCommit: string;
  committed: boolean;
  repoPath: string;
  baseBranch: string;
  prompt: string;
  desig: string;
  agentProvider: AgentProvider;
  planGateEnabled: boolean | null;
  autopilotEnabled: boolean | null;
  research: boolean;
  epicAuthoring: boolean;
  plain: boolean;
  amendments: string[];
  files: string[];
}

/** A regular, non-symlink file physically inside the worktree, with the identity it had now. */
function regularInside(worktreePath: string, rel: string) {
  const path = join(worktreePath, rel);
  try {
    const st = lstatSync(path);
    const root = realpathSync(worktreePath) + sep;
    if (!st.isFile() || !realpathSync(path).startsWith(root)) return null;
    return { path, dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/** The worktree files a move carries, worktree-relative: the plan first, then the uploads —
 *  capped like a create's attachments. */
export function handoffFiles(worktreePath: string): string[] {
  const files = regularInside(worktreePath, PLAN_FILE) ? [PLAN_FILE] : [];
  for (const upload of listRegularUploadEntries(worktreePath))
    files.push(relative(worktreePath, upload.path));
  return files.slice(0, MAX_IMAGES);
}

const UPLOADS_PREFIX = ".shepherd-uploads/";

/** `.shepherd-uploads/<name>`: exactly one plain segment below the uploads dir. */
export function isUploadName(rel: string): boolean {
  if (!rel.startsWith(UPLOADS_PREFIX)) return false;
  const name = rel.slice(UPLOADS_PREFIX.length);
  return name.length > 0 && name !== "." && name !== ".." && !/[/\\]/.test(name);
}

/** Copy one carried file (as `handoffFiles` named it) to `dest`, refusing anything that is not a
 *  regular file inside the worktree — the worktree is agent-writable. False when it is not one. */
export function copyHandoffFile(worktreePath: string, rel: string, dest: string): boolean {
  if (rel !== PLAN_FILE && !isUploadName(rel)) return false;
  const file = regularInside(worktreePath, rel);
  if (!file) return false;
  copyRegularFileNoFollow(file, dest);
  return true;
}
