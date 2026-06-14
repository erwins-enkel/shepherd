import { describe, it, expect, afterEach, vi } from "vitest";
import { pwaRowState } from "./pwa";

// Stub the browser globals pwaRowState() inspects. standalone toggles the
// display-mode media query; the rest shape the platform branch.
function setEnv(opts: {
  standalone?: boolean;
  iosLegacy?: boolean;
  platform?: string;
  ua?: string;
  maxTouchPoints?: number;
}) {
  const {
    standalone = false,
    iosLegacy = false,
    platform = "",
    ua = "",
    maxTouchPoints = 0,
  } = opts;
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: standalone && q.includes("standalone") }),
  });
  vi.stubGlobal("navigator", {
    standalone: iosLegacy,
    platform,
    userAgent: ua,
    maxTouchPoints,
  });
}

afterEach(() => vi.unstubAllGlobals());

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPADOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

describe("pwaRowState", () => {
  it("reports installed when running standalone (display-mode)", () => {
    setEnv({ standalone: true, platform: "iPhone", ua: IOS_UA });
    expect(pwaRowState()).toBe("installed");
  });

  it("reports installed via the iOS legacy navigator.standalone flag", () => {
    setEnv({ iosLegacy: true, platform: "iPhone", ua: IOS_UA });
    expect(pwaRowState()).toBe("installed");
  });

  it("warns (ios) for an iPhone Safari tab", () => {
    setEnv({ platform: "iPhone", ua: IOS_UA });
    expect(pwaRowState()).toBe("ios");
  });

  it("warns (ios) for an iPadOS tab reporting a Mac UA with touch", () => {
    setEnv({ platform: "MacIntel", ua: IPADOS_UA, maxTouchPoints: 5 });
    expect(pwaRowState()).toBe("ios");
  });

  it("warns (android) for an Android browser tab", () => {
    setEnv({ platform: "Linux armv8l", ua: ANDROID_UA });
    expect(pwaRowState()).toBe("android");
  });

  it("stays optional for a desktop browser tab (push works without install)", () => {
    setEnv({ platform: "Win32", ua: DESKTOP_UA });
    expect(pwaRowState()).toBe("optional");
  });

  it("does not mistake a touch-capable desktop Mac for an iPad", () => {
    // A desktop Mac with a touch device attached: Mac UA but no real iOS platform.
    setEnv({ platform: "MacIntel", ua: DESKTOP_UA, maxTouchPoints: 0 });
    expect(pwaRowState()).toBe("optional");
  });
});
