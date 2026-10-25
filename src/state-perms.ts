/**
 * Owner-only permissions for the state dir and its secret-bearing files (#3404).
 *
 * The db holds the cookie-signing secret, password hash and tokens, and shepherd.log can carry the
 * first-boot generated-password banner — so the dir is 0700 and those files 0600 regardless of the
 * process umask, and an existing install is tightened at boot. A path that is a symlink or owned by
 * another uid is left alone (a custom SHEPHERD_DB in a shared dir must not be chmod'ed out from
 * under its owner); any failure only warns — a permission fix must never brick boot.
 *
 * No side-effecting imports: `scripts/backup.ts` imports `tightenPath` (it must not load config).
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionStore } from "./store";

/** chmod `path` to `mode` when it is an own, non-symlink file/dir whose mode differs. */
export function tightenPath(path: string, mode: number): void {
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) return;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      console.warn(`[state-perms] not tightening ${path}: owned by uid ${st.uid}`);
      return;
    }
    if ((st.mode & 0o777) !== mode) chmodSync(path, mode);
  } catch (err) {
    console.warn(`[state-perms] could not tighten ${path}: ${(err as Error).message}`);
  }
}

/** Create `dir` 0700 (missing parents too) and tighten an existing one. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  tightenPath(dir, 0o700);
}

/** Run `fn` under `mask`, restoring the previous umask afterwards. Process-global: only for
 *  synchronous sections where nothing else creates files concurrently. */
function withUmask<T>(mask: number, fn: () => T): T {
  const prev = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(prev);
  }
}

/**
 * Boot-time store open: private state dir, db created under umask 077, and the db, its SQLite side
 * files and the app log tightened to 0600. SQLite creates later `-journal`/`-wal` files with the main
 * db's mode, so tightening the db once covers them going forward.
 */
export function openPrivateStore(
  dbPath: string,
  logPath: string,
  open: (path: string) => SessionStore,
): SessionStore {
  ensurePrivateDir(dirname(dbPath));
  const store = withUmask(0o077, () => open(dbPath));
  for (const suffix of ["", "-journal", "-wal", "-shm"]) tightenPath(dbPath + suffix, 0o600);
  tightenPath(logPath, 0o600);
  // Every rotation (rotate-shepherd-log.sh shifts .1.gz up to .7.gz) — the first-boot banner ages
  // into the high-numbered ones.
  const logDir = dirname(logPath);
  const rotated = `${basename(logPath)}.`;
  try {
    for (const f of readdirSync(logDir))
      if (f.startsWith(rotated)) tightenPath(join(logDir, f), 0o600);
  } catch (err) {
    console.warn(`[state-perms] could not list ${logDir}: ${(err as Error).message}`);
  }
  return store;
}
