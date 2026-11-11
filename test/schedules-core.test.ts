import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ALL_DAYS,
  STALE_MS,
  daysToMask,
  decideFiring,
  decideUsageLimit,
  scheduleUsageWindows,
  waitingLimitExpiresAt,
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

  test("validates interval bodies and retains required times", () => {
    for (const everyMinutes of [5, 10, 15, 30, 60]) {
      expect(
        validateScheduleInput(
          { ...base, times: [], interval: { everyMinutes, from: null, until: null } },
          root,
        ).ok,
      ).toBe(true);
    }
    for (const interval of [
      { everyMinutes: 7, from: null, until: null },
      { everyMinutes: "15", from: null, until: null },
      { everyMinutes: 15, from: null, until: "18:00" },
      { everyMinutes: 15, from: "08:00", until: null },
      { everyMinutes: 15, from: "08:00", until: "08:00" },
      { everyMinutes: 15, from: "18:00", until: "08:00" },
      { everyMinutes: 15, from: "24:00", until: "18:00" },
      { everyMinutes: 15 },
      { everyMinutes: 15, from: null, until: null, extra: true },
    ])
      expect(validateScheduleInput({ ...base, times: [], interval }, root).ok).toBe(false);
    const interval = { everyMinutes: 15, from: "08:00", until: "18:00" };
    expect(validateScheduleInput({ ...base, interval }, root).ok).toBe(false);
    expect(validateScheduleInput({ ...base, times: undefined, interval }, root).ok).toBe(false);
    expect(validateScheduleInput({ ...base, times: [], interval }, root).ok).toBe(true);
    expect(validateScheduleInput({ ...base, interval: null }, root).ok).toBe(true);
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

describe("interval cadence", () => {
  const interval = { everyMinutes: 15 as const, from: "08:00", until: "18:00" };
  function daySlots(
    day: number,
    cadence: { everyMinutes: 5 | 15; from: string | null; until: string | null } = interval,
  ) {
    const slots = [];
    let cursor = at(2026, 10, day, 0) - 1;
    for (;;) {
      const slot = nextSlot(ALL_DAYS, [], cursor, cadence);
      if (!slot || new Date(slot.at).getDate() !== day) break;
      slots.push(slot);
      cursor = slot.at;
    }
    return slots;
  }
  test("window is exclusive and all-day counts are nominal", () => {
    const slots = daySlots(26);
    expect(slots).toHaveLength(40);
    expect(slots.at(-1)?.slotKey).toBe("2026-10-26T17:45");
    expect(daySlots(26, { everyMinutes: 15, from: null, until: null })).toHaveLength(96);
    expect(daySlots(26, { everyMinutes: 5, from: null, until: null })).toHaveLength(288);
    expect(daySlots(26, { everyMinutes: 15, from: "08:07", until: "09:00" }).at(-1)?.slotKey).toBe(
      "2026-10-26T08:52",
    );
    expect(nextSlot(WORKDAYS, [], at(2026, 10, 30, 18), interval)?.slotKey).toBe(
      "2026-11-02T08:00",
    );
  });
  test("stale threshold is strictly greater than one interval", () => {
    const slot = { slotKey: "x", at: 1 };
    expect(decideFiring({ slot, baselineAt: 0, hasRow: false, now: 900001, interval })).toBe(
      "fire",
    );
    expect(decideFiring({ slot, baselineAt: 0, hasRow: false, now: 900002, interval })).toBe(
      "stale",
    );
  });
  test.each([
    [3, 29, 92],
    [10, 25, 96],
  ])("DST day %i/%i has unique consistent slots", (mo, d, count) => {
    const cadence = { everyMinutes: 15 as const, from: null, until: null };
    const slots = [];
    let cursor = at(2026, mo, d, 0) - 1;
    for (;;) {
      const slot = nextSlot(ALL_DAYS, [], cursor, cadence);
      if (!slot || new Date(slot.at).getDate() !== d) break;
      expect(latestDueSlot(ALL_DAYS, [], slot.at, cadence)).toEqual(slot);
      slots.push(slot);
      cursor = slot.at;
    }
    expect(slots).toHaveLength(count);
    expect(new Set(slots.map((s) => s.at)).size).toBe(count);
    expect(new Set(slots.map((s) => s.slotKey)).size).toBe(count);
  });
});

describe("schedule usage limits", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-limit-"));
  const from = { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 } as const;
  test("decision table: stop wins, selected start must be known, exact thresholds", () => {
    for (const [limit, week, session5h, reason] of [
      [{ kind: "upTo", stopPct: 70 }, 69, null, null],
      [{ kind: "upTo", stopPct: 70 }, 70, null, "stop-reached"],
      [{ kind: "upTo", stopPct: 100 }, null, null, null],
      [{ kind: "upTo", stopPct: 100 }, 100, 0, "stop-reached"],
      [from, 79, 10, "below-start"],
      [from, 80, 10, null],
      [from, null, 90, "usage-unknown"],
      [from, null, 95, "stop-reached"],
      [from, 80, 95, "stop-reached"],
      [from, null, null, "usage-unknown"],
      [{ ...from, startWindow: "5h" }, 90, 80, null],
      [{ ...from, startWindow: "5h" }, 90, null, "usage-unknown"],
    ] as const) {
      const result = decideUsageLimit(limit, "claude", { week, session5h });
      expect(result.reason).toBe(reason);
      expect(result.allowed).toBe(reason === null);
      expect(result.usage.provider).toBe("claude");
    }
    expect(decideUsageLimit(from, "codex", { week: 80, session5h: 96 }).usage).toEqual({
      provider: "codex",
      window: "max",
      usedPct: 96,
      thresholdPct: 95,
    });
  });
  test("validates closed usage-limit variants in five-percent steps", () => {
    const body = { repoPath: root, name: "Usage", prompt: "test", days: 127, times: ["09:00"] };
    for (const usageLimit of [
      null,
      { kind: "upTo", stopPct: 5 },
      { kind: "upTo", stopPct: 100 },
      from,
      { ...from, startPct: 0 },
      { ...from, startPct: 95, stopPct: 100 },
    ])
      expect(validateScheduleInput({ ...body, usageLimit }, root).ok).toBe(true);
    for (const usageLimit of [
      [],
      80,
      {},
      { kind: "other", stopPct: 70 },
      { kind: "upTo", stopPct: 0 },
      { kind: "upTo", stopPct: 101 },
      { kind: "upTo", stopPct: 71 },
      { kind: "upTo", stopPct: 70.5 },
      { kind: "upTo", stopPct: "70" },
      { kind: "upTo", stopPct: 70, startPct: 0 },
      { ...from, startWindow: "day" },
      { ...from, startPct: 95 },
      { ...from, startPct: -5 },
      { ...from, startPct: 81 },
      { ...from, stopPct: 80 },
    ])
      expect(validateScheduleInput({ ...body, usageLimit }, root).ok).toBe(false);
  });
});

test("schedule windows select computed Claude and provider-specific Codex usage", () => {
  const limits = {
    week: { pct: 12, resetAt: 0 },
    session5h: null,
    observed: { week: { pct: 99, resetAt: 0 } },
    providers: [
      { provider: "codex", kind: "tokens", week: null, session5h: { pct: 80, resetAt: 0 } },
    ],
  } as any;
  expect(scheduleUsageWindows(limits, "claude")).toEqual({ week: 12, session5h: null });
  expect(scheduleUsageWindows(limits, "codex")).toEqual({ week: null, session5h: 80 });
  expect(scheduleUsageWindows(null, "codex")).toEqual({ week: null, session5h: null });
});

test("usage mismatch actions validate without changing legacy limits", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-actions-"));
  const body = { repoPath: root, name: "Usage", prompt: "test", days: 127, times: ["09:00"] };
  for (const limit of [
    { kind: "upTo", stopPct: 70 },
    { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 },
  ] as const) {
    for (const onMismatch of [undefined, "skip", "wait", "otherProvider"] as const) {
      const usageLimit = { ...limit, ...(onMismatch !== undefined && { onMismatch }) };
      const result = validateScheduleInput({ ...body, usageLimit }, root);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.usageLimit).toEqual(usageLimit);
    }
    for (const onMismatch of [null, "later", 1]) {
      expect(
        validateScheduleInput({ ...body, usageLimit: { ...limit, onMismatch } }, root).ok,
      ).toBe(false);
    }
  }
});

test("waiting deadline uses the nominal slot, the earlier next slot and local DST normalization", () => {
  const fixed = { days: ALL_DAYS, times: ["09:00", "18:00"], interval: null };
  expect(waitingLimitExpiresAt(fixed, "2026-10-26T09:00")).toBe(at(2026, 10, 26, 18));
  expect(waitingLimitExpiresAt({ ...fixed, times: ["09:00"] }, "2026-10-26T09:00")).toBe(
    at(2026, 10, 26, 21),
  );
  const interval = {
    ...fixed,
    times: [],
    interval: { everyMinutes: 15 as const, from: null, until: null },
  };
  expect(waitingLimitExpiresAt(interval, "2026-10-26T09:00")).toBe(at(2026, 10, 26, 9, 15));
  for (const [key, nominal] of [
    ["2026-03-29T02:30", at(2026, 3, 29, 2, 30)],
    ["2026-10-25T02:30", at(2026, 10, 25, 2, 30)],
  ] as const) {
    expect(waitingLimitExpiresAt({ ...fixed, times: ["02:30"] }, key)).toBe(nominal + STALE_MS);
  }
});

test("pauseAtStop validates booleans and preserves both limit variants", () => {
  const root = mkdtempSync(join(tmpdir(), "sched-pause-"));
  const body = { repoPath: root, name: "Usage", prompt: "test", days: 127, times: ["09:00"] };
  for (const limit of [
    { kind: "upTo", stopPct: 70 },
    { kind: "from", startPct: 60, startWindow: "week", stopPct: 95 },
  ] as const) {
    for (const pauseAtStop of [true, false]) {
      const usageLimit = { ...limit, pauseAtStop };
      const result = validateScheduleInput({ ...body, usageLimit }, root);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.usageLimit).toEqual(usageLimit);
    }
    for (const pauseAtStop of [null, "true", 1])
      expect(
        validateScheduleInput({ ...body, usageLimit: { ...limit, pauseAtStop } }, root).ok,
      ).toBe(false);
  }
});
