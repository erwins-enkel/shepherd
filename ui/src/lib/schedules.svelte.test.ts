import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cadenceSummary,
  usageLimitPreview,
  intervalStats,
  outcomeLabel,
  outcomeTone,
  schedules,
  upcomingOrder,
  upcomingSlots,
  weekdayNames,
  WORKDAYS,
  ALL_DAYS,
} from "./schedules.svelte";
import type { Schedule } from "#lib/types.js";

describe("outcomeLabel (#3469)", () => {
  it("labels a no-op run", () => {
    expect(outcomeLabel("noop")).toBe("nothing to do");
  });
});

describe("schedule outcome presentation", () => {
  it("keeps future outcomes readable and neutral", () => {
    expect(outcomeLabel("future:result")).toBe("future:result");
    expect(outcomeTone("future:result")).toBe("neutral");
  });

  it.each([
    ["error", "red"],
    ["claimed", "red"],
    ["held", "amber"],
    ["skipped:overlap", "amber"],
    ["skipped:stale", "amber"],
    ["spawned", "neutral"],
    ["noop", "neutral"],
  ])("assigns %s its outcome tone", (outcome, tone) => {
    expect(outcomeTone(outcome)).toBe(tone);
    expect(outcomeLabel(outcome)).toBeTruthy();
  });
});

describe("schedule history revisions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("invalidates only the changed repo even if its list reload fails", async () => {
    vi.resetModules();
    const { schedules: fresh } = await import("./schedules.svelte");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 500 }));
    await fresh.load("/changed");
    const before = fresh.revisionFor("/changed");
    fresh.refresh("/changed");
    expect(fresh.revisionFor("/changed")).toBe(before + 1);
    expect(fresh.revisionFor("/other")).toBe(0);
  });

  it("invalidates history after running locally", async () => {
    vi.resetModules();
    const { schedules: fresh } = await import("./schedules.svelte");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        new Response(
          JSON.stringify(init?.method === "POST" ? { outcome: "spawned" } : { schedules: [] }),
        ),
    );
    await fresh.runNow(sched("local", "/local", "Local", null));
    expect(fresh.revisionFor("/local")).toBe(1);
  });
});

describe("cadenceSummary (#3469)", () => {
  it("formats a compact German workweek", () => {
    expect(cadenceSummary(WORKDAYS, ["09:00", "18:00"], "de")).toBe("Mo–Fr · 09:00, 18:00");
  });
  it("collapses contiguous days into a range", () => {
    expect(cadenceSummary(WORKDAYS, ["09:00", "18:00"], "en")).toBe("Mon–Fri · 09:00, 18:00");
    expect(cadenceSummary(ALL_DAYS, ["07:30"], "en")).toBe("Mon–Sun · 07:30");
  });
  it("lists short runs and gaps", () => {
    // Mon, Tue, Thu
    expect(cadenceSummary(0b0001011, ["09:00"], "en")).toBe("Mon, Tue, Thu · 09:00");
  });
  it("weekdays are Monday-first and localized", () => {
    expect(weekdayNames("en")[0]).toBe("Mon");
    expect(weekdayNames("de")[6]).toBe("So");
  });
  it("labels never shift with the browser's time zone", () => {
    const fmt = Intl.DateTimeFormat;
    // Simulate a UTC+13 browser: default the zone unless one is passed explicitly.
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      loc?: string | string[],
      opts?: Intl.DateTimeFormatOptions,
    ) {
      return new fmt(loc, { timeZone: "Pacific/Auckland", ...opts });
    } as unknown as typeof Intl.DateTimeFormat);
    try {
      expect(weekdayNames("en")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    } finally {
      spy.mockRestore();
    }
  });
});

function sched(id: string, repoPath: string, name: string, nextAt: number | null): Schedule {
  return {
    id,
    repoPath,
    name,
    prompt: "p",
    days: WORKDAYS,
    times: ["09:00"],
    enabled: nextAt !== null,
    launch: {
      agentProvider: null,
      model: null,
      effort: null,
      autopilotEnabled: false,
      planGateEnabled: null,
      research: false,
      sandboxProfile: null,
      baseBranch: null,
    },
    createdAt: 1,
    updatedAt: 1,
    lastRun: null,
    nextAt,
  };
}

describe("upcomingOrder (#3475)", () => {
  it("sorts by next run, disabled last by repo then name", () => {
    const list = [
      sched("a", "/x/zeta", "Off B", null),
      sched("b", "/x/beta", "Later", 200),
      sched("c", "/x/alpha", "Off A", null),
      sched("d", "/x/zeta", "Soon", 100),
      sched("e", "/x/alpha", "Off C", null),
    ];
    expect(upcomingOrder(list).map((s) => s.id)).toEqual(["d", "b", "c", "e", "a"]);
    expect(list[0].id).toBe("a"); // input untouched
  });
});

describe("schedules store: every-repo list (#3475)", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockFetch() {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ schedules: [sched("a", "/r", "A", 1)] }));
    });
    return urls;
  }

  it("schedules:changed re-reads the global list only once it was loaded", async () => {
    const urls = mockFetch();
    schedules.refresh("/r");
    expect(urls).toEqual([]);
    await schedules.loadAll();
    expect(schedules.all()?.map((s) => s.id)).toEqual(["a"]);
    urls.length = 0;
    schedules.refresh("/r");
    await vi.waitFor(() => expect(urls.some((u) => u.endsWith("/api/schedules"))).toBe(true));
  });
});

describe("schedules store: every-repo list load failure (#3475)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a failed first read is reported and retried by the next schedules:changed", async () => {
    vi.resetModules(); // a store that has never loaded the every-repo list
    const { schedules: fresh } = await import("./schedules.svelte");
    let ok = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ok
        ? new Response(JSON.stringify({ schedules: [sched("a", "/r", "A", 1)] }))
        : new Response("boom", { status: 500 }),
    );
    await fresh.loadAll();
    expect(fresh.all()).toBeNull();
    expect(fresh.allFailed()).toBe(true);
    ok = true;
    fresh.refresh("/r");
    await vi.waitFor(() => expect(fresh.all()?.map((s) => s.id)).toEqual(["a"]));
    expect(fresh.allFailed()).toBe(false);
  });
});

describe("upcomingSlots", () => {
  const at = (day: number, hour = 9, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

  it("crosses Sunday into Monday and only includes active days", () => {
    expect(upcomingSlots(WORKDAYS, ["09:00"], at(8, 20), 3)).toEqual([at(9), at(10), at(11)]);
  });

  it("fills the preview across multiple weeks for a single active day", () => {
    expect(upcomingSlots(1, ["09:00"], at(9), 3)).toEqual([at(16), at(23), at(30)]);
  });

  it("sorts times, excludes now, and never mutates the input", () => {
    const times = ["18:00", "09:00", "12:00", "18:00"];
    expect(upcomingSlots(ALL_DAYS, times, at(9), 3)).toEqual([at(9, 12), at(9, 18), at(10)]);
    expect(times).toEqual(["18:00", "09:00", "12:00", "18:00"]);
  });

  it("uses local calendar dates across daylight saving changes", () => {
    const now = new Date(2026, 2, 28, 18).getTime();
    expect(upcomingSlots(ALL_DAYS, ["09:00"], now, 3)).toEqual([
      new Date(2026, 2, 29, 9).getTime(),
      new Date(2026, 2, 30, 9).getTime(),
      new Date(2026, 2, 31, 9).getTime(),
    ]);
  });

  it("ignores incomplete or invalid times and handles empty cadences", () => {
    expect(upcomingSlots(0, ["09:00"], at(9), 3)).toEqual([]);
    expect(upcomingSlots(ALL_DAYS, [], at(9), 3)).toEqual([]);
    expect(upcomingSlots(ALL_DAYS, ["", "25:00", "09:"], at(9), 3)).toEqual([]);
    expect(upcomingSlots(ALL_DAYS, ["", "18:00"], at(9), 1)).toEqual([at(9, 18)]);
    expect(upcomingSlots(ALL_DAYS, ["09:00"], at(9), 0)).toEqual([]);
  });
});

describe("interval presentation", () => {
  const interval = { everyMinutes: 15 as const, from: "08:00", until: "18:00" };
  it("counts slots and formats a window and all day", () => {
    expect(intervalStats(WORKDAYS, interval)).toEqual({ perDay: 40, perWeek: 200, last: "17:45" });
    expect(intervalStats(ALL_DAYS, { ...interval, from: null, until: null })).toEqual({
      perDay: 96,
      perWeek: 672,
      last: "23:45",
    });
    expect(cadenceSummary(WORKDAYS, [], "en", interval)).toBe(
      "Mon–Fri · every 15 min · 08:00–18:00",
    );
    expect(cadenceSummary(ALL_DAYS, [], "en", { ...interval, from: null, until: null })).toBe(
      "Mon–Sun · every 15 min · around the clock",
    );
  });
  it("previews exclusive window slots and skips inactive days", () => {
    const now = new Date(2026, 9, 30, 17, 30).getTime();
    expect(upcomingSlots(WORKDAYS, [], now, 3, interval)).toEqual([
      new Date(2026, 9, 30, 17, 45).getTime(),
      new Date(2026, 10, 2, 8).getTime(),
      new Date(2026, 10, 2, 8, 15).getTime(),
    ]);
    expect(upcomingSlots(ALL_DAYS, [], now, 3, { ...interval, until: "08:00" })).toEqual([]);
    expect(intervalStats(WORKDAYS, { ...interval, until: "08:00" })).toBeNull();
  });
  it.each([
    [2, 29],
    [9, 25],
  ])("previews unique instants across DST month %i day %i", (month, day) => {
    const start = new Date(2026, month, day).getTime();
    const end = new Date(2026, month, day + 1).getTime();
    const slots = upcomingSlots(ALL_DAYS, [], start - 1, 300, {
      everyMinutes: 15,
      from: null,
      until: null,
    }).filter((at) => at < end);
    expect(slots).toHaveLength(Math.min(96, (end - start) / 900_000));
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots[0]).toBe(start);
  });
  it("distinguishes historical stale reasons", () => {
    expect(outcomeLabel("skipped:stale", "missed by more than one interval")).toBe(
      "skipped, missed by more than one interval",
    );
    expect(outcomeLabel("skipped:stale", "missed slot older than 12h")).toContain("12h");
  });
});

describe("schedule usage limit preview", () => {
  const from = { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 } as const;
  it.each([
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
  ] as const)("mirrors the server: %j / %s / %s", (limit, week, session5h, reason) => {
    const preview = usageLimitPreview(limit, "claude", {
      week: week === null ? null : { pct: week, resetAt: 1000 },
      session5h: session5h === null ? null : { pct: session5h, resetAt: 2000 },
    } as any);
    expect(preview.reason).toBe(reason);
    expect(preview.allowed).toBe(reason === null);
  });
  it("uses Codex windows and the stopping window reset while keeping the start marker", () => {
    const preview = usageLimitPreview(from, "codex", {
      week: { pct: 10, resetAt: 1 },
      providers: [
        {
          provider: "codex",
          kind: "tokens",
          week: { pct: 80, resetAt: 1000 },
          session5h: { pct: 96, resetAt: 2000 },
        },
      ],
    } as any);
    expect(preview).toMatchObject({
      reason: "stop-reached",
      markerPct: 80,
      resetAt: 2000,
      resetWindow: "5h",
      usage: { usedPct: 96, thresholdPct: 95 },
    });
  });
  it("formats a historic skip with the captured thresholds", () => {
    expect(
      outcomeLabel("skipped:limit", "below-start", {
        provider: "claude",
        window: "week",
        usedPct: 79,
        thresholdPct: 80,
      }),
    ).toContain("80");
    expect(outcomeLabel("skipped:limit", "usage-unknown", null)).toContain("unknown");
    expect(outcomeTone("skipped:limit")).toBe("amber");
  });
});
