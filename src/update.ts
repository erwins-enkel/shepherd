import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";

export interface UpdateCommit {
  sha: string;
  subject: string;
}

export interface UpdateStatus {
  /** how many commits the tracked branch is ahead of the running HEAD; 0 = up to date */
  behind: number;
  /** short SHA of the running checkout (HEAD) */
  current: string | null;
  /** short SHA of origin/<branch> after fetch */
  latest: string | null;
  /** the new commits (HEAD..origin/branch), newest first; empty when up to date */
  commits: UpdateCommit[];
  checkedAt: number;
  /** set when the check itself failed (network/git); badge stays hidden on error */
  error?: string;
}

const EMPTY = (now: number): UpdateStatus => ({
  behind: 0,
  current: null,
  latest: null,
  commits: [],
  checkedAt: now,
});

/** Runs git inside a fixed repo dir and returns stdout; injectable for tests. */
export type GitRunner = (args: string[]) => string;

export interface UpdateDeps {
  /** repo to check; defaults to the service working dir (the live deployment) */
  repoDir?: string;
  /** branch to track on origin; defaults to "main" */
  branch?: string;
  /** path to the deploy script run on apply */
  scriptPath?: string;
  /** inject point for tests; defaults to real `git -C <repoDir> …` */
  git?: GitRunner;
  /** inject point for tests; defaults to launching the deploy script detached */
  launch?: () => void;
  /** cap the commit list shown in the UI */
  limit?: number;
}

/**
 * Tracks how far the running checkout is behind origin/<branch> and, on demand,
 * launches the existing deploy script to pull + rebuild + restart the service.
 *
 * The check compares HEAD against origin/<branch> *after* a fetch, so the badge
 * surfaces individual new commits on main — no version tags required.
 */
export class UpdateService {
  private repoDir: string;
  private branch: string;
  private scriptPath: string;
  private git: GitRunner;
  private launch: () => void;
  private limit: number;
  private last: UpdateStatus | null = null;
  private applying = false;

  constructor(deps: UpdateDeps = {}) {
    this.repoDir = deps.repoDir ?? process.cwd();
    this.branch = deps.branch ?? "main";
    this.scriptPath = deps.scriptPath ?? join(this.repoDir, "deploy", "update.sh");
    this.limit = deps.limit ?? 20;
    this.git =
      deps.git ??
      ((args) =>
        execFileSync("git", ["-C", this.repoDir, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }));
    this.launch = deps.launch ?? (() => this.defaultLaunch());
  }

  /** Launch the deploy script in its own transient systemd scope so it survives
   *  the `systemctl restart shepherd` it triggers (otherwise the script, being a
   *  child in the service cgroup, would be killed mid-update). */
  private defaultLaunch(): void {
    // forward our PATH: a transient --user unit gets a bare environment, but the
    // deploy script needs bun/herdr/git/systemctl, which live on the service's PATH.
    const args = ["--user", "--collect", "--unit=shepherd-update"];
    if (process.env.PATH) args.push(`--setenv=PATH=${process.env.PATH}`);
    args.push("bash", this.scriptPath, "--pull");
    const child = spawn("systemd-run", args, { cwd: this.repoDir, stdio: "ignore" });
    child.unref();
  }

  /** Last computed status, or null before the first check. */
  current(): UpdateStatus | null {
    return this.last;
  }

  /** Fetch origin and recompute how far behind the tracked branch we are. On any
   *  git/network failure, returns behind:0 (fail safe → no false update badge). */
  check(now: number): UpdateStatus {
    try {
      const remote = `origin/${this.branch}`;
      this.git(["fetch", "--quiet", "origin", this.branch]);
      const current = this.git(["rev-parse", "--short", "HEAD"]).trim() || null;
      const latest = this.git(["rev-parse", "--short", remote]).trim() || null;
      const range = `HEAD..${remote}`;
      const behind = Number(this.git(["rev-list", "--count", range]).trim()) || 0;
      const commits =
        behind > 0
          ? this.git(["log", `--max-count=${this.limit}`, "--format=%h%x09%s", range])
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const tab = line.indexOf("\t");
                return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
              })
          : [];
      this.last = { behind, current, latest, commits, checkedAt: now };
    } catch (e) {
      this.last = {
        ...EMPTY(now),
        current: this.last?.current ?? null,
        error: e instanceof Error ? e.message : "git error",
      };
    }
    return this.last;
  }

  /** Kick off the detached deploy script. Guards against double-launch within a
   *  single process lifetime; returns whether it actually started. */
  apply(): { started: boolean } {
    if (this.applying) return { started: false };
    this.applying = true;
    this.launch();
    return { started: true };
  }
}
