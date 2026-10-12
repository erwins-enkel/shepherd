/** Public browser entry point used by the Mac app: /?pair=iphone.
 * Strip only this parameter after consuming it; retain all unrelated navigation state. */
export function pairingSettingsOpen(href: string) {
  const url = new URL(href);
  if (url.searchParams.get("pair") !== "iphone") return null;
  url.searchParams.delete("pair");
  return {
    showSettings: true as const,
    settingsTab: "access" as const,
    settingsDeepLink: true,
    showPairing: true,
    cleanUrl: url.pathname + url.search + url.hash,
  };
}
