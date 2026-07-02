import { test, expect } from "bun:test";
import { compareSemver, nextVersion, parseSemver } from "../scripts/next-version.mjs";

test("parseSemver: extracts major/minor/patch, tolerates suffixes", () => {
  expect(parseSemver("1.40.0")).toEqual([1, 40, 0]);
  expect(parseSemver(" 2.3.4 ")).toEqual([2, 3, 4]);
  expect(parseSemver("1.41.0-rc.1")).toEqual([1, 41, 0]);
});

test("parseSemver: throws on non-semver", () => {
  expect(() => parseSemver("dev")).toThrow();
  expect(() => parseSemver("1.2")).toThrow();
});

test("compareSemver: orders by major, then minor, then patch", () => {
  expect(compareSemver("1.40.0", "1.40.0")).toBe(0);
  expect(compareSemver("1.41.0", "1.40.0")).toBeGreaterThan(0);
  expect(compareSemver("1.40.0", "1.41.0")).toBeLessThan(0);
  expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
  expect(compareSemver("1.40.1", "1.40.0")).toBeGreaterThan(0);
});

test("nextVersion: bumps the minor, zeroes the patch (release-please feat bump)", () => {
  expect(nextVersion("1.40.0")).toBe("1.41.0");
  expect(nextVersion("1.40.3")).toBe("1.41.0");
  expect(nextVersion("2.0.0")).toBe("2.1.0");
});
