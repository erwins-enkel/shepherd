import type { CaptureConfig } from "./types";

const KEY = "captureConfig";

export const DEFAULT_CONFIG: CaptureConfig = {
  baseUrl: "http://localhost:7330",
  token: "",
  repoPath: "",
  baseBranch: "main",
  model: "default",
};

/** Load config from chrome.storage.local, merged over defaults. */
export async function loadConfig(): Promise<CaptureConfig> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_CONFIG, ...((got[KEY] as Partial<CaptureConfig>) ?? {}) };
}

/** Persist config (local only — never synced; holds the token). */
export async function saveConfig(config: CaptureConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}

/** True once the minimum required fields for a spawn are present. */
export function isConfigured(config: CaptureConfig): boolean {
  return config.baseUrl.trim() !== "" && config.repoPath.trim() !== "";
}
