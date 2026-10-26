import { describe, expect, it, vi } from "vitest";
import { cadenceSummary, weekdayNames, WORKDAYS, ALL_DAYS } from "./schedules.svelte";

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
