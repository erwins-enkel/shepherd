import { describe, expect, it } from "vitest";
import type { HeavySlotSnapshot } from "#lib/types.js";
import {
  chipModel,
  formatBytes,
  formatRuntime,
  memPressureBar,
  orderedWaiters,
  slotActive,
  resultView,
  shortRevision,
  slotEnabled,
} from "./heavy-slot";

const GIB = 1024 ** 3;
function snap(over: Partial<HeavySlotSnapshot> = {}): HeavySlotSnapshot {
  return {
    enabled: true,
    capacity: 1,
    holders: [],
    waiters: [],
    brake: { active: false, reason: null },
    pressure: {
      ramAvailableBytes: 2 * GIB,
      ramTotalBytes: 30 * GIB,
      swapUsedBytes: null,
      swapTotalBytes: null,
      memFullAvg10: 10,
      memBrakeThreshold: 20,
      cpuSomeAvg10: null,
    },
    memoryBySource: { agentsBytes: null, foreignBytes: null, foreignTop: [] },
    lastResults: [],
    ...over,
  };
}

describe("heavy-slot logic", () => {
  it("is off without the master switch, whatever else is set", () => {
    expect(slotEnabled(null)).toBe(false);
    expect(slotEnabled(snap({ enabled: false }))).toBe(false);
    expect(
      slotActive(
        snap({
          enabled: false,
          holders: [{ sessionId: "a", command: "x", startedAt: 0, rssBytes: null }],
        }),
      ),
    ).toBe(false);
  });

  it("is idle with no holder, waiter or brake", () => {
    expect(slotActive(snap())).toBe(false);
    expect(slotActive(snap({ brake: { active: true, reason: "memory" } }))).toBe(true);
    expect(slotActive(snap({ waiters: [{ sessionId: "a", position: 1, reason: "slot" }] }))).toBe(
      true,
    );
  });

  it("derives the chip numbers", () => {
    const c = chipModel(
      snap({
        holders: [{ sessionId: "a", command: "vitest", startedAt: 0, rssBytes: null }],
        waiters: [
          { sessionId: "b", position: 1, reason: "slot" },
          { sessionId: "c", position: 2, reason: "slot" },
        ],
      }),
    );
    expect(c).toEqual({ held: 1, capacity: 1, waiting: 2, ramPct: 93, braking: false });
  });

  it("tolerates missing pressure values", () => {
    const s = snap();
    s.pressure.ramTotalBytes = null;
    s.pressure.memFullAvg10 = null;
    expect(chipModel(s).ramPct).toBeNull();
    expect(memPressureBar(s)).toBeNull();
  });

  it("places the brake limit at half the pressure scale", () => {
    expect(memPressureBar(snap())).toEqual({ fill: 0.25, limit: 0.5 });
  });

  it("formats runtime and bytes", () => {
    expect(formatRuntime(0, 134_000)).toBe("2:14");
    expect(formatRuntime(0, 3_725_000)).toBe("1:02:05");
    expect(formatRuntime(10_000, 0)).toBe("0:00");
    expect(formatBytes(null)).toBe("–");
    expect(formatBytes(2.5 * GIB)).toBe("2.5 GiB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MiB");
  });

  it("orders waiters by position", () => {
    const s = snap({
      waiters: [
        { sessionId: "b", position: 2, reason: "slot" },
        { sessionId: "a", position: 1, reason: "slot" },
      ],
    });
    expect(orderedWaiters(s).map((w) => w.sessionId)).toEqual(["a", "b"]);
  });
});

describe("resultView", () => {
  const base = {
    sessionId: "a",
    command: "vitest run",
    startedAt: 0,
    endedAt: 1,
    exitCode: 0,
    result: "passed" as const,
    head: "abcdef0123",
    treeHash: "t",
    stale: false,
  };
  it("shows a current pass as passed and a pass on a moved-on source as stale, never green", () => {
    expect(resultView(base)).toBe("passed");
    expect(resultView({ ...base, stale: true })).toBe("stale");
  });
  it("keeps failures red even when stale", () => {
    expect(resultView({ ...base, result: "failed", exitCode: 1, stale: true })).toBe("failed");
  });
  it("shortens the commit", () => {
    expect(shortRevision(base)).toBe("abcdef0");
    expect(shortRevision({ ...base, head: null })).toBe("–");
  });
});
