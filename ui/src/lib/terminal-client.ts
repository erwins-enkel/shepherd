import { m } from "$lib/paraglide/messages";
import { isStandalone } from "./pwa";
import type { TerminalClientInfo } from "./types";

export function detectTerminalClient(): TerminalClientInfo {
  if (typeof navigator === "undefined" || typeof window === "undefined")
    return { kind: "unknown", platform: "unknown" };
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const signals = `${platform} ${ua}`;
  const os =
    /ipad/i.test(signals) ||
    ((/mac/i.test(platform) || /Macintosh/i.test(ua)) && navigator.maxTouchPoints > 1)
      ? "ipados"
      : /iphone|ipod/i.test(signals)
        ? "ios"
        : /android/i.test(ua)
          ? "android"
          : /cros/i.test(ua)
            ? "chromeos"
            : /win/i.test(platform) || /windows/i.test(ua)
              ? "windows"
              : /mac/i.test(signals)
                ? "macos"
                : /linux/i.test(signals)
                  ? "linux"
                  : "unknown";
  return { kind: isStandalone() ? "pwa" : "browser", platform: os };
}

/** undefined: no current snapshot; null: a current snapshot without an owner. */
export function terminalOwnerTitle(owner: TerminalClientInfo | null | undefined): string {
  if (owner === undefined) return m.terminal_owner_unavailable();
  if (owner === null) return m.terminal_owner_none();
  if (owner.kind === "mac-app") return m.terminal_owner_mac();
  const platforms: Record<string, string> = {
    macos: "macOS",
    ios: "iOS",
    ipados: "iPadOS",
    android: "Android",
    windows: "Windows",
    linux: "Linux",
    chromeos: "ChromeOS",
  };
  const platform = platforms[owner.platform];
  if (owner.kind === "pwa")
    return platform ? m.terminal_owner_pwa_platform({ platform }) : m.terminal_owner_pwa();
  if (owner.kind === "browser")
    return platform ? m.terminal_owner_browser_platform({ platform }) : m.terminal_owner_browser();
  return m.viewport_parked_title();
}
