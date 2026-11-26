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

import { readdir, readFile } from "node:fs/promises";
import { DIAGNOSTICS_PROBE_TIMEOUT_MS } from "./config";
import { execFileAsync } from "./instrument";
import { SESSION_MARKER_ENV } from "./process-reaper";

/** The slice agent scopes run in. Underscore, not dash: `shepherd-agents.slice` would nest under
 *  `shepherd.slice`, which operators may limit for herdr.service + shepherd.service together. */
export const AGENT_SLICE = "shepherd_agents.slice";
/** herdr's drop-in that ties the slice's lifetime to the daemon (deploy/herdr.service.d/). */
export const AGENT_SCOPE_DROPIN = "99-shepherd.conf";

const SCOPE_BIN = "systemd-run";

/** The argv every agent spawn is prefixed with while the gate is open. `OOMPolicy=continue`: a
 *  kernel OOM kill of one process (a dev server, a test) must not stop the scope and with it the
 *  whole session. `--expand-environment=no`: systemd-run otherwise expands `${VAR}` in every
 *  argument (ExecStart= rules), blanking shell parameter expansions (the agent-secrets launcher) and
 *  prompt text alike. Needs systemd v254+; an older one fails the probe and the gate stays shut. */
export function agentScopePrefix(): string[] {
  return [SCOPE_BIN, ...scopeArgs()];
}

function scopeArgs(): string[] {
  return [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--expand-environment=no",
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

/** The name `systemd-run --scope` gives a scope it was not told to name: `run-p<its own pid>-i<n>`.
 *  That pid execs in place into the agent, so it IS the scope's main process. */
const AUTO_SCOPE_RE = /^run-p(\d+)-i\d+\.scope$/;
/** Per-scope cap on environ reads when matching a session marker. */
const MAX_MARKER_READS = 64;

export interface StopAgentScopesDeps extends AgentScopeDeps {
  readDir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
}

/** The pids in a cgroup.procs file. */
function parsePids(text: string): number[] {
  return text
    .split("\n")
    .filter((l) => /^\d+$/.test(l))
    .map(Number);
}

/** Does any of `pids` carry `SHEPHERD_SESSION_ID=<sessionId>` exactly in its environ? */
async function carriesMarker(
  pids: number[],
  sessionId: string,
  read: (path: string) => Promise<string>,
): Promise<boolean> {
  const entry = `${SESSION_MARKER_ENV}=${sessionId}`;
  for (const pid of pids.slice(0, MAX_MARKER_READS)) {
    // best-effort: a process gone or not ours reads as "no marker"
    const environ = await read(`/proc/${pid}/environ`).catch(() => "");
    if (environ.split("\0").includes(entry)) return true;
  }
  return false;
}

/** Should `unit` (a dirent of the slice's cgroup dir) be stopped? See {@link stopAgentScopes}. */
async function scopeEnded(
  sliceDir: string,
  unit: string,
  sessionId: string | undefined,
  read: (path: string) => Promise<string>,
): Promise<boolean> {
  const main = AUTO_SCOPE_RE.exec(unit)?.[1];
  if (!main) return false;
  // best-effort: a scope collected mid-sweep simply drops out
  const procs = parsePids(await read(`${sliceDir}/${unit}/cgroup.procs`).catch(() => ""));
  if (procs.length === 0) return false;
  if (!procs.includes(Number(main))) return true;
  return !!sessionId && (await carriesMarker(procs, sessionId, read));
}

/**
 * Stop agent scopes that outlived their agent (#4039). The slice's ExecStopPost only fires when
 * herdr stops, so without this a scope whose agent died keeps every dev server, browser and test
 * runner the agent started — for weeks.
 *
 * Selects auto-named scopes (`run-p<pid>-i<n>.scope`) directly under `shepherd_agents.slice` —
 * never the heavy-run slice or anything else in it — and stops one when:
 *  - its main pid is no longer in its `cgroup.procs` (the agent is gone; a recycled pid lives in
 *    another cgroup, and a recycle INSIDE the scope spares it — the safe direction), or
 *  - `sessionId` is given (archive) and one of its processes carries that session's marker, which
 *    covers an agent still dying after `herdr.stop`.
 * Empty scopes are skipped: systemd collects those itself.
 *
 * One `systemctl --user stop --no-block` (SIGTERM, then SIGKILL after the unit's stop timeout).
 * Best-effort throughout: never throws; returns the units it asked systemd to stop.
 */
export async function stopAgentScopes(
  opts: { sessionId?: string } = {},
  deps: StopAgentScopesDeps = {},
): Promise<string[]> {
  if ((deps.platform ?? process.platform) !== "linux") return [];
  const run = deps.run ?? defaultRun;
  const readDir = deps.readDir ?? ((path: string) => readdir(path));
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  try {
    const cgroup = await showValue(run, AGENT_SLICE, "ControlGroup");
    if (!cgroup.startsWith("/")) return [];
    const sliceDir = `/sys/fs/cgroup${cgroup}`;
    const stop: string[] = [];
    for (const unit of await readDir(sliceDir)) {
      if (await scopeEnded(sliceDir, unit, opts.sessionId, read)) stop.push(unit);
    }
    if (stop.length > 0) await run("systemctl", ["--user", "stop", "--no-block", "--", ...stop]);
    return stop;
  } catch {
    return []; // best-effort: no slice, no user bus, or systemctl refused — the next sweep retries
  }
}

/** Test-only: drop the latch so each case starts cold. */
export function __resetAgentScope(): void {
  enabled = false;
}

/** Test-only: force the latch (exercises `buildWrappedArgv` without a host probe). */
export function __setAgentScope(value: boolean): void {
  enabled = value;
}
