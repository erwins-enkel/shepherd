export interface SteersSettingsOpen {
  showSettings: true;
  settingsTab: "steers";
  settingsMobileView: "detail";
  focusSteerId: string | null;
}

export function steersSettingsOpen(id?: string): SteersSettingsOpen {
  return {
    showSettings: true,
    settingsTab: "steers",
    settingsMobileView: "detail",
    focusSteerId: id ?? null,
  };
}
