// Heavy-run scopes (#3555): every heavy check the slot lets run gets its own transient systemd scope
// with a hard memory limit, so an OOM kill takes out that run — not herdr.service, not the agent's
// own scope, not another session.
//
// The scope is started SERVER-side with D-Bus `StartTransientUnit` (via `busctl --user`) and the
// run's host PIDs: inside the sandbox membrane `systemd-run` cannot reach the user bus, and
// `AttachProcessesToUnit` is refused for non-delegated scopes. So the runner (scripts/heavy-slot.mjs)
// starts its command behind a gate, the server moves the gated process, and only then does the
// command exec — everything it forks is born inside the scope.
//
// Shape (live-probed on systemd 262):
//   - `MemoryMax` + `MemorySwapMax=0`, no `MemoryHigh`: a soft limit without swap stalls the run
//     instead of killing it, and without a swap cap the run spills into swap instead.
//   - `OOMPolicy=stop`: the whole run stops — no orphaned browsers or workers — and the unit's
//     `Result=oom-kill` tells the agent why. No `CollectMode`: the failed unit lingers until
//     {@link heavyScopeOutcome} has read it and reset it.
//   - Slice `shepherd_agents-heavy.slice` nests under `shepherd_agents.slice` (dash = child), so
//     herdr's ExecStopPost, which stops the agents slice, stops heavy runs too.
//
// Enabled only where agent scopes are (src/agent-scope.ts) and `busctl` runs. Everywhere else the
// latch stays false and the runner path is unchanged.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { agentScopeEnabled } from "./agent-scope";
import { DIAGNOSTICS_PROBE_TIMEOUT_MS } from "./config";

export const HEAVY_SCOPE_SLICE = "shepherd_agents-heavy.slice";

const UNIT_PREFIX = "shepherd-heavy-";
const MOVE_WAIT_MS = 2_000;
const OUTCOME_WAIT_MS = 2_000;
const POLL_MS = 50;

export type HeavyScopeOutcome = "oom" | "ok" | "unknown";

export interface HeavyScopeDeps {
  platform?: NodeJS.Platform;
  /** Run a binary; resolve stdout, reject on non-zero exit / timeout. */
  run?: (bin: string, args: string[]) => Promise<string>;
  /** `/proc/<pid>/cgroup`; reject when the process is gone. */
  readCgroup?: (pid: number) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const execFileAsync = promisify(execFile);

async function defaultRun(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    encoding: "utf8",
    timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS,
  });
  return stdout.toString();
}

function resolve(deps: HeavyScopeDeps) {
  return {
    run: deps.run ?? defaultRun,
    readCgroup: deps.readCgroup ?? ((pid: number) => readFile(`/proc/${pid}/cgroup`, "utf8")),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
  };
}

/** The scope unit of a job; null for an id that is not a plain UUID-like token. */
export function heavyScopeUnit(jobId: string): string | null {
  return /^[A-Za-z0-9-]{1,64}$/.test(jobId) ? `${UNIT_PREFIX}${jobId}.scope` : null;
}

/** The exact `busctl` argv that starts the scope around `pids`. */
export function startTransientArgv(unit: string, pids: readonly number[], maxBytes: number) {
  const props: string[][] = [
    ["PIDs", "au", String(pids.length), ...pids.map(String)],
    ["Slice", "s", HEAVY_SCOPE_SLICE],
    ["Description", "s", "Shepherd heavy check (#3555)"],
    ["MemoryMax", "t", String(Math.floor(maxBytes))],
    ["MemorySwapMax", "t", "0"],
    ["OOMPolicy", "s", "stop"],
  ];
  return [
    "--user",
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    unit,
    "fail",
    String(props.length),
    ...props.flat(),
    "0",
  ];
}

/**
 * Start the job's scope around `pids` and wait until the first one is inside it (the move runs as
 * a systemd job, after the D-Bus reply). False on any failure — the run then goes on unscoped.
 */
export async function startHeavyScope(
  jobId: string,
  pids: readonly number[],
  maxBytes: number,
  deps: HeavyScopeDeps = {},
): Promise<boolean> {
  const unit = heavyScopeUnit(jobId);
  const valid = pids.length > 0 && pids.every((p) => Number.isInteger(p) && p > 0);
  if (!unit || !valid || !(maxBytes > 0)) return false;
  const { run, readCgroup, sleep, now } = resolve(deps);
  try {
    await run("busctl", startTransientArgv(unit, pids, maxBytes));
  } catch {
    return false;
  }
  const deadline = now() + MOVE_WAIT_MS;
  for (;;) {
    const cgroup = await readCgroup(pids[0]!).catch(() => null);
    if (cgroup === null) return false;
    if (cgroup.includes(`/${unit}`)) return true;
    if (now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * How the job's scope ended: `oom` when systemd stopped it for an OOM kill. Waits briefly while it
 * is still stopping (the runner can report its exit before systemd settles the unit), then resets
 * the unit so a failed one doesn't linger.
 */
export async function heavyScopeOutcome(
  jobId: string,
  deps: HeavyScopeDeps = {},
): Promise<HeavyScopeOutcome> {
  const unit = heavyScopeUnit(jobId);
  if (!unit) return "unknown";
  const { run, sleep, now } = resolve(deps);
  const deadline = now() + OUTCOME_WAIT_MS;
  let outcome: HeavyScopeOutcome = "unknown";
  for (;;) {
    const props = await run("systemctl", [
      "--user",
      "show",
      "-p",
      "Result,ActiveState,LoadState",
      unit,
    ]).catch(() => "");
    const value = (key: string) => props.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
    const active = value("ActiveState");
    if (value("Result") === "oom-kill") {
      outcome = "oom";
      break;
    }
    if (value("LoadState") === "not-found" || active === "inactive" || active === "failed") {
      outcome = value("LoadState") === "loaded" ? "ok" : "unknown";
      break;
    }
    if (!props || now() >= deadline) break;
    await sleep(POLL_MS * 2);
  }
  await run("systemctl", ["--user", "reset-failed", unit]).catch(() => "");
  return outcome;
}

/** Boot: reset the failed scopes a restart left behind (their outcome is no longer wanted). */
export async function reapHeavyScopes(deps: HeavyScopeDeps = {}): Promise<void> {
  const { run } = resolve(deps);
  await run("systemctl", ["--user", "reset-failed", `${UNIT_PREFIX}*.scope`]).catch(() => "");
}

let enabled = false;

/** Latch the gate: agent scopes on (provisioned Linux host) and `busctl` runs. */
export async function refreshHeavyScope(
  deps: HeavyScopeDeps & { agentScopes?: () => boolean } = {},
): Promise<boolean> {
  enabled = false;
  if ((deps.platform ?? process.platform) !== "linux") return false;
  if (!(deps.agentScopes ?? agentScopeEnabled)()) return false;
  try {
    await resolve(deps).run("busctl", ["--version"]);
    enabled = true;
  } catch {
    enabled = false;
  }
  return enabled;
}

/** Synchronous read for the acquire path. Cold ⇒ false. */
export function heavyScopeEnabled(): boolean {
  return enabled;
}

/** Test-only: drop the latch so each case starts cold. */
export function __resetHeavyScope(): void {
  enabled = false;
}
