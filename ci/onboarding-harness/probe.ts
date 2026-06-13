import type { IncusDriver } from "./incus";
import type { DiagnosticsSnapshot } from "../../src/types";

const SHEPHERD_DIR = "/opt/shepherd";
const PORT = 7330; // config.port default

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
  // - `bun src/index.ts`, NOT `bun run start`: the `start` package-script spawns a
  //   nested BARE `bun`, which the non-login exec PATH can't resolve ("bun: not
  //   found"). Running the entry file directly avoids the indirection.
  // - `setsid`: a plain `nohup … &` child is reaped when the `incus exec` session
  //   closes; setsid detaches it into its own session so the server outlives exec.
  // - PATH adds ~/.local/bin + ~/.bun/bin so binaries a remediation installs there
  //   (node symlink, claude, herdr) are visible to the running server's probes,
  //   which resolve each tool via PATH on every `?refresh=1`.
  await driver.exec(name, [
    "sh",
    "-c",
    `cd ${SHEPHERD_DIR} && setsid env -u SHEPHERD_TOKEN ` +
      `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" ` +
      `~/.bun/bin/bun src/index.ts >/var/log/shepherd.log 2>&1 </dev/null &`,
  ]);
  const poll = await driver.exec(name, [
    "sh",
    "-c",
    `for i in $(seq 1 60); do curl -sf localhost:${PORT}/api/diagnostics >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`,
  ]);
  if (poll.code !== 0) throw new Error(`Shepherd did not come up in ${name}`);
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
