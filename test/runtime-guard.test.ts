import { describe, expect, it } from "bun:test";
import { bunTooOld } from "../src/runtime-guard";

describe("Bun runtime floor", () => {
  it("warns below 1.3.2, including its prereleases", () => {
    expect(bunTooOld("1.3.1")).toBe(true);
    expect(bunTooOld("1.3.2")).toBe(false);
    expect(bunTooOld("1.4.2")).toBe(false);
    expect(bunTooOld("1.3.2-canary")).toBe(true);
  });
});
