import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { timedAsync } from "../instrument";
import type { SessionStore } from "../store";
import {
  EMPTY_BACKLOG_COUNTS,
  EmptyDiffError,
  type GitForge,
  type Issue,
  type MergeMethod,
  type OpenPrInput,
  type PrStatus,
  type PullRequest,
  type RepoCounts,
} from "./types";

const execFileAsync = promisify(execFile);

/** Per-git-call timeout (ms). Every invocation in this module is bounded — the
 *  ref-writing merge path is NOT exempt (house rule: never label a ref-writing
 *  path read-only/fail-fast). Generous enough for a full off-working-tree squash
 *  + an in-worktree fast-forward checkout on a large repo. Also covers
 *  `merge-tree --write-tree` (the mergeability dry run AND the squash compute):
 *  it is a real 3-way merge that writes a tree, not a trivial metadata read. */
const GIT_TIMEOUT_MS = 60_000;
/** Lighter bound for the trivial metadata reads (rev-parse / status / worktree
 *  list / --version). */
const GIT_READ_TIMEOUT_MS = 15_000;

export const MIN_GIT_MAJOR = 2;
export const MIN_GIT_MINOR = 38;

/** Thrown when the squash would conflict (`git merge-tree --write-tree` exits 1).
 *  A higher exit code is a genuine git error and surfaces as a plain Error instead.
 *  No refs are touched when this is thrown. */
export class MergeConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly base: string,
  ) {
    super(`merge conflict squashing ${branch} into ${base}`);
    this.name = "MergeConflictError";
  }
}

/** Thrown when `base` is checked out in a worktree that is dirty or whose HEAD has
 *  moved off the base tip we computed — advancing it would desync that working tree,
 *  so we abort having moved nothing. */
export class BaseCheckoutBusyError extends Error {
  constructor(readonly base: string) {
    super(
      `base branch '${base}' is checked out in a worktree that is dirty or has moved; ` +
        `commit/clean it (or move off it) before merging`,
    );
    this.name = "BaseCheckoutBusyError";
  }
}

/** An async `git --version` probe; injectable so tests can simulate an old git. */
export type GitVersionProbe = () => Promise<string>;

export interface GitVersion {
  major: number;
  minor: number;
}

/** Parse "git version 2.54.0" → { major: 2, minor: 54 }; null when unparseable. */
export function parseGitVersion(out: string): GitVersion | null {
  const m = /git version (\d+)\.(\d+)/.exec(out);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function gitVersionAtLeast(v: GitVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

const defaultVersionProbe: GitVersionProbe = async () => {
  const { stdout } = await timedAsync("git --version", () =>
    execFileAsync("git", ["--version"], { timeout: GIT_READ_TIMEOUT_MS }),
  );
  return stdout;
};

/** Module-level memoized version (the installed git doesn't change mid-process). */
let cachedVersionOut: string | undefined;

/** Throw a clear, actionable error if git < 2.38 (required for `merge-tree
 *  --write-tree`). Returns the raw version string on success. */
async function assertGitCapable(probe: GitVersionProbe): Promise<string> {
  // Cache only the default probe's result; an injected probe (tests) is honored each call.
  let out: string;
  if (probe === defaultVersionProbe) {
    if (cachedVersionOut === undefined) cachedVersionOut = await probe();
    out = cachedVersionOut;
  } else {
    out = await probe();
  }
  const v = parseGitVersion(out);
  const found = out.trim() || "unknown";
  if (!v || !gitVersionAtLeast(v, MIN_GIT_MAJOR, MIN_GIT_MINOR)) {
    throw new Error(
      `Lightweight repo mode requires git >= ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} ` +
        `(for 'git merge-tree --write-tree'); found ${found}`,
    );
  }
  return out;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a git command in `cwd`, returning code+stdout+stderr WITHOUT throwing on a
 *  non-zero exit (so callers can branch on the exit code — e.g. merge-tree's
 *  conflict signal). A spawn failure (ENOENT etc.) still rejects. */
async function gitRun(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await timedAsync(`git ${args[0]}`, () =>
      execFileAsync("git", args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 }),
    );
    return { code: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
    // execFile sets a numeric `code` on a non-zero exit; a spawn failure has no
    // numeric code (e.g. "ENOENT") → rethrow, it's not a clean non-zero exit.
    if (typeof e.code === "number") {
      return { code: e.code, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    }
    throw err;
  }
}

/** Run git and throw on a non-zero exit (stderr in the message). */
async function gitOrThrow(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const r = await gitRun(cwd, args, timeout);
  if (r.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} → exit ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout.trim();
}

/** Run `git merge-tree --write-tree <base> <branch>`, decoding git's exit codes:
 *  - exit 0   → clean merge; returns the merged tree OID (first line of stdout).
 *  - exit 1   → genuine merge CONFLICT (`{ conflict: true }`).
 *  - exit >1  → a real git failure (bad object, missing ref, etc.) → THROWS with
 *               stderr, so a genuine error is never misreported as a merge conflict.
 *  Shared by the merge path and the mergeability dry run. */
export async function mergeTreeWriteTree(
  repoPath: string,
  base: string,
  branch: string,
): Promise<{ conflict: boolean; tree?: string }> {
  const r = await gitRun(repoPath, ["merge-tree", "--write-tree", base, branch]);
  if (r.code === 0) return { conflict: false, tree: r.stdout.split("\n")[0]?.trim() };
  if (r.code === 1) return { conflict: true };
  throw new Error(
    `git merge-tree --write-tree ${base} ${branch} → exit ${r.code}: ` +
      `${r.stderr.trim() || r.stdout.trim()}`,
  );
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string; // short name (refs/heads/ stripped)
  detached: boolean;
  /** worktree is locked (`git worktree lock`); its record can't be pruned. */
  locked: boolean;
  /** the main worktree of a bare-ish checkout (`bare` line). */
  bare: boolean;
  /** git considers the record prunable (its working dir is gone / broken). */
  prunable: boolean;
}

/** Apply one non-`worktree` porcelain line to the current entry.
 *
 *  `locked`/`prunable` MUST be prefix-matched: git emits a bare `locked` /
 *  `prunable` line when no reason is present, but `locked <reason>` /
 *  `prunable <reason>` when one is. An exact match (as for `detached`/`bare`,
 *  which never carry a reason) would silently drop the flag on the
 *  reason-carrying form — and a dropped `locked`/`prunable` is exactly the
 *  worktree whose dangling record cannot be pruned, so a reaper must never
 *  treat it as reapable. */
function applyWorktreeAttr(cur: WorktreeEntry, line: string): void {
  if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length);
  else if (line.startsWith("branch "))
    cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
  else if (line === "detached") cur.detached = true;
  else if (line === "bare") cur.bare = true;
  else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
  else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
}

/** Parse `git worktree list --porcelain` into structured entries. Blocks are
 *  separated by blank lines; lines are `worktree <path>`, `HEAD <sha>`,
 *  `branch refs/heads/<name>`, `detached`, `bare`, `locked [<reason>]`, or
 *  `prunable [<reason>]` (per-line handling in `applyWorktreeAttr`). */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = {
        path: line.slice("worktree ".length),
        detached: false,
        locked: false,
        bare: false,
        prunable: false,
      };
    } else if (cur) {
      applyWorktreeAttr(cur, line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Off-working-tree squash-merge of `branch` into `base` in `repoPath`, with NO
 * checkout of the base in the primary worktree required.
 *
 * ORDER IS LOAD-BEARING — the shared base ref is moved only AFTER the
 * base-checkout strategy is decided, and ONLY ONE of the three strategies runs:
 *
 *  - base checked out in a worktree, clean, HEAD === baseTip → advance it via
 *    `git -C <wt> merge --ff-only <newCommit>` (ref + index + files atomically;
 *    no bare update-ref, no desync). This is the headline case.
 *  - base checked out but dirty, or its HEAD !== baseTip → throw
 *    BaseCheckoutBusyError having moved NOTHING.
 *  - base checked out nowhere → `git update-ref refs/heads/<base> <newCommit>
 *    <baseTip>` (3-arg compare-and-swap; a stale baseTip lets it throw).
 *
 * A conflict (merge-tree non-zero) throws MergeConflictError before any ref moves.
 */
export async function squashMergeLocal(
  repoPath: string,
  branch: string,
  base: string,
  versionProbe: GitVersionProbe = defaultVersionProbe,
): Promise<void> {
  // 1. Capability guard — git >= 2.38 for `merge-tree --write-tree`.
  await assertGitCapable(versionProbe);

  // 2. Snapshot the base tip (compare-and-swap anchor; nothing moved yet).
  const baseTip = await gitOrThrow(
    repoPath,
    ["rev-parse", "--verify", `refs/heads/${base}`],
    GIT_READ_TIMEOUT_MS,
  );

  // 3. Compute the merged tree off the working tree. Exit 1 ⇒ a real conflict;
  //    exit >1 ⇒ a genuine git failure (surfaced by mergeTreeWriteTree, NOT
  //    misreported as a conflict). NO refs touched either way.
  const mt = await mergeTreeWriteTree(repoPath, base, branch);
  if (mt.conflict) throw new MergeConflictError(branch, base);
  const tree = mt.tree;
  if (!tree) {
    throw new Error(`git merge-tree produced no tree OID for ${branch} into ${base}`);
  }

  // 4. Deterministic squash commit message: subject = branch, body = the squashed
  //    commit subjects (base..branch), oldest-first.
  const subjects = (
    await gitOrThrow(repoPath, ["log", "--reverse", "--format=%s", `${base}..${branch}`])
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const message =
    subjects.length > 0 ? `${branch}\n\n${subjects.map((s) => `* ${s}`).join("\n")}` : branch;

  // 5. Build the squash commit (single parent = base tip). STILL no refs moved.
  const newCommit = await gitOrThrow(repoPath, ["commit-tree", tree, "-p", baseTip, "-m", message]);

  // 6. Decide the base-checkout strategy, then move the ref EXACTLY ONCE.
  const worktrees = parseWorktrees(
    await gitOrThrow(repoPath, ["worktree", "list", "--porcelain"], GIT_READ_TIMEOUT_MS),
  );
  const baseWt = worktrees.find((w) => w.branch === base);

  if (baseWt) {
    // base is checked out somewhere — never bare-update a checked-out ref.
    const dirty = (await gitOrThrow(baseWt.path, ["status", "--porcelain"], GIT_READ_TIMEOUT_MS))
      .length;
    if (dirty > 0 || baseWt.head !== baseTip) {
      throw new BaseCheckoutBusyError(base); // nothing moved yet
    }
    // clean + at baseTip → advance ref + index + files atomically.
    await gitOrThrow(baseWt.path, ["merge", "--ff-only", newCommit]);
  } else {
    // checked out nowhere → compare-and-swap; a stale baseTip makes this throw.
    await gitOrThrow(repoPath, ["update-ref", `refs/heads/${base}`, newCommit, baseTip]);
  }

  // 7. Branch cleanup hook: point the (about-to-be-removed) task branch at the
  //    squash commit so the ancestry-gated pruneMergedBranch deletes it later.
  //    update-ref does NOT refuse a branch checked out in another worktree.
  const branchRef = await gitRun(
    repoPath,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    GIT_READ_TIMEOUT_MS,
  );
  if (branchRef.code === 0) {
    await gitOrThrow(repoPath, ["update-ref", `refs/heads/${branch}`, newCommit]);
  }
}

/** Local-only forge (#807, lightweight repo mode): drives a repo with local git
 *  only — no remote, no `gh`. Completion squash-merges the branch into its base
 *  locally. Deliberately implements only the GitForge methods that make sense
 *  without a host; every optional method is OMITTED so forge-only features
 *  (drain claims, epics, standalone critic, fork UI, deploy) self-disable. */
export class LocalForge implements GitForge {
  readonly kind = "local" as const;
  readonly slug = null;
  readonly mergeMethod: MergeMethod = "squash";
  readonly deployWorkflow = null;
  readonly webUrl = null;
  readonly isLightweight = true;

  constructor(
    readonly repoPath: string,
    private readonly store: Pick<
      SessionStore,
      "ensureLocalPr" | "getLocalPr" | "getLocalPrByNumber" | "markLocalPrMerged"
    >,
    private readonly versionProbe: GitVersionProbe = defaultVersionProbe,
  ) {}

  async listIssues(): Promise<Issue[]> {
    return [];
  }

  async listPullRequests(): Promise<PullRequest[]> {
    return [];
  }

  /** No remote backlog surface — the overview shows blank counts for lightweight repos.
   *  (CountsService never resolves a LocalForge, so this is belt-and-suspenders.) */
  async listBacklogCounts(): Promise<RepoCounts> {
    return EMPTY_BACKLOG_COUNTS;
  }

  async defaultBranch(): Promise<string> {
    try {
      return (
        (
          await gitOrThrow(this.repoPath, ["symbolic-ref", "--short", "HEAD"], GIT_READ_TIMEOUT_MS)
        ).trim() || "main"
      );
    } catch {
      return "main";
    }
  }

  /** Tip sha of a local branch, or undefined when the branch is gone. */
  private async tipOf(branch: string): Promise<string | undefined> {
    const r = await gitRun(
      this.repoPath,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      GIT_READ_TIMEOUT_MS,
    );
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  /** Cleanly-mergeable dry run via `git merge-tree --write-tree`: exit 0 ⇒ true.
   *  Goes through the capability guard so an old git surfaces the guard error
   *  rather than a silently-wrong boolean. */
  private async dryRunMergeable(branch: string, base: string): Promise<boolean> {
    await assertGitCapable(this.versionProbe);
    // Exit 1 ⇒ conflict (not mergeable); exit >1 ⇒ a genuine git error, which
    // mergeTreeWriteTree throws (the poller keeps its last value) rather than
    // silently reporting a wrong `mergeable: false`.
    return !(await mergeTreeWriteTree(this.repoPath, base, branch)).conflict;
  }

  async prStatus(headBranch: string): Promise<PrStatus> {
    const row = this.store.getLocalPr(this.repoPath, headBranch);
    if (!row) return { state: "none", checks: "none", deployConfigured: false };
    if (row.state === "merged") {
      return {
        state: "merged",
        number: row.number,
        checks: "success",
        deployConfigured: false,
      };
    }
    // open
    return {
      state: "open",
      number: row.number,
      checks: "success",
      mergeable: await this.dryRunMergeable(headBranch, row.base),
      headSha: await this.tipOf(headBranch),
      createdAt: row.createdAt,
      deployConfigured: false,
    };
  }

  async openPr(o: OpenPrInput): Promise<PrStatus> {
    // No commits ahead of base ⇒ nothing to open a pseudo-PR for (and a later squash
    // would be an empty commit). Forge-agnostic signal: callers resolve "nothing to land".
    const ahead = await gitOrThrow(
      this.repoPath,
      ["rev-list", "--count", `${o.base}..${o.head}`],
      GIT_READ_TIMEOUT_MS,
    );
    if (Number(ahead) === 0) throw new EmptyDiffError(o.head, o.base);
    const row = this.store.ensureLocalPr(this.repoPath, o.head, o.base);
    return {
      state: "open",
      number: row.number,
      checks: "success",
      mergeable: await this.dryRunMergeable(o.head, row.base),
      headSha: await this.tipOf(o.head),
      createdAt: row.createdAt,
      deployConfigured: false,
    };
  }

  async merge(prNumber: number): Promise<void> {
    const row = this.store.getLocalPrByNumber(prNumber);
    if (!row) throw new Error(`no local PR with number ${prNumber}`);
    await squashMergeLocal(row.repoPath, row.branch, row.base, this.versionProbe);
    this.store.markLocalPrMerged(prNumber);
  }

  async postReview(): Promise<{ url?: string }> {
    // No-op: the verdict is persisted to the `reviews` table and shown in the UI
    // independently of any host review.
    return {};
  }

  async redeploy(): Promise<void> {
    // Unreachable backstop: deployWorkflow is null so the endpoint 400s first.
    throw new Error("redeploy is not supported in lightweight mode");
  }
}
