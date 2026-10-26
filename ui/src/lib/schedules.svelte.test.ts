import { describe, expect, it } from "vitest";
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
});
