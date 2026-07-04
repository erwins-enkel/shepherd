import { spawnSync } from "node:child_process";
import { config } from "./config";

/**
 * One-click restart of the shepherd systemd unit, optionally preceded by a
 * graceful herdr daemon restart (`herdr server live-handoff` — panes are handed
 * to the new server, so no agent session ends).
 *
 * Deliberately minimal compared to UpdateService: a successful restart kills
 * this very process within seconds, so deploy-style exit markers / stale-log
 * self-healing would be inert. A relaunch window debounces double-clicks and
 * self-clears, and the transient unit's output lands in the journal
 * (`journalctl --user -u shepherd-restart`) for post-mortems.
 *
 * Like the deploy (update.ts), the restart runs in a detached transient unit
 * via `systemd-run --user`: a plain child in the service cgroup would be
 * killed by the very `systemctl restart` it issues.
 */

/** systemd unit this shepherd runs as (matches deploy/shepherd.service). */
const UNIT = "shepherd";
/** transient unit name for the detached restart script */
const RESTART_UNIT = "shepherd-restart";
/** refuse a re-launch this soon after the last one; self-clears so a restart
 *  that never killed us (systemctl failed inside the transient unit) can be
 *  retried without bouncing shepherd first */
const RELAUNCH_WINDOW_MS = 60_000;

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The two-liner the transient unit runs. herdr goes FIRST so a freshly booted
 *  shepherd finds a settled daemon instead of the mid-handoff window (ordering
 *  is politeness, not safety — a down daemon can't trip the exit-78 preflight,
 *  which only fires on a missing binary). `|| true` keeps a failed handoff from
 *  blocking the shepherd restart; the old herdr server stays up in that case.
 *  `herdrBin` is the configured binary (HERDR_BIN / config.herdrBin) — a
 *  custom-binary install must hand off via the same herdr it runs. */
export function buildRestartScript(opts: { herdr: boolean }, herdrBin = config.herdrBin): string {
  const lines: string[] = [];
  if (opts.herdr) lines.push(`${shq(herdrBin)} server live-handoff || true`);
  lines.push(`systemctl --user restart ${shq(UNIT)}`);
  return lines.join("\n");
}

export interface RestartDeps {
  /** this process's systemd invocation id; default reads $INVOCATION_ID */
  ownInvocationId?: () => string | undefined;
  /** the shepherd unit's live InvocationID per systemd; default asks systemctl */
  unitInvocationId?: () => string;
  /** inject point for tests; defaults to launching the script detached */
  launch?: (script: string) => void;
  /** clock inject for the relaunch window */
  now?: () => number;
  /** herdr binary for the live-handoff line; defaults to config.herdrBin */
  herdrBin?: string;
}

export class RestartService {
  private ownInvocationId: () => string | undefined;
  private unitInvocationId: () => string;
  private launch: (script: string) => void;
  private now: () => number;
  private herdrBin: string;
  private launchedAt = 0;

  constructor(deps: RestartDeps = {}) {
    this.ownInvocationId = deps.ownInvocationId ?? (() => process.env.INVOCATION_ID);
    this.unitInvocationId = deps.unitInvocationId ?? defaultUnitInvocationId;
    this.launch = deps.launch ?? defaultLaunch;
    this.now = deps.now ?? Date.now;
    this.herdrBin = deps.herdrBin ?? config.herdrBin;
  }

  /** True only when this process IS the systemd unit's current activation:
   *  $INVOCATION_ID is stamped per activation and inherited by children (so the
   *  check survives bun ever spawning the entry point in a subprocess), and it
   *  must match what systemd reports for the `shepherd` unit. A dev-worktree
   *  shepherd (terminal / herdr pane) has no or a foreign id → guarded off, so
   *  a dev UI can never bounce the production unit. */
  private underUnit(): boolean {
    const own = this.ownInvocationId()?.trim();
    if (!own) return false;
    let unit: string;
    try {
      unit = this.unitInvocationId().trim();
    } catch {
      return false;
    }
    return unit.length > 0 && unit === own;
  }

  /** Kick off the detached restart. Never throws — returns a stable error code
   *  (`not_systemd`, `already_restarting`) or the launcher's message so the UI
   *  can map it; the caller decides the HTTP shape. */
  apply(opts: { herdr: boolean }): { started: boolean; error?: string } {
    if (!this.underUnit()) return { started: false, error: "not_systemd" };
    if (this.now() - this.launchedAt < RELAUNCH_WINDOW_MS) {
      return { started: false, error: "already_restarting" };
    }
    try {
      this.launch(buildRestartScript(opts, this.herdrBin));
    } catch (e) {
      return {
        started: false,
        error: e instanceof Error ? e.message : "could not launch the restart",
      };
    }
    this.launchedAt = this.now();
    return { started: true };
  }
}

function defaultUnitInvocationId(): string {
  const r = spawnSync("systemctl", ["--user", "show", UNIT, "-p", "InvocationID", "--value"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.error) throw r.error;
  if (typeof r.status === "number" && r.status !== 0) {
    throw new Error(`systemctl show exited ${r.status}`);
  }
  return (r.stdout ?? "").trim();
}

/** Launch the restart script in its own transient unit so it survives the
 *  `systemctl restart shepherd` it issues (same pattern as update.ts). PATH is
 *  forwarded because a transient --user unit gets a bare environment but the
 *  script needs herdr + systemctl. Output goes to the journal via --collect. */
function defaultLaunch(script: string): void {
  const args = ["--user", "--collect", `--unit=${RESTART_UNIT}`];
  if (process.env.PATH) args.push(`--setenv=PATH=${process.env.PATH}`);
  args.push("bash", "-c", script);
  const r = spawnSync("systemd-run", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.error) throw new Error(`could not launch the restart: ${r.error.message}`);
  if (typeof r.status === "number" && r.status !== 0) {
    const stderr = r.stderr?.toString().trim();
    throw new Error(`restart launcher exited ${r.status}${stderr ? `: ${stderr}` : ""}`);
  }
}
