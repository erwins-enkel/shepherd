import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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

/**
 * Write {@link buildSpawnScript} to a fresh file and return its path. Async fs throughout: Shepherd
 * is one Bun loop pumping the web terminal, and sync fs on it stalls typing.
 *
 * Mode 0600 (dir 0700) because the script carries the full spawn command, including caller-supplied
 * env tokens such as `CLAUDE_CONFIG_DIR`. The name is random rather than pane-derived so it stays
 * short (every byte lands in the typed line) and can never collide across concurrent spawns, and
 * the write is `wx` (exclusive create) so it always lands on a fresh file of ours — never through a
 * pre-placed symlink, and never truncating an existing one whose mode we would not have set.
 *
 * The script is deliberately NOT made executable: it is handed to `sh` as an argument, so it also
 * runs from a `noexec` mount.
 */
export async function writeSpawnScript(wrapped: string[]): Promise<string> {
  const dir = spawnScriptDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `spawn-${randomBytes(6).toString("hex")}.sh`);
  await writeFile(path, buildSpawnScript(wrapped), { mode: 0o600, flag: "wx" });
  return path;
}

/** The command line typed into the pane for `wrapped` — `sh '<script path>'`. Both ≥0.7.5 drivers
 *  route through this, so the two transports stay one behavior. */
export async function spawnCommandLine(wrapped: string[]): Promise<string> {
  return posixShellJoin(["sh", await writeSpawnScript(wrapped)]);
}
