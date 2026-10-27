import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cadenceSummary,
  outcomeLabel,
  schedules,
  upcomingOrder,
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

describe("cadenceSummary (#3469)", () => {
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
