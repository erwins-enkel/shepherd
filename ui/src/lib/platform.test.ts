import { describe, it, expect, afterEach, vi } from "vitest";
import { isMacPlatform } from "./platform";

afterEach(() => vi.unstubAllGlobals());

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("isMacPlatform", () => {
  it("returns true for a Mac UA", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: MAC_UA });
    expect(isMacPlatform()).toBe(true);
  });

  it("returns false for a Windows UA", () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: WINDOWS_UA });
    expect(isMacPlatform()).toBe(false);
  });

  it("returns false for a Linux UA", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgent: LINUX_UA });
    expect(isMacPlatform()).toBe(false);
  });

  it("returns false when navigator is undefined (SSR)", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isMacPlatform()).toBe(false);
  });
});
