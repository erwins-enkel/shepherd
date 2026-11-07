// Agent scopes (#3128): run every agent spawn in its own transient systemd scope under the
// repo-shipped `shepherd_agents.slice` (deploy/shepherd_agents.slice), so agent workloads — claude
// plus every dev server, build and test it starts — are charged to that slice's memory/task limits
// instead of herdr.service. Without this they share herdr's cgroup, and a memory-full herd throttles
// the herdr daemon along with them (#3127).
//
// `systemd-run --scope` execs the command IN PLACE (same PID, parent = the pane shell), so herdr's
// PTY, foreground detection and auto-detect see exactly the process they saw before; only the
// cgroup differs.
//
// Enabled only on a host where provisioning installed BOTH halves: the slice unit file (limits) and
// herdr's `99-shepherd.conf` drop-in, whose ExecStopPost stops the slice so agents still die with the
// server. Everywhere else — macOS, non-systemd Linux, a hand-rolled install — the gate stays false and
// the spawn argv is byte-identical to before.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DIAGNOSTICS_PROBE_TIMEOUT_MS } from "./config";

/** The slice agent scopes run in. Underscore, not dash: `shepherd-agents.slice` would nest under
 *  `shepherd.slice`, which operators may limit for herdr.service + shepherd.service together. */
export const AGENT_SLICE = "shepherd_agents.slice";
/** herdr's drop-in that ties the slice's lifetime to the daemon (deploy/herdr.service.d/). */
export const AGENT_SCOPE_DROPIN = "99-shepherd.conf";

const SCOPE_BIN = "systemd-run";

/** The argv every agent spawn is prefixed with while the gate is open. `OOMPolicy=continue`: a
 *  kernel OOM kill of one process (a dev server, a test) must not stop the scope and with it the
 *  whole session. */
export function agentScopePrefix(): string[] {
  return [SCOPE_BIN, ...scopeArgs()];
}

function scopeArgs(): string[] {
  return [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--slice=${AGENT_SLICE}`,
    "-p",
    "OOMPolicy=continue",
    "--",
  ];
}

export interface AgentScopeDeps {
  platform?: NodeJS.Platform;
  /** Run a binary; resolve stdout, reject on non-zero exit / timeout. */
  run?: (bin: string, args: string[]) => Promise<string>;
}

const execFileAsync = promisify(execFile);

async function defaultRun(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: "utf8",
    timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS,
  });
  return stdout.toString();
}

/** `systemctl --user show -p <prop> --value <unit>`, trimmed. */
function showValue(
  run: (bin: string, args: string[]) => Promise<string>,
  unit: string,
  prop: string,
): Promise<string> {
  return run("systemctl", ["--user", "show", "-p", prop, "--value", unit]).then((s) => s.trim());
}

let enabled = false;

/** Probe the host and latch the gate. Order matters: the unit-file checks run BEFORE the
 *  `systemd-run` probe, because starting a scope in a slice creates the slice implicitly — and a
 *  fragment-less slice still reports `LoadState=loaded`, so only `FragmentPath` proves the shipped
 *  unit (and its limits) is installed. The probe runs the EXACT spawn prefix, so a systemd that
 *  rejects a scope property (`OOMPolicy=` on scopes needs v253+) fails here, not in every pane. */
export async function refreshAgentScope(deps: AgentScopeDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  enabled = false;
  if (platform !== "linux") return false;
  try {
    const fragment = await showValue(run, AGENT_SLICE, "FragmentPath");
    if (!fragment) return false;
    const dropIns = await showValue(run, "herdr.service", "DropInPaths");
    const tied = dropIns
      .split(/\s+/)
      .some((p) => p.endsWith(`/herdr.service.d/${AGENT_SCOPE_DROPIN}`));
    if (!tied) return false;
    await run(SCOPE_BIN, [...scopeArgs(), "true"]);
    enabled = true;
  } catch {
    enabled = false;
  }
  return enabled;
}

/** Synchronous read for the spawn path (`buildWrappedArgv` must never probe). Cold ⇒ false. */
export function agentScopeEnabled(): boolean {
  return enabled;
}

/** Test-only: drop the latch so each case starts cold. */
export function __resetAgentScope(): void {
  enabled = false;
}

/** Test-only: force the latch (exercises `buildWrappedArgv` without a host probe). */
export function __setAgentScope(value: boolean): void {
  enabled = value;
}
