import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface UpdateCommit {
  sha: string;
  subject: string;
}

/** Live state of the detached deploy launched by {@link UpdateService.apply}. */
export type DeployPhase = "idle" | "running" | "done" | "failed";

export interface DeployState {
  phase: DeployPhase;
  /** exit code of the deploy script once it finished; null while running/idle */
  exitCode: number | null;
  /** tail of the deploy's captured stdout+stderr (ANSI stripped) so the UI can
   *  show *why* a deploy failed instead of a bare status code */
  log: string;
}

/** Marker the launch wrapper appends once the deploy script returns, carrying
 *  its exit code. Lets a surviving (or freshly restarted) shepherd tell a
 *  finished deploy from one still in flight. */
const EXIT_MARKER = "__SHEPHERD_UPDATE_EXIT__";
/** A deploy with no exit marker whose log hasn't been touched for this long is
 *  treated as dead (crashed/killed) so a stuck launch can't block retries. */
const DEPLOY_STALE_MS = 15 * 60_000;

// ESC[…m colour codes; built from the ESC char so no control literal sits in source
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");
const tail = (s: string, max = 6000): string => (s.length > max ? s.slice(s.length - max) : s);
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

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
  /** where the detached deploy streams its output; defaults to a tmp file shared
   *  across restarts so a freshly booted shepherd can still read a deploy result */
  logPath?: string;
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
  private logPath: string;
  private git: GitRunner;
  private launch: () => void;
  private limit: number;
  private last: UpdateStatus | null = null;
  private applying = false;

  constructor(deps: UpdateDeps = {}) {
    this.repoDir = deps.repoDir ?? process.cwd();
    this.branch = deps.branch ?? "main";
    this.scriptPath = deps.scriptPath ?? join(this.repoDir, "deploy", "update.sh");
    this.logPath = deps.logPath ?? join(tmpdir(), "shepherd-update.log");
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
   *  child in the service cgroup, would be killed mid-update).
   *
   *  Output is redirected to {@link logPath} and an exit marker is appended once
   *  the script returns, so a failed deploy (which never restarts shepherd) can
   *  be read back and shown to the operator instead of vanishing. Throws if the
   *  unit can't even be registered (e.g. systemd-run missing). */
  private defaultLaunch(): void {
    // truncate up front so the file exists immediately → readState() reports
    // "running" before the scope has had a chance to open it.
    writeFileSync(this.logPath, "");
    // forward our PATH: a transient --user unit gets a bare environment, but the
    // deploy script needs bun/herdr/git/systemctl, which live on the service's PATH.
    const args = ["--user", "--collect", "--unit=shepherd-update"];
    if (process.env.PATH) args.push(`--setenv=PATH=${process.env.PATH}`);
    const inner =
      `exec >${shq(this.logPath)} 2>&1; ` +
      `bash ${shq(this.scriptPath)} --pull; ` +
      `echo "${EXIT_MARKER}:$?"`;
    args.push("bash", "-c", inner);
    const r = spawnSync("systemd-run", args, {
      cwd: this.repoDir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (r.error) throw new Error(`could not launch the deploy: ${r.error.message}`);
    if (typeof r.status === "number" && r.status !== 0) {
      const stderr = r.stderr?.toString().trim();
      throw new Error(`deploy launcher exited ${r.status}${stderr ? `: ${stderr}` : ""}`);
    }
  }

  /** Read the detached deploy's captured output to classify its state. Fail-safe:
   *  a missing/unreadable log is "idle"; an exit marker decides done/failed; a
   *  marker-less log that's gone quiet past {@link DEPLOY_STALE_MS} is "failed"
   *  (crashed) so a stuck launch can't block future updates forever. */
  applyState(): DeployState {
    let raw: string;
    try {
      raw = readFileSync(this.logPath, "utf8");
    } catch {
      return { phase: "idle", exitCode: null, log: "" };
    }
    const clean = stripAnsi(raw);
    const m = clean.match(new RegExp(`${EXIT_MARKER}:(\\d+)`));
    if (m) {
      const exitCode = Number(m[1]);
      const log = tail(clean.replace(m[0], "").trimEnd());
      return { phase: exitCode === 0 ? "done" : "failed", exitCode, log };
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.logPath).mtimeMs;
    } catch {
      /* keep 0 → treated as stale below only if a log somehow existed */
    }
    if (mtimeMs && Date.now() - mtimeMs > DEPLOY_STALE_MS) {
      return {
        phase: "failed",
        exitCode: null,
        log: `${tail(clean)}\n[deploy timed out — no result]`,
      };
    }
    return { phase: "running", exitCode: null, log: tail(clean) };
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

  /** Kick off the detached deploy script. Guards against double-launch, but
   *  self-heals: once a prior deploy has finished (or crashed), the latch clears
   *  so a failed update can be retried. Returns `started: false` with a reason
   *  the UI can surface verbatim — never a bare status code. */
  apply(): { started: boolean; error?: string } {
    // reconcile the in-process latch with the real deploy result: a terminal
    // deploy (done/failed) means we're free to launch again.
    const phase = this.applyState().phase;
    if (phase === "done" || phase === "failed") this.applying = false;
    if (this.applying || phase === "running") {
      return {
        started: false,
        error: "a deploy is already running — wait for it to finish or check the log",
      };
    }
    this.applying = true;
    try {
      this.launch();
    } catch (e) {
      this.applying = false;
      return {
        started: false,
        error: e instanceof Error ? e.message : "could not launch the update",
      };
    }
    return { started: true };
  }
}
