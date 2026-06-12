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
 * ~88%→16%); this module automates that plus age-gated scratch cleanup, but only once
 * inode use crosses a threshold — so a healthy tmpfs is never disturbed.
 *
 * The server runs on a single Bun event loop, so EVERYTHING here is async `fs/promises`:
 * a sync stat/rm on the loop freezes the live web terminal.
 */

/** Process uid, derived at call time (1000 fallback when getuid is absent, e.g. Windows). */
const uid = (): number => process.getuid?.() ?? 1000;

/** A worktree cwd → the dash-encoded directory name a nested claude derives for it. */
const dashify = (p: string): string => p.replace(/[/.]/g, "-");

/**
 * The claude tmp root for this user. Read from env at call time so tests and operators
 * can redirect it; falls back to the conventional `<tmpdir>/claude-$uid`.
 */
export function claudeTmpRoot(): string {
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

/**
 * Threshold-gated inode guard. TOTAL by contract: it NEVER throws or rejects — any
 * unexpected error resolves to `{ swept:false, reason:"error", removed:0 }` after logging,
 * so a caller can fire-and-forget it on a timer without a guard.
 *
 * Only sweeps once inode use ≥ `thresholdPct`; below that it removes NOTHING. When it does
 * sweep, it walks `root` and the nested `root/claude-$uid`, removing `node-compile-cache`
 * wholesale (pure cache) and age-gating everything else, but never the nested scratch dir
 * itself (its children are age-gated when it is the sweep root) and never a root dir itself.
 * Age-gating is evaluated at stat time: an entry that looks fresh by mtime is kept. This is a
 * best-effort age check, not a TOCTOU-atomic guarantee — a writer touching an entry between
 * our stat and rm is not fenced out.
 */
export async function sweepClaudeTmp(opts?: SweepOpts): Promise<SweepResult> {
  const log = opts?.log ?? console.warn;
  try {
    const root = opts?.root ?? claudeTmpRoot();
    const thresholdPct = opts?.thresholdPct ?? (Number(process.env.SHEPHERD_TMP_INODE_PCT) || 80);
    const staleMs =
      opts?.staleMs ?? (Number(process.env.SHEPHERD_TMP_STALE_HOURS) || 24) * 3600_000;
    const now = opts?.now ?? Date.now();
    const ops: FsOps = opts?.fsOps ?? {
      statfs: fsp.statfs,
      readdir: fsp.readdir,
      stat: fsp.stat,
      rm: fsp.rm,
    };

    // Fail-open: without a usable statfs we cannot read inode pressure, so do nothing.
    if (typeof ops.statfs !== "function") {
      log("[tmp-sweep] statfs unavailable — skipping inode guard");
      return { swept: false, reason: "statfs-unavailable", removed: 0 };
    }

    let stats: Awaited<ReturnType<typeof fsp.statfs>>;
    try {
      stats = await ops.statfs(root);
    } catch {
      // Root absent / unstatfs-able — nothing to guard.
      return { swept: false, reason: "root-missing", removed: 0 };
    }

    const files = Number((stats as { files?: unknown }).files);
    const ffree = Number((stats as { ffree?: unknown }).ffree);
    if (!Number.isFinite(files) || !Number.isFinite(ffree) || files <= 0) {
      return { swept: false, reason: "statfs-unavailable", removed: 0 };
    }

    const usePct = (1 - ffree / files) * 100;
    if (usePct < thresholdPct) {
      return {
        swept: false,
        reason: `below-threshold ${usePct.toFixed(1)}%`,
        removed: 0,
      };
    }

    const nestedName = `claude-${uid()}`;
    let removed = 0;
    const sweepRoots = [root, join(root, nestedName)];

    for (const dir of sweepRoots) {
      let entries: Dirent[];
      try {
        entries = (await ops.readdir(dir, { withFileTypes: true })) as Dirent[];
      } catch {
        // Missing/unreadable dir (e.g. no nested claude root yet) — skip it.
        continue;
      }
      for (const ent of entries) {
        const p = join(dir, ent.name);
        try {
          if (ent.name === "node-compile-cache") {
            // Pure V8 compile cache — safe to drop wholesale regardless of age.
            await ops.rm(p, { recursive: true, force: true });
            removed++;
          } else if (ent.name === nestedName) {
            // The nested scratch root: never wholesale-removed; its children are
            // age-gated when it is itself swept (as the second sweep root).
            continue;
          } else {
            const st = await ops.stat(p);
            // Deliberately the top-level entry's own mtime, not a recursive
            // newest-descendant walk — don't "fix" this into a sync/expensive tree traversal.
            if (now - st.mtimeMs > staleMs) {
              await ops.rm(p, { recursive: true, force: true });
              removed++;
            }
          }
        } catch (err) {
          // Fail-closed per-entry: a removal that fails is surfaced in the log and
          // skipped — it NEVER aborts the sweep and is never miscounted as success.
          log(`[tmp-sweep] failed to remove ${p}: ${String(err)}`);
        }
      }
    }

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
