import { promises as fsp, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  parseWorktrees,
  parseGitVersion,
  gitVersionAtLeast,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
} from "./forge/local";
import { WORKTREE_MARKER, isUnder } from "./process-reaper";

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
 * The disk-backed `TMPDIR` that spawned (trusted) agents are pointed at (#1875), so ALL their temp
 * I/O — the per-session scratch tree, git worktrees, dependency installs, and bare-`$TMPDIR` tool
 * caches (fallow/bunx/agent-browser) — lands on a real filesystem instead of the `/tmp` tmpfs, whose
 * INODE table it otherwise exhausts (ENOSPC with bytes to spare). Default mirrors `compileCacheDir()`'s
 * `~/.cache/shepherd/*` home. Read from env at call time.
 *
 * Returns `null` when the redirect is DISABLED — the operator set `SHEPHERD_AGENT_TMPDIR` to the
 * empty string — restoring the pre-#1875 tmpfs inheritance as a one-env-var rollback (the write
 * traffic this relocates to disk is unmeasured). A non-empty value overrides the default path.
 */
export function agentTmpDir(): string | null {
  const v = process.env.SHEPHERD_AGENT_TMPDIR;
  if (v === "") return null; // explicitly disabled
  return v ?? join(homedir(), ".cache", "shepherd", "tmp");
}

/**
 * The value the SERVER sets as its own `CLAUDE_CODE_TMPDIR` at boot so `claudeTmpRoot()` (and every
 * scratch consumer) follows trusted agents onto the disk `agentTmpDir()`. It is `agentTmpDir()` plus
 * the `claude-$uid` suffix, because `claudeTmpRoot()` treats `CLAUDE_CODE_TMPDIR` as the FINAL root
 * (returns it verbatim). Null when the redirect is disabled.
 *
 * The spawn shim STRIPS `CLAUDE_CODE_TMPDIR` from the agent (`env -u`, see `buildWrappedArgv`): claude
 * honours it as a BASE and appends its OWN `claude-$uid`, so an inherited value would double-suffix the
 * agent's root (`<disk>/claude-$uid/claude-$uid`) and desync it from this server-side read path. Instead
 * the agent re-derives this SAME path from `TMPDIR=agentTmpDir()` alone.
 */
export function agentClaudeTmpRoot(): string | null {
  const base = agentTmpDir();
  return base === null ? null : join(base, `claude-${uid()}`);
}

/**
 * The pre-#1875 claude tmp root on the system tmpfs — `<os.tmpdir()>/claude-$uid`. After the boot
 * override moves `claudeTmpRoot()` to the disk `agentClaudeTmpRoot()`, this is where an ADOPTED
 * (pre-upgrade) session's live agent — which kept its spawn-time `TMPDIR=/tmp` across the deploy —
 * still writes. The dual-read / dual-clean / sweep paths consult it so those sessions are not orphaned.
 * Read at call time.
 */
export function legacyClaudeTmpRoot(): string {
  return join(tmpdir(), `claude-${uid()}`);
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
 * Ordered, DEDUPED nested-scratch-dir candidates for a worktree (#1875 migration). Primary is the
 * live `worktreeScratchDir()` (disk after the boot override); the second is the same doubled
 * `claude-$uid/<dashified>` tail under the legacy tmpfs root, where an ADOPTED pre-upgrade session's
 * live agent still writes. `removeWorktreeScratch` reclaims BOTH on archival — without this the
 * disk-only primary would silently stop reclaiming those tmpfs dirs, regressing an existing
 * automatic tmpfs-inode reclaim. No override → the two collapse and dedupe to one → unchanged.
 */
export function worktreeScratchDirCandidates(worktreePath: string): string[] {
  const primary = worktreeScratchDir(worktreePath);
  const legacy = join(legacyClaudeTmpRoot(), `claude-${uid()}`, dashify(worktreePath));
  return [...new Set([primary, legacy])];
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
 * Ordered, DEDUPED scratchpad-dir candidates for a session (#1875 migration). The primary is the
 * live `sessionScratchpadDir()` (disk after the boot override); the second is the same tail under
 * the legacy tmpfs root, where an ADOPTED pre-upgrade session's live agent — which kept its
 * spawn-time `TMPDIR=/tmp` — still writes. When no override is active (`claudeTmpRoot()` ===
 * `legacyClaudeTmpRoot()`) the two collapse and the list dedupes to a single entry, so every
 * non-migration consumer is byte-for-byte unchanged.
 */
export function sessionScratchpadDirCandidates(
  worktreePath: string,
  claudeSessionId: string,
): string[] {
  const primary = sessionScratchpadDir(worktreePath, claudeSessionId);
  const legacy = join(legacyClaudeTmpRoot(), dashify(worktreePath), claudeSessionId, "scratchpad");
  return [...new Set([primary, legacy])];
}

/**
 * Resolve which scratchpad root a session ACTUALLY uses: the first candidate that exists, else the
 * primary (for creation). Rule: a live disk session → disk; a legacy-only (adopted) session →
 * legacy tmpfs; if BOTH exist (e.g. a respawned session) → prefer disk (the live root). Keeps a
 * SINGLE root per session so reads, downloads, and uploads never split across roots. Returns the
 * primary on a blank `claudeSessionId` (callers already guard that separately).
 */
export async function existingScratchpadDir(
  worktreePath: string,
  claudeSessionId: string,
): Promise<string> {
  const primary = sessionScratchpadDir(worktreePath, claudeSessionId);
  for (const dir of sessionScratchpadDirCandidates(worktreePath, claudeSessionId)) {
    try {
      await fsp.access(dir);
      return dir;
    } catch {
      // try the next candidate
    }
  }
  return primary;
}

/**
 * Shallow, async, non-throwing "does this session's scratchpad hold any entry?" probe — the
 * cheap signal that gates the UI's Files tab (#1164). Counts ANY entry (files OR subdirs,
 * dotfiles included). Returns false on a blank `claudeSessionId` (pre-`--session-id` session /
 * agent not yet started), a missing dir, or any read error. Dual-read across the disk + legacy
 * candidates (#1875) so an adopted pre-upgrade session on the tmpfs still lights the tab; a single
 * shallow `readdir` per candidate, short-circuiting on the first non-empty hit.
 */
export async function scratchpadHasFiles(
  worktreePath: string,
  claudeSessionId: string,
): Promise<boolean> {
  if (!claudeSessionId) return false;
  for (const dir of sessionScratchpadDirCandidates(worktreePath, claudeSessionId)) {
    try {
      const entries = await fsp.readdir(dir);
      if (entries.length > 0) return true;
    } catch {
      // missing/unreadable candidate — try the next
    }
  }
  return false;
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
  unlink: typeof fsp.unlink;
  rmdir: typeof fsp.rmdir;
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
 * The documented default of `SHEPHERD_TMP_INODE_PCT` — the SINGLE source for both consumers: the
 * sweep gate in `sweepClaudeTmp` and the `tmp_inodes` row's warning band via `tmpInodeBands`. The
 * row's whole premise is that it warns exactly where the sweeper starts acting, so two independent
 * literals would let one drift and silently break that correspondence.
 */
const DEFAULT_TMP_INODE_PCT = 80;

/**
 * Ordered display bands for the `tmp_inodes` diagnostics row.
 *
 * The warning band tracks `SHEPHERD_TMP_INODE_PCT` so the row warns at exactly the point the
 * sweeper starts acting — hardcoding 80 would warn about a state an operator who raised the knob
 * deliberately told the sweeper to ignore. But the knob CANNOT be forwarded raw, because it is a
 * sweep-GATE value and this is a DISPLAY band, and the two disagree at both extremes:
 *
 *  - `0` is a legitimate gate setting meaning "always sweep" (`envNum` deliberately honours it —
 *    see its doc). Forwarded raw it means "always WARN": `usePct >= 0` holds on every host, so a
 *    healthy machine shows a permanent warning that no fix can clear, degrading the health pip
 *    forever. There is no useful display band derivable from it, so fall back to the default.
 *  - A value above `TMP_INODE_ERROR_PCT` inverts the bands: the warning range `[warn, error)` is
 *    empty, and `error` fires at 95% — BELOW the threshold the operator set — so the row alarms
 *    about a state they explicitly told Shepherd to leave alone. Raise the error band to match
 *    instead, so it never fires below the operator's own line.
 *  - A value above 100 (or otherwise outside `(0, 100]`) is not a percentage at all; treat it as
 *    misconfiguration and fall back rather than silently disabling the row.
 *
 * Postcondition, relied on by `classifyTmpInodes`: `0 < warnPct <= errorPct`.
 */
export function tmpInodeBands(): { warnPct: number; errorPct: number } {
  const configured = envNum(process.env.SHEPHERD_TMP_INODE_PCT, DEFAULT_TMP_INODE_PCT);
  const warnPct = configured > 0 && configured <= 100 ? configured : DEFAULT_TMP_INODE_PCT;
  return { warnPct, errorPct: Math.max(TMP_INODE_ERROR_PCT, warnPct) };
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
 * The directories one sweep visits. An explicit `root` (`explicitRoot`, tests) sweeps ONLY that
 * root + its nested `claude-$uid` dir — today's behavior, byte-for-byte, and never touches the real
 * disk/legacy roots. The default (production) path expands (#1875) to the DEDUPED set of the bare
 * disk `agentTmpDir()` — where bare-`$TMPDIR` tool caches (fallow/bunx/agent-browser) land — the
 * disk claude `root` + nested, and the legacy tmpfs root + nested — where an adopted pre-upgrade
 * session's live agent still writes. No override → the roots collapse and dedupe to today's pair.
 */
function resolveSweepRoots(root: string, nestedName: string, explicitRoot: boolean): string[] {
  if (explicitRoot) return [root, join(root, nestedName)];
  const agentTmp = agentTmpDir();
  const legacy = legacyClaudeTmpRoot();
  return [
    ...new Set([
      ...(agentTmp ? [agentTmp] : []),
      root,
      join(root, nestedName),
      legacy,
      join(legacy, nestedName),
    ]),
  ];
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
    const thresholdPct =
      opts?.thresholdPct ?? envNum(process.env.SHEPHERD_TMP_INODE_PCT, DEFAULT_TMP_INODE_PCT);
    const staleMs = opts?.staleMs ?? envNum(process.env.SHEPHERD_TMP_STALE_HOURS, 24) * 3600_000;
    const now = opts?.now ?? Date.now();
    const ops: FsOps = opts?.fsOps ?? {
      statfs: fsp.statfs,
      readdir: fsp.readdir,
      stat: fsp.stat,
      rm: fsp.rm,
      unlink: fsp.unlink,
      rmdir: fsp.rmdir,
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
    const sweepRoots = resolveSweepRoots(root, nestedName, opts?.root !== undefined);

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
 * Best-effort targeted teardown of one worktree's scratch dir (e.g. on session retire). Reclaims
 * BOTH the disk and legacy-tmpfs candidates (#1875) so an adopted pre-upgrade session's nested
 * scratch on the tmpfs is still freed. No-op per candidate when absent (`force:true`), swallows
 * every error — never throws. An explicit `opts.dir` (tests) targets exactly that one dir.
 */
export async function removeWorktreeScratch(
  worktreePath: string,
  opts?: { dir?: string; rm?: typeof fsp.rm },
): Promise<void> {
  const dirs = opts?.dir ? [opts.dir] : worktreeScratchDirCandidates(worktreePath);
  const rm = opts?.rm ?? fsp.rm;
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort — continue to the next candidate */
    }
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

  // Dedupe roots: claudeTmpRoot(), claude-$uid subdir, bare tmpdir() for caches whose TMPDIR was
  // the system default, and (when enabled) the bare disk agentTmpDir() — where an agent's Bash tool
  // running fallow writes `fallow-audit-base-cache-*` at its bare `$TMPDIR` (#1875). Without the
  // agentTmpDir() root those disk caches are reaped by NEITHER this pass nor sweepClaudeTmp, so they
  // accrete unbounded on disk. Using a Set so a reconfigured env can't double-scan. opts?.roots
  // overrides the computed set (lets tests isolate from bare /tmp — #817).
  const claudeRoot = claudeTmpRoot();
  const nestedRoot = join(claudeRoot, `claude-${uid()}`);
  const systemTmp = tmpdir();
  const agentTmp = agentTmpDir();
  const roots = opts?.roots
    ? [...new Set(opts.roots)]
    : [...new Set([claudeRoot, nestedRoot, systemTmp, ...(agentTmp ? [agentTmp] : [])])];

  const ctx: ReapFallowCtx = { ops, now, staleMs, log };
  let removed = 0;
  for (const root of roots) removed += await reapFallowRoot(root, ctx);

  return { removed };
}

// ── worktree reaper ─────────────────────────────────────────────────────────
//
// Removes abandoned agent git worktrees that live under a tmp root: a nested agent
// creates its own `git worktree add /tmp/…` for a configured repo, then finishes
// without removing it. Those worktrees hardlink `node_modules` into the forked pnpm
// store, so their survival pins every store file at `nlink = 2` — the store pass
// can only reclaim once they are gone. This reaper drops them; its `retained` count
// is the store pass's go/no-go signal.
//
// The removal is DESTRUCTIVE against possibly-unrecoverable data (a worktree can hold
// uncommitted edits + untracked files existing nowhere else), so it is guarded by a
// wall of refusals AND gated on live inode pressure — a destructive act needs a live
// justification. Every path comparison is realpath-normalized: porcelain emits resolved
// paths while a stored `worktreePath` / `tmpdir()` may be a symlink (macOS `/private/tmp`),
// and a non-match on the protective side is the dangerous direction.

/** Injectable git exec for the reaper: runs `git -C <cwd> <args>`, resolves stdout,
 *  rejects on non-zero exit or spawn failure. */
type ExecGit = (cwd: string, args: string[]) => Promise<string>;

const defaultExecGit: ExecGit = (cwd, args) =>
  execFileAsync("git", ["-C", cwd, ...args], { timeout: 60_000 }).then((r) => r.stdout);

export interface ReapWorktreesOpts {
  /** Configured repo paths to enumerate worktrees for (`listRepos(...).map(r => r.path)`). */
  repoPaths: string[];
  /** Live-session worktree dirs to spare (from `store.list({ activeOnly: true })`). */
  liveWorktreePaths?: string[];
  /** A RESOLVED snapshot of same-uid process cwds (from `liveProcCwds()`), taken by the
   *  caller so the synchronous `/proc` scan stays out of this async module. */
  liveCwds?: string[];
  /** Tmp roots a candidate must live under to be eligible. Default `[claudeTmpRoot(), tmpdir()]`. */
  tmpRoots?: string[];
  thresholdPct?: number;
  staleMs?: number;
  now?: number;
  log?: (msg: string) => void;
  execGit?: ExecGit;
  realpath?: (p: string) => Promise<string>;
  statfs?: FsOps["statfs"];
  fsOps?: Pick<FsOps, "readdir" | "stat">;
  /** Injectable removal (default `git worktree remove`, no `--force` — cleanliness proven). */
  removeWorktree?: (repo: string, worktreePath: string) => Promise<void>;
}

export interface ReapWorktreesResult {
  reaped: number;
  /** Candidates under a tmp root still on disk after the pass — the store pass skips when > 0. */
  retained: number;
}

/** A discovered, realpath-resolved worktree candidate under a tmp root. */
interface WorktreeCandidate {
  repo: string;
  path: string; // git-registered path
  real: string; // realpath-resolved (implies on-disk: realpath threw ⇒ not a candidate)
  locked: boolean;
  bare: boolean;
  prunable: boolean;
}

/** Realpath-resolve each path, dropping unresolvable ones, deduped. */
async function resolveAllRealpaths(
  paths: string[],
  realpath: (p: string) => Promise<string>,
): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    try {
      out.push(await realpath(p));
    } catch {
      /* unresolvable (gone / broken) — drop */
    }
  }
  return [...new Set(out)];
}

/** Max entries the freshness walk will stat before giving up. Sized for a source tree
 *  with `node_modules`/`.git` pruned from descent; exhaustion resolves to *keep*. */
const FRESHNESS_ENTRY_BUDGET = 10_000;

/**
 * True when the worktree looks fresh (recently touched) — the KEEP-biased direction.
 * Bounded DFS from `root`, statting every entry for its mtime but pruning `node_modules`
 * and `.git` from DESCENT (they are stat'd for their own mtime — a recent install/git op
 * shows there — but never walked: `node_modules/.pnpm` alone is thousands of dirs and
 * would exhaust the budget). ANY of {a mtime within the window, a stat/readdir error,
 * budget exhaustion} ⇒ `true` (keep). Only a full, error-free walk finding nothing fresh
 * ⇒ `false` (provably stale ⇒ reapable).
 */
/** Mutable entry budget shared across a single freshness/idle walk. */
interface Budget {
  n: number;
}

/**
 * Scan ONE directory for the freshness walk. `stop: true` is the KEEP-biased outcome (a fresh
 * mtime, a stat/readdir error, or budget exhaustion); otherwise `children` are the sub-dirs to
 * descend, with `node_modules`/`.git` pruned from descent (stat'd for mtime, never walked).
 */
async function scanFreshDir(
  dir: string,
  cutoff: number,
  budget: Budget,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<{ stop: boolean; children: string[] }> {
  const keep = { stop: true, children: [] as string[] };
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return keep; // unreadable subtree → keep
  }
  const children: string[] = [];
  for (const ent of entries) {
    if (--budget.n < 0) return keep; // budget exhausted → keep (never a reap by omission)
    const p = join(dir, ent.name);
    try {
      if (Number((await stat(p)).mtimeMs) > cutoff) return keep; // a fresh entry → keep
    } catch {
      return keep; // stat error → keep
    }
    if (ent.isDirectory() && ent.name !== "node_modules" && ent.name !== ".git") children.push(p);
  }
  return { stop: false, children };
}

async function worktreeIsFresh(
  root: string,
  cutoff: number,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<boolean> {
  try {
    if (Number((await stat(root)).mtimeMs) > cutoff) return true;
  } catch {
    return true; // can't even stat the root → keep
  }
  const budget: Budget = { n: FRESHNESS_ENTRY_BUDGET };
  const stack: string[] = [root];
  while (stack.length > 0) {
    const scan = await scanFreshDir(stack.pop() as string, cutoff, budget, readdir, stat);
    if (scan.stop) return true;
    stack.push(...scan.children);
  }
  return false; // fully walked within budget, nothing fresh
}

/**
 * The refusal reason for a candidate, or `null` when it is safe to reap. Cheap checks
 * (porcelain annotations, the Shepherd-worktree marker, the live sets) run before the
 * `git status` spawn, which runs before the freshness fs-walk.
 */
async function worktreeRefusal(
  c: WorktreeCandidate,
  ctx: {
    liveWorktreePaths: string[];
    liveCwds: string[];
    cutoff: number;
    execGit: ExecGit;
    readdir: FsOps["readdir"];
    stat: FsOps["stat"];
  },
): Promise<string | null> {
  if (c.locked) return "locked";
  if (c.bare) return "bare";
  if (c.prunable) return "prunable";
  if (c.real.includes(WORKTREE_MARKER) || c.path.includes(WORKTREE_MARKER))
    return "shepherd-worktree";
  if (ctx.liveWorktreePaths.includes(c.real)) return "live-session";
  if (ctx.liveCwds.some((cwd) => isUnder(cwd, c.real))) return "live-cwd";

  // Dirty check — the `src/worktree.ts` idiom: ANY error counts as dirty (safe default),
  // because a worktree can hold work that exists nowhere else.
  let status: string;
  try {
    status = await ctx.execGit(c.path, ["status", "--porcelain"]);
  } catch {
    return "dirty";
  }
  if (status.trim().length > 0) return "dirty";

  if (await worktreeIsFresh(c.real, ctx.cutoff, ctx.readdir, ctx.stat)) return "fresh";
  return null;
}

/** Shared option resolution for the two tmp reclaimers: current time, the staleness `cutoff`
 *  (`SHEPHERD_TMP_STALE_HOURS`, default 24h), and the inode-pressure gate (`SHEPHERD_TMP_INODE_PCT`). */
function resolveTmpGate(opts: { now?: number; staleMs?: number; thresholdPct?: number }): {
  now: number;
  cutoff: number;
  thresholdPct: number;
} {
  const now = opts.now ?? Date.now();
  const cutoff =
    now - (opts.staleMs ?? envNum(process.env.SHEPHERD_TMP_STALE_HOURS, 24) * 3600_000);
  const thresholdPct =
    opts.thresholdPct ?? envNum(process.env.SHEPHERD_TMP_INODE_PCT, DEFAULT_TMP_INODE_PCT);
  return { now, cutoff, thresholdPct };
}

/** True iff the installed git meets the worktree-annotation floor (>= 2.38); unreadable ⇒ false. */
async function gitMeetsFloor(execGit: ExecGit, repo: string): Promise<boolean> {
  try {
    const v = parseGitVersion(await execGit(repo, ["--version"]));
    return !!v && gitVersionAtLeast(v, MIN_GIT_MAJOR, MIN_GIT_MINOR);
  } catch {
    return false;
  }
}

/** Enumerate every worktree of the configured repos that realpath-resolves under a tmp root,
 *  deduped by resolved path (overlapping repo configs can list the same tmp worktree twice). A
 *  path that fails realpath is gone (not on disk) and skipped. */
async function discoverTmpWorktreeCandidates(ctx: {
  repoPaths: string[];
  tmpRoots: string[];
  execGit: ExecGit;
  realpath: (p: string) => Promise<string>;
  log: (msg: string) => void;
}): Promise<WorktreeCandidate[]> {
  const candidates: WorktreeCandidate[] = [];
  const seen = new Set<string>();
  for (const repo of ctx.repoPaths) {
    let porcelain: string;
    try {
      porcelain = await ctx.execGit(repo, ["worktree", "list", "--porcelain"]);
    } catch (err) {
      ctx.log(`[tmp-sweep] worktree list failed for ${repo}: ${String(err)}`);
      continue;
    }
    for (const e of parseWorktrees(porcelain)) {
      let real: string;
      try {
        real = await ctx.realpath(e.path); // resolves ⇒ on disk; throws ⇒ gone, not a candidate
      } catch {
        continue;
      }
      if (!ctx.tmpRoots.some((r) => isUnder(real, r)) || seen.has(real)) continue;
      seen.add(real);
      candidates.push({
        repo,
        path: e.path,
        real,
        locked: e.locked,
        bare: e.bare,
        prunable: e.prunable,
      });
    }
  }
  return candidates;
}

/** Apply refusals to each candidate and reap those with a live justification. Returns the count
 *  removed. `canRemove` folds the git-floor + inode-pressure gate: false ⇒ discover-only. */
async function reapCandidates(
  candidates: WorktreeCandidate[],
  canRemove: boolean,
  refusalCtx: Parameters<typeof worktreeRefusal>[1],
  removeWorktree: (repo: string, worktreePath: string) => Promise<void>,
  log: (msg: string) => void,
): Promise<number> {
  let reaped = 0;
  for (const c of candidates) {
    const reason = await worktreeRefusal(c, refusalCtx);
    if (reason) {
      log(`[tmp-sweep] keep worktree ${c.real}: ${reason}`);
      continue;
    }
    if (!canRemove) continue; // reapable but no live justification to act
    try {
      await removeWorktree(c.repo, c.path);
      reaped += 1;
      log(`[tmp-sweep] reaped abandoned worktree ${c.real}`);
    } catch (err) {
      log(`[tmp-sweep] worktree remove failed for ${c.real}: ${String(err)}`);
    }
  }
  return reaped;
}

/**
 * Reap abandoned tmp worktrees of the configured repos. TOTAL by contract — never throws;
 * any unexpected failure resolves to a conservative `retained >= 1` so the store pass skips.
 *
 * Discovery + refusal always run; only the actual REMOVAL is gated on git >= 2.38 (the floor
 * for the `locked`/`prunable` annotations that keep a dangling record from being reaped) AND
 * inode pressure >= `thresholdPct`. `retained` = candidates under a tmp root still on disk
 * after the pass (every candidate was realpath-resolved, so it exists) minus those removed —
 * deliberately NOT the raw refusal list, whose off-tmp entries would pin it non-zero forever.
 */
export async function reapAbandonedWorktrees(
  opts: ReapWorktreesOpts,
): Promise<ReapWorktreesResult> {
  const log = opts.log ?? console.warn;
  try {
    const firstRepo = opts.repoPaths[0];
    if (firstRepo === undefined) return { reaped: 0, retained: 0 };

    const { cutoff, thresholdPct } = resolveTmpGate(opts);
    const realpath = opts.realpath ?? fsp.realpath;
    const statfs = opts.statfs ?? fsp.statfs;
    const readdir = opts.fsOps?.readdir ?? fsp.readdir;
    const stat = opts.fsOps?.stat ?? fsp.stat;
    const execGit = opts.execGit ?? defaultExecGit;
    const removeWorktree =
      opts.removeWorktree ??
      ((repo: string, wt: string) => execGit(repo, ["worktree", "remove", wt]).then(() => {}));

    const [tmpRoots, liveWorktreePaths, liveCwds] = await Promise.all([
      resolveAllRealpaths(opts.tmpRoots ?? [claudeTmpRoot(), tmpdir()], realpath),
      resolveAllRealpaths(opts.liveWorktreePaths ?? [], realpath),
      resolveAllRealpaths(opts.liveCwds ?? [], realpath),
    ]);

    // Git floor: without the 2.36+ porcelain annotations a locked/prunable worktree looks
    // reapable while its record can't be pruned — a dangling entry. Below the floor we still
    // discover (so `retained` reflects reality and the store skips) but never remove.
    const gitOk = await gitMeetsFloor(execGit, firstRepo);
    if (!gitOk) log("[tmp-sweep] worktree reap: git < 2.38 or unreadable — discovering only");
    const usePct = await inodeUsePct(tmpdir(), statfs, log);
    const pressureOk = typeof usePct === "number" && usePct >= thresholdPct;

    const candidates = await discoverTmpWorktreeCandidates({
      repoPaths: opts.repoPaths,
      tmpRoots,
      execGit,
      realpath,
      log,
    });

    const refusalCtx = { liveWorktreePaths, liveCwds, cutoff, execGit, readdir, stat };
    const reaped = await reapCandidates(
      candidates,
      gitOk && pressureOk,
      refusalCtx,
      removeWorktree,
      log,
    );
    // Every candidate is on-disk-under-tmp (realpath-resolved); those not reaped remain.
    return { reaped, retained: candidates.length - reaped };
  } catch (err) {
    log(`[tmp-sweep] worktree reap unexpected error: ${String(err)}`);
    // Defensive: an unknown failure must NOT let the store pass proceed.
    return { reaped: 0, retained: 1 };
  }
}

// ── forked pnpm store reclaimer ─────────────────────────────────────────────
//
// pnpm forks a content-addressable store onto the tmpfs (`<tmp>/.pnpm-store/v<N>/`) to
// stay same-filesystem for hardlinking. Store content lingers pinning inodes long after the
// worktrees that linked it are gone. Reclaim is PARTIAL (#1880): under each idle version dir,
// unlink only the `nlink === 1` content (nothing else references it) and prune the bucket dirs
// that empty out, leaving still-linked (`nlink > 1`) content and the `index/` metadata intact.
// `index/` pointing at removed content is a clean re-fetch trigger, not a hard error — measured
// on pnpm 10.28.2: offline reinstall reports `ERR_PNPM_NO_OFFLINE_TARBALL` (it *wants* to
// download), online reinstall re-fetches cleanly. So partial reclaim is safe GIVEN NETWORK AT
// REINSTALL TIME. This supersedes #1874's all-or-nothing removal: the residual case where some
// content is still hardlinked (a surviving worktree, an orphaned `node_modules`) — where
// all-or-nothing freed ZERO — now frees the unlinked fraction. Every unprobable subtree or
// per-entry error resolves to KEEP: we only ever remove content we positively proved is
// `nlink === 1`, never on a failure-to-probe.

/** The `/^v\d+$/` version subdirs of a store root. An empty result makes the caller skip (an
 *  unrecognized layout is never touched) — the harmless direction. */
export function resolveStoreVersionDirs(rootEntries: Dirent[]): string[] {
  return rootEntries.filter((e) => e.isDirectory() && /^v\d+$/.test(e.name)).map((e) => e.name);
}

/**
 * Provably idle iff a full depth-2 enumeration from the versioned dir finds every mtime
 * <= `cutoff`. Depth 2 is load-bearing: a mid-install store's depth-<=1 mtimes stop moving
 * once the buckets exist, so a shallower probe reads a busy store as idle. Any error, or a
 * budget overrun, ⇒ `false` (keep).
 */
/** Every entry directly under `dir` has an mtime <= `cutoff` (and budget wasn't exhausted).
 *  Throws propagate to the caller's catch. */
async function childrenAllStale(
  dir: string,
  cutoff: number,
  budget: Budget,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<boolean> {
  for (const e of (await readdir(dir, { withFileTypes: true })) as Dirent[]) {
    if (--budget.n < 0) return false;
    if (Number((await stat(join(dir, e.name))).mtimeMs) > cutoff) return false;
  }
  return true;
}

async function storeVersionDirIsIdle(
  vdir: string,
  cutoff: number,
  readdir: FsOps["readdir"],
  stat: FsOps["stat"],
): Promise<boolean> {
  const budget: Budget = { n: 100_000 };
  try {
    for (const e1 of (await readdir(vdir, { withFileTypes: true })) as Dirent[]) {
      if (--budget.n < 0) return false;
      const p1 = join(vdir, e1.name);
      if (Number((await stat(p1)).mtimeMs) > cutoff) return false;
      if (e1.isDirectory() && !(await childrenAllStale(p1, cutoff, budget, readdir, stat)))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Running tally of a partial reclaim: content files unlinked + bucket dirs pruned. */
interface ReclaimCounters {
  freedFiles: number;
  freedDirs: number;
}
type ContentOps = Pick<FsOps, "readdir" | "stat" | "unlink" | "rmdir">;

/** Reclaim a subdir, then prune it if it emptied out. `true` iff it was pruned (`rmdir` ok). */
async function reclaimAndPruneSubdir(
  p: string,
  ops: ContentOps,
  c: ReclaimCounters,
): Promise<boolean> {
  if (!(await reclaimContentDir(p, ops, c))) return false; // still holds linked/unprobable content
  try {
    await ops.rmdir(p);
    c.freedDirs += 1;
    return true;
  } catch {
    return false; // rmdir raced/failed → keep
  }
}

/** Unlink a content file iff it is provably `nlink === 1`. `true` iff it was unlinked. Any
 *  stat/unlink error or a surviving reference (`nlink > 1`) leaves it in place → `false`. */
async function unlinkIfUnlinked(p: string, ops: ContentOps, c: ReclaimCounters): Promise<boolean> {
  let nlink: number;
  try {
    nlink = Number((await ops.stat(p)).nlink);
  } catch {
    return false; // unstattable → keep
  }
  if (nlink > 1) return false; // another reference survives → keep
  try {
    await ops.unlink(p);
    c.freedFiles += 1;
    return true;
  } catch {
    return false; // unlink failed → keep
  }
}

/**
 * Recursive post-order reclaim of one content dir: unlink every file that is provably
 * `nlink === 1` (no other reference), recurse into subdirs and `rmdir` any that empty out, and
 * leave still-linked (`nlink > 1`) files in place. NEVER throws — an unreadable dir or a
 * per-entry stat/unlink/rmdir error just leaves that entry standing (counted as remaining), so
 * we only ever remove content we positively proved is unlinked. Returns `true` iff `dir` has
 * ZERO remaining entries after the pass (so the caller can prune it). Exhaustive, unbudgeted:
 * the full walk is the point, and it runs microtask-deferred off the event loop.
 */
async function reclaimContentDir(
  dir: string,
  ops: ContentOps,
  c: ReclaimCounters,
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = (await ops.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return false; // unprobable subtree → keep, treat as non-empty
  }
  let remaining = 0;
  for (const ent of entries) {
    const p = join(dir, ent.name);
    const reclaimed = ent.isDirectory()
      ? await reclaimAndPruneSubdir(p, ops, c)
      : await unlinkIfUnlinked(p, ops, c);
    if (!reclaimed) remaining += 1;
  }
  return remaining === 0;
}

export interface ReclaimStoreOpts {
  /** The forked store root. Default `<tmpdir>/.pnpm-store` — the only name allowed to reach
   *  bare `tmpdir()`. A wrong mount root just yields a missing dir → safe skip. */
  storeRoot?: string;
  thresholdPct?: number;
  staleMs?: number;
  now?: number;
  statfs?: FsOps["statfs"];
  fsOps?: Pick<FsOps, "readdir" | "stat" | "unlink" | "rmdir">;
  log?: (msg: string) => void;
}

export interface ReclaimStoreResult {
  /** Content files unlinked (`nlink === 1`) across all idle version dirs. */
  freedFiles: number;
  /** Bucket dirs pruned after emptying out. */
  freedDirs: number;
  /** A whole-store skip reason (`below-threshold …`, `no-store`, `sibling-fresh …`, …), or
   *  `reclaimed` when the per-file pass ran (freed counts carry the detail). */
  reason: string;
}

/** A skip reason for any non-`v*` sibling of the store root that could be freshly written while
 *  the two v-dir probes (which only look inside `v*`) read "idle" — else `null`. */
async function siblingBlocker(
  rootEntries: Dirent[],
  storeRoot: string,
  cutoff: number,
  stat: FsOps["stat"],
): Promise<string | null> {
  for (const e of rootEntries) {
    if (/^v\d+$/.test(e.name)) continue;
    let st: Awaited<ReturnType<FsOps["stat"]>>;
    try {
      st = await stat(join(storeRoot, e.name));
    } catch {
      return `sibling-unstattable ${e.name}`;
    }
    if (Number(st.mtimeMs) > cutoff) return `sibling-fresh ${e.name}`;
    if (e.isDirectory()) return `sibling-unrecognized ${e.name}`;
  }
  return null;
}

/** Partial-reclaim every depth-2-idle version dir's `files/` tree into `c`; a busy dir is
 *  skipped (logged), never touched. `index/` metadata is left intact as a re-fetch trigger. */
async function reclaimIdleVersionDirs(
  storeRoot: string,
  versionDirs: string[],
  cutoff: number,
  ops: ContentOps,
  c: ReclaimCounters,
  log: (msg: string) => void,
): Promise<void> {
  for (const v of versionDirs) {
    const vdir = join(storeRoot, v);
    if (!(await storeVersionDirIsIdle(vdir, cutoff, ops.readdir, ops.stat))) {
      log(`[tmp-sweep] store reclaim: skip busy version dir ${v}`);
      continue;
    }
    await reclaimContentDir(join(vdir, "files"), ops, c);
  }
}

/**
 * Partial reclaim of the forked pnpm store. TOTAL by contract — never throws. Under sustained
 * inode pressure, for each depth-2-idle version dir it unlinks the `nlink === 1` content in
 * `files/`, prunes the bucket dirs that empty out, and leaves still-linked content, `index/`,
 * and the store root intact. WHOLE-STORE skip gates (return freed 0): inode pressure below
 * threshold, an unreadable / non-`v<N>` store, or a fresh / unrecognized non-`v*` sibling
 * (active install → touch nothing). A NON-idle version dir is skipped per-dir (logged), so an
 * idle sibling version dir is still reclaimed. Unlike #1874's all-or-nothing removal, a
 * surviving hardlink no longer blocks the reclaim — the linked file is simply kept. The caller
 * runs the worktree reaper FIRST so a truly-abandoned worktree's links drop to `nlink === 1`
 * before this pass. Safe GIVEN NETWORK AT REINSTALL TIME (see module header).
 */
export async function reclaimForkedPnpmStore(opts: ReclaimStoreOpts): Promise<ReclaimStoreResult> {
  const log = opts.log ?? console.warn;
  const c: ReclaimCounters = { freedFiles: 0, freedDirs: 0 };
  try {
    const storeRoot = opts.storeRoot ?? join(tmpdir(), ".pnpm-store");
    const { cutoff, thresholdPct } = resolveTmpGate(opts);
    const readdir = opts.fsOps?.readdir ?? fsp.readdir;
    const stat = opts.fsOps?.stat ?? fsp.stat;
    const unlink = opts.fsOps?.unlink ?? fsp.unlink;
    const rmdir = opts.fsOps?.rmdir ?? fsp.rmdir;
    const statfs = opts.statfs ?? fsp.statfs;

    const usePct = await inodeUsePct(tmpdir(), statfs, log);
    if (typeof usePct === "string") return { ...c, reason: usePct };
    if (usePct < thresholdPct) {
      return { ...c, reason: `below-threshold ${usePct.toFixed(1)}%` };
    }

    let rootEntries: Dirent[];
    try {
      rootEntries = (await readdir(storeRoot, { withFileTypes: true })) as Dirent[];
    } catch {
      return { ...c, reason: "no-store" };
    }

    const versionDirs = resolveStoreVersionDirs(rootEntries);
    if (versionDirs.length === 0) return { ...c, reason: "no-version-dir" };

    const sibling = await siblingBlocker(rootEntries, storeRoot, cutoff, stat);
    if (sibling) return { ...c, reason: sibling };

    const contentOps: ContentOps = { readdir, stat, unlink, rmdir };
    await reclaimIdleVersionDirs(storeRoot, versionDirs, cutoff, contentOps, c, log);
    return { ...c, reason: "reclaimed" };
  } catch (err) {
    log(`[tmp-sweep] store reclaim unexpected error: ${String(err)}`);
    return { ...c, reason: "error" };
  }
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
