import { describe, expect, it } from "vitest";
import type { HeavySlotSnapshot, HeavySlotStartWaiter } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import {
  brakeLine,
  chipModel,
  commandLabel,
  formatBytes,
  formatRuntime,
  memPressureBar,
  orderedWaiters,
  popoverLeft,
  recentResults,
  slotActive,
  needsResultRefresh,
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

  const start: HeavySlotStartWaiter = {
    kind: "task",
    repoPath: "/r",
    issueNumber: null,
    label: "x",
    since: 0,
    position: 1,
  };

  it("stays active while new sessions wait to start", () => {
    expect(slotActive(snap({ startQueue: [] }))).toBe(false);
    expect(slotActive(snap({ startQueue: [start] }))).toBe(true);
  });

  it("names the brake with how many starts wait, and the waiting starts once it let go", () => {
    const on = { active: true, reason: "memory" } as const;
    expect(brakeLine(snap())).toBeNull();
    expect(brakeLine(snap({ brake: on }))).toBe(m.heavyslot_strip_brake());
    expect(brakeLine(snap({ brake: on, startQueue: [start, start] }))).toBe(
      m.heavyslot_strip_brake_waiting({ n: 2 }),
    );
    expect(brakeLine(snap({ startQueue: [start] }))).toBe(
      m.heavyslot_strip_starts_pacing({ n: 1 }),
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

describe("needsResultRefresh", () => {
  const r = (stale: boolean) => ({
    sessionId: "a",
    command: "x",
    startedAt: 0,
    endedAt: 1,
    exitCode: 0,
    result: "passed" as const,
    head: "h",
    treeHash: "t",
    stale,
  });
  it("polls only while a still-current result is shown", () => {
    expect(needsResultRefresh(snap({ lastResults: [r(false)] }))).toBe(true);
    expect(needsResultRefresh(snap({ lastResults: [r(true)] }))).toBe(false);
    expect(needsResultRefresh(snap())).toBe(false);
    expect(needsResultRefresh(snap({ enabled: false, lastResults: [r(false)] }))).toBe(false);
    expect(needsResultRefresh(null)).toBe(false);
  });
});

describe("recentResults", () => {
  const r = (sessionId: string, endedAt: number | null) => ({
    sessionId,
    command: "x",
    startedAt: 0,
    endedAt,
    exitCode: 0,
    result: "passed" as const,
    head: "h",
    treeHash: "t",
    stale: false,
  });
  const ids = (rows: { sessionId: string }[]) => rows.map((x) => x.sessionId);
  const s = snap({
    lastResults: [r("a", 1), r("n", null), r("b", 7), r("c", 3), r("d", 5), r("e", 6), r("f", 2)],
  });
  it("lists newest first, unknown end last, cut to five", () => {
    expect(recentResults(s, false)).toEqual({
      rows: expect.any(Array),
      hidden: 2,
    });
    expect(ids(recentResults(s, false).rows)).toEqual(["b", "e", "d", "c", "f"]);
  });
  it("lists everything when asked", () => {
    const all = recentResults(s, true);
    expect(ids(all.rows)).toEqual(["b", "e", "d", "c", "f", "a", "n"]);
    expect(all.hidden).toBe(0);
  });
  it("hides nothing at or under the cap", () => {
    expect(recentResults(snap({ lastResults: [r("a", 1)] }), false).hidden).toBe(0);
  });
});

describe("commandLabel", () => {
  it("drops leading cd hops", () => {
    expect(commandLabel("cd /a; bun test x")).toBe("bun test x");
    expect(commandLabel("cd /a && cd 'b c' && bun run check")).toBe("bun run check");
  });
  it("keeps only the first line and collapses whitespace", () => {
    expect(commandLabel("\n  vitest   run\t a.ts\nmore")).toBe("vitest run a.ts");
  });
  it("leaves a plain command alone", () => {
    expect(commandLabel("bun test ./test/x.test.ts")).toBe("bun test ./test/x.test.ts");
  });
  it("falls back to the command when nothing follows the cd", () => {
    expect(commandLabel("cd /a")).toBe("cd /a");
    expect(commandLabel("cd /a;")).toBe("cd /a;");
  });
  it("shortens a heredoc probe to its first command", () => {
    const cmd =
      "cd /home/p/wt; cat > /home/p/scratch/probe.test.ts <<'EOF'\nimport { it } from 'vitest';\nEOF";
    expect(commandLabel(cmd)).toBe("cat > /home/p/scratch/probe.test.ts <<'EOF'");
  });
});

describe("popoverLeft", () => {
  it("aligns under the chip when the popover fits", () => {
    expect(popoverLeft(300, 380, 100, 1200)).toBe(200);
  });
  it("clamps to the box's right edge", () => {
    expect(popoverLeft(1100, 380, 100, 1200)).toBe(820);
  });
  it("pins to the left when the box is narrower than the popover", () => {
    expect(popoverLeft(150, 380, 100, 300)).toBe(0);
  });
});
