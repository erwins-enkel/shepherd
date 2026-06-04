import { describe, expect, it } from "vitest";
import { buildMetadata, dataUrlToBlob, type PageInfo } from "../src/lib/capture";

const PAGE_INFO: PageInfo = {
  viewportW: 1024,
  viewportH: 768,
  devicePixelRatio: 1.5,
  userAgent: "UA-string",
  locale: "de-DE",
};

describe("dataUrlToBlob", () => {
  it("decodes a PNG data URL into a Blob of the right type", async () => {
    // 1x1 transparent PNG
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const blob = dataUrlToBlob(dataUrl);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe("buildMetadata", () => {
  it("merges tab fields + page info + timestamp into PageMetadata", () => {
    const meta = buildMetadata(
      { url: "https://x.test/p", title: "X" },
      PAGE_INFO,
      "2026-06-04T10:00:00.000Z",
    );
    expect(meta).toEqual({
      url: "https://x.test/p",
      title: "X",
      viewportW: 1024,
      viewportH: 768,
      devicePixelRatio: 1.5,
      userAgent: "UA-string",
      locale: "de-DE",
      timestamp: "2026-06-04T10:00:00.000Z",
    });
  });

  it("falls back to empty strings when tab url/title are missing", () => {
    const meta = buildMetadata({}, PAGE_INFO, "2026-06-04T10:00:00.000Z");
    expect(meta.url).toBe("");
    expect(meta.title).toBe("");
  });
});
