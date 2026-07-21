import { promises as fsp, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Centralizes the "claude tmp directory" geometry and a threshold-gated inode-guard
 * sweep. Claude Code points spawned agents at `TMPDIR=/tmp/claude-$uid`; Node's V8
 * compile cache (`$TMPDIR/node-compile-cache`) and per-session scratch accumulate
 * unbounded there and exhaust the tmpfs *inodes* (ENOSPC with bytes to spare).
 *
 * The proven operator fix is `rm -rf /tmp/claude-$uid/node-compile-cache` (inode use
 * ~88%→16%); this module automates that plus age-gated removal of known regenerable tool
 * caches, but only once inode use crosses a threshold — so a healthy tmpfs is never
 * disturbed, and a live session's per-session scratch is never wholesale-removed.
 *
 * The server runs on a single Bun event loop, so EVERYTHING here is async `fs/promises`:
 * a sync stat/rm on the loop freezes the live web terminal.
 */

/** Process uid, derived at call time (1000 fallback when getuid is absent, e.g. Windows). */
const uid = (): number => process.getuid?.() ?? 1000;

/** A worktree cwd → the dash-encoded directory name a nested claude derives for it. */
const dashify = (p: string): string => p.replace(/[/.]/g, "-");

/**
 * Parse a numeric env override, honoring a legitimate `0` (unlike `Number(x) || d`, which
 * coerces a configured `0` back to the default). Empty/whitespace/non-finite → the fallback.
 */
const envNum = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The claude tmp root for this user. Read from env at call time so tests and operators
 * can redirect it; falls back to the conventional `<tmpdir>/claude-$uid`.
 */
function claudeTmpRoot(): string {
  return (
    process.env.SHEPHERD_TMP_SWEEP_DIR ??
    process.env.CLAUDE_CODE_TMPDIR ??
    join(tmpdir(), `claude-${uid()}`)
  );
}

/**
 * Disk-backed compile-cache dir (deliberately OFF tmpfs). Other code sets
 * `NODE_COMPILE_CACHE` to this on spawns so the cache stops eating tmpfs inodes.
 */
export function compileCacheDir(): string {
  return (
    process.env.SHEPHERD_NODE_COMPILE_CACHE ??
    join(homedir(), ".cache", "shepherd", "node-compile-cache")
  );
}

/**
 * The per-session scratch dir a NESTED claude derives for a given worktree cwd:
 * `<claudeTmpRoot>/claude-$uid/<dashified-worktree-path>`. The doubled `claude-$uid`
 * is real — our spawned agents inherit TMPDIR and re-derive their own claude root under it.
 */
export function worktreeScratchDir(worktreePath: string): string {
  return join(claudeTmpRoot(), `claude-${uid()}`, dashify(worktreePath));
}

/**
 * The per-session SCRATCHPAD dir for a Shepherd session's OWN (top-level) claude agent:
 * `<claudeTmpRoot>/<dashified-worktree>/<claudeSessionId>/scratchpad`.
 *
 * DISTINCT from `worktreeScratchDir` above: that helper models the doubled `claude-$uid` base
 * a NESTED sub-agent derives (those dirs hold `<uuid>/tasks`, never a `scratchpad`). A session's
 * own artifacts live under the SINGLE base, keyed by the claude session UUID. The issue (#1164)
 * originally said to reuse `worktreeScratchDir` — that is the wrong base; verified empirically
 * against the live tmp tree (the server runs with no TMPDIR override, so `claudeTmpRoot()` here
 * matches the agent's). Reuses the same `claudeTmpRoot()` + `dashify()` primitives, dropping the
 * nested `claude-$uid` segment and appending the session-scoped tail.
 */
export function sessionScratchpadDir(worktreePath: string, claudeSessionId: string): string {
  return join(claudeTmpRoot(), dashify(worktreePath), claudeSessionId, "scratchpad");
}

/**
 * Shallow, async, non-throwing "does this session's scratchpad hold any entry?" probe — the
 * cheap signal that gates the UI's Files tab (#1164). Counts ANY entry (files OR subdirs,
 * dotfiles included). Returns false on a blank `claudeSessionId` (pre-`--session-id` session /
 * agent not yet started), a missing dir, or any read error. Single shallow `readdir`.
 */
export async function scratchpadHasFiles(
  worktreePath: string,
  claudeSessionId: string,
): Promise<boolean> {
  if (!claudeSessionId) return false;
  try {
    const entries = await fsp.readdir(sessionScratchpadDir(worktreePath, claudeSessionId));
    return entries.length > 0;
  } catch {
    return false;
  }
}

export interface SweepResult {
  swept: boolean;
  reason: string;
  removed: number;
}

interface FsOps {
  statfs: typeof fsp.statfs;
  readdir: typeof fsp.readdir;
  stat: typeof fsp.stat;
  rm: typeof fsp.rm;
}

interface SweepOpts {
  root?: string;
  thresholdPct?: number;
  staleMs?: number;
  now?: number;
  fsOps?: FsOps;
  log?: (msg: string) => void;
}

/** Resolved options for one sweep run, threaded through the internal helpers. */
interface SweepCtx {
  ops: FsOps;
  now: number;
  staleMs: number;
  nestedName: string;
  log: (msg: string) => void;
}

/**
 * Resolves the fail-open inode gate. Returns the numeric inode use% when readable, or a
 * string skip-reason when the guard cannot read inode pressure:
 *  - `"statfs-unavailable"` — `statfs` is not a function, or reports non-finite `files`/`ffree`
 *    or `files <= 0` (an unusable count).
 *  - `"root-missing"` — `statfs(root)` throws (root absent / unstatfs-able).
 */
async function inodeUsePct(
  root: string,
  statfs: FsOps["statfs"],
  log: (msg: string) => void,
): Promise<number | string> {
  // Fail-open: without a usable statfs we cannot read inode pressure, so do nothing.
  if (typeof statfs !== "function") {
    log("[tmp-sweep] statfs unavailable — skipping inode guard");
    return "statfs-unavailable";
  }

  let stats: Awaited<ReturnType<typeof fsp.statfs>>;
  try {
    stats = await statfs(root);
  } catch {
    // Root absent / unstatfs-able — nothing to guard.
    return "root-missing";
  }

  const files = Number((stats as { files?: unknown }).files);
  const ffree = Number((stats as { ffree?: unknown }).ffree);
  if (!Number.isFinite(files) || !Number.isFinite(ffree) || files <= 0) {
    return "statfs-unavailable";
  }
  return (1 - ffree / files) * 100;
}

/**
 * Inode-use% band above which the `tmp_inodes` diagnostics row reports `error` rather than
 * `warning`. Lives here, beside the `SHEPHERD_TMP_INODE_PCT` read that drives both the sweep gate
 * and that row's WARNING band, so one module owns both thresholds (#1862).
 */
export const TMP_INODE_ERROR_PCT = 95;

/**
 * The sweep threshold, resolved the same way `sweepClaudeTmp` resolves it. Exported so the
 * `tmp_inodes` diagnostics row warns at exactly the point the sweeper starts acting: hardcoding 80
 * there would warn about a state an operator who raised `SHEPHERD_TMP_INODE_PCT` deliberately told
 * the sweeper to ignore, and would contradict the documented meaning of the knob.
 */
export function tmpInodeWarnPct(): number {
  return envNum(process.env.SHEPHERD_TMP_INODE_PCT, 80);
}

/**
 * Inode use% of the temp filesystem, or `null` when it cannot be determined.
 *
 * Deliberately statfs's `tmpdir()` rather than `claudeTmpRoot()`: the latter is
 * `<tmpdir>/claude-$uid`, which does not exist on a freshly booted host, and `inodeUsePct`'s
 * `root-missing` branch would then report "uninspectable" on exactly the hosts that still have
 * headroom worth protecting. `tmpdir()` is the filesystem actually at risk and is always present.
 *
 * NOTE this is not necessarily `/tmp` — `os.tmpdir()` honours the SERVER process's own `TMPDIR`.
 * User-facing copy driven by this value must therefore say "the temporary filesystem", never a
 * hardcoded path. `null` covers both `inodeUsePct` skip-reasons, notably a btrfs tmp reporting
 * `files: 0` (it allocates inodes dynamically, so a percentage is meaningless there).
 */
export async function readTmpInodeUsePct(
  statfs: FsOps["statfs"] = fsp.statfs,
): Promise<number | null> {
  const pct = await inodeUsePct(tmpdir(), statfs, () => {});
  return typeof pct === "number" ? pct : null;
}

/**
 * Entry names this sweep is willing to age-gate-remove: regenerable tool caches that hold NO
 * live session working state (Bun's bunx cache, fallow's audit base cache, agent-browser's
 * Chrome profiles). Per-session scratch — the dashified `-home-…` worktree dirs and their
 * session-id subdirs — is deliberately EXCLUDED: a still-running session leaves a stale
 * TOP-LEVEL mtime because it only writes into subdirs, so a coarse mtime check would let this
 * best-effort sweep `rm -rf` a live agent's scratch out from under it. Those dirs are reclaimed
 * precisely by `removeWorktreeScratch` on archival, when the session is known to be finished.
 */
const REGENERABLE_CACHE = /^(bunx-|fallow-|agent-browser-)/;

/**
 * Name prefix for fallow's audit-base worktree caches: `fallow-audit-base-cache-<srcHash>-<shaHash>`.
 * Each `git worktree prune` pre-push creates one; they accumulate until reaped.
 */
export const FALLOW_CACHE_PREFIX = "fallow-audit-base-cache-";

/**
 * Shared helper: age-gate a single known-regenerable-cache dir by its own top-level mtime and
 * `rm -rf` it if stale. Returns 1 if removed, 0 if kept. Fail-closed: a stat or rm failure is
 * logged and counted as 0 (never miscounted as success). Does NOT remove sidecar files — callers
 * that need sidecar cleanup (e.g. `reapFallowCaches`) must do so themselves.
 */
async function removeIfStale(
  p: string,
  st: { mtimeMs: number | bigint },
  ctx: Pick<SweepCtx, "now" | "staleMs" | "log"> & { ops: Pick<FsOps, "rm"> },
): Promise<number> {
  // Deliberately the top-level entry's own mtime, not a recursive
  // newest-descendant walk — don't "fix" this into a sync/expensive tree traversal.
  if (ctx.now - Number(st.mtimeMs) > ctx.staleMs) {
    try {
      await ctx.ops.rm(p, { recursive: true, force: true });
      return 1;
    } catch (err) {
      ctx.log(`[tmp-sweep] failed to remove ${p}: ${String(err)}`);
      return 0;
    }
  }
  return 0;
}

/**
 * Handles ONE directory entry, returning the count removed (0 or 1). Fail-closed per-entry:
 * its own try/catch surfaces a removal failure in the log and continues, so a bad entry NEVER
 * aborts the sweep and is never miscounted as success. The cases:
 *  - `node-compile-cache` — pure V8 compile cache, dropped wholesale regardless of age.
 *  - the nested `claude-$uid` root — never wholesale-removed (its children are swept when it is
 *    itself the sweep root); skipped here.
 *  - a known regenerable cache (see `REGENERABLE_CACHE`) — age-gated by its top-level mtime via
 *    `removeIfStale`.
 *  - anything else (per-session/unknown scratch) — LEFT in place; never wholesale-removed by
 *    this sweep (reclaimed via `removeWorktreeScratch` on archival instead).
 */
async function sweepEntry(dir: string, ent: Dirent, ctx: SweepCtx): Promise<number> {
  const p = join(dir, ent.name);
  try {
    if (ent.name === "node-compile-cache") {
      await ctx.ops.rm(p, { recursive: true, force: true });
      return 1;
    }
    if (ent.name === ctx.nestedName) return 0;
    // Only known regenerable caches are eligible for age-gated removal; everything else
    // (live/orphaned session scratch, unrecognized dirs) is left untouched by the sweep.
    if (!REGENERABLE_CACHE.test(ent.name)) return 0;

    const st = await ctx.ops.stat(p);
    return removeIfStale(p, st, ctx);
  } catch (err) {
    // Fail-closed per-entry: a stat or wholesale-rm failure is surfaced in the log and
    // skipped — it NEVER aborts the sweep and is never miscounted as success.
    ctx.log(`[tmp-sweep] failed to remove ${p}: ${String(err)}`);
    return 0;
  }
}

/** Sweep one directory: readdir (skip a missing/unreadable dir) then sum sweepEntry over it. */
async function sweepDir(dir: string, ctx: SweepCtx): Promise<number> {
  let entries: Dirent[];
  try {
    entries = (await ctx.ops.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    // Missing/unreadable dir (e.g. no nested claude root yet) — skip it.
    return 0;
  }
  let removed = 0;
  for (const ent of entries) removed += await sweepEntry(dir, ent, ctx);
  return removed;
}

/**
 * Threshold-gated inode guard. TOTAL by contract: it NEVER throws or rejects — any
 * unexpected error resolves to `{ swept:false, reason:"error", removed:0 }` after logging,
 * so a caller can fire-and-forget it on a timer without a guard.
 *
 * `thresholdPct <= 0` FORCES a sweep: the gate is skipped entirely (no `statfs` call), so neither
 * `inodeUsePct` failure reason can silently suppress an explicitly-requested sweep. That path
 * reports `reason: "swept forced (gate bypassed)"` — there is no measured use% to quote.
 *
 * Otherwise only sweeps once inode use ≥ `thresholdPct`; below that it removes NOTHING. When it does
 * sweep, it walks `root` and the nested `root/claude-$uid`, removing `node-compile-cache`
 * wholesale (pure cache) and age-gating known regenerable tool caches (see `REGENERABLE_CACHE`),
 * while LEAVING per-session/unknown scratch in place, the nested scratch dir itself (its
 * children are swept when it is the sweep root), and every root dir itself. Age-gating is
 * evaluated at stat time: an entry that looks fresh by mtime is kept. This is a best-effort age
 * check, not a TOCTOU-atomic guarantee — a writer touching an entry between our stat and rm is
 * not fenced out.
 */
export async function sweepClaudeTmp(opts?: SweepOpts): Promise<SweepResult> {
  const log = opts?.log ?? console.warn;
  try {
    const root = opts?.root ?? claudeTmpRoot();
    const thresholdPct = opts?.thresholdPct ?? envNum(process.env.SHEPHERD_TMP_INODE_PCT, 80);
    const staleMs = opts?.staleMs ?? envNum(process.env.SHEPHERD_TMP_STALE_HOURS, 24) * 3600_000;
    const now = opts?.now ?? Date.now();
    const ops: FsOps = opts?.fsOps ?? {
      statfs: fsp.statfs,
      readdir: fsp.readdir,
      stat: fsp.stat,
      rm: fsp.rm,
    };

    // FORCED sweep (#1862): `thresholdPct <= 0` means "sweep unconditionally" — the operator's
    // one-click Doctor fix passes 0 for exactly that. Without this branch the gate below still
    // bails on BOTH `inodeUsePct` failure reasons ("statfs-unavailable" — including a btrfs tmp
    // reporting `files: 0` — and "root-missing" on a host whose claude root doesn't exist yet),
    // because those return before the threshold is ever compared. The fix would silently do
    // nothing on precisely those hosts. A 0% threshold has no other coherent meaning, so this
    // makes the existing contract explicit; every threshold >= 1 keeps today's fail-open path
    // byte-for-byte. `statfs` is not called at all here, so no use% exists to report — the reason
    // string says so rather than formatting a figure that was never measured.
    let gateReason = "swept forced (gate bypassed)";
    if (thresholdPct > 0) {
      const usePct = await inodeUsePct(root, ops.statfs, log);
      if (typeof usePct === "string") {
        return { swept: false, reason: usePct, removed: 0 };
      }

      if (usePct < thresholdPct) {
        return {
          swept: false,
          reason: `below-threshold ${usePct.toFixed(1)}%`,
          removed: 0,
        };
      }
      gateReason = `swept ${usePct.toFixed(1)}% inode use`;
    }

    const nestedName = `claude-${uid()}`;
    const ctx: SweepCtx = { ops, now, staleMs, nestedName, log };
    const sweepRoots = [root, join(root, nestedName)];

    let removed = 0;
    for (const dir of sweepRoots) removed += await sweepDir(dir, ctx);

    return {
      swept: true,
      reason: gateReason,
      removed,
    };
  } catch (err) {
    log(`[tmp-sweep] unexpected error: ${String(err)}`);
    return { swept: false, reason: "error", removed: 0 };
  }
}

/**
 * Best-effort targeted teardown of one worktree's scratch dir (e.g. on session retire).
 * No-op when absent (`force:true`), swallows every error — never throws.
 */
export async function removeWorktreeScratch(
  worktreePath: string,
  opts?: { dir?: string; rm?: typeof fsp.rm },
): Promise<void> {
  const dir = opts?.dir ?? worktreeScratchDir(worktreePath);
  const rm = opts?.rm ?? fsp.rm;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

interface ReapFallowOpts {
  staleMs?: number;
  now?: number;
  fsOps?: Pick<FsOps, "readdir" | "stat" | "rm">;
  log?: (msg: string) => void;
  /**
   * Overrides the directories scanned (default: computed `[claudeTmpRoot(), claude-$uid subdir,
   * tmpdir()]` set). Lets a test isolate the scan to a controlled root so the bare-`/tmp` scan
   * can't pull in a concurrent process's caches. Reference #817.
   */
  roots?: string[];
}

export interface ReapFallowResult {
  removed: number;
}

/** Shared context threaded through the fallow reaper helpers. */
interface ReapFallowCtx {
  ops: Pick<FsOps, "readdir" | "stat" | "rm">;
  now: number;
  staleMs: number;
  log: (msg: string) => void;
}

/**
 * Handles ONE fallow-cache directory entry. Skips sidecar files (`.lock`/`.last-used` —
 * cleaned up alongside their parent) and any name not starting with `FALLOW_CACHE_PREFIX`.
 * For eligible entries: stats the path, age-gates via `removeIfStale`, and on removal
 * best-effort removes `${p}.lock` and `${p}.last-used`. Per-entry try/catch — never
 * aborts the pass, never rejects. Returns 1 if the dir was removed, 0 otherwise.
 */
async function reapFallowEntry(root: string, ent: Dirent, ctx: ReapFallowCtx): Promise<number> {
  // Skip sidecar files (.lock / .last-used) — cleaned up with their parent dir.
  if (!ent.name.startsWith(FALLOW_CACHE_PREFIX)) return 0;
  if (ent.name.endsWith(".lock") || ent.name.endsWith(".last-used")) return 0;

  const p = join(root, ent.name);
  try {
    const st = await ctx.ops.stat(p);
    const wasRemoved = await removeIfStale(p, st, ctx);
    if (wasRemoved) {
      // Best-effort removal of sidecars; ignore individual failures.
      await ctx.ops.rm(`${p}.lock`, { recursive: false, force: true }).catch(() => {});
      await ctx.ops.rm(`${p}.last-used`, { recursive: false, force: true }).catch(() => {});
      return 1;
    }
    return 0;
  } catch (err) {
    ctx.log(`[tmp-sweep] fallow reap failed for ${p}: ${String(err)}`);
    return 0;
  }
}

/**
 * Reaps one root directory: readdirs it (skipping missing/unreadable roots silently) then
 * sums `reapFallowEntry` over every entry. Returns the count of dirs removed.
 */
async function reapFallowRoot(root: string, ctx: ReapFallowCtx): Promise<number> {
  let entries: Dirent[];
  try {
    entries = (await ctx.ops.readdir(root, { withFileTypes: true })) as Dirent[];
  } catch {
    // Missing/unreadable root — skip it silently.
    return 0;
  }
  let removed = 0;
  for (const ent of entries) removed += await reapFallowEntry(root, ent, ctx);
  return removed;
}

/**
 * Ungated reaper for stale `fallow-audit-base-cache-*` worktree cache dirs. Runs regardless of
 * inode pressure — decoupled from the `sweepClaudeTmp` threshold gate.
 *
 * Scans the deduped set of roots `[claudeTmpRoot(), join(claudeTmpRoot(), "claude-"+uid()),
 * tmpdir()]` (the third catches caches whose `TMPDIR` was the bare system `/tmp`). Only considers
 * entries whose name starts with `FALLOW_CACHE_PREFIX`; ignores `.lock`/`.last-used` sidecar
 * files (they are cleaned up alongside their parent dir). For each stale cache dir it removes the
 * dir AND `${dir}.lock` AND `${dir}.last-used`. Per-entry try/catch — never aborts the pass,
 * never rejects. Returns `{ removed }`.
 */
export async function reapFallowCaches(opts?: ReapFallowOpts): Promise<ReapFallowResult> {
  const log = opts?.log ?? console.warn;
  const staleMs = opts?.staleMs ?? envNum(process.env.SHEPHERD_TMP_STALE_HOURS, 24) * 3600_000;
  const now = opts?.now ?? Date.now();
  const ops: Pick<FsOps, "readdir" | "stat" | "rm"> = opts?.fsOps ?? {
    readdir: fsp.readdir,
    stat: fsp.stat,
    rm: fsp.rm,
  };

  // Dedupe roots: claudeTmpRoot(), claude-$uid subdir, and bare tmpdir() for caches whose
  // TMPDIR was the system default. Using a Set so a reconfigured env can't double-scan.
  // opts?.roots overrides the computed set (lets tests isolate from bare /tmp — #817).
  const claudeRoot = claudeTmpRoot();
  const nestedRoot = join(claudeRoot, `claude-${uid()}`);
  const systemTmp = tmpdir();
  const roots = opts?.roots
    ? [...new Set(opts.roots)]
    : [...new Set([claudeRoot, nestedRoot, systemTmp])];

  const ctx: ReapFallowCtx = { ops, now, staleMs, log };
  let removed = 0;
  for (const root of roots) removed += await reapFallowRoot(root, ctx);

  return { removed };
}

interface PruneOpts {
  /** Injectable git-exec hook for tests. Receives the same args as `git -C <repo> worktree prune`. */
  execGit?: (repo: string, args: string[]) => Promise<void>;
  /** Injectable git-repo predicate for tests. Defaults to an async `.git` presence check. */
  isGitRepo?: (repo: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

export interface PruneResult {
  pruned: number;
  failed: number;
}

/**
 * Runs `git worktree prune` for each supplied repo path that is a git repo — prunes every
 * orphaned record (missing working dir) regardless of how the dir vanished (reboot,
 * tmpfiles, manual rm). The caller enumerates *every* work-dir folder (not just git repos),
 * so a non-git folder is skipped silently up front — neither logged nor counted — rather
 * than spawning git and logging its `fatal: not a git repository` as a failure. Per-repo
 * try/catch on the rest: a git repo whose prune truly errors is logged and skipped while the
 * others still run. Never rejects. Returns `{ pruned, failed }`.
 */
export async function pruneRepoWorktrees(
  repoPaths: string[],
  opts?: PruneOpts,
): Promise<PruneResult> {
  const log = opts?.log ?? console.warn;
  const execGit =
    opts?.execGit ?? ((repo: string, args: string[]) => execFileAsync("git", args).then(() => {}));
  const isGitRepo =
    opts?.isGitRepo ??
    ((repo: string) =>
      fsp.access(join(repo, ".git")).then(
        () => true,
        () => false,
      ));

  let pruned = 0;
  let failed = 0;
  for (const repo of repoPaths) {
    // Skip non-git folders silently: the work dir holds plain project folders alongside
    // repos, and pruning those only yields a benign "not a git repository" error.
    if (!(await isGitRepo(repo))) continue;
    try {
      // `--expire=now` makes the immediate-prune intent explicit. A bare `git worktree prune`
      // already defaults to `--expire=TIME_MAX` (prune every orphaned record regardless of age),
      // but `gc.worktreePruneExpire` (default 3.months.ago) governs the prune that automatic
      // `git gc` runs — so being explicit here keeps reaped records (deleted at ~24h) from being
      // misread as subject to that 3-month window.
      await execGit(repo, ["-C", repo, "worktree", "prune", "--expire=now"]);
      pruned += 1;
    } catch (err) {
      log(`[tmp-sweep] git worktree prune failed for ${repo}: ${String(err)}`);
      failed += 1;
    }
  }
  return { pruned, failed };
}
