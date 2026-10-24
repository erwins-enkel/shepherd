import { describe, expect, it } from "vitest";
import { linkSegments } from "./textLinks";

// Same case table as native/Tests/ShepherdAppCoreTests/TextLinksTests.swift — keep them in step.
const hrefs = (text: string) => linkSegments(text).flatMap((s) => (s.href ? [s.href] : []));

describe("linkSegments", () => {
  it("links a bare URL inside prose, stopping at the space", () => {
    const text =
      "Drei Varianten ganz oben auf https://claude.ai/artifact/GWC6c82ryRzbZfTmTKfhJK (Version 3). Welche nehmen wir?";
    expect(linkSegments(text)).toEqual([
      { text: "Drei Varianten ganz oben auf " },
      {
        text: "https://claude.ai/artifact/GWC6c82ryRzbZfTmTKfhJK",
        href: "https://claude.ai/artifact/GWC6c82ryRzbZfTmTKfhJK",
      },
      { text: " (Version 3). Welche nehmen wir?" },
    ]);
  });

  it("leaves trailing punctuation and quotes out of the link", () => {
    expect(hrefs("See https://x.dev/a.")).toEqual(["https://x.dev/a"]);
    expect(hrefs("„https://x.dev/a“")).toEqual(["https://x.dev/a"]);
    expect(hrefs('"https://x.dev/a",')).toEqual(["https://x.dev/a"]);
    expect(hrefs("https://x.dev/a?!")).toEqual(["https://x.dev/a"]);
  });

  it("drops an unbalanced closing bracket but keeps a balanced one", () => {
    expect(hrefs("(https://x.dev/a)")).toEqual(["https://x.dev/a"]);
    expect(hrefs("[https://x.dev/a]")).toEqual(["https://x.dev/a"]);
    expect(hrefs("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(hrefs("(see https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("links every URL in the text", () => {
    expect(hrefs("http://a.dev/x and https://b.dev/y")).toEqual([
      "http://a.dev/x",
      "https://b.dev/y",
    ]);
  });

  it("matches the scheme case-insensitively, keeping the URL as written", () => {
    expect(hrefs("HTTPS://X.DEV/A")).toEqual(["HTTPS://X.DEV/A"]);
  });

  it("links nothing that is not a bare http(s) URL", () => {
    for (const text of [
      "No link here.",
      "www.example.com",
      "ftp://x.dev/a",
      "javascript:alert(1)",
      "https://",
      "https://.",
      "xhttps://a.b",
      "",
    ]) {
      expect(hrefs(text), text).toEqual([]);
    }
  });

  it("always reassembles to the input", () => {
    for (const text of [
      "Drei Varianten auf https://claude.ai/artifact/GWC6c82ryRzbZfTmTKfhJK (Version 3).",
      "(see https://en.wikipedia.org/wiki/Foo_(bar)).",
      "„https://x.dev/a“ and http://b.dev",
      "No link here.",
      "",
    ]) {
      expect(
        linkSegments(text)
          .map((s) => s.text)
          .join(""),
      ).toBe(text);
    }
  });
});
