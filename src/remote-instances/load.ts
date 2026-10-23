import { cpus, loadavg } from "node:os";

export const LOAD_FRESH_MS = 15_000;
export const LOAD_BUSY = 1;
export const LOAD_RESERVE = 0.75;
export const LOAD_TIMEOUT_MS = 1_500;

export interface HostLoadSnapshot {
  sampledAt: number;
  load1: number;
  cpuCount: number;
  runningSessions: number;
}

export interface HostLoadReport extends HostLoadSnapshot {
  ageMs: number;
  stale: boolean;
}

const nonnegative = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The whole host's one-minute load, normalized by host CPUs, not process affinity. */
export function readHostLoad(
  runningSessions: number,
  now = Date.now(),
  os = { platform: process.platform as string, load1: loadavg()[0], cpuCount: cpus().length },
): HostLoadSnapshot | null {
  if (os.platform !== "linux" && os.platform !== "darwin") return null;
  const report = parseHostLoadReport({
    ...os,
    runningSessions,
    sampledAt: now,
    ageMs: 0,
    stale: false,
  });
  if (!report) return null;
  return { sampledAt: now, load1: report.load1, cpuCount: report.cpuCount, runningSessions };
}

export function hostLoadReport(snapshot: HostLoadSnapshot, now: number): HostLoadReport {
  const ageMs = Math.max(0, now - snapshot.sampledAt);
  return { ...snapshot, ageMs, stale: ageMs > LOAD_FRESH_MS };
}

/** Validate historical records without moving their timestamps. */
export function parseHostLoadReport(raw: unknown): HostLoadReport | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    !nonnegative(r.sampledAt) ||
    !nonnegative(r.ageMs) ||
    !nonnegative(r.load1) ||
    !nonnegative(r.cpuCount) ||
    !Number.isSafeInteger(r.cpuCount) ||
    r.cpuCount === 0 ||
    !nonnegative(r.runningSessions) ||
    !Number.isSafeInteger(r.runningSessions) ||
    typeof r.stale !== "boolean"
  )
    return null;
  return {
    sampledAt: r.sampledAt,
    ageMs: r.ageMs,
    load1: r.load1,
    cpuCount: r.cpuCount,
    runningSessions: r.runningSessions,
    stale: r.stale || r.ageMs > LOAD_FRESH_MS,
  };
}

/** Rebase onto the caller's clock at request START, conservatively including network latency. */
export function parseRemoteLoad(raw: unknown, requestedAt: number): HostLoadSnapshot | null {
  const r = parseHostLoadReport(raw);
  if (!r || r.stale) return null;
  return {
    sampledAt: requestedAt - r.ageMs,
    load1: r.load1,
    cpuCount: r.cpuCount,
    runningSessions: r.runningSessions,
  };
}

export function usableLoad(report: HostLoadReport | null | undefined, now: number): boolean {
  return (
    !!report &&
    !report.stale &&
    report.ageMs <= LOAD_FRESH_MS &&
    now - report.sampledAt <= LOAD_FRESH_MS
  );
}

export const normalizedLoad = (report: HostLoadReport): number => report.load1 / report.cpuCount;
