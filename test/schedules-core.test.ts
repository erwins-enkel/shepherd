import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALL_DAYS,
  STALE_MS,
  daysToMask,
  decideFiring,
  latestDueSlot,
  maskToDays,
  nextSlot,
  scheduleCreateInput,
  validateScheduleInput,
} from "../src/schedules-core";

// Slot math is server-local; pin a DST-observing zone so the spring-forward / fall-back cases
// mean the same thing on every machine and CI. Restored after: test files share one process.
const prevTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Berlin";
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

const WORKDAYS = 0b0011111;
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe("latestDueSlot", () => {
  // 2026-10-26 is a Monday.
  test("picks the latest time today", () => {
    expect(latestDueSlot(WORKDAYS, ["09:00", "18:00"], at(2026, 10, 26, 19))?.slotKey).toBe(
      "2026-10-26T18:00",
    );
    expect(latestDueSlot(WORKDAYS, ["09:00", "18:00"], at(2026, 10, 26, 9))?.slotKey).toBe(
      "2026-10-26T09:00",
    );
  });

  test("before today's first slot it is yesterday's (or the last workday's) last slot", () => {
    expect(latestDueSlot(WORKDAYS, ["09:00", "18:00"], at(2026, 10, 27, 8))?.slotKey).toBe(
      "2026-10-26T18:00",
    );
    // Monday 08:00 → Friday 18:00 (Sat/Sun masked out).
    expect(latestDueSlot(WORKDAYS, ["09:00", "18:00"], at(2026, 10, 26, 8))?.slotKey).toBe(
      "2026-10-23T18:00",
    );
  });

  test("never lands on a weekend for a workday mask", () => {
    for (let h = 0; h < 48; h++) {
      const now = at(2026, 10, 31, 0) + h * 3600_000; // Sat+Sun
      expect(latestDueSlot(WORKDAYS, ["09:00", "18:00"], now)?.slotKey).toBe("2026-10-30T18:00");
    }
  });

  test("spring-forward gap slot fires after the gap, keyed by its nominal time", () => {
    // 2026-03-29 02:00 → 03:00 in Berlin; 02:30 does not exist.
    const s = latestDueSlot(ALL_DAYS, ["02:30"], at(2026, 3, 29, 3, 31));
    expect(s?.slotKey).toBe("2026-03-29T02:30");
    expect(s!.at).toBeLessThanOrEqual(at(2026, 3, 29, 3, 31));
    // Before the (normalized) instant it is still yesterday's slot.
    expect(latestDueSlot(ALL_DAYS, ["02:30"], at(2026, 3, 29, 1, 59))?.slotKey).toBe(
      "2026-03-28T02:30",
    );
  });

  test("fall-back repeated hour yields one key", () => {
    // 2026-10-25 03:00 → 02:00; 02:30 happens twice.
    const first = new Date(2026, 9, 25, 2, 30).getTime();
    const keys = new Set<string>();
    for (let m = 0; m < 180; m += 5) {
      const s = latestDueSlot(ALL_DAYS, ["02:30"], first + m * 60_000);
      if (s) keys.add(s.slotKey);
    }
    expect([...keys]).toEqual(["2026-10-25T02:30"]);
  });
});

describe("nextSlot", () => {
  test("Friday evening → Monday morning", () => {
    expect(nextSlot(WORKDAYS, ["09:00", "18:00"], at(2026, 10, 30, 18))?.slotKey).toBe(
      "2026-11-02T09:00",
    );
  });
});

describe("decideFiring", () => {
  const now = at(2026, 10, 26, 9, 1);
  const slot = { slotKey: "2026-10-26T09:00", at: at(2026, 10, 26, 9) };
  test("fires a due unclaimed slot", () => {
    expect(decideFiring({ slot, baselineAt: 0, hasRow: false, now })).toBe("fire");
  });
  test("claimed slot does nothing", () => {
    expect(decideFiring({ slot, baselineAt: 0, hasRow: true, now })).toBe("none");
  });
  test("slot before baseline (created/enabled later) does nothing", () => {
    expect(decideFiring({ slot, baselineAt: slot.at + 1, hasRow: false, now })).toBe("none");
  });
  test("slot older than the stale cap is stale", () => {
    expect(decideFiring({ slot, baselineAt: 0, hasRow: false, now: slot.at + STALE_MS + 1 })).toBe(
      "stale",
    );
    expect(decideFiring({ slot, baselineAt: 0, hasRow: false, now: slot.at + STALE_MS })).toBe(
      "fire",
    );
  });
});

describe("validateScheduleInput", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-"));
  const repo = join(root, "aetherial");
  mkdirSync(repo);
  const base = {
    repoPath: repo,
    name: " Triage ",
    prompt: "/triage-feedback",
    days: WORKDAYS,
    times: ["18:00", "09:00", "09:00"],
  };

  test("normalizes and defaults to attended", () => {
    const r = validateScheduleInput(base, root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("Triage");
    expect(r.value.times).toEqual(["09:00", "18:00"]);
    expect(r.value.enabled).toBe(true);
    expect(r.value.launch.autopilotEnabled).toBe(false);
  });

  test.each([
    [{ days: 0 }, "days"],
    [{ days: 128 }, "days"],
    [{ times: [] }, "times"],
    [{ times: ["24:00"] }, "times"],
    [{ times: ["9:00"] }, "times"],
    [{ name: "" }, "name"],
    [{ prompt: "  " }, "prompt"],
    [{ extra: 1 }, "unknown key"],
    [{ launch: { bogus: 1 } }, "unknown key"],
    [{ launch: { agentProvider: "gpt" } }, "agentProvider"],
    [{ launch: { baseBranch: "-bad" } }, "baseBranch"],
    [{ repoPath: "/nope/elsewhere" }, "repoPath"],
  ])("rejects %j", (patch, msg) => {
    const r = validateScheduleInput({ ...base, ...patch }, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });

  test("create input carries launch options through the New Task validator", () => {
    const v = validateScheduleInput(
      { ...base, launch: { autopilotEnabled: null, planGateEnabled: true, research: true } },
      root,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const c = scheduleCreateInput(v.value, "main", root);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.prompt).toBe("/triage-feedback");
    expect(c.value.baseBranch).toBe("main");
    expect(c.value.autopilotEnabled ?? null).toBeNull();
    expect(c.value.planGateEnabled).toBe(true);
    expect(c.value.research).toBe(true);
  });
});

describe("weekday names", () => {
  test("round-trip names and mask, Monday = bit 0", () => {
    expect(daysToMask(["mon", "fri", "mon"])).toBe(0b0010001);
    expect(maskToDays(0b0010001)).toEqual(["mon", "fri"]);
    expect(maskToDays(ALL_DAYS)).toHaveLength(7);
  });
  test("empty or unknown names are null", () => {
    expect(daysToMask([])).toBeNull();
    expect(daysToMask(["monday"])).toBeNull();
    expect(daysToMask([1])).toBeNull();
  });
});
