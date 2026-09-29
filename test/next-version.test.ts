import { test, expect } from "bun:test";
import {
  compareSemver,
  nextVersion,
  parseSemver,
  readChangelogVersions,
  strandedVersion,
} from "../scripts/next-version.mjs";

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

test("readChangelogVersions: collects `## [x.y.z]` headings from the real CHANGELOG", () => {
  const versions = readChangelogVersions();
  expect(versions.has("2.0.0")).toBe(true);
  expect(versions.has("1.47.0")).toBe(true);
  expect(versions.has("1.48.0")).toBe(false);
});

test("readChangelogVersions: parses given text", () => {
  const text = "# Changelog\n\n## [1.2.0](https://x) (2026-01-02)\n\n### [1.1.1](https://x)\n";
  expect([...readChangelogVersions(text)].sort()).toEqual(["1.1.1", "1.2.0"]);
});

test("strandedVersion: released or upcoming is fine, anything else is stranded", () => {
  const released = new Set(["1.47.0", "2.0.0"]);
  expect(strandedVersion("1.47.0", released, "2.0.0")).toBe(false);
  expect(strandedVersion("2.1.0", released, "2.0.0")).toBe(false);
  expect(strandedVersion("1.48.0", released, "2.0.0")).toBe(true);
  expect(strandedVersion("2.0.0", new Set(["1.47.0"]), "2.0.0")).toBe(true);
  expect(() => strandedVersion("dev", released, "2.0.0")).toThrow();
});
