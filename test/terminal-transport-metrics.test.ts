import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  recordSocketAttach,
  recordFallback,
  terminalTransportMetrics,
  __resetTerminalTransportMetrics,
  shouldWarnSilentFallback,
  startTerminalTransportSelfCheck,
} from "../src/terminal-transport-metrics";

beforeEach(() => {
  __resetTerminalTransportMetrics();
});

describe("recordSocketAttach", () => {
  test("increments socketAttach and sets lastSocketAttachAt", () => {
    recordSocketAttach(12345);
    const m = terminalTransportMetrics();
    expect(m.socketAttach).toBe(1);
    expect(m.lastSocketAttachAt).toBe(12345);
  });

  test("defaults now to Date.now() and accumulates across calls", () => {
    recordSocketAttach();
    recordSocketAttach();
    const m = terminalTransportMetrics();
    expect(m.socketAttach).toBe(2);
    expect(typeof m.lastSocketAttachAt).toBe("number");
  });
});

describe("recordFallback", () => {
  test("increments socketFallback", () => {
    recordFallback();
    recordFallback();
    expect(terminalTransportMetrics().socketFallback).toBe(2);
  });
});

describe("terminalTransportMetrics", () => {
  test("returns a copy — mutating result does not affect later snapshot", () => {
    recordSocketAttach(1);
    const snap = terminalTransportMetrics();
    snap.socketAttach = 999;
    snap.socketFallback = 999;
    snap.lastSocketAttachAt = 999;
    const later = terminalTransportMetrics();
    expect(later.socketAttach).toBe(1);
    expect(later.socketFallback).toBe(0);
    expect(later.lastSocketAttachAt).toBe(1);
  });
});

describe("shouldWarnSilentFallback", () => {
  test("flagActive false -> false", () => {
    recordFallback();
    expect(shouldWarnSilentFallback(false)).toBe(false);
  });

  test("flagActive true + socketAttach>0 -> false", () => {
    recordSocketAttach(1);
    recordFallback();
    expect(shouldWarnSilentFallback(true)).toBe(false);
  });

  test("flagActive true + socketAttach 0 + socketFallback 0 -> false", () => {
    expect(shouldWarnSilentFallback(true)).toBe(false);
  });

  test("flagActive true + socketAttach 0 + socketFallback>0 -> true", () => {
    recordFallback();
    expect(shouldWarnSilentFallback(true)).toBe(true);
  });
});

describe("startTerminalTransportSelfCheck", () => {
  test("flagActive false -> schedule never called, warn never called", () => {
    const schedule = mock(() => ({ stop: mock(() => {}) }));
    const warn = mock(() => {});
    const stop = startTerminalTransportSelfCheck(false, { schedule, warn });
    stop();
    expect(schedule).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns when a fallback happened with zero attaches (synchronous schedule)", () => {
    recordFallback();
    const schedule = (fn: () => void) => {
      fn();
      return { stop: mock(() => {}) };
    };
    const warn = mock<(msg: string) => void>(() => {});
    startTerminalTransportSelfCheck(true, { schedule, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("socket terminal never engaged");
  });

  test("does not warn when an attach happened", () => {
    recordSocketAttach(1);
    recordFallback();
    const schedule = (fn: () => void) => {
      fn();
      return { stop: mock(() => {}) };
    };
    const warn = mock(() => {});
    startTerminalTransportSelfCheck(true, { schedule, warn });
    expect(warn).not.toHaveBeenCalled();
  });

  test("returned stop() is wired to the schedule's stop", () => {
    const innerStop = mock(() => {});
    const schedule = mock(() => ({ stop: innerStop }));
    const warn = mock(() => {});
    const stop = startTerminalTransportSelfCheck(true, { schedule, warn });
    expect(innerStop).not.toHaveBeenCalled();
    stop();
    expect(innerStop).toHaveBeenCalledTimes(1);
  });
});
