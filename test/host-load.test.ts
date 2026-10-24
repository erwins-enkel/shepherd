import { expect, test } from "bun:test";
import {
  hostLoadReport,
  parseHostLoadReport,
  parseRemoteLoad,
  readHostLoad,
  usableLoad,
} from "../src/remote-instances/load";
import { SessionStore } from "../src/store";

const sample = { sampledAt: 100_000, load1: 8, cpuCount: 8, runningSessions: 3 };

test("host load: reads Linux/macOS, not unsupported or unavailable host measurements", () => {
  for (const platform of ["linux", "darwin"]) {
    expect(readHostLoad(3, 100_000, { platform, load1: 8, cpuCount: 8 })).toEqual(sample);
  }
  for (const os of [
    { platform: "win32", load1: 0, cpuCount: 8 },
    { platform: "linux", load1: 1, cpuCount: 0 },
    { platform: "linux", load1: NaN, cpuCount: 8 },
  ])
    expect(readHostLoad(3, 100_000, os)).toBeNull();
});

test("host load: freshness includes network time and does not trust remote wall clocks", () => {
  const wire = hostLoadReport(sample, 102_000);
  const snapshot = parseRemoteLoad({ ...wire, sampledAt: 9_000_000 }, 200_000)!;
  expect(snapshot.sampledAt).toBe(198_000);
  const report = hostLoadReport(snapshot, 213_000);
  expect(report.stale).toBe(false);
  expect(usableLoad(report, 213_000)).toBe(true);
  expect(usableLoad(report, 213_001)).toBe(false);
  expect(hostLoadReport(snapshot, 213_001).stale).toBe(true);
  expect(parseHostLoadReport(wire)?.sampledAt).toBe(sample.sampledAt);
  expect(parseRemoteLoad({ ...wire, stale: true }, 200_000)).toBeNull();
});

test("host load: rejects malformed telemetry without inventing spare capacity", () => {
  const report = hostLoadReport(sample, sample.sampledAt);
  for (const patch of [
    { load1: -1 },
    { load1: Infinity },
    { cpuCount: 0 },
    { cpuCount: 1.5 },
    { ageMs: -1 },
    { ageMs: NaN },
    { sampledAt: "now" },
    { stale: "false" },
    { runningSessions: -1 },
    { runningSessions: 0.5 },
  ])
    expect(parseHostLoadReport({ ...report, ...patch })).toBeNull();
  expect(parseHostLoadReport(undefined)).toBeNull();
  expect(parseHostLoadReport({ ...report, ageMs: 15_001, stale: false })?.stale).toBe(true);
});

test("host load: counts only local running agent tasks", () => {
  const store = new SessionStore(":memory:");
  const base = {
    name: "load",
    prompt: "task",
    repoPath: "/r",
    baseBranch: "main",
    branch: "task",
    worktreePath: "/w",
    isolated: true,
    herdrSession: "default",
  };
  for (const status of ["running", "idle", "blocked", "done", "archived"] as const) {
    const s = store.create({ ...base, herdrAgentId: status });
    store.update(s.id, { status });
  }
  store.create({ ...base, herdrAgentId: "shell", terminal: true });
  store.create({ ...base, herdrAgentId: "assistant", operatorAssistant: true });
  expect(store.countRunningSessions()).toBe(1);
});
