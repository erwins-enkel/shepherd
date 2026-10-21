import { describe, expect, test } from "bun:test";
import {
  cacheControlFor,
  etagFor,
  etagMatches,
  isAssetPath,
  isCompressible,
  pickEncodings,
} from "../src/static-assets";

describe("cacheControlFor", () => {
  test("hashed chunks are immutable for a year", () => {
    expect(cacheControlFor("_app/immutable/nodes/2.abc.js")).toBe(
      "public, max-age=31536000, immutable",
    );
  });
  test("everything else revalidates", () => {
    for (const p of ["index.html", "sw.js", "manifest.webmanifest", "_app/version.json"])
      expect(cacheControlFor(p)).toBe("no-cache");
  });
});

test("isAssetPath: only the _app tree skips the SPA fallback", () => {
  expect(isAssetPath("_app/immutable/x.js")).toBe(true);
  expect(isAssetPath("settings")).toBe(false);
});

test("isCompressible: text assets only", () => {
  expect(isCompressible("a.js")).toBe(true);
  expect(isCompressible("a.webmanifest")).toBe(true);
  expect(isCompressible("icons/v2/icon-192.png")).toBe(false);
  expect(isCompressible("a.js.br")).toBe(false);
});

describe("pickEncodings", () => {
  test("prefers brotli, then gzip", () => {
    expect(pickEncodings("gzip, deflate, br, zstd")).toEqual(["br", "gzip"]);
  });
  test("honors q=0 as not acceptable", () => {
    expect(pickEncodings("br;q=0, gzip;q=0.5")).toEqual(["gzip"]);
  });
  test("wildcard accepts both", () => {
    expect(pickEncodings("*")).toEqual(["br", "gzip"]);
  });
  test("missing or identity-only header gets nothing", () => {
    expect(pickEncodings(null)).toEqual([]);
    expect(pickEncodings("identity")).toEqual([]);
  });
});

describe("etag", () => {
  test("differs per encoding variant", () => {
    expect(etagFor(10, 1000, null)).not.toBe(etagFor(10, 1000, "br"));
  });
  test("weak comparison, lists and wildcard", () => {
    const tag = etagFor(10, 1000, "gzip");
    expect(etagMatches(tag, tag)).toBe(true);
    expect(etagMatches(`"other", ${tag.replace(/^W\//, "")}`, tag)).toBe(true);
    expect(etagMatches("*", tag)).toBe(true);
    expect(etagMatches(null, tag)).toBe(false);
    expect(etagMatches(etagFor(11, 1000, "gzip"), tag)).toBe(false);
  });
});
