import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posixShellJoin } from "./argv-limit";
import { agentTmpDir } from "./tmp-sweep";

/**
 * The spawn TRANSPORT for herdr ≥0.7.5 (issue #1967).
 *
 * `pane run` (CLI) and `pane.send_text` (socket) do NOT `execvp` the command — they TYPE it into the
 * pane's interactive shell. A shell sitting at its prompt has its tty in CANONICAL mode, whose input
 * line is bounded by `MAX_INPUT`: ~1024 bytes on Darwin (4096 on Linux). Shepherd's spawn line is
 * several KB — dominated by the `--settings` overlay and the `--append-system-prompt` directive — so
 * on macOS it was silently truncated mid-JSON, leaving an unterminated `'`. The shell then waited
 * for line continuation, `claude` never launched, and the spawn died at the 30s auto-detect deadline.
 *
 * The fix is to make the TYPED line short regardless of command size: the real command goes into a
 * throwaway script and only `sh '<path>'` (~60 bytes) is typed. The process that ends up running is
 * byte-identical to before — same argv, same env — so herdr's detection, the membrane wrap and every
 * downstream consumer are unaffected.
 *
 * Shrinking `argvElementLimit` for Darwin (#1944's lever) was NOT an option: trimming a system
 * prompt to fit under 1 KB would gut it.
 */

/** Directory the throwaway spawn scripts live in: the disk-backed agent tmp root when the #1875
 *  redirect is enabled, else the system tmp dir (`SHEPHERD_AGENT_TMPDIR=""` disables it). Resolved
 *  at call time so the env seam works the same way it does for the agents themselves. */
function spawnScriptDir(): string {
  return join(agentTmpDir() ?? tmpdir(), "spawn");
}

/** A real directory, owned by us, that no one else can write into. Uses `lstat`, so a symlink
 *  planted on the path is rejected rather than followed. */
async function isOwnPrivateDir(dir: string): Promise<boolean> {
  try {
    const st = await lstat(dir);
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Remembered across spawns once the preferred directory turns out to be squatted. */
let fallbackDir: string | null = null;

/** A private directory of our own under the system tmp dir, reused across spawns — but RE-VERIFIED
 *  every time, never blindly reused: a tmp cleaner (or anything else) may have removed it since,
 *  and a stale memo would fail every subsequent spawn with `ENOENT`. */
async function privateFallbackDir(): Promise<string> {
  if (fallbackDir && (await isOwnPrivateDir(fallbackDir))) return fallbackDir;
  fallbackDir = await mkdtemp(join(tmpdir(), "shepherd-spawn-"));
  return fallbackDir;
}

/**
 * The directory to write into, PROVEN to be ours and private before anything is written to it.
 *
 * The check is load-bearing, not defensive dressing. With the #1875 redirect rolled back
 * (`SHEPHERD_AGENT_TMPDIR=""`) the path is a fixed, guessable `<os.tmpdir()>/spawn` in a
 * world-writable parent, and `mkdir(…, {recursive: true, mode})` silently accepts a pre-existing
 * directory WITHOUT applying the mode. So a local user could pre-create (or symlink) that directory,
 * then unlink our 0600 script and substitute their own between our write and the pane's `sh` opening
 * it — arbitrary code as the Shepherd user. The `wx` flag on the file cannot help: it guards only
 * the final component, inside a directory the attacker controls.
 *
 * Squatted path → fall back to a fresh `mkdtemp` directory (unpredictable name, 0700, ours by
 * construction), memoized so a hostile `/tmp/spawn` cannot make us mint one per spawn. Refusing
 * outright would hand any local user a spawn-wide denial of service instead.
 *
 * EVERY way the path can be occupied has to route into that fallback, which is why the `mkdir` is
 * inside the `try`: recursive `mkdir` swallows `EEXIST` only when the existing entry is a real
 * DIRECTORY (verified against the runtime — a plain file, a symlink to a file and a dangling symlink
 * all throw). Letting that throw would mean a local user could `touch /tmp/spawn` and permanently
 * fail every spawn — the very denial of service the fallback exists to prevent, reachable by the
 * cheapest possible squat.
 */
async function ensureSpawnDir(): Promise<string> {
  const dir = spawnScriptDir();
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await isOwnPrivateDir(dir)) return dir;
  } catch {
    /* occupied by a non-directory (or uncreatable) — the fallback below is the answer */
  }
  return privateFallbackDir();
}

/**
 * The POSIX script that launches `wrapped`. Two lines carry the whole contract:
 *
 *  - `rm -f -- "$0"` — self-delete. The shell holds an open fd, so the script stays readable after
 *    the unlink and leaves nothing behind. Retry-safe: both drivers only retry a run that was
 *    REJECTED before execution, so a script that has not launched is still on disk for the retry.
 *  - `exec` — mandatory, not cosmetic. Without it `sh` survives as the pane's foreground process and
 *    herdr detects `sh` instead of the agent.
 */
export function buildSpawnScript(wrapped: string[]): string {
  return [
    "#!/bin/sh",
    "# Shepherd spawn transport (#1967) — typed into the pane as `sh <path>` so the line stays",
    "# under the tty's canonical-mode MAX_INPUT. Self-deletes, then execs so the pane's foreground",
    "# process is the agent itself.",
    'rm -f -- "$0"',
    `exec ${posixShellJoin(wrapped)}`,
    "",
  ].join("\n");
}

/** How long a script may sit before it is presumed abandoned. Two orders of magnitude above the
 *  30s spawn deadline, so a script still waiting to be read can never be reaped out from under a
 *  pane. */
const STALE_SCRIPT_MS = 60 * 60 * 1000;

/**
 * Best-effort reap of scripts that were written but never ran — a spawn whose `pane run` failed
 * every attempt leaves one behind, since the self-delete only fires when the script executes.
 * Without this they accrete in the agent tmp root: exactly the directory whose inode table Shepherd
 * has exhausted before (#560/#1875).
 *
 * Deliberately silent and non-blocking on failure: cleanup must never be the reason a spawn fails.
 * Runs on the next spawn rather than on a timer, so it costs one `readdir` per spawn and needs no
 * lifecycle wiring.
 */
async function reapStaleScripts(dir: string, now: number): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith("spawn-") || !name.endsWith(".sh")) continue;
      const path = join(dir, name);
      try {
        if (now - (await stat(path)).mtimeMs > STALE_SCRIPT_MS) await rm(path, { force: true });
      } catch {
        /* raced with the script's own self-delete — nothing to do */
      }
    }
  } catch {
    /* unreadable dir — a spawn must not fail because cleanup could not run */
  }
}

/**
 * Write {@link buildSpawnScript} to a fresh file and return its path. Async fs throughout: Shepherd
 * is one Bun loop pumping the web terminal, and sync fs on it stalls typing.
 *
 * Mode 0600 inside the verified-private directory {@link ensureSpawnDir} hands back, because the
 * script carries the full spawn command, including caller-supplied env tokens such as
 * `CLAUDE_CONFIG_DIR`. The name is random rather than pane-derived so it stays short (every byte
 * lands in the typed line) and can never collide across concurrent spawns, and the write is `wx`
 * (exclusive create) so it always lands on a fresh file of ours — never through a pre-placed
 * symlink, and never truncating an existing one whose mode we would not have set.
 *
 * The script is deliberately NOT made executable: it is handed to `sh` as an argument, so it also
 * runs from a `noexec` mount.
 */
export async function writeSpawnScript(wrapped: string[]): Promise<string> {
  const dir = await ensureSpawnDir();
  await reapStaleScripts(dir, Date.now());
  const path = join(dir, `spawn-${randomBytes(6).toString("hex")}.sh`);
  await writeFile(path, buildSpawnScript(wrapped), { mode: 0o600, flag: "wx" });
  return path;
}

/** The command line typed into the pane for `wrapped` — `sh '<script path>'`. Both ≥0.7.5 drivers
 *  route through this, so the two transports stay one behavior. */
export async function spawnCommandLine(wrapped: string[]): Promise<string> {
  return posixShellJoin(["sh", await writeSpawnScript(wrapped)]);
}
