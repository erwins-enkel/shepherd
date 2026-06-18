import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timedAsync } from "./instrument";

const execFileAsync = promisify(execFile);

// Same refname regex as used in worktree.ts
const REFNAME_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

const FAIL_CLOSED: UpstreamStatus = {
  hasUpstream: false,
  localExists: false,
  upstreamSha: null,
  localSha: null,
  behind: 0,
  ahead: 0,
  diverged: false,
};

export interface UpstreamStatus {
  hasUpstream: boolean; // refs/remotes/origin/<base> resolves (fresh OR pre-existing/stale)
  localExists: boolean; // refs/heads/<base> resolves
  upstreamSha: string | null; // sha of origin/<base> when hasUpstream, else null
  localSha: string | null; // sha of local <base> when localExists, else null
  behind: number; // commits local<base> is behind origin/<base>; 0 when either ref absent
  ahead: number; // commits local<base> is ahead of origin/<base>; 0 when either ref absent
  diverged: boolean; // ahead > 0 && behind > 0
}

export async function upstreamStatus(
  repoPath: string,
  baseBranch: string,
): Promise<UpstreamStatus> {
  // 1. Validate baseBranch — fail-closed immediately, no git calls
  if (!REFNAME_RE.test(baseBranch)) {
    return { ...FAIL_CLOSED };
  }

  // 2. Bounded fetch — best-effort, never throws out of the function.
  // Uses a deterministic per-branch tracking ref (NOT FETCH_HEAD) so concurrent
  // fetches for different bases don't collide.
  // NOTE: The hard-timeout-kill path (SIGKILL after 5s) is exercised operationally,
  // not in unit tests (unit tests use an immediately-failing remote).
  try {
    await timedAsync("git fetch", () =>
      execFileAsync(
        "git",
        [
          "-c",
          "http.lowSpeedLimit=1000",
          "-c",
          "http.lowSpeedTime=5",
          "fetch",
          "origin",
          `+${baseBranch}:refs/remotes/origin/${baseBranch}`,
        ],
        { cwd: repoPath, timeout: 5000, killSignal: "SIGKILL" },
      ),
    );
  } catch {
    // fetch failure is swallowed — offline, timeout/kill, lock contention, no remote;
    // resolution continues against whatever refs already exist locally.
  }

  // 3. Resolve fields independently — do NOT collapse a missing local branch into a global failure.

  // Resolve upstream sha
  let upstreamSha: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}^{commit}`],
      { cwd: repoPath },
    );
    upstreamSha = stdout.trim() || null;
  } catch {
    // hasUpstream = false, upstreamSha = null
  }

  // Resolve local sha
  let localSha: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}^{commit}`],
      { cwd: repoPath },
    );
    localSha = stdout.trim() || null;
  } catch {
    // localExists = false, localSha = null
  }

  // Compute behind/ahead only when both shas resolve
  let behind = 0;
  let ahead = 0;

  if (upstreamSha !== null && localSha !== null) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-list", "--count", `${localSha}..${upstreamSha}`],
        { cwd: repoPath },
      );
      behind = Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      // safe default
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-list", "--count", `${upstreamSha}..${localSha}`],
        { cwd: repoPath },
      );
      ahead = Number.parseInt(stdout.trim(), 10) || 0;
    } catch {
      // safe default
    }
  }

  return {
    hasUpstream: upstreamSha !== null,
    localExists: localSha !== null,
    upstreamSha,
    localSha,
    behind,
    ahead,
    diverged: ahead > 0 && behind > 0,
  };
}
