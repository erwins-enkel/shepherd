import { afterEach, expect, test, vi } from "vitest";
import { detectTerminalClient, terminalOwnerTitle } from "./terminal-client";

afterEach(() => vi.unstubAllGlobals());

test.each([
  ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5, "ios"],
  ["iPad", "iPad", 5, "ipados"],
  ["MacIntel", "Mozilla Macintosh", 5, "ipados"],
  ["MacIntel", "Mozilla Macintosh", 0, "macos"],
  ["Linux armv8l", "Mozilla Android Linux", 5, "android"],
  ["Win32", "Mozilla Windows NT", 0, "windows"],
  ["Linux x86_64", "Mozilla X11 Linux", 0, "linux"],
  ["Linux x86_64", "Mozilla CrOS", 0, "chromeos"],
  ["", "unrecognized", 0, "unknown"],
])(
  "identifies platform %s / %s without confusing mobile with desktop",
  (platform, userAgent, maxTouchPoints, expected) => {
    vi.stubGlobal("navigator", { platform, userAgent, maxTouchPoints });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(detectTerminalClient()).toEqual({ kind: "browser", platform: expected });
  },
);

test("installed PWA identifies itself, including iOS legacy standalone", () => {
  vi.stubGlobal("navigator", { platform: "iPhone", userAgent: "iPhone", standalone: true });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  expect(detectTerminalClient()).toEqual({ kind: "pwa", platform: "ios" });
  vi.stubGlobal("navigator", { platform: "Win32" });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  expect(detectTerminalClient()).toEqual({ kind: "pwa", platform: "windows" });
});

test("without browser globals the platform stays unknown", () => {
  vi.stubGlobal("navigator", undefined);
  vi.stubGlobal("window", undefined);
  expect(detectTerminalClient()).toEqual({ kind: "unknown", platform: "unknown" });
});

test("titles distinguish disconnected status, no owner and an unrecognized owner", () => {
  expect(terminalOwnerTitle(undefined)).toBe("Current access unknown");
  expect(terminalOwnerTitle(null)).toBe("Not currently open on another device");
  expect(terminalOwnerTitle({ kind: "unknown", platform: "unknown" })).toBe(
    "Active on another device",
  );
  expect(terminalOwnerTitle({ kind: "mac-app", platform: "macos" })).toBe("Active in the Mac app");
  expect(terminalOwnerTitle({ kind: "pwa", platform: "ios" })).toBe("Active in the PWA on iOS");
  expect(terminalOwnerTitle({ kind: "browser", platform: "unknown" })).toBe("Active in a browser");
});
