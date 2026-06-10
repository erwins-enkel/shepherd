import { describe, it, expect } from "vitest";
import { promoDefaultModel, FABLE_PROMO_UNTIL } from "./fable-promo";

describe("fable-promo promoDefaultModel", () => {
  it("preselects fable during the launch window", () => {
    expect(promoDefaultModel(new Date("2026-06-09T12:00:00+02:00"))).toBe("fable");
  });

  it("preselects fable right up to the cutoff (inclusive)", () => {
    expect(promoDefaultModel(new Date(FABLE_PROMO_UNTIL.getTime()))).toBe("fable");
  });

  it("reverts to the prior default just after the cutoff", () => {
    expect(promoDefaultModel(new Date(FABLE_PROMO_UNTIL.getTime() + 1000))).toBe("default");
  });

  it("uses the prior default well after the window", () => {
    expect(promoDefaultModel(new Date("2026-08-01T00:00:00+02:00"))).toBe("default");
  });
});
