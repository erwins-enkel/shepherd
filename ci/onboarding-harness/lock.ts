import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// FIXED absolute path under the host-global Shepherd state dir (~/.shepherd) — NOT
// $TMPDIR. A systemd-user timer service and an interactive shell can see different
// $TMPDIR (PrivateTmp, per-session dirs), which would defeat the lock; $HOME is
// stable and identical for both (same user), so the lock is genuinely host-wide.
export const LOCK_PATH = join(homedir(), ".shepherd", "onboarding-harness.lock");

/** Who holds the lock — recorded so a later run can tell "held" from "leaked". */
interface LockOwner {
  pid: number;
  startedAt: string;
  runId: string;
}

/** Thrown when the lock is held by a run that is genuinely still alive. The
 *  caller maps this to exit 3 (the documented "another run holds the host" code). */
export class LockHeldError extends Error {}

/** Is `pid` still a live harness run? Liveness alone is not enough: pids are
 *  recycled, and a recycled pid must not lock the harness out forever, so a live
 *  pid is additionally checked against /proc for the harness in its command line.
 *  If /proc is unreadable we stay conservative and call it live — refusing to run
 *  is recoverable, stealing a lock from a running harness is not. */
function isLiveHarness(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // ESRCH ⇒ no such process. EPERM ⇒ alive but owned by another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("onboarding-harness");
  } catch {
    return true;
  }
}

function readOwner(path: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    return typeof owner.pid === "number" ? (owner as LockOwner) : null;
  } catch {
    return null; // absent, empty (the pre-owner format), or corrupt
  }
}

/** `wx` — create-exclusive — so acquiring is atomic against a concurrent run. */
function tryCreate(path: string, runId: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    return null;
  }
  const owner: LockOwner = { pid: process.pid, startedAt: new Date().toISOString(), runId };
  writeSync(fd, JSON.stringify(owner));
  return fd;
}

/**
 * Acquire the host-wide exclusive lock so concurrent runs never share the Incus
 * host. Returns an idempotent release fn.
 *
 * The lock records its owner, and an existing lock is reclaimed when that owner is
 * provably gone. Existence alone used to mean "held", which made a single leaked
 * file permanently fatal: in Aug 2026 a run killed by the service's start timeout
 * left a 0-byte lock behind and every nightly for the next 21 days aborted at exit
 * 3 in under a second — silently, until a release gate noticed three weeks later.
 *
 * Release is also wired to SIGINT/SIGTERM by the caller, but that path CANNOT be
 * relied on, and not merely in theory: while Bun awaits a spawned child, SIGTERM
 * never reaches the JS handler and the process dies by signal with its cleanup
 * unrun. The harness awaits `incus` children for essentially its whole runtime, so
 * a start-timeout kill lands in that state every time. Reclaiming is the fix;
 * the signal handler is a best-effort extra that covers an interactive Ctrl-C.
 *
 * `reclaimed` tells the caller it inherited a dead run's host: instances that run
 * leaked are still there, and only a reclaiming run can safely destroy them.
 */
export function acquireHostLock(
  runId: string,
  opts: { path?: string; isLive?: (pid: number) => boolean } = {},
): { release: () => void; reclaimed: boolean } {
  const path = opts.path ?? LOCK_PATH;
  const isLive = opts.isLive ?? isLiveHarness;
  mkdirSync(dirname(path), { recursive: true });

  let reclaimed = false;
  let fd = tryCreate(path, runId);
  if (fd === null) {
    reclaimed = true;
    const owner = readOwner(path);
    if (owner && isLive(owner.pid))
      throw new LockHeldError(
        `another onboarding-harness run holds ${path} (pid ${owner.pid}, since ${owner.startedAt}); aborting`,
      );
    console.warn(
      `reclaiming stale lock ${path} — ${owner ? `owner pid ${owner.pid} (since ${owner.startedAt}) is gone` : "it records no live owner"}`,
    );
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    fd = tryCreate(path, runId);
    // Lost the race: another run created the lock between our unlink and retry.
    if (fd === null)
      throw new LockHeldError(`another onboarding-harness run took ${path}; aborting`);
  }

  const heldFd = fd;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    closeSync(heldFd);
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  return { release, reclaimed };
}
