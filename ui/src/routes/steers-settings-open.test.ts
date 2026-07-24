import { describe, expect, it } from "vitest";
import { steersSettingsOpen } from "./steers-settings-open";

describe("steersSettingsOpen", () => {
  it("routes a targeted edit into the mobile Steers detail", () => {
    expect(steersSettingsOpen("b")).toEqual({
      showSettings: true,
      settingsTab: "steers",
      settingsMobileView: "detail",
      focusSteerId: "b",
    });
  });

  it("opens the same detail without targeting a steer", () => {
    expect(steersSettingsOpen()).toEqual({
      showSettings: true,
      settingsTab: "steers",
      settingsMobileView: "detail",
      focusSteerId: null,
    });
  });
});
