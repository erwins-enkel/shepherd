import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { timedAsync } from "./instrument";
import { shepherdRuntimeDir } from "./runtime-dir";

const execFileAsync = promisify(execFile);

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
  /** classified failure cause, so the UI can route a dirty/stale deploy through the
   *  friendly dirty-repo flow instead of the raw log. `"dirty"` = the working tree
   *  blocked `--pull` (`needs a clean tree`); `"stale"` = the discard's confirmed
   *  signature no longer matched at reset time (`SHEPHERD_DISCARD_STALE`). */
  reason?: "dirty" | "stale" | null;
}

/**
 * Fresh snapshot of the running deployment's *tracked* dirty state, computed on
 * demand (never from the periodic {@link UpdateService.check}). Drives the
 * dirty-repo update flow: the file list the operator confirms, a content-sensitive
 * signature the discard is validated against, and the exact NUL pathspecs the
 * scoped `git restore` runs over.
 */
export interface DirtyStatus {
  /** true when the tracked tree has staged or unstaged changes (what blocks `--pull`) */
  dirty: boolean;
  /** capped, display-formatted `XY path` lines (lossy UTF-8 ok — display only) */
  dirtyFiles: string[];
  /** total number of changed entries, independent of the capped {@link dirtyFiles} */
  dirtyCount: number;
  /** SHA-256 over the framed per-command subhashes (status + both content diffs);
   *  null when the diff was too large / timed out (auto-discard then unavailable) */
  sig: string | null;
  /** raw NUL-joined pathspec bytes for `git restore --staged` — every confirmed
   *  path (both sides of a rename/copy). Server-internal; stripped from the API. */
  pathspecAll: Buffer;
  /** raw NUL-joined pathspec bytes for `git restore --worktree` — only paths that
   *  exist in HEAD (excludes pure adds + the new side of renames/copies, which are
   *  left as untracked so created content is never deleted). Server-internal. */
  pathspecWorktree: Buffer;
}

/** Marker `update.sh` dies with when a discard's confirmed signature no longer
 *  matches the tree at reset time; classified as {@link DeployState.reason} "stale". */
const DISCARD_STALE_MARKER = "SHEPHERD_DISCARD_STALE";
/** Signature the `--pull` clean-tree guard prints; classified as reason "dirty". */
const CLEAN_TREE_MARKER = "needs a clean tree";

/** Classify a failed deploy's log so the UI can route it through the dirty-repo flow. */
function classifyDeployReason(exitCode: number, log: string): "dirty" | "stale" | null {
  if (exitCode === 0) return null;
  if (log.includes(DISCARD_STALE_MARKER)) return "stale";
  if (log.includes(CLEAN_TREE_MARKER)) return "dirty";
  return null;
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

const NUL = 0x00;

/** Split a NUL-separated buffer into field slices (drops a trailing empty field). */
function splitNul(buf: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NUL) {
      fields.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) fields.push(buf.subarray(start));
  return fields;
}

/**
 * Which restore pathspecs a single porcelain entry contributes.
 * `all` → `git restore --staged` (every confirmed path; both sides of a rename/copy).
 * `wt`  → `git restore --worktree` (only paths that exist in HEAD, so pure adds and the
 *          new side of a rename/copy are left as untracked instead of being deleted).
 */
function entrySpecs(
  x: string,
  path: Buffer,
  orig: Buffer | undefined,
): { all: Buffer[]; wt: Buffer[] } {
  if (x === "R" || x === "C") {
    return orig ? { all: [path, orig], wt: [orig] } : { all: [path], wt: [] };
  }
  return { all: [path], wt: x === "A" ? [] : [path] };
}

/**
 * Parse `git status --porcelain -z --untracked-files=no` output (raw bytes) into
 * the display list + the two restore pathspecs, all NUL-safe.
 *
 * Each record is `XY<space>PATH`; a rename/copy (X ∈ {R,C}) is followed by an
 * extra NUL field carrying the ORIGinal path. Path bytes are taken **verbatim**
 * (never decoded) for the pathspecs, so non-UTF-8 paths still match under
 * `git restore --pathspec-from-file --pathspec-file-nul`; only the capped display
 * strings are decoded (lossy is fine — they're never used to match).
 *
 * `pathspecWorktree` excludes paths that don't exist in HEAD (pure adds and the new
 * side of a rename/copy) so `git restore --worktree` never tries — and can't be
 * asked — to delete them; they're left as untracked, preserving created content.
 */
function parsePorcelain(
  buf: Buffer,
  limit: number,
): { dirtyFiles: string[]; dirtyCount: number; pathspecAll: Buffer; pathspecWorktree: Buffer } {
  const fields = splitNul(buf);
  const dirtyFiles: string[] = [];
  const allParts: Buffer[] = [];
  const wtParts: Buffer[] = [];
  const sep = Buffer.from([NUL]);
  const push = (parts: Buffer[], paths: Buffer[]) => {
    for (const p of paths) parts.push(p, sep);
  };

  let dirtyCount = 0;
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    if (!rec || rec.length < 3) {
      i++;
      continue; // malformed / empty — skip
    }
    const x = String.fromCharCode(rec[0]!);
    const path = rec.subarray(3); // skip "XY "
    const orig = x === "R" || x === "C" ? fields[i + 1] : undefined;
    i += orig ? 2 : 1;

    dirtyCount++;
    if (dirtyFiles.length < limit)
      dirtyFiles.push(`${rec.subarray(0, 2).toString("latin1")} ${path.toString("utf8")}`);

    const { all, wt } = entrySpecs(x, path, orig);
    push(allParts, all);
    push(wtParts, wt);
  }

  return {
    dirtyFiles,
    dirtyCount,
    pathspecAll: Buffer.concat(allParts),
    pathspecWorktree: Buffer.concat(wtParts),
  };
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
export type GitRunner = (args: string[]) => Promise<string>;

/** Runs git and returns raw stdout **bytes** (no UTF-8 decode), so a signature or
 *  pathspec built from it is byte-exact even for non-UTF-8 paths. Injectable. */
export type GitRawRunner = (args: string[]) => Promise<Buffer>;

/** Streams a git command's stdout chunk-by-chunk into `hash` (never buffering the
 *  whole output — so a huge `git diff --binary` can't overflow memory), returning
 *  the byte count streamed. Must throw if it streamed more than `limit.maxBytes`
 *  before completing or ran past `limit.timeoutMs`. Injectable for tests. */
export type GitHashStreamer = (
  args: string[],
  hash: Hash,
  limit: { maxBytes: number; timeoutMs: number },
) => Promise<number>;

/** Discard args passed through {@link UpdateService.apply} to the deploy launch. */
export interface DiscardLaunch {
  /** confirmed content signature the script re-verifies before restoring */
  sig: string;
  /** private temp dir holding the two pathspec files (script `trap`s its removal) */
  dir: string;
  /** file of NUL-joined pathspec bytes for `git restore --staged` */
  pathspecAllFile: string;
  /** file of NUL-joined pathspec bytes for `git restore --worktree` */
  pathspecWtFile: string;
}

export interface UpdateDeps {
  /** repo to check; defaults to the service working dir (the live deployment) */
  repoDir?: string;
  /** branch to track on origin; defaults to "main" */
  branch?: string;
  /** path to the deploy script run on apply */
  scriptPath?: string;
  /** where the detached deploy streams its output; defaults to a fixed file under the
   *  user-private runtime dir ({@link shepherdRuntimeDir}, `0700`), shared across restarts
   *  so a freshly booted shepherd can still read a deploy result */
  logPath?: string;
  /** inject point for tests; defaults to real `git -C <repoDir> …` */
  git?: GitRunner;
  /** inject point for tests; defaults to real `git -C <repoDir> …` returning bytes */
  gitRaw?: GitRawRunner;
  /** inject point for tests; defaults to streaming `git -C <repoDir> …` into a hash */
  gitHashStream?: GitHashStreamer;
  /** inject point for tests; defaults to launching the deploy script detached */
  launch?: (discard?: DiscardLaunch) => void;
  /** cap the commit list shown in the UI */
  limit?: number;
  /** cap the total signature bytes hashed before falling back to sig:null */
  sigMaxBytes?: number;
  /** timeout for the whole signature computation before falling back to sig:null */
  sigTimeoutMs?: number;
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
  private gitRaw: GitRawRunner;
  private gitHashStream: GitHashStreamer;
  private launch: (discard?: DiscardLaunch) => void;
  private limit: number;
  private sigMaxBytes: number;
  private sigTimeoutMs: number;
  private last: UpdateStatus | null = null;
  private applying = false;

  constructor(deps: UpdateDeps = {}) {
    this.repoDir = deps.repoDir ?? process.cwd();
    this.branch = deps.branch ?? "main";
    this.scriptPath = deps.scriptPath ?? join(this.repoDir, "deploy", "update.sh");
    this.logPath = deps.logPath ?? shepherdRuntimeDir("shepherd-update.log");
    this.limit = deps.limit ?? 20;
    this.sigMaxBytes = deps.sigMaxBytes ?? 64 * 1024 * 1024;
    this.sigTimeoutMs = deps.sigTimeoutMs ?? 10_000;
    this.git =
      deps.git ??
      (async (args) => {
        const { stdout } = await timedAsync(`git ${args[0] ?? ""}`, () =>
          execFileAsync("git", ["-C", this.repoDir, ...args], { encoding: "utf8" }),
        );
        return stdout as string;
      });
    this.gitRaw =
      deps.gitRaw ??
      (async (args) => {
        const { stdout } = await execFileAsync("git", ["-C", this.repoDir, ...args], {
          encoding: "buffer",
          maxBuffer: this.sigMaxBytes,
        });
        return stdout as Buffer;
      });
    this.gitHashStream =
      deps.gitHashStream ?? ((args, hash, limit) => this.streamGit(args, hash, limit));
    this.launch = deps.launch ?? ((discard) => this.defaultLaunch(discard));
  }

  /** Default {@link GitHashStreamer}: spawn `git` and pipe stdout into `hash`,
   *  aborting (kill + throw) once the running total exceeds the cap or the timeout
   *  fires — so an enormous `--binary` diff never buffers or hangs the request. */
  private streamGit(
    args: string[],
    hash: Hash,
    limit: { maxBytes: number; timeoutMs: number },
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-C", this.repoDir, ...args], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let streamed = 0;
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          child.kill("SIGKILL");
          reject(err);
        } else {
          resolve(streamed);
        }
      };
      const timer = setTimeout(() => finish(new Error("signature timed out")), limit.timeoutMs);
      child.on("error", (e) => finish(e));
      child.stdout.on("data", (chunk: Buffer) => {
        streamed += chunk.length;
        if (streamed > limit.maxBytes) {
          finish(new Error("signature too large"));
          return;
        }
        hash.update(chunk);
      });
      child.on("close", (code) =>
        code === 0 ? finish() : finish(new Error(`git exited ${code}`)),
      );
    });
  }

  /** Launch the deploy script in its own transient systemd scope so it survives
   *  the `systemctl restart shepherd` it triggers (otherwise the script, being a
   *  child in the service cgroup, would be killed mid-update).
   *
   *  Output is redirected to {@link logPath} and an exit marker is appended once
   *  the script returns, so a failed deploy (which never restarts shepherd) can
   *  be read back and shown to the operator instead of vanishing. Throws if the
   *  unit can't even be registered (e.g. systemd-run missing). */
  private defaultLaunch(discard?: DiscardLaunch): void {
    // The runtime dir ($XDG_RUNTIME_DIR/shepherd or the ~/.shepherd/run fallback) may not
    // exist yet — /tmp always did. Create it before the write, or the deploy never launches.
    mkdirSync(dirname(this.logPath), { recursive: true });
    // truncate up front so the file exists immediately → readState() reports
    // "running" before the scope has had a chance to open it.
    writeFileSync(this.logPath, "");
    // forward our PATH: a transient --user unit gets a bare environment, but the
    // deploy script needs bun/herdr/git/systemctl, which live on the service's PATH.
    const args = ["--user", "--collect", "--unit=shepherd-update"];
    if (process.env.PATH) args.push(`--setenv=PATH=${process.env.PATH}`);
    // A discard forwards the confirmed signature + the private pathspec dir so the
    // script can re-verify the tree and restore ONLY the confirmed paths.
    if (discard) {
      args.push(`--setenv=SHEPHERD_DISCARD_SIG=${discard.sig}`);
      args.push(`--setenv=SHEPHERD_DISCARD_DIR=${discard.dir}`);
      args.push(`--setenv=SHEPHERD_DISCARD_PATHSPEC_ALL=${discard.pathspecAllFile}`);
      args.push(`--setenv=SHEPHERD_DISCARD_PATHSPEC_WT=${discard.pathspecWtFile}`);
    }
    const inner =
      `exec >${shq(this.logPath)} 2>&1; ` +
      `bash ${shq(this.scriptPath)} --pull${discard ? " --discard" : ""}; ` +
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
      // Classify a failed deploy so the UI can route it through the friendly
      // dirty-repo flow (fresh probe + refreshed list) instead of the raw log.
      const reason = classifyDeployReason(exitCode, log);
      return { phase: exitCode === 0 ? "done" : "failed", exitCode, log, reason };
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

  /**
   * Compute a **fresh** snapshot of the running deployment's tracked dirty state.
   * Never cached (the tree changes underfoot), so both the proactive warning and
   * the reactive failure path read the current truth.
   *
   * The `sig` is content-sensitive and framed: each of three git commands
   * (status, staged diff, unstaged diff) is hashed independently, then the three
   * fixed-length hex digests are hashed together — unambiguous, and the heavy
   * `--binary` diffs stream (never buffered). All diff commands neutralise the
   * repo's diff config (`--no-ext-diff --no-textconv`) so `sig` depends only on
   * real content. If the diffs exceed the byte cap or timeout, `sig` is null and
   * the caller must not offer a one-click discard.
   */
  async dirtyStatus(): Promise<DirtyStatus> {
    // status: small + bounded → buffer it raw (bytes, not UTF-8) for parsing AND
    // as the first signature input.
    const statusBuf = await this.gitRaw(["status", "--porcelain", "-z", "--untracked-files=no"]);
    const { dirtyFiles, dirtyCount, pathspecAll, pathspecWorktree } = parsePorcelain(
      statusBuf,
      this.limit,
    );
    const dirty = dirtyCount > 0;

    let sig: string | null;
    try {
      const hStatus = createHash("sha256").update(statusBuf);
      const hCached = createHash("sha256");
      const hWt = createHash("sha256");
      // shared byte budget across the two streamed diffs (status already counted)
      let remaining = Math.max(0, this.sigMaxBytes - statusBuf.length);
      const cachedArgs = [
        "diff",
        "--cached",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
      ];
      const wtArgs = ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv"];
      remaining -= await this.gitHashStream(cachedArgs, hCached, {
        maxBytes: remaining,
        timeoutMs: this.sigTimeoutMs,
      });
      await this.gitHashStream(wtArgs, hWt, {
        maxBytes: Math.max(0, remaining),
        timeoutMs: this.sigTimeoutMs,
      });
      sig = createHash("sha256")
        .update(hStatus.digest("hex") + hCached.digest("hex") + hWt.digest("hex"))
        .digest("hex");
    } catch {
      // too large / timed out / git error → no signature; discard stays unavailable
      sig = null;
    }

    return { dirty, dirtyFiles, dirtyCount, sig, pathspecAll, pathspecWorktree };
  }

  /** Fetch origin and recompute how far behind the tracked branch we are. On any
   *  git/network failure, returns behind:0 (fail safe → no false update badge). */
  async check(now: number): Promise<UpdateStatus> {
    try {
      const remote = `origin/${this.branch}`;
      await this.git(["fetch", "--quiet", "origin", this.branch]);
      const current = (await this.git(["rev-parse", "--short", "HEAD"])).trim() || null;
      const latest = (await this.git(["rev-parse", "--short", remote])).trim() || null;
      const range = `HEAD..${remote}`;
      const behind = Number((await this.git(["rev-list", "--count", range])).trim()) || 0;
      const commits =
        behind > 0
          ? (await this.git(["log", `--max-count=${this.limit}`, "--format=%h%x09%s", range]))
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
   *  the UI can surface verbatim — never a bare status code.
   *
   *  `opts.discard` forwards the confirmed signature + private pathspec dir so the
   *  deploy runs a scoped `git restore` of only the confirmed paths (see
   *  {@link DiscardLaunch}); throwing propagates so the caller can clean the dir up. */
  apply(opts?: { discard?: boolean } & Partial<DiscardLaunch>): {
    started: boolean;
    error?: string;
  } {
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
    const discard =
      opts?.discard && opts.sig && opts.dir && opts.pathspecAllFile && opts.pathspecWtFile
        ? {
            sig: opts.sig,
            dir: opts.dir,
            pathspecAllFile: opts.pathspecAllFile,
            pathspecWtFile: opts.pathspecWtFile,
          }
        : undefined;
    try {
      this.launch(discard);
    } catch (e) {
      this.applying = false;
      // never launched → the caller (server) removes the private pathspec dir it wrote
      return {
        started: false,
        error: e instanceof Error ? e.message : "could not launch the update",
      };
    }
    return { started: true };
  }
}
