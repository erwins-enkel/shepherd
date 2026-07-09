import type { IncusDriver } from "./incus";
import type { DiagnosticsSnapshot } from "../../src/types";

const SHEPHERD_DIR = "/opt/shepherd";
const PORT = 7330; // config.port default
const BOOT_POLL_CEILING = 120; // seconds the poll waits for the HTTP API (was 60 — too tight on a slow/cold instance)
const SHEPHERD_LOG = "/var/log/shepherd.log"; // detached server's stdout+stderr
const LOG_TAIL_LINES = 60; // lines of the boot log appended to a failure message

/** Operator bearer token the harness boots Shepherd with so it can read the GATED
 *  diagnostics snapshot. Single-operator auth (#1079/#1081) gates the whole `/api/*`
 *  surface once `config.cookieSecret` is bootstrapped (always, at boot), so an
 *  un-credentialed `/api/diagnostics` now 401s. The harness owns both ends — it sets
 *  `SHEPHERD_TOKEN` (→ `config.token`) on the booted server (or the unit's
 *  `~/.shepherd/env`) and sends `Authorization: Bearer ${HARNESS_TOKEN}` on the
 *  snapshot probe (checkAuth's bearer branch). Liveness uses the public `/api/health`
 *  and needs NO token. A fixed in-repo constant is correct here: this is test infra,
 *  not a secret, and timing-safe compare only needs the two ends to match. #1112 */
export const HARNESS_TOKEN = "onboarding-harness-probe-token";

/** Start Shepherd detached inside the instance and poll until its HTTP API
 *  answers (or time out). Degraded boots are expected — we only need the server
 *  process up far enough to serve `/api/diagnostics`.
 *
 *  AUTH (#1112): single-operator auth (#1079/#1081) gates `/api/*`, so the boot poll
 *  hits the PUBLIC liveness route `/api/health` (pollApiCmd) — no credential — and the
 *  GATED diagnostics snapshot (probeDiagnostics) is authorized by a bearer token. We
 *  therefore boot WITH `SHEPHERD_TOKEN=${HARNESS_TOKEN}` set (NOT unset) so the server's
 *  `config.token` matches the `Authorization: Bearer` header the snapshot probe sends. */
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
  // - SHEPHERD_TOKEN=${HARNESS_TOKEN}: set (not unset) so the gated diagnostics probe
  //   authorizes via `Authorization: Bearer` (single-operator auth #1081). #1112
  const launch = (redirect: ">" | ">>"): string =>
    `cd ${SHEPHERD_DIR} && setsid env SHEPHERD_TOKEN=${HARNESS_TOKEN} ` +
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

/** Boot Shepherd in the FOREGROUND expecting the #1313 herdr fail-fast, and return
 *  its exit code + combined output. Used only by the `herdr-missing` runner: with
 *  herdr removed, preflight prints the banner and exits 78 BEFORE binding the HTTP
 *  server, so there is nothing to poll — we capture the process's exit directly.
 *
 *  Mirrors `bootShepherd`'s launch env exactly (same `cd`, `~/.bun/bin/bun
 *  src/index.ts`, and PATH ordering) so the ONLY behavioral difference from a real
 *  boot is the removed herdr. It intentionally OMITS `SHEPHERD_TOKEN` (which
 *  `bootShepherd` sets): harmless, because preflight runs and exits before any
 *  token/auth/store use and this path never reaches the server. `timeout 30` is a
 *  defensive guard — the caller must treat ONLY exit 78 as the expected fail-fast
 *  (timeout's 124, or any other code, means Shepherd did NOT fail-fast). */
export async function bootExpectingPreflightExit(
  driver: IncusDriver,
  name: string,
): Promise<{ code: number; output: string }> {
  const r = await driver.exec(name, [
    "sh",
    "-c",
    `cd ${SHEPHERD_DIR} && timeout 30 env PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" ` +
      `~/.bun/bin/bun src/index.ts 2>&1`,
  ]);
  return { code: r.code, output: r.stdout };
}

/** The poll command shared by the manual-boot retry path and `waitForApi`: poll
 *  the server until it answers or the ceiling elapses (degraded boots are expected —
 *  we only need the process up far enough to serve HTTP). Hits the PUBLIC `/api/health`
 *  liveness route (#1112): single-operator auth (#1081) gates `/api/diagnostics`, so an
 *  un-credentialed poll of it now 401s and `curl -sf` would never succeed; health is
 *  auth-exempt and needs no token. */
const pollApiCmd = (): string =>
  `for i in $(seq 1 ${BOOT_POLL_CEILING}); do curl -sf localhost:${PORT}/api/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`;

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

/** Best-effort `systemctl status` tail for a unit, formatted for appending to an assertion
 *  failure. Returns "" on any capture problem so it can never mask the original failure. */
async function unitStatusDetail(driver: IncusDriver, name: string, unit: string): Promise<string> {
  try {
    const s = await driver.exec(name, [
      "sh",
      "-c",
      `XDG_RUNTIME_DIR=/run/user/0 systemctl --user status ${unit} --no-pager -l -n 30 2>&1 || true`,
    ]);
    const out = s.stdout.trim();
    return out ? `\n--- systemctl status ${unit} ---\n${out}` : "";
  } catch {
    return "";
  }
}

/** Assert a systemd USER unit is `active` (the lifecycle scenario's proof that the service
 *  path — not a hand-rolled boot — owns the process). `XDG_RUNTIME_DIR=/run/user/0` is
 *  required for `systemctl --user` to reach the user bus inside an `incus exec` session
 *  (no login session sets it).
 *
 *  Asserting `herdr` too is load-bearing, not decorative: a `herdr: ok` diagnostic only
 *  proves SOME daemon answers the socket. If provision left an unsupervised daemon there,
 *  the unit's ExecStart exits 1 ("already running") and `Restart=always` thrashes it into
 *  `failed` — while the check stays green and the host silently has no supervised daemon.
 *  Only the unit's own state can catch that. #1574 */
export async function assertUnitActive(
  driver: IncusDriver,
  name: string,
  unit = "shepherd",
): Promise<void> {
  const r = await driver.exec(name, [
    "sh",
    "-c",
    `XDG_RUNTIME_DIR=/run/user/0 systemctl --user is-active ${unit}`,
  ]);
  if (r.stdout.trim() !== "active") {
    // A bare "not active: failed" is undiagnosable from CI logs. Attach the unit's status +
    // recent journal so the FIRST red run says why (ExecStart missing? crash-looped? bound
    // socket?). Best-effort: a capture failure must never mask the assertion failure.
    const detail = await unitStatusDetail(driver, name, unit);
    throw new Error(`${unit} user unit not active in ${name}: ${r.stdout || r.stderr}${detail}`);
  }
}

/** Capture a fresh diagnostics snapshot from inside the instance. `/api/diagnostics`
 *  is GATED by single-operator auth (#1081), so authorize with the operator bearer the
 *  harness boots Shepherd with (HARNESS_TOKEN → config.token). #1112 */
export async function probeDiagnostics(
  driver: IncusDriver,
  name: string,
): Promise<DiagnosticsSnapshot> {
  const r = await driver.exec(name, [
    "sh",
    "-c",
    `curl -s -H "Authorization: Bearer ${HARNESS_TOKEN}" localhost:${PORT}/api/diagnostics?refresh=1`,
  ]);
  if (r.code !== 0 || !r.stdout.trim()) {
    throw new Error(`diagnostics probe failed in ${name}: ${r.stderr || "empty"}`);
  }
  return JSON.parse(r.stdout) as DiagnosticsSnapshot;
}
