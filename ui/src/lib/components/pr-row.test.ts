import { describe, it, expect } from "vitest";
import { showRebaseOffer } from "./pr-row";

describe("showRebaseOffer", () => {
  const base = { kind: "dependabot" as const, blocked: true, failed: false, requested: false };
  it("offers for a blocked dependabot PR", () => {
    expect(showRebaseOffer(base)).toBe(true);
  });
  it("offers after a failed merge", () => {
    expect(showRebaseOffer({ ...base, blocked: false, failed: true })).toBe(true);
  });
  it("hides for a regular blocked PR", () => {
    expect(showRebaseOffer({ ...base, kind: "regular" })).toBe(false);
  });
  it("hides for a release blocked PR", () => {
    expect(showRebaseOffer({ ...base, kind: "release" })).toBe(false);
  });
  it("hides when neither blocked nor failed", () => {
    expect(showRebaseOffer({ ...base, blocked: false, failed: false })).toBe(false);
  });
  it("hides once a rebase has been requested", () => {
    expect(showRebaseOffer({ ...base, requested: true })).toBe(false);
  });
});
