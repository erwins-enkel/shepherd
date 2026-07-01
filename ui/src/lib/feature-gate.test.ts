import { describe, it, expect } from "vitest";
import { computeNewEntries } from "./feature-gate";
import { featureAnnouncements } from "./feature-announcements";
import type { FeatureAnnouncement } from "./feature-announcements";
import enMessages from "../../messages/en.json";

// Minimal catalog for most tests so they don't depend on Task 2/3 data
const catalog: readonly FeatureAnnouncement[] = [
  { id: "a", sinceVersion: "1.10.0", titleKey: "feat_a_title", bodyKey: "feat_a_body" },
  { id: "b", sinceVersion: "1.9.0", titleKey: "feat_b_title", bodyKey: "feat_b_body" },
  { id: "c", sinceVersion: "1.11.0", titleKey: "feat_c_title", bodyKey: "feat_c_body" },
  {
    id: "bad",
    sinceVersion: "not-a-version",
    titleKey: "feat_bad_title",
    bodyKey: "feat_bad_body",
  },
];

describe("computeNewEntries", () => {
  it("fresh install (null lastSeen) → []", () => {
    expect(computeNewEntries(null, "1.10.0", catalog)).toEqual([]);
  });

  it("equal version → []", () => {
    expect(computeNewEntries("1.10.0", "1.10.0", catalog)).toEqual([]);
  });

  it("current older than lastSeen → []", () => {
    expect(computeNewEntries("1.11.0", "1.10.0", catalog)).toEqual([]);
  });

  it("current 'dev' (unparseable) → []", () => {
    expect(computeNewEntries("1.9.0", "dev", catalog)).toEqual([]);
  });

  it("unparseable lastSeen → []", () => {
    expect(computeNewEntries("not-valid", "1.10.0", catalog)).toEqual([]);
  });

  it("higher current returns entries with sinceVersion > lastSeen and <= current", () => {
    // lastSeen = 1.9.0, current = 1.10.0
    // entry 'a' sinceVersion 1.10.0 → 1.10.0 > 1.9.0 AND 1.10.0 <= 1.10.0 → included
    // entry 'b' sinceVersion 1.9.0 → 1.9.0 > 1.9.0 is false → excluded
    // entry 'c' sinceVersion 1.11.0 → 1.11.0 > 1.10.0 (current) → excluded (future-dated)
    // entry 'bad' sinceVersion unparseable → excluded
    const result = computeNewEntries("1.9.0", "1.10.0", catalog);
    expect(result.map((e) => e.id)).toEqual(["a"]);
  });

  it("sinceVersion > currentVersion → excluded", () => {
    // entry 'c' has sinceVersion 1.11.0, current is 1.10.0 — must not surface prematurely
    const result = computeNewEntries("1.9.0", "1.10.0", catalog);
    expect(result.find((e) => e.id === "c")).toBeUndefined();
  });

  it("sinceVersion === lastSeen → excluded", () => {
    const result = computeNewEntries("1.9.0", "1.10.0", catalog);
    expect(result.find((e) => e.id === "b")).toBeUndefined();
  });

  it("sinceVersion > lastSeen → included", () => {
    const result = computeNewEntries("1.9.0", "1.10.0", catalog);
    expect(result.find((e) => e.id === "a")).toBeDefined();
  });

  it("entries with unparseable sinceVersion are excluded, never throws", () => {
    expect(() => computeNewEntries("1.9.0", "1.10.0", catalog)).not.toThrow();
    const result = computeNewEntries("1.9.0", "1.10.0", catalog);
    expect(result.find((e) => e.id === "bad")).toBeUndefined();
  });

  it("works with patch-level bumps", () => {
    const result = computeNewEntries("1.10.0", "1.10.1", [
      { id: "patch", sinceVersion: "1.10.1", titleKey: "t", bodyKey: "b" },
    ]);
    expect(result.map((e) => e.id)).toEqual(["patch"]);
  });

  it("empty catalog → []", () => {
    expect(computeNewEntries("1.9.0", "1.10.0", [])).toEqual([]);
  });

  it("orders results newest release first, catalog order within a release", () => {
    const c: readonly FeatureAnnouncement[] = [
      { id: "old", sinceVersion: "1.10.0", titleKey: "t", bodyKey: "b" },
      { id: "mid-1", sinceVersion: "1.11.0", titleKey: "t", bodyKey: "b" },
      { id: "new", sinceVersion: "1.12.0", titleKey: "t", bodyKey: "b" },
      { id: "mid-2", sinceVersion: "1.11.0", titleKey: "t", bodyKey: "b" },
    ];
    expect(computeNewEntries("1.9.0", "1.12.0", c).map((e) => e.id)).toEqual([
      "new",
      "mid-1",
      "mid-2",
      "old",
    ]);
  });

  it("real catalog: upgrade from 1.9.0 → 1.10.0 shows the three 1.10.0 seed entries", () => {
    // sinceVersion "1.10.0" <= current "1.10.0" → included (upper-bound is inclusive);
    // later entries (e.g. the 1.15.0 halt-the-herd e-stop) are future-dated → excluded.
    const result = computeNewEntries("1.9.0", "1.10.0", featureAnnouncements);
    expect(result.map((e) => e.id)).toEqual(
      expect.arrayContaining(["critic", "auto-address", "learnings"]),
    );
    // exactly the entries whose sinceVersion falls in (1.9.0, 1.10.0]
    expect(result).toHaveLength(
      featureAnnouncements.filter((e) => e.sinceVersion === "1.10.0").length,
    );
    expect(result.find((e) => e.id === "halt-the-herd")).toBeUndefined();
  });
});

describe("catalog has no duplicate ids", () => {
  // Feature announcements are split into one-file fragments to avoid merge
  // hotspots. A duplicated `id` is still an invalid catalog identity, so fail
  // loudly here instead of shipping a doubled What's-New entry.
  it("every entry id is unique", () => {
    const ids = featureAnnouncements.map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(
      dupes,
      `duplicate feature-announcement id(s): ${[...new Set(dupes)].join(", ")}`,
    ).toEqual([]);
  });
});

describe("catalog key parity — all titleKey/bodyKey exist in en.json", () => {
  const enKeys = new Set(Object.keys(enMessages));

  for (const entry of featureAnnouncements) {
    it(`entry '${entry.id}' titleKey '${entry.titleKey}' exists in en.json`, () => {
      expect(enKeys.has(entry.titleKey)).toBe(true);
    });

    it(`entry '${entry.id}' bodyKey '${entry.bodyKey}' exists in en.json`, () => {
      expect(enKeys.has(entry.bodyKey)).toBe(true);
    });
  }
});
