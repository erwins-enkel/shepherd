import { promises as fsp, type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
 * Handles ONE directory entry, returning the count removed (0 or 1). Fail-closed per-entry:
 * its own try/catch surfaces a removal failure in the log and continues, so a bad entry NEVER
 * aborts the sweep and is never miscounted as success. The cases:
 *  - `node-compile-cache` — pure V8 compile cache, dropped wholesale regardless of age.
 *  - the nested `claude-$uid` root — never wholesale-removed (its children are swept when it is
 *    itself the sweep root); skipped here.
 *  - a known regenerable cache (see `REGENERABLE_CACHE`) — age-gated by its top-level mtime.
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
    // Deliberately the top-level entry's own mtime, not a recursive
    // newest-descendant walk — don't "fix" this into a sync/expensive tree traversal.
    if (ctx.now - st.mtimeMs > ctx.staleMs) {
      await ctx.ops.rm(p, { recursive: true, force: true });
      return 1;
    }
    return 0;
  } catch (err) {
    // Fail-closed per-entry: a removal that fails is surfaced in the log and
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
 * Only sweeps once inode use ≥ `thresholdPct`; below that it removes NOTHING. When it does
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

    const nestedName = `claude-${uid()}`;
    const ctx: SweepCtx = { ops, now, staleMs, nestedName, log };
    const sweepRoots = [root, join(root, nestedName)];

    let removed = 0;
    for (const dir of sweepRoots) removed += await sweepDir(dir, ctx);

    return {
      swept: true,
      reason: `swept ${usePct.toFixed(1)}% inode use`,
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
