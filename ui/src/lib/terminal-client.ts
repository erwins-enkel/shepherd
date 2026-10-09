import { m } from "#lib/paraglide/messages.js";
import { isStandalone } from "./pwa";
import type { TerminalClientInfo } from "./types";

export function detectTerminalClient(): TerminalClientInfo {
  if (typeof navigator === "undefined" || typeof window === "undefined")
    return { kind: "unknown", platform: "unknown" };
  const { userAgent: ua = "", platform = "" } = navigator;
  const signals = `${platform} ${ua}`;
  let os: TerminalClientInfo["platform"] = "unknown";
  if (
    /ipad/i.test(signals) ||
    ((/mac/i.test(platform) || /Macintosh/i.test(ua)) && navigator.maxTouchPoints > 1)
  )
    os = "ipados";
  else if (/iphone|ipod/i.test(signals)) os = "ios";
  else if (/android/i.test(ua)) os = "android";
  else if (/cros/i.test(ua)) os = "chromeos";
  else if (/win/i.test(platform) || /windows/i.test(ua)) os = "windows";
  else if (/mac/i.test(signals)) os = "macos";
  else if (/linux/i.test(signals)) os = "linux";
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
