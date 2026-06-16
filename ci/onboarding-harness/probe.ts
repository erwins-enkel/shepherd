import type { IncusDriver } from "./incus";
import type { DiagnosticsSnapshot } from "../../src/types";

const SHEPHERD_DIR = "/opt/shepherd";
const PORT = 7330; // config.port default
const BOOT_POLL_CEILING = 120; // seconds the poll waits for the HTTP API (was 60 — too tight on a slow/cold instance)
const SHEPHERD_LOG = "/var/log/shepherd.log"; // detached server's stdout+stderr
const LOG_TAIL_LINES = 60; // lines of the boot log appended to a failure message

/** Start Shepherd detached inside the instance and poll until its HTTP API
 *  answers (or time out). Degraded boots are expected — we only need the server
 *  process up far enough to serve `/api/diagnostics`.
 *
 *  AUTH (point 7): `GET /api/diagnostics` passes through `checkAuth`, which only
 *  authorizes when `config.token` (`SHEPHERD_TOKEN`) is null. We boot with the
 *  var explicitly UNSET (`env -u SHEPHERD_TOKEN`) so the plain `curl` probe below
 *  is authorized — the harness controls the env, so this is safe and the simplest
 *  correct option. (If a future scenario needs a token, the probe must add
 *  `-H "Authorization: Bearer $SHEPHERD_TOKEN"` instead.) */
export async function bootShepherd(driver: IncusDriver, name: string): Promise<void> {
  // The launch command. `redirect` is the shell redirect for the server's log:
  // - `>`  truncates — the FIRST launch starts a clean log.
  // - `>>` appends — a RETRY launch keeps the first crash's log instead of clobbering it.
  // Notes on the command itself:
  // - `bun src/index.ts`, NOT `bun run start`: the `start` package-script spawns a
  //   nested BARE `bun`, which the non-login exec PATH can't resolve ("bun: not
  //   found"). Running the entry file directly avoids the indirection.
  // - `setsid`: a plain `nohup … &` child is reaped when the `incus exec` session
  //   closes; setsid detaches it into its own session so the server outlives exec.
  // - PATH adds ~/.local/bin + ~/.bun/bin so binaries a remediation installs there
  //   (node symlink, claude, herdr) are visible to the running server's probes,
  //   which resolve each tool via PATH on every `?refresh=1`.
  const launch = (redirect: ">" | ">>"): string =>
    `cd ${SHEPHERD_DIR} && setsid env -u SHEPHERD_TOKEN ` +
    `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" ` +
    `~/.bun/bin/bun src/index.ts ${redirect}${SHEPHERD_LOG} 2>&1 </dev/null &`;

  await driver.exec(name, ["sh", "-c", launch(">")]);
  let poll = await driver.exec(name, ["sh", "-c", pollApiCmd()]);

  if (poll.code !== 0) {
    // First boot didn't answer. A transient boot flake is worth ONE retry — but
    // only if the server actually died, never while something is still listening
    // (a slow/hung boot we'd otherwise double-launch into a port conflict).
    //
    // Liveness via the PORT, NOT pgrep: `pgrep -f 'src/index.ts'` self-matches its
    // own wrapping `sh -c` argv and always reports "alive", making the retry dead
    // code. Instead probe the port: curl exit 7 (CURLE_COULDNT_CONNECT) = connection
    // refused ⇒ nothing listening ⇒ server died ⇒ guard exits 0. Any other outcome
    // (exit 0 = connected; 28 = connected-then-timeout/hung) ⇒ port occupied ⇒
    // non-zero ⇒ do NOT relaunch.
    const guard = await driver.exec(name, [
      "sh",
      "-c",
      `curl -s -o /dev/null --max-time 2 localhost:${PORT}/; [ $? -eq 7 ]`,
    ]);
    if (guard.code === 0) {
      // Port free ⇒ server died. Relaunch ONCE, appending to the log so the first
      // crash's output survives, then poll again on the same ceiling.
      await driver.exec(name, ["sh", "-c", launch(">>")]);
      poll = await driver.exec(name, ["sh", "-c", pollApiCmd()]);
    }
  }

  if (poll.code !== 0) {
    // Boot failed after the (at most one) retry. Surface the boot log's tail so the
    // failure is diagnosable — but capture must NEVER mask the original failure:
    // the bare message survives a missing/empty log or any error capturing it.
    const base = `Shepherd did not come up in ${name}`;
    throw new Error(await withLogTail(driver, name, base));
  }
}

/** The poll command shared by the manual-boot retry path and `waitForApi`: poll
 *  the HTTP API until it answers or the ceiling elapses (degraded boots are
 *  expected — we only need the server up far enough to serve /api/diagnostics). */
const pollApiCmd = (): string =>
  `for i in $(seq 1 ${BOOT_POLL_CEILING}); do curl -sf localhost:${PORT}/api/diagnostics >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`;

/** Best-effort: append a tail of the boot log to `base`. On any failure (exec
 *  throws, non-zero, or empty/whitespace-only log) returns the bare `base` so the
 *  original boot failure is never masked by a capture problem. */
async function withLogTail(driver: IncusDriver, name: string, base: string): Promise<string> {
  try {
    const t = await driver.exec(name, [
      "sh",
      "-c",
      `tail -n ${LOG_TAIL_LINES} ${SHEPHERD_LOG} 2>/dev/null`,
    ]);
    const log = t.stdout.trim();
    if (t.code !== 0 || !log) return `${base} (log empty/unavailable)`;
    return `${base}\n--- tail ${SHEPHERD_LOG} ---\n${log}`;
  } catch {
    return base;
  }
}

/** Poll Shepherd's HTTP API until `/api/diagnostics` answers (or time out). Shared
 *  by the manual-boot path (`bootShepherd`) and the systemd-lifecycle path, which
 *  has the unit own the process and only needs to wait for it to serve. Uses the
 *  same ${BOOT_POLL_CEILING}s ceiling as the manual boot (60s was too tight on a
 *  slow/cold instance). */
export async function waitForApi(driver: IncusDriver, name: string): Promise<void> {
  const poll = await driver.exec(name, ["sh", "-c", pollApiCmd()]);
  if (poll.code !== 0) throw new Error(`Shepherd did not come up in ${name}`);
}

/** Assert the `shepherd` systemd USER unit is `active` (the lifecycle scenario's
 *  proof that the service path — not a hand-rolled boot — owns the process).
 *  `XDG_RUNTIME_DIR=/run/user/0` is required for `systemctl --user` to reach the
 *  user bus inside an `incus exec` session (no login session sets it). */
export async function assertUnitActive(driver: IncusDriver, name: string): Promise<void> {
  const r = await driver.exec(name, [
    "sh",
    "-c",
    "XDG_RUNTIME_DIR=/run/user/0 systemctl --user is-active shepherd",
  ]);
  if (r.stdout.trim() !== "active") {
    throw new Error(`shepherd user unit not active in ${name}: ${r.stdout || r.stderr}`);
  }
}

/** Capture a fresh diagnostics snapshot from inside the instance. */
export async function probeDiagnostics(
  driver: IncusDriver,
  name: string,
): Promise<DiagnosticsSnapshot> {
  const r = await driver.exec(name, [
    "sh",
    "-c",
    `curl -s localhost:${PORT}/api/diagnostics?refresh=1`,
  ]);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error(`diagnostics probe failed in ${name}: ${r.stderr || "empty"}`);
  }
  return JSON.parse(r.stdout) as DiagnosticsSnapshot;
}
