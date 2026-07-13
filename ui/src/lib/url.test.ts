import { describe, it, expect } from "vitest";
import { firstSafeHttpUrl } from "./url";

describe("firstSafeHttpUrl", () => {
  it("accepts http and https", () => {
    expect(firstSafeHttpUrl("http://example.com/pr/1")).toBe("http://example.com/pr/1");
    expect(firstSafeHttpUrl("https://github.com/o/r/pull/2")).toBe("https://github.com/o/r/pull/2");
  });

  it("rejects non-http(s) schemes and garbage, returning null", () => {
    expect(firstSafeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(firstSafeHttpUrl("data:text/html,x")).toBeNull();
    expect(firstSafeHttpUrl("mailto:x@y.z")).toBeNull();
    expect(firstSafeHttpUrl("ftp://host/f")).toBeNull();
    expect(firstSafeHttpUrl("not a url")).toBeNull();
    expect(firstSafeHttpUrl(undefined, null, "")).toBeNull();
  });

  it("returns the FIRST safe candidate (verdict preferred over git.url)", () => {
    expect(firstSafeHttpUrl("https://verdict/pr", "https://git/pr")).toBe("https://verdict/pr");
  });

  it("falls back past an unsafe candidate to a safe one", () => {
    expect(firstSafeHttpUrl("javascript:alert(1)", "https://git/pr")).toBe("https://git/pr");
    expect(firstSafeHttpUrl(undefined, "https://git/pr")).toBe("https://git/pr");
  });
});
