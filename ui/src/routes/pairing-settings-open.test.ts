import { expect, test } from "vitest";
import { pairingSettingsOpen } from "./pairing-settings-open";
test("iPhone deep link opens access and strips only the pairing parameter", () => {
  expect(pairingSettingsOpen("https://shepherd.ts.net/?pair=iphone&repo=alpha#sessions")).toEqual({
    showSettings: true,
    settingsTab: "access",
    settingsDeepLink: true,
    showPairing: true,
    cleanUrl: "/?repo=alpha#sessions",
  });
});
test("unrelated links do not open settings", () => {
  expect(pairingSettingsOpen("https://shepherd.ts.net/")).toBeNull();
  expect(pairingSettingsOpen("https://shepherd.ts.net/?pair=other")).toBeNull();
});
