/**
 * Event-loop watchdog: turns a frozen server into a named, self-healing incident.
 *
 * WHY: the server is ONE Bun event loop that also pumps the live web terminal. When some code path
 * spins on it (measured with `perf`: main thread ~100% CPU, RSS climbing, 98% of samples in native
 * allocation), nothing else ever runs again — HTTP dies, SIGTERM handlers never fire (so `systemctl
 * restart` burns its full 90s stop timeout before SIGKILL), and `SHEPHERD_PROFILE_LOOP`'s lag
 * sampler is silenced too, because it lives on the very loop that stopped. Twice this left the HUD
 * dead for hours with nothing in the log to say what froze it.
 *
 * HOW: the main loop only publishes — a heartbeat timestamp every second, and a start/end record
 * for every HTTP request and `timerTask` tick — into SharedArrayBuffers. A Worker, on its own thread
 * and event loop, reads them:
 *   - while the heartbeat is fresh it pings systemd (`WATCHDOG=1`), when the unit armed a watchdog;
 *   - once the heartbeat is {@link STALL_REPORT_MS} stale it writes a `[loop-watchdog]` report
 *     straight to fd 2 naming what was in flight and what just finished, with ISO timestamps;
 *   - it stops pinging, so systemd restarts the service after `WatchdogSec` instead of never.
 * The registry costs a slot scan and a label copy per request; nothing is logged unless the loop
 * actually stalls, so the hot path adds no log volume.
 */
import { Worker } from "node:worker_threads";
import { OpRegistry, allocRegistryBuffers } from "./loop-watchdog-core";
import type { WatchdogWorkerInit } from "./loop-watchdog-worker";

const HEARTBEAT_MS = 1_000;
const TICK_MS = 1_000;
/** A stall is reported once the heartbeat is this old. Well above any normal tick jitter, and short
 *  enough that the report lands long before systemd's `WatchdogSec` kill. */
const STALL_REPORT_MS = 10_000;
/** The worker vouches for the loop only while the last heartbeat is younger than this. */
const PING_FRESH_MS = 5_000;
/** Upper bound between pings; systemd asks for at least one per half `WatchdogSec`. */
const MAX_PING_INTERVAL_MS = 10_000;

let registry: OpRegistry | null = null;

const NOOP = () => {};

/**
 * Start the heartbeat and the watcher thread. Idempotent; call once, early in boot, so a stall in
 * boot work is caught too. Everything else in this module is a no-op until it runs, which keeps
 * tests and one-off scripts that import the server free of timers and threads.
 */
export function startLoopWatchdog(): void {
  if (registry) return;
  const reg = new OpRegistry(allocRegistryBuffers());
  reg.beat(Date.now());
  setInterval(() => reg.beat(Date.now()), HEARTBEAT_MS).unref();

  const { notifySocket, watchdogMs } = claimSystemdWatchdog();
  const init: WatchdogWorkerInit = {
    buffers: reg.buffers,
    pid: process.pid,
    tickMs: TICK_MS,
    stallReportMs: STALL_REPORT_MS,
    pingFreshMs: PING_FRESH_MS,
    pingIntervalMs: watchdogMs
      ? Math.min(MAX_PING_INTERVAL_MS, watchdogMs / 4)
      : MAX_PING_INTERVAL_MS,
    notifySocket,
  };
  // Config travels as workerData (the SABs stay shared), not a message: the worker has no
  // message handler at all, so there is nothing for any other sender to reach and no second
  // message that could re-initialise it.
  const worker = new Worker(new URL("./loop-watchdog-worker.ts", import.meta.url), {
    workerData: init,
  });
  // The watcher must never be what keeps a shutting-down process alive.
  worker.unref();
  registry = reg;

  console.info(
    `[loop-watchdog] armed — stall report after ${STALL_REPORT_MS / 1000}s; systemd watchdog ${
      notifySocket ? `on (WatchdogSec=${watchdogMs / 1000}s)` : "off (unit sets no WatchdogSec)"
    }`,
  );
}

/**
 * Read systemd's watchdog contract, then REMOVE it from `process.env`. Children spawned later
 * inherit `process.env`; leaving `NOTIFY_SOCKET` there (with the unit's `NotifyAccess=all`) would
 * let any of them vouch for this process — exactly the false "alive" the watchdog exists to catch.
 */
function claimSystemdWatchdog(): { notifySocket: string | null; watchdogMs: number } {
  const socket = process.env.NOTIFY_SOCKET;
  const usec = Number(process.env.WATCHDOG_USEC);
  const pid = process.env.WATCHDOG_PID;
  delete process.env.NOTIFY_SOCKET;
  delete process.env.WATCHDOG_USEC;
  delete process.env.WATCHDOG_PID;
  // WATCHDOG_PID names the process systemd supervises; honor it only when that's us.
  const ours = pid === undefined || Number(pid) === process.pid;
  if (!socket || !Number.isFinite(usec) || usec <= 0 || !ours) {
    return { notifySocket: null, watchdogMs: 0 };
  }
  return { notifySocket: socket, watchdogMs: usec / 1000 };
}

/**
 * Mark an operation as in flight; call the returned function when it settles. Safe to call more
 * than once, and a no-op before {@link startLoopWatchdog}.
 */
export function opStart(label: string): () => void {
  const reg = registry;
  if (!reg) return NOOP;
  const slot = reg.start(label, Date.now());
  if (slot < 0) return NOOP;
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    reg.end(slot, Date.now());
  };
}
