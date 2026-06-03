import { describe, it, expect } from "vitest";
import { isDependabotAuthor, showRebaseOffer } from "./pr-row";

describe("isDependabotAuthor", () => {
  it("matches gh's app/dependabot login", () => {
    expect(isDependabotAuthor("app/dependabot")).toBe(true);
  });
  it("matches dependabot[bot]", () => {
    expect(isDependabotAuthor("dependabot[bot]")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isDependabotAuthor("App/Dependabot")).toBe(true);
  });
  it("rejects a human author", () => {
    expect(isDependabotAuthor("alice")).toBe(false);
  });
  it("rejects a vanity login that merely contains 'dependabot'", () => {
    expect(isDependabotAuthor("dependabot-fan")).toBe(false);
    expect(isDependabotAuthor("not-dependabot")).toBe(false);
    expect(isDependabotAuthor("app/dependabot-mirror")).toBe(false);
  });
});

describe("showRebaseOffer", () => {
  const base = { author: "app/dependabot", blocked: true, failed: false, requested: false };
  it("offers for a blocked dependabot PR", () => {
    expect(showRebaseOffer(base)).toBe(true);
  });
  it("offers after a failed merge", () => {
    expect(showRebaseOffer({ ...base, blocked: false, failed: true })).toBe(true);
  });
  it("hides for a non-dependabot blocked PR", () => {
    expect(showRebaseOffer({ ...base, author: "alice" })).toBe(false);
  });
  it("hides when neither blocked nor failed", () => {
    expect(showRebaseOffer({ ...base, blocked: false, failed: false })).toBe(false);
  });
  it("hides once a rebase has been requested", () => {
    expect(showRebaseOffer({ ...base, requested: true })).toBe(false);
  });
});
