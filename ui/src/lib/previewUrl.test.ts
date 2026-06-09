import { describe, it, expect } from "vitest";
import { buildPreviewUrl } from "./previewUrl";

const PORT = 8001;

describe("buildPreviewUrl — loopback branch", () => {
  it("localhost http → preserves http and localhost", () => {
    expect(buildPreviewUrl(null, { protocol: "http:", hostname: "localhost" }, PORT)).toBe(
      "http://localhost:8001/",
    );
  });

  it("127.0.0.1 → uses location host+protocol", () => {
    expect(buildPreviewUrl(null, { protocol: "http:", hostname: "127.0.0.1" }, PORT)).toBe(
      "http://127.0.0.1:8001/",
    );
  });

  it("::1 → uses location host+protocol", () => {
    expect(buildPreviewUrl(null, { protocol: "http:", hostname: "::1" }, PORT)).toBe(
      "http://::1:8001/",
    );
  });

  it("[::1] → uses location host+protocol", () => {
    expect(buildPreviewUrl(null, { protocol: "http:", hostname: "[::1]" }, PORT)).toBe(
      "http://[::1]:8001/",
    );
  });

  it("loopback wins even when previewHost is set", () => {
    // Dev must stay on localhost; previewHost must be ignored.
    expect(
      buildPreviewUrl(
        "backontop.chicken-beardie.ts.net",
        { protocol: "http:", hostname: "localhost" },
        PORT,
      ),
    ).toBe("http://localhost:8001/");
  });
});

describe("buildPreviewUrl — previewHost branch (split-front fix)", () => {
  it("non-loopback + previewHost → https://previewHost:port/", () => {
    expect(
      buildPreviewUrl(
        "backontop.chicken-beardie.ts.net",
        { protocol: "https:", hostname: "shepherd.chicken-beardie.ts.net" },
        PORT,
      ),
    ).toBe("https://backontop.chicken-beardie.ts.net:8001/");
  });

  it("forces https on the previewHost branch even when loc.protocol is http", () => {
    // Operator reached the HUD over http, but the node serves slots via
    // tailscale serve --https (HTTPS-only) → the preview URL must still be https.
    expect(
      buildPreviewUrl(
        "backontop.chicken-beardie.ts.net",
        { protocol: "http:", hostname: "shepherd.chicken-beardie.ts.net" },
        PORT,
      ),
    ).toBe("https://backontop.chicken-beardie.ts.net:8001/");
  });

  it("port is interpolated correctly", () => {
    expect(
      buildPreviewUrl(
        "backontop.chicken-beardie.ts.net",
        { protocol: "https:", hostname: "shepherd.chicken-beardie.ts.net" },
        9999,
      ),
    ).toBe("https://backontop.chicken-beardie.ts.net:9999/");
  });
});

describe("buildPreviewUrl — fallback branch", () => {
  it("non-loopback + previewHost null → loc.protocol//loc.hostname:port/", () => {
    expect(
      buildPreviewUrl(
        null,
        { protocol: "https:", hostname: "backontop.chicken-beardie.ts.net" },
        PORT,
      ),
    ).toBe("https://backontop.chicken-beardie.ts.net:8001/");
  });

  it("non-loopback + previewHost empty string → fallback (NOT https://:8001/)", () => {
    const url = buildPreviewUrl(
      "",
      { protocol: "https:", hostname: "backontop.chicken-beardie.ts.net" },
      PORT,
    );
    expect(url).toBe("https://backontop.chicken-beardie.ts.net:8001/");
    // Explicit guard: empty previewHost must never produce `https://:port/`
    expect(url).not.toContain("https://:");
  });

  it("non-loopback + previewHost null uses loc.protocol", () => {
    expect(buildPreviewUrl(null, { protocol: "http:", hostname: "myhost.example.com" }, PORT)).toBe(
      "http://myhost.example.com:8001/",
    );
  });
});
