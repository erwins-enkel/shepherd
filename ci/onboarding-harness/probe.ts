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
  await driver.exec(name, [
    "sh",
    "-c",
    `cd ${SHEPHERD_DIR} && env -u SHEPHERD_TOKEN nohup ~/.bun/bin/bun run start >/var/log/shepherd.log 2>&1 &`,
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
