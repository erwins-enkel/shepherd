/**
 * Worker half of the event-loop watchdog (see `loop-watchdog.ts`).
 *
 * Runs on its own thread with its own event loop, so it keeps ticking while the main thread is
 * spinning. It must therefore never depend on the main loop for anything: the stall report goes
 * straight to fd 2 with `writeSync` (the service's `StandardError=` log) rather than through
 * `console`, and the systemd ping is a direct `systemd-notify` spawn from here.
 */
import { writeSync } from "node:fs";
import { workerData } from "node:worker_threads";
import {
  OpRegistry,
  StallMonitor,
  formatStallReport,
  type RegistryBuffers,
} from "./loop-watchdog-core";

export interface WatchdogWorkerInit {
  buffers: RegistryBuffers;
  pid: number;
  tickMs: number;
  stallReportMs: number;
  pingFreshMs: number;
  pingIntervalMs: number;
  /** systemd's `NOTIFY_SOCKET` when the unit armed a watchdog, else null (report-only mode). */
  notifySocket: string | null;
}

const P = "[loop-watchdog]";

function emit(lines: string[]): void {
  try {
    writeSync(2, `${lines.join("\n")}\n`);
  } catch {
    // Nothing sensible to do if the log fd itself is gone.
  }
}

function run(init: WatchdogWorkerInit): void {
  const registry = new OpRegistry(init.buffers);
  const monitor = new StallMonitor({
    stallReportMs: init.stallReportMs,
    pingFreshMs: init.pingFreshMs,
  });
  let lastPingAt = 0;
  let pingFailureReported = false;

  const ping = (now: number) => {
    lastPingAt = now;
    try {
      const proc = Bun.spawn(["systemd-notify", "WATCHDOG=1"], {
        env: { NOTIFY_SOCKET: init.notifySocket!, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      void proc.exited.then((code) => {
        if (code !== 0 && !pingFailureReported) {
          pingFailureReported = true;
          emit([
            `${P} ${new Date().toISOString()} systemd-notify exited ${code} — watchdog pings are failing; expect systemd to restart the service`,
          ]);
        }
      });
    } catch (e) {
      if (!pingFailureReported) {
        pingFailureReported = true;
        emit([
          `${P} ${new Date().toISOString()} cannot spawn systemd-notify (${String(e)}) — watchdog pings are failing; expect systemd to restart the service`,
        ]);
      }
    }
  };

  setInterval(() => {
    const now = Date.now();
    const decision = monitor.tick(registry.lastBeat(), now);
    if (decision.reportStall) {
      emit(formatStallReport(registry.snapshot(), now, init.pid, init.notifySocket !== null));
    }
    if (decision.recoveredAfterMs !== null) {
      emit([
        `${P} ${new Date(now).toISOString()} event loop recovered after a ${(decision.recoveredAfterMs / 1000).toFixed(1)}s stall`,
      ]);
    }
    if (decision.ping && init.notifySocket && now - lastPingAt >= init.pingIntervalMs) ping(now);
  }, init.tickMs);
}

// Config arrives as workerData at construction — deliberately no message handler (see loop-watchdog.ts).
run(workerData as WatchdogWorkerInit);
